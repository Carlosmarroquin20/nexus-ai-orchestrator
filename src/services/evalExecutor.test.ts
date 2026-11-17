import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_DATASET_FILE_BYTES,
  readDatasetFile,
  startEvaluation,
  stopEvaluation,
} from '@/services/evalExecutor';
import { useEvaluationStore } from '@/store/useEvaluationStore';
import { useGraphStore } from '@/store/useGraphStore';
import { makeEdge, makeNode } from '@/test/factories';
import type { EvalDataset } from '@/utils/evaluation/dataset';
import { IDLE_PROGRESS } from '@/utils/evaluation/progress';
import type {
  EvalCaseFrame,
  EvalStartedFrame,
  EvalSummaryFrame,
  EvaluationRequest,
} from '@/utils/evaluation/protocol';

/**
 * Exercises the evaluation controller against the real stores with `fetch`
 * replaced by a scripted streaming response: request shape, local preflight
 * checks, progress folding, recording into the history, and staleness.
 */

const encoder = new TextEncoder();
const evalStore = () => useEvaluationStore.getState();

const dataset: EvalDataset = {
  version: 1,
  name: 'Smoke',
  cases: [{ id: 'c0', input: 'hi', checks: [{ scorer: 'equals', nodeId: 'a', expected: 'x' }] }],
};

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const startedFrame = (evalId: string): EvalStartedFrame => ({
  evalId,
  datasetName: 'Smoke',
  caseCount: 1,
  mode: 'simulated',
  model: null,
});

const caseFrame: EvalCaseFrame = {
  caseId: 'c0',
  index: 0,
  runOutcome: 'completed',
  verdict: 'passed',
  durationMs: 10,
  costInUSD: 0,
  totalTokens: 0,
  checks: [{ nodeId: 'a', scorer: 'equals', status: 'passed', detail: 'Matched.', actual: 'x', score: null }],
};

const summaryFrame: EvalSummaryFrame = {
  cases: { passed: 1, total: 1, rate: 1 },
  checks: { passed: 1, total: 1, rate: 1 },
  erroredChecks: 0,
  skippedChecks: 0,
  byNode: { a: { passed: 1, total: 1, rate: 1 } },
  byScorer: { equals: { passed: 1, total: 1, rate: 1 } },
  judgeScore: null,
  duration: { meanMs: 10, p50Ms: 10, p95Ms: 10, maxMs: 10 },
  totalCostInUSD: 0,
  meanCostInUSD: 0,
  totalTokens: 0,
  judgeUsage: { calls: 0, inputTokens: 0, outputTokens: 0, costInUSD: 0 },
};

interface ScriptedStream {
  readonly push: (chunk: string) => void;
  readonly close: () => void;
}

interface Call {
  readonly url: string;
  readonly request: EvaluationRequest;
  readonly stream: ScriptedStream;
}

const calls: Call[] = [];

const stubStreamingFetch = (): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
        },
      });
      init.signal?.addEventListener('abort', () => {
        controller.error(new DOMException('Aborted', 'AbortError'));
      });
      calls.push({
        url,
        request: JSON.parse(String(init.body)) as EvaluationRequest,
        stream: {
          push: (chunk) => controller.enqueue(encoder.encode(chunk)),
          close: () => controller.close(),
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }),
  );
};

const streamFullEvaluation = (call: Call, status: 'completed' | 'cancelled' = 'completed'): void => {
  call.stream.push(frame('started', startedFrame(call.request.evalId)));
  call.stream.push(frame('case_started', { caseId: 'c0', index: 0 }));
  call.stream.push(frame('case', caseFrame));
  call.stream.push(frame('summary', summaryFrame));
  call.stream.push(frame('done', { status }));
};

beforeEach(() => {
  calls.length = 0;
  useGraphStore.setState({
    nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' })],
    edges: [makeEdge('a', 'b')],
  });
  useEvaluationStore.setState({
    selection: { source: 'bundled', key: 'smoke', dataset },
    progress: IDLE_PROGRESS,
    history: [],
    historyLoaded: true,
  });
});

afterEach(() => {
  stopEvaluation();
  vi.unstubAllGlobals();
});

describe('startEvaluation', () => {
  it('posts the pipeline and the selected dataset', async () => {
    stubStreamingFetch();
    startEvaluation();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const { url, request } = calls[0]!;
    expect(url).toBe('/api/evals/stream');
    expect(request.evalId).toMatch(/^eval_/);
    expect(request.dataset).toEqual(dataset);
    expect(request.graph.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(evalStore().progress.phase).toBe('connecting');
  });

  it('folds the stream into progress and records the finished evaluation', async () => {
    stubStreamingFetch();
    startEvaluation();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    streamFullEvaluation(calls[0]!);

    await vi.waitFor(() => expect(evalStore().progress.phase).toBe('completed'));
    expect(evalStore().progress.cases).toEqual([caseFrame]);
    expect(evalStore().progress.summary).toEqual(summaryFrame);
    expect(evalStore().history).toHaveLength(1);
    expect(evalStore().history[0]).toMatchObject({
      id: calls[0]!.request.evalId,
      status: 'completed',
      datasetName: 'Smoke',
      metrics: { casesPassed: 1, casesTotal: 1 },
    });
    expect(evalStore().history[0]!.pipelineFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('records a server-side cancellation that came with a summary', async () => {
    stubStreamingFetch();
    startEvaluation();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    streamFullEvaluation(calls[0]!, 'cancelled');

    await vi.waitFor(() => expect(evalStore().progress.phase).toBe('cancelled'));
    expect(evalStore().history[0]!.status).toBe('cancelled');
  });

  it('fails without a request when the dataset checks nodes the pipeline lacks', () => {
    stubStreamingFetch();
    evalStore().selectDataset({
      source: 'imported',
      key: 'other.json',
      dataset: {
        ...dataset,
        cases: [{ ...dataset.cases[0]!, checks: [{ scorer: 'equals', nodeId: 'zz', expected: 'x' }] }],
      },
    });
    startEvaluation();
    expect(calls).toHaveLength(0);
    expect(evalStore().progress.phase).toBe('failed');
    expect(evalStore().progress.error).toMatch(/does not have: "zz"/);
  });

  it('fails without a request when the pipeline is empty, and ignores a missing selection', () => {
    stubStreamingFetch();
    useGraphStore.setState({ nodes: [], edges: [] });
    startEvaluation();
    expect(evalStore().progress.error).toMatch(/Add nodes/);

    evalStore().selectDataset(null);
    evalStore().updateProgress(() => IDLE_PROGRESS);
    startEvaluation();
    expect(evalStore().progress.phase).toBe('idle');
    expect(calls).toHaveLength(0);
  });

  it('reports the server reason for a rejected request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('An evaluation is already running on this server; try again when it finishes.', {
            status: 429,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          }),
      ),
    );
    startEvaluation();
    await vi.waitFor(() => expect(evalStore().progress.phase).toBe('failed'));
    expect(evalStore().progress.error).toMatch(/already running/);
    expect(evalStore().history).toEqual([]);
  });

  it('fails an evaluation whose stream closes before done, keeping the scored cases', async () => {
    stubStreamingFetch();
    startEvaluation();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const { request, stream } = calls[0]!;
    stream.push(frame('started', startedFrame(request.evalId)));
    stream.push(frame('case', caseFrame));
    stream.close();

    await vi.waitFor(() => expect(evalStore().progress.phase).toBe('failed'));
    expect(evalStore().progress.error).toMatch(/closed before/);
    expect(evalStore().progress.cases).toHaveLength(1);
    expect(evalStore().history).toEqual([]);
  });

  it('never lets a superseded stream write into the evaluation that replaced it', async () => {
    stubStreamingFetch();
    startEvaluation();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    startEvaluation();
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    calls[1]!.stream.push(frame('started', startedFrame(calls[1]!.request.evalId)));
    await vi.waitFor(() => expect(evalStore().progress.phase).toBe('running'));
    expect(evalStore().progress.started?.evalId).toBe(calls[1]!.request.evalId);
  });
});

describe('stopEvaluation', () => {
  it('cancels the evaluation in flight without recording it', async () => {
    stubStreamingFetch();
    startEvaluation();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const { request, stream } = calls[0]!;
    stream.push(frame('started', startedFrame(request.evalId)));
    await vi.waitFor(() => expect(evalStore().progress.phase).toBe('running'));

    stopEvaluation();
    expect(evalStore().progress.phase).toBe('cancelled');
    // Give the aborted stream's continuation a chance to run: it must not report a failure.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(evalStore().progress.phase).toBe('cancelled');
    expect(evalStore().history).toEqual([]);
  });
});

describe('readDatasetFile', () => {
  const fileOf = (text: string): File => new File([text], 'dataset.json', { type: 'application/json' });

  it('parses a valid dataset file', async () => {
    expect(await readDatasetFile(fileOf(JSON.stringify(dataset)))).toEqual({ ok: true, dataset });
  });

  it('rejects files that are not JSON, not a dataset, or too large', async () => {
    expect(await readDatasetFile(fileOf('{oops'))).toEqual({ ok: false, error: 'The file is not valid JSON.' });
    expect(await readDatasetFile(fileOf('{"version": 2}'))).toMatchObject({ ok: false });
    const large = await readDatasetFile(fileOf('x'.repeat(MAX_DATASET_FILE_BYTES + 1)));
    expect(large).toMatchObject({ ok: false, error: expect.stringMatching(/larger than 2 MB/) });
  });
});

/**
 * Pipeline execution engine (ADR 0010).
 *
 * Executes a graph descriptor level by level (longest-path rank), running the
 * mutually independent nodes of a level concurrently, and reports progress as
 * `TelemetryEvent`s through a callback: one `running` then one `completed` or
 * `failed` per node, or `skipped` for nodes downstream of a failure. Output text
 * flows downstream: a node's input is the concatenation of its predecessors'
 * outputs, and source nodes receive the run input.
 *
 * Transport-agnostic: it knows nothing about HTTP or Server-Sent Events, so the
 * same engine serves the run stream, dataset evaluations, and the command line.
 * Telemetry events carry display-truncated payloads (they are a UI contract); the
 * returned result carries every node's full output, which is what scoring needs.
 *
 * Mode: with a provider, LLM-backed kinds (AGENT, LLM_CORE, CLASSIFIER) call it;
 * with `null`, they produce simulated telemetry paced in wall-clock time.
 */

import { SIMULATED_PRICING } from '@/config/telemetry';
import type { ExecutionDescriptor, ExecutionNodeParams, RunOutcome } from '@/types/execution';
import {
  type NexusNodeKind,
  type NodeExecutionState,
  type NodeTelemetryPatch,
  type TelemetryEvent,
  asNodeId,
  asRunId,
} from '@/types/graph';
import { LlmError, type LlmProvider } from '@/server/llm/types';
import { forEachWithConcurrency } from '@/utils/concurrency';
import { computeExecutionLevels } from '@/utils/graphValidation';
import { renderTemplate, renderedTemplateLength } from '@/utils/promptTemplate';
import { computeTokenCost } from '@/utils/telemetry';

/**
 * Maximum nodes of one level executing at the same time. Without a bound, a wide
 * level (up to the 200-node limit) would open that many model requests at once
 * and run straight into the provider's rate limit, turning a valid pipeline into
 * a cascade of 429 retries. The critical-path metric still reports the unbounded
 * ideal, so a level wider than this bound can take longer than that metric.
 */
const MAX_LEVEL_CONCURRENCY = 4;

/** Wall-clock pacing for the simulated fallback (real mode is paced by the API). */
const RUNNING_PHASE_MS = 420;
const INTER_NODE_GAP_MS = 110;

/** Display bounds for the payloads carried by telemetry events. */
const INPUT_PREVIEW_CHARS = 280;
const OUTPUT_PREVIEW_CHARS = 600;

/**
 * Upper bound on the text a node receives or a template produces. Without it,
 * text grows without limit: a template multiplies its input by its number of
 * references, and a node concatenates the outputs of all its predecessors, so a
 * request of a few kilobytes could exhaust the server's memory. A node that would
 * exceed the bound fails instead of building the text.
 */
export const MAX_NODE_TEXT_LENGTH = 200_000;

/** Separator between predecessor outputs in a node's combined input. */
const INPUT_SEPARATOR = '\n\n';

/** A node-level limit was hit; carries the failure code reported for the node. */
class NodeLimitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NodeLimitError';
  }
}

export interface PipelineRunOptions {
  /** Correlation id stamped on every emitted event. */
  readonly runId: string;
  readonly descriptor: ExecutionDescriptor;
  /** Input handed to source nodes. */
  readonly input: string;
  /** Fault-injection probability in [0,1]. */
  readonly failRate: number;
  /** Model backend; `null` selects the simulator. */
  readonly provider: LlmProvider | null;
  /**
   * Cancels the run. Model calls and their retry delays observe it, no event is
   * emitted after it fires, and the run resolves as `cancelled`.
   */
  readonly signal: AbortSignal;
  /**
   * Receives every telemetry event, synchronously and in emission order. It must
   * not throw: the engine treats every failure it observes as a node failure.
   */
  readonly onEvent: (event: TelemetryEvent) => void;
}

/** Terminal record of one node. Nodes a cancelled run never reached are absent. */
export interface NodeRunRecord {
  readonly state: Extract<NodeExecutionState, 'completed' | 'failed' | 'skipped'>;
  /** Full, untruncated output; `null` unless the node completed. */
  readonly outputText: string | null;
  readonly latencyMs: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costInUSD: number;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface PipelineRunResult {
  readonly outcome: RunOutcome;
  readonly nodes: ReadonlyMap<string, NodeRunRecord>;
}

interface NodeExecutionResult {
  readonly outputText: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly costInUSD: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const randomInt = (min: number, max: number): number =>
  Math.floor(min + Math.random() * (max - min + 1));

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/** Per-kind simulated telemetry profile (used only without a provider). */
const simulateMetrics = (kind: NexusNodeKind): Omit<NodeExecutionResult, 'outputText'> => {
  switch (kind) {
    case 'LLM_CORE':
    case 'AGENT': {
      const inputTokens = randomInt(400, 2400);
      const outputTokens = randomInt(150, 1600);
      return {
        inputTokens,
        outputTokens,
        latencyMs: randomInt(700, 4200),
        costInUSD: computeTokenCost(SIMULATED_PRICING.generative, inputTokens, outputTokens),
      };
    }
    case 'CLASSIFIER': {
      const inputTokens = randomInt(80, 400);
      const outputTokens = randomInt(5, 40);
      return {
        inputTokens,
        outputTokens,
        latencyMs: randomInt(150, 900),
        costInUSD: computeTokenCost(SIMULATED_PRICING.classifier, inputTokens, outputTokens),
      };
    }
    case 'VECTOR_DB':
      return { inputTokens: 0, outputTokens: 0, latencyMs: randomInt(40, 320), costInUSD: 0 };
    case 'PROMPT_TEMPLATE':
      return { inputTokens: 0, outputTokens: 0, latencyMs: randomInt(2, 25), costInUSD: 0 };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
};

/** Builds the prompt (and optional system instruction) for an LLM-backed node. */
const buildPrompt = (
  kind: NexusNodeKind,
  params: ExecutionNodeParams,
  inputText: string,
): { systemInstruction?: string; prompt: string } => {
  if (kind === 'AGENT') {
    return {
      ...(params.systemPrompt !== undefined && params.systemPrompt.length > 0
        ? { systemInstruction: params.systemPrompt }
        : {}),
      prompt: inputText,
    };
  }
  if (kind === 'CLASSIFIER') {
    const labels = params.labels !== undefined && params.labels.length > 0
      ? params.labels.join(', ')
      : 'general';
    return {
      prompt: `Classify the request into exactly one of: [${labels}]. Reply with only the label.\n\nRequest: ${inputText}`,
    };
  }
  return { prompt: inputText };
};

/** Runs a pipeline to completion, failure, or cancellation. Never rejects. */
export const runPipeline = async (options: PipelineRunOptions): Promise<PipelineRunResult> => {
  const { runId, descriptor, input, failRate, provider, signal, onEvent } = options;
  const realMode = provider !== null;
  const isAborted = (): boolean => signal.aborted;

  const emit = (nodeId: string, state: NodeExecutionState, patch: NodeTelemetryPatch): void => {
    if (isAborted()) return;
    onEvent({
      runId: asRunId(runId),
      nodeId: asNodeId(nodeId),
      state,
      emittedAt: Date.now(),
      patch,
    });
  };

  const levels = computeExecutionLevels(descriptor.nodes, descriptor.edges);
  const kindById = new Map(descriptor.nodes.map((node) => [node.id, node.kind]));
  const paramsById = new Map(descriptor.nodes.map((node) => [node.id, node.params ?? {}]));

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of descriptor.edges) {
    (outgoing.get(edge.source) ?? outgoing.set(edge.source, []).get(edge.source)!).push(edge.target);
    (incoming.get(edge.target) ?? incoming.set(edge.target, []).get(edge.target)!).push(edge.source);
  }

  /** Transitive descendants of a node (the subgraph that cannot run if it fails). */
  const descendantsOf = (start: string): Set<string> => {
    const result = new Set<string>();
    const stack = [...(outgoing.get(start) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (result.has(current)) continue;
      result.add(current);
      for (const next of outgoing.get(current) ?? []) {
        if (!result.has(next)) stack.push(next);
      }
    }
    return result;
  };

  const records = new Map<string, NodeRunRecord>();
  const outputOf = (nodeId: string): string => records.get(nodeId)?.outputText ?? '';
  /** The node's combined input, or `null` when it would exceed `MAX_NODE_TEXT_LENGTH`. */
  const gatherInput = (nodeId: string): string | null => {
    const parts = (incoming.get(nodeId) ?? [])
      .map(outputOf)
      .filter((text) => text.length > 0);
    if (parts.length === 0) return input;
    const length =
      parts.reduce((sum, text) => sum + text.length, 0) +
      INPUT_SEPARATOR.length * (parts.length - 1);
    return length > MAX_NODE_TEXT_LENGTH ? null : parts.join(INPUT_SEPARATOR);
  };

  const execute = async (
    kind: NexusNodeKind,
    params: ExecutionNodeParams,
    inputText: string,
  ): Promise<NodeExecutionResult> => {
    if (kind === 'PROMPT_TEMPLATE') {
      const template = params.template ?? '';
      if (renderedTemplateLength(template, inputText) > MAX_NODE_TEXT_LENGTH) {
        throw new NodeLimitError(
          'OUTPUT_TOO_LARGE',
          `The rendered template would exceed ${MAX_NODE_TEXT_LENGTH} characters.`,
        );
      }
      const rendered = renderTemplate(template, inputText);
      return { outputText: rendered, inputTokens: 0, outputTokens: 0, latencyMs: 0, costInUSD: 0 };
    }
    if (kind === 'VECTOR_DB') {
      return {
        outputText: `Retrieved context for: ${truncate(inputText, 160)}`,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        costInUSD: 0,
      };
    }

    // LLM-backed kinds: AGENT, LLM_CORE, CLASSIFIER.
    if (provider !== null) {
      const { systemInstruction, prompt } = buildPrompt(kind, params, inputText);
      const result = await provider.generate({
        prompt,
        ...(systemInstruction !== undefined ? { systemInstruction } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.maxOutputTokens !== undefined ? { maxOutputTokens: params.maxOutputTokens } : {}),
        ...(params.topP !== undefined ? { topP: params.topP } : {}),
        signal,
      });
      return {
        outputText: result.text,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs,
        costInUSD: computeTokenCost(provider.pricing, result.inputTokens, result.outputTokens),
      };
    }

    const metrics = simulateMetrics(kind);
    return { outputText: `Simulated ${kind} output.`, ...metrics };
  };

  let outcome: RunOutcome = 'completed';
  const skipped = new Set<string>();

  const fail = (nodeId: string, code: string, message: string): void => {
    emit(nodeId, 'failed', { error: { code, message, originNodeId: null } });
    records.set(nodeId, {
      state: 'failed',
      outputText: null,
      latencyMs: null,
      inputTokens: 0,
      outputTokens: 0,
      costInUSD: 0,
      error: { code, message },
    });
    outcome = 'failed';
    for (const descendant of descendantsOf(nodeId)) skipped.add(descendant);
  };

  const runNode = async (nodeId: string): Promise<void> => {
    if (isAborted()) return;

    if (skipped.has(nodeId)) {
      emit(nodeId, 'skipped', {});
      records.set(nodeId, {
        state: 'skipped',
        outputText: null,
        latencyMs: null,
        inputTokens: 0,
        outputTokens: 0,
        costInUSD: 0,
        error: null,
      });
      return;
    }

    const kind = kindById.get(nodeId) ?? 'PROMPT_TEMPLATE';
    const params = paramsById.get(nodeId) ?? {};
    const inputText = gatherInput(nodeId);
    if (inputText === null) {
      fail(
        nodeId,
        'INPUT_TOO_LARGE',
        `The combined input from upstream nodes exceeds ${MAX_NODE_TEXT_LENGTH} characters.`,
      );
      return;
    }

    emit(nodeId, 'running', { inputPayload: { input: truncate(inputText, INPUT_PREVIEW_CHARS) } });
    if (!realMode) {
      await sleep(RUNNING_PHASE_MS);
      if (isAborted()) return;
    }

    if (failRate > 0 && Math.random() < failRate) {
      fail(nodeId, 'INJECTED_FAILURE', 'Injected fault (failRate).');
      return;
    }

    // Only the execution itself is guarded: reporting happens outside the try, so
    // a failure while emitting can never be misattributed to the node.
    let result: NodeExecutionResult;
    try {
      result = await execute(kind, params, inputText);
    } catch (error) {
      if (isAborted()) return;
      fail(
        nodeId,
        error instanceof NodeLimitError
          ? error.code
          : error instanceof LlmError
            ? `LLM_${error.status}`
            : 'EXECUTION_ERROR',
        error instanceof Error ? error.message : 'Node execution failed.',
      );
      return;
    }
    if (isAborted()) return;

    records.set(nodeId, {
      state: 'completed',
      outputText: result.outputText,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costInUSD: result.costInUSD,
      error: null,
    });
    emit(nodeId, 'completed', {
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costInUSD: result.costInUSD,
      outputPayload: { output: truncate(result.outputText, OUTPUT_PREVIEW_CHARS) },
    });
  };

  // Execute level by level. Within a level the nodes are mutually independent
  // (edges only cross to higher levels), so they run concurrently, at most
  // MAX_LEVEL_CONCURRENCY at a time. `runNode` never rejects.
  for (const level of levels) {
    if (isAborted()) break;
    await forEachWithConcurrency(level, MAX_LEVEL_CONCURRENCY, runNode);
    if (!realMode && !isAborted()) await sleep(INTER_NODE_GAP_MS);
  }

  return { outcome: isAborted() ? 'cancelled' : outcome, nodes: records };
};

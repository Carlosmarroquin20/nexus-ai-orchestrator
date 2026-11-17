/**
 * Client-side state of one evaluation, folded from its event stream (ADR 0010).
 *
 * A pure reducer over decoded SSE events, so the panel's view of an evaluation
 * is a function of the frames received and can be tested without a network or
 * a store. Lifecycle:
 *
 *   idle -> connecting -> running -> completed | cancelled
 *                \____________\____-> failed   (rejected request, broken stream)
 *
 * Once terminal, further events are ignored: a late frame from a stream that
 * was already finalized must not reopen it.
 */

import type { SseEvent } from '../sseParser';
import { safeJsonParse } from '../telemetryEvent';
import {
  parseCaseFrame,
  parseCaseStartedFrame,
  parseDoneFrame,
  parseStartedFrame,
  parseSummaryFrame,
} from './frames';
import type {
  EvalCaseFrame,
  EvalCaseStartedFrame,
  EvalStartedFrame,
  EvalSummaryFrame,
} from './protocol';

export type EvalPhase = 'idle' | 'connecting' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface EvalProgress {
  readonly phase: EvalPhase;
  /** `null` until the server accepts the request. */
  readonly started: EvalStartedFrame | null;
  /** The case being run right now, if any. */
  readonly currentCase: EvalCaseStartedFrame | null;
  /** Scored cases, in dataset order. */
  readonly cases: readonly EvalCaseFrame[];
  readonly summary: EvalSummaryFrame | null;
  /** Why the evaluation failed; set only in the `failed` phase. */
  readonly error: string | null;
}

export const IDLE_PROGRESS: EvalProgress = {
  phase: 'idle',
  started: null,
  currentCase: null,
  cases: [],
  summary: null,
  error: null,
};

export const CONNECTING_PROGRESS: EvalProgress = { ...IDLE_PROGRESS, phase: 'connecting' };

export const isTerminalPhase = (phase: EvalPhase): boolean =>
  phase === 'completed' || phase === 'cancelled' || phase === 'failed';

/** Applies one stream event. Malformed or unknown events leave the state unchanged. */
export const applyEvalEvent = (progress: EvalProgress, event: SseEvent): EvalProgress => {
  if (isTerminalPhase(progress.phase)) return progress;
  const payload = safeJsonParse(event.data);

  switch (event.event) {
    case 'started': {
      const started = parseStartedFrame(payload);
      return started === null ? progress : { ...progress, phase: 'running', started };
    }
    case 'case_started': {
      const currentCase = parseCaseStartedFrame(payload);
      return currentCase === null ? progress : { ...progress, currentCase };
    }
    case 'case': {
      const scored = parseCaseFrame(payload);
      if (scored === null) return progress;
      // Keyed by position, so a repeated frame replaces its case instead of duplicating it.
      const cases = [...progress.cases.filter((entry) => entry.index !== scored.index), scored].sort(
        (a, b) => a.index - b.index,
      );
      return { ...progress, cases, currentCase: null };
    }
    case 'summary': {
      const summary = parseSummaryFrame(payload);
      return summary === null ? progress : { ...progress, summary };
    }
    case 'done': {
      const done = parseDoneFrame(payload);
      return done === null ? progress : { ...progress, phase: done.status, currentCase: null };
    }
    default:
      return progress;
  }
};

/** Ends the evaluation as failed, keeping whatever was received before. */
export const failProgress = (progress: EvalProgress, reason: string): EvalProgress =>
  isTerminalPhase(progress.phase)
    ? progress
    : { ...progress, phase: 'failed', currentCase: null, error: reason };

/** Ends the evaluation as cancelled by the user, keeping the cases already scored. */
export const cancelProgress = (progress: EvalProgress): EvalProgress =>
  isTerminalPhase(progress.phase) || progress.phase === 'idle'
    ? progress
    : { ...progress, phase: 'cancelled', currentCase: null };

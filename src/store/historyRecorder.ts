/**
 * Undo recorder: observes the store and turns bursts of structural edits into
 * single undo steps. Free of React so the recording state machine is unit-testable;
 * `useGraphHistory` binds it to the workspace lifetime.
 *
 * `present` tracks the last committed structural snapshot. The first edit of a
 * burst pushes `present` onto the undo stack; the debounce timer marks the burst
 * end and advances `present`. Changes flagged `historyApplying` (undo/redo) only
 * resync `present` and are never recorded. Telemetry and selection churn is
 * filtered out by the structural comparison.
 *
 * Re-entrancy constraint: this listener writes to the store it observes
 * (`recordSnapshot`, and the `historyApplying` reset), and Zustand notifies
 * listeners synchronously from inside `set`. Each such write re-enters the
 * listener before the write returns. Local state must therefore already describe
 * the post-write situation when the write is issued; otherwise the nested call
 * sees the same pending condition and repeats the write until the stack overflows.
 */

import type { StoreApi } from 'zustand';

import { isSameGraphStructure } from '@/utils/graphStructure';

import type { GraphSnapshot } from './slices/historySlice';
import type { GraphStore } from './useGraphStore';

/**
 * Window of inactivity after which a burst of edits is committed as a single
 * undo step. Coalesces continuous gestures (dragging, typing) into one entry.
 */
export const HISTORY_DEBOUNCE_MS = 300;

type RecorderStore = Pick<StoreApi<GraphStore>, 'getState' | 'setState' | 'subscribe'>;

const captureSnapshot = (state: GraphStore): GraphSnapshot => ({
  nodes: state.nodes,
  edges: state.edges,
});

/**
 * Starts recording structural edits of `store` into its undo history. The graph
 * at attach time becomes the baseline, so attach only after hydration. Returns a
 * detach function that stops recording and cancels the pending burst commit.
 */
export const attachHistoryRecorder = (store: RecorderStore): (() => void) => {
  let present = captureSnapshot(store.getState());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let burst = false;

  const commitPresent = (): void => {
    present = captureSnapshot(store.getState());
    burst = false;
    timer = null;
  };

  const unsubscribe = store.subscribe((state) => {
    if (state.historyApplying) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      burst = false;
      // Resync before the reset below: its nested notification must find the
      // restored graph already committed as the baseline.
      present = captureSnapshot(state);
      store.setState({ historyApplying: false });
      return;
    }

    if (isSameGraphStructure(present, state)) return;

    if (!burst) {
      // Raised before the write: the nested notification must observe an open
      // burst and fall through to the timer instead of recording again.
      burst = true;
      state.recordSnapshot(present);
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(commitPresent, HISTORY_DEBOUNCE_MS);
  });

  return () => {
    if (timer !== null) clearTimeout(timer);
    unsubscribe();
  };
};

'use client';

import { useEffect } from 'react';

import { attachHistoryRecorder } from '@/store/historyRecorder';
import { useGraphStore } from '@/store/useGraphStore';

/**
 * Records topology/config edits into the undo history for the lifetime of the
 * host component. Call EXACTLY ONCE at the workspace root, after
 * `useGraphAutoPersist` so the hydrated graph — not the empty initial state —
 * becomes the history baseline.
 *
 * The recording state machine lives in `attachHistoryRecorder`; this hook only
 * owns its subscription lifecycle.
 */
export const useGraphHistory = (): void => {
  useEffect(() => attachHistoryRecorder(useGraphStore), []);
};

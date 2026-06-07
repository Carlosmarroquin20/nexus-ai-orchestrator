'use client';

import { useEffect } from 'react';

import { useGraphStore } from '@/store/useGraphStore';
import { parseTelemetryEvent, safeJsonParse } from '@/utils/telemetryEvent';

export interface UseTelemetryStreamOptions {
  /** SSE endpoint emitting `TelemetryEvent` frames. `null` keeps the stream closed. */
  readonly url: string | null;
  /** Gate the connection without unmounting the host component. Defaults to `true`. */
  readonly enabled?: boolean;
}

/**
 * Subscribes the store to a server-sent telemetry stream for the duration of the
 * host component's lifetime.
 *
 * Design notes:
 * - Store actions are read via `getState()` inside handlers rather than captured
 *   as effect dependencies. Their identities are stable, so this avoids
 *   reconnect churn while always dispatching through the live store.
 * - Frames are parsed defensively; an unparseable frame is dropped, never
 *   ingested. `runId` correlation (enforced in `ingestTelemetryEvent`) discards
 *   frames belonging to a superseded run.
 * - The effect is the sole owner of the `EventSource`; teardown closes it and
 *   resets transport status, guaranteeing no leaked connections across reconnects.
 */
export const useTelemetryStream = ({ url, enabled = true }: UseTelemetryStreamOptions): void => {
  useEffect(() => {
    if (!enabled || url === null) return undefined;

    const { setStreamStatus, ingestTelemetryEvent } = useGraphStore.getState();
    setStreamStatus('connecting');

    const source = new EventSource(url);

    source.onopen = (): void => setStreamStatus('open');

    source.onmessage = (message: MessageEvent<string>): void => {
      const event = parseTelemetryEvent(safeJsonParse(message.data));
      if (event !== null) ingestTelemetryEvent(event);
    };

    source.onerror = (): void => setStreamStatus('error');

    return (): void => {
      source.close();
      setStreamStatus('disconnected');
    };
  }, [url, enabled]);
};

# 5. Execution as a server-streamed dual backend (Gemini + simulator)

- Status: Accepted
- Date: 2026-06-15

## Context

A run must drive the graph and surface live per-node telemetry. We want real model
calls (Google AI Studio / Gemini) when configured, but the application must remain
fully functional with no credentials, and the API key must never reach the browser.

## Decision

A Next.js route handler (`GET /api/runs/stream`) streams `TelemetryEvent` frames over
Server-Sent Events: one `running` then one `completed`/`failed` per node, a named
`mode` event up front, and a terminal `done` event.

- **Real mode** (`GEMINI_API_KEY` set): LLM-backed nodes call Gemini server-side; the
  key is read from `process.env` (never `NEXT_PUBLIC_`), sent via the `x-goog-api-key`
  header (not the URL), with per-attempt timeout and retry/backoff on transient failures.
- **Simulated mode** (no key): deterministic per-kind telemetry, so the app runs offline.
- Output flows downstream (predecessors' outputs become a successor's input). Nodes
  are executed in topological **levels** (longest-path rank); nodes within a level are
  independent and run concurrently, matching the parallelism the critical-path metric
  assumes. A failed node marks its transitive descendants `skipped`.
- The graph topology travels in the SSE GET query string.

## Consequences

- The app works with or without credentials; the active mode is shown live in the UI.
- Real runs report genuine token usage, latency, and cost.
- EventSource is native and simple, and auto-reconnect is avoided via the `done` event.
- SSE GET cannot carry a body, so the descriptor rides the query string — bounded in
  size (rejected past a limit). The documented evolution for large graphs is a
  POST-to-start + GET-by-id handshake; the event contract is unaffected by that change.
- Serverless platforms may cap stream duration; local development is unaffected.
- The endpoint is currently unauthenticated — acceptable for local use, documented as a
  prerequisite before public deployment (each run can incur real API cost).

## Alternatives considered

- **WebSocket** — bidirectional but heavier; the stream is one-way server→client.
- **Polling** — worse latency and more requests for a streaming workload.
- **Client-side model calls** — would expose the API key in the browser. Rejected on security grounds.

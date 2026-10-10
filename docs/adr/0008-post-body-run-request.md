# 8. Run requests travel as a POST body with a streamed response

- Status: Accepted
- Date: 2026-10-09
- Amends: [ADR 0005](0005-server-streamed-dual-execution-backend.md) (request transport only)

## Context

ADR 0005 streamed a run over `EventSource`, which can only issue GET requests, so the
graph descriptor — prompts included — travelled in the query string. Three problems
followed:

- **A hard size ceiling.** Node's HTTP server rejects a request whose request line and
  headers exceed 16 KB with `431`, before the route handler runs. Measured against the
  dev server: a 12 KB URL was accepted, a 20 KB URL was not. The handler's own 100 KB
  guard was therefore unreachable, and a pipeline with a few long prompts could not be
  executed at all; the client only saw a generic stream error.
- **Prompts in URLs.** Query strings are recorded verbatim in server and proxy access
  logs, so every run wrote its prompts to them.
- **A side-effecting GET.** A run can incur real model cost, and a GET can be issued by
  any third-party page (an `<img>` or a cross-origin `EventSource`) without the browser
  asking the server first.

ADR 0005 anticipated a POST-to-start + GET-by-id handshake as the eventual fix.

## Decision

A run is a single request: `POST /api/runs/stream` with an `ExecutionRequest` JSON body
(`runId`, `graph`, optional `failRate`). The response body keeps the exact
`text/event-stream` framing and event contract of ADR 0005 (`mode`, telemetry frames,
terminal `done`).

- The client issues the request with `fetch`, reads the body incrementally, and decodes
  the framing with a pure, incremental decoder (`utils/sseParser`). Cancellation is an
  `AbortController`. A body that ends without `done` is treated as an interrupted run.
- The handler accepts only `application/json` (`415` otherwise), caps the body at 1 MB
  counted on the bytes actually received (`413`), and delegates structural validation to
  a pure parser (`utils/executionRequest`), which rejects duplicate node ids and drops
  edges that reference an absent node.
- No GET handler is exported.

## Consequences

- Prompt size is bounded by an explicit, documented cap instead of an accidental URL
  limit, and prompts no longer appear in URLs or access logs.
- A cross-origin JSON POST requires a CORS preflight, which the route never grants, so a
  third-party page can no longer start a run from the user's browser. This is **not**
  authentication: same-origin and non-browser callers are still unauthenticated, and the
  prerequisite recorded in ADR 0005 for public deployment stands.
- A rejected request now reaches the client as an HTTP status with a reason, rather than
  an opaque `EventSource` error.
- The event contract, the store, and the execution engine are unchanged.
- The framing is decoded by project code instead of the browser. The decoder is small
  and its chunk-boundary independence is a property-based test.
- The request is stateless, so the endpoint needs no server-side run registry and
  behaves identically behind multiple instances.

## Alternatives considered

- **POST-to-start + GET-by-id** (the evolution ADR 0005 anticipated) — keeps
  `EventSource`, but the two requests must be joined by server-side state. That state
  does not survive multiple instances or serverless isolation without a shared store,
  and it adds a lifecycle of its own (expiry, runs that are started but never streamed).
  Rejected in favor of the stateless single request.
- **Raising Node's header limit** — moves the ceiling without removing it (intermediate
  proxies impose their own) and leaves prompts in URLs.
- **WebSocket** — rejected for the reasons given in ADR 0005.

# 4. Telemetry is execution state, not document state

- Status: Accepted
- Date: 2026-06-15

## Context

The pipeline graph is a **document** the user authors, shares, and reloads. A run's
telemetry (state, latency, tokens, cost, payloads) is **ephemeral execution output**.
Conflating the two would pollute exported pipelines with run artifacts and could
resurrect a stale `running` state on reload.

## Decision

- The graph snapshot (localStorage auto-save and JSON import/export) is a canonical
  projection of the authored document: it **omits telemetry** (and React Flow runtime
  fields such as selection and measured dimensions) on serialize and rehydrates
  telemetry to pristine on load. Telemetry is never part of the persisted document.
- Undo/redo restores structure only and re-bases the live telemetry onto it, so history
  never time-travels execution state.
- Workspace settings (e.g. `failRate`) persist under a **separate versioned storage key**,
  never inside the graph document, so a shared pipeline never carries debugging knobs.
- Run records snapshot telemetry **immutably** at capture time and the history is capped,
  so historical runs stay stable as the live graph mutates.
- Run metrics deliberately separate two latency notions: cumulative compute time (the
  sum of node latencies) and **critical-path latency** (the longest dependency path),
  computed by a dedicated analyzer.

## Consequences

- Exported pipelines are clean, portable, and shareable.
- A reload never shows a stale execution state.
- Settings do not leak into shared graphs.
- There are two persistence concerns to maintain (graph and settings); both are
  versioned and defensively parsed, and both reject unknown schema versions.

## Alternatives considered

- **Persist everything together** — simpler, but leaks execution state into the document,
  inflates snapshots, and produces confusing reloads (stale telemetry, lingering selection).

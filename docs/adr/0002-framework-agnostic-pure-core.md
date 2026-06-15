# 2. Layered architecture with a framework-agnostic pure core

- Status: Accepted
- Date: 2026-06-15

## Context

The highest-risk logic — graph algorithms (cycle detection, topological order,
layout), the telemetry reducer and its invariants, run analysis (critical path),
diagnostics, and (de)serialization — must be correct, reusable on both client and
server, and testable without a browser or React.

## Decision

Enforce a strict layering:

- `types/` — domain models, no behavior.
- `utils/` — pure, side-effect-free functions (the core).
- `config/` — immutable registries and constants, behavior-free.
- `server/` — server-only modules (e.g. the Gemini client), never imported by a component.
- `services/` — side-effecting orchestration (run controller, file transfer).
- `store/`, `hooks/`, `components/` — state and view layers.

The pure core never imports the view layer. Browser-only side effects are quarantined
in thin wrappers (`utils/localStorage` is a guarded accessor; DOM downloads live in
hooks/services), so `utils/` stays pure.

## Consequences

- The core runs and is unit/property-tested in a Node environment with no DOM.
- The same algorithms are reused by the server execution route and the client.
- A small number of localized, documented casts exist at the React Flow boundary
  (correlated unions the compiler cannot prove); they are confined to factories.
- Discipline is required to keep `utils/` pure — enforced by review and by the fact
  that the tests import these modules in a Node environment (a DOM dependency would break them).

## Alternatives considered

- **Colocating logic inside components/hooks** — fast to write, but couples correctness
  to React, makes unit testing hard, and blocks server reuse.

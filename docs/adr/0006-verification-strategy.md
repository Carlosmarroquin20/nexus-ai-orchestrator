# 6. Verification strategy independent of manual QA

- Status: Accepted
- Date: 2026-06-15

## Context

Confidence in correctness should not depend on manually clicking through the UI. The
riskiest areas are the pure core (graph algorithms, telemetry reducer, analysis,
serialization) and the store mutations that the UI relies on.

## Decision

Adopt a layered verification pyramid, all wired into CI on every push and pull request:

1. **Strict type-check** (`tsc --noEmit`) over the whole project, tests included.
2. **Lint** (`next lint`).
3. **Example unit tests** for the pure core.
4. **Property-based tests + fuzzing** (fast-check): assert universal invariants over
   generated inputs (token/error invariants, topological order respects edges,
   `detectCycle` ⇔ no topological order, admissible connection never cycles,
   `max ≤ critical-path ≤ sum`, serialize→parse round-trip) and fuzz the wire parser to
   guarantee it never throws on arbitrary input.
5. **State-machine tests** of the Zustand store in a Node environment (reference
   preservation, DAG admissibility, run lifecycle, history, clamps).
6. **Production build** (`next build`).

## Consequences

- Invariants are checked over thousands of generated inputs, not a few hand-picked cases.
- The transport parser is fuzzed, so a malformed frame can never corrupt state.
- Regressions are caught before merge without a human running the app.
- Property-based tests require carefully designed input generators (arbitraries).
- Tests live inside the project and are therefore type-checked and linted, which keeps
  them honest but means they must meet the same standards as production code.

## Alternatives considered

- **Example-only tests** — weaker; miss whole input ranges.
- **End-to-end / browser tests** — valuable and complementary, but require a running
  runtime and are out of scope for this iteration; the pyramid here is browser-free by design.

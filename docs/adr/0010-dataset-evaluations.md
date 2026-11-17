# 10. Dataset evaluations run on the server through a shared engine

- Status: Accepted
- Date: 2026-11-17

## Context

The orchestrator can execute a pipeline and show per-node telemetry, but it cannot say
whether the outputs are *good*. Comparing two prompt or model versions today means
running the pipeline by hand and reading the results. That does not scale beyond a few
manual tries and leaves quality claims unsupported.

Constraints found in the current code:

- The execution engine lives inside the `POST /api/runs/stream` handler closure, so it
  cannot be reused to run many cases.
- Every run starts from a fixed seed input; a test case needs its own input.
- The stream truncates node outputs to 600 characters for display, so scoring on the
  client would score incomplete text.
- Simulated mode produces fixed placeholder outputs: it exercises the mechanics but
  yields no meaningful quality signal.
- Evaluations must cost nothing. Real runs use the Gemini free tier, which is
  rate-limited.

## Decision

1. **Extract the engine.** Pipeline execution moves to a server module that takes a
   descriptor, an input, a provider, and an abort signal, emits telemetry events, and
   returns the full output of every node. The stream route becomes a thin adapter over
   it. `ExecutionRequest` gains an optional `input`, defaulting to the current seed.
2. **Datasets are versioned JSON in the repository** (`src/config/evalDatasets/`), with
   a schema version, defensively parsed like graph snapshots. A dataset is a list of
   cases; each case has an input and a list of checks, and each check names a node, a
   scorer, and its expected value. The UI loads bundled datasets and imports files, and
   does not edit them.
3. **Scorers.** Deterministic scorers (`equals`, `contains`, `regex`, `oneOf`) are pure
   functions. An `llm_judge` scorer grades free-text output from 1 to 5 against a rubric
   and returns a reason, as validated JSON at temperature 0. The judged output is
   delimited and declared as data, so instructions inside it are not followed. In
   simulated mode judge checks are reported as not evaluated, never given an invented
   score.
4. **Evaluations run on the server.** `POST /api/evals/stream` runs the cases one after
   another through the shared engine, scores them against full outputs, and streams one
   result per case and a final summary. It reuses the access gate, the body limits,
   cancellation, and the keep-alive heartbeat of the run endpoint. Cases run
   sequentially, so a dataset stays inside the free tier's rate limits; nodes within a
   case keep the per-level concurrency bound.
5. **Results are comparable.** Each evaluation records a fingerprint of the pipeline
   configuration (prompts and sampling settings) next to its metrics, stored locally
   with a capped history. Two evaluations can be compared case by case, listing
   regressions and fixes.
6. **A command-line runner** (`npm run eval`) reuses the same engine and scorers, reads
   a graph file and a dataset file, and writes a Markdown and JSON report.

## Consequences

- Prompt and model changes can be judged against a fixed set of cases instead of by
  impression, from the UI or from the terminal.
- The engine gains a test surface of its own, independent of HTTP.
- Full outputs never leave the server during an evaluation, and the API key stays
  server-side, including for the judge.
- Evaluations on the free tier are slow for large datasets; this is accepted in
  exchange for zero cost.
- LLM-as-judge scores are noisy and can be biased. Temperature 0, an explicit rubric,
  and a visible reason per score make them auditable, not authoritative.
- Retrieval metrics (recall@k) are deferred until the vector store performs real
  retrieval.

## Alternatives considered

- **Client-side orchestration over the existing run endpoint** — no engine refactor,
  but it scores truncated outputs, needs a separate judge endpoint, and stops when the
  tab closes.
- **A command-line runner only** — reproducible, but invisible in the application and
  in a demo. Kept as an addition to the server endpoint instead.
- **Datasets edited in the UI** — convenient, but it adds a full interface phase and
  makes datasets harder to review than files under version control.

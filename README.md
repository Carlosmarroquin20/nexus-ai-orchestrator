# Nexus AI Orchestrator

A production-grade, visual node-based debugger for multi-agent AI pipelines. It lets
engineers compose a pipeline as a graph, trace execution flow, inspect data payloads,
and analyze per-node telemetry — latency, token consumption, and cost — across the run.

Execution runs against a real backend (Google AI Studio / Gemini) when a key is
configured, and falls back to a built-in deterministic simulator otherwise, so the
application is fully functional with or without credentials.

## Tech stack

- **Framework:** Next.js 16 (App Router, Turbopack) on React 19
- **Language:** TypeScript (strict: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, etc.)
- **Graph engine:** React Flow (`@xyflow/react` v12)
- **State:** Zustand (slice-based)
- **UI:** Tailwind CSS + Radix UI (Shadcn-style primitives)
- **Tests:** Vitest

## Getting started

Requires **Node.js 22.12+** (Node 20 is end-of-life, and the test toolchain needs 22.12).

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. With an empty canvas, use **Load demo pipeline** (or the
command palette, `Ctrl/⌘ K`) to seed an example graph, then **Execute pipeline**.

### Environment variables

Real execution uses the Google AI Studio (Gemini) API. Copy the template and fill it in:

```bash
cp .env.example .env.local
```

| Variable              | Required | Description                                                              |
| --------------------- | -------- | ------------------------------------------------------------------------ |
| `GEMINI_API_KEY`      | No       | Google AI Studio key. When unset, execution falls back to the simulator. |
| `GEMINI_MODEL`        | No       | Override the Gemini model (default `gemini-3.1-flash-lite`).             |
| `NEXUS_AUTH_USER`     | No       | With `NEXUS_AUTH_PASSWORD`, enables the HTTP Basic access gate.          |
| `NEXUS_AUTH_PASSWORD` | No       | With `NEXUS_AUTH_USER`, enables the HTTP Basic access gate.              |

> **Security.** `GEMINI_API_KEY` is read **server-side only** (`process.env`) and is never
> prefixed with `NEXT_PUBLIC_`, so it is never shipped to the browser bundle. It is sent to
> Google via the `x-goog-api-key` header (not the URL) and is never logged. `.env.local` is
> gitignored; only the empty `.env.example` template is committed. **Never commit real keys.**

> **Access gate.** With both `NEXUS_AUTH_USER` and `NEXUS_AUTH_PASSWORD` set, every page and
> API request requires those HTTP Basic credentials; the browser prompts once. Setting only
> one of them refuses every request. Serve the app over HTTPS when the gate is enabled
> ([ADR 0009](docs/adr/0009-opt-in-basic-access-gate.md)).

## Scripts

| Script                  | Purpose                                |
| ----------------------- | -------------------------------------- |
| `npm run dev`           | Start the dev server                   |
| `npm run build`         | Production build                       |
| `npm run start`         | Serve the production build             |
| `npm run lint`          | ESLint (flat config, `eslint .`)       |
| `npm run type-check`    | `tsc --noEmit` (strict)                |
| `npm test`              | Run the Vitest suite                   |
| `npm run test:watch`    | Vitest in watch mode                   |
| `npm run test:coverage` | Vitest with a coverage gate (as in CI) |
| `npm run eval`          | Evaluate a dataset from the terminal   |

## Architecture

```text
src/
├── app/                  # App Router: layout, workspace page, run and evaluation stream routes
├── cli/                  # `npm run eval`: command-line evaluation runner
├── components/
│   ├── canvas/           # React Flow surface, custom node/edge, toolbar, palette
│   ├── evaluation/       # Evaluations dialog: dataset choice, results, history and comparison
│   ├── inspector/        # Telemetry, diagnostics, run history, editable config forms
│   ├── shared/           # Layout primitives + workspace chrome
│   └── ui/               # Low-level design-system primitives
├── config/               # Immutable registries (node kinds, telemetry/pricing, demo, datasets)
├── hooks/                # Persistence, history, shortcuts, auto-layout, manipulation
├── server/               # Server-only: pipeline engine, evaluation runner, LLM judge, Gemini client
├── services/             # Run and evaluation controllers (SSE lifecycle)
├── store/                # Zustand store: slices + combined store and selectors
├── test/                 # Test factories
├── types/                # Domain models (graph, execution contract)
└── utils/                # Pure functions: validation, telemetry, analysis, serialization
```

The rationale behind the major decisions is recorded as
[Architecture Decision Records](docs/adr/README.md).

### State

The store is composed from decoupled slices sharing one `set`/`get`:

- **`graphUi`** — nodes, edges, selection, and the React Flow change handlers. Owns the
  per-node telemetry write, which replaces only the changed node's reference so React Flow
  re-renders just that node, never the whole canvas.
- **`dataFlow`** — run lifecycle, streaming transport status, fault-injection rate, and
  run metric aggregation. Drives node telemetry through the graph-UI slice.
- **`history`** — undo/redo stacks. Snapshots are O(1) reference captures (the immutable
  update model makes this safe); a recorder hook coalesces edit bursts into single steps.

Components subscribe to the narrowest slice they need via selector hooks; deriving fresh
references in a selector without `useShallow` is what to avoid.

### Pure core

All non-trivial logic lives in framework-agnostic, side-effect-free modules under `utils/`
and is unit-tested in isolation: graph validation (cycle detection, topological order),
the telemetry reducer (with its token/cost/error invariants), critical-path analysis,
diagnostics, and (de)serialization. Run `npm test`.

### Execution backend

`POST /api/runs/stream` takes the graph as a JSON body and answers with a stream in
Server-Sent Events framing. It sequences the graph in topological levels — nodes within
a level are independent and run concurrently, at most four at a time — and emits
`TelemetryEvent` frames (one `running`, then `completed` or `failed`, per node) plus a
terminal `done` event. The client reads the stream with `fetch`, so prompts never travel
in a URL ([ADR 0008](docs/adr/0008-post-body-run-request.md)).

- **Real mode** (`GEMINI_API_KEY` set): LLM-backed nodes (`AGENT`, `LLM_CORE`, `CLASSIFIER`)
  call Gemini and report real latency, token usage, and output. Requests are retried with
  backoff on transient failures (429/5xx) and bounded by a per-attempt timeout.
- **Simulated mode** (no key): deterministic per-kind telemetry, so the app runs without
  credentials. The active mode is shown live in the toolbar (`Gemini` / `Simulated`).

Output flows downstream: each node's input is the concatenation of its predecessors'
outputs (a fixed seed for sources). A failed node marks its transitive descendants
`skipped`. `failRate` (toolbar) injects faults to exercise that propagation.

### Evaluations

A single run shows what one input did. An evaluation answers whether a prompt or model
change made the pipeline better or worse: it runs a fixed dataset of cases through the
pipeline and scores each one ([ADR 0010](docs/adr/0010-dataset-evaluations.md)).

Open it with **Evaluate** in the header, pick the bundled *Support triage* dataset (written
for the demo pipeline) or import your own JSON file, and run it. A dataset lists cases, and
each case checks the output of named nodes:

```json
{
  "version": 1,
  "name": "Support triage",
  "cases": [
    {
      "id": "billing-refund",
      "input": "How can I get a refund for my annual plan?",
      "checks": [
        { "nodeId": "demo-classifier", "scorer": "equals", "expected": "billing" },
        { "nodeId": "demo-formatter", "scorer": "contains", "expected": "refund" },
        { "nodeId": "demo-formatter", "scorer": "llm_judge", "criteria": "Explains how to request a refund.", "minScore": 4 }
      ]
    }
  ]
}
```

- **Scorers:** `equals`, `contains`, `oneOf` (on normalized text) and `regex` (run with RE2,
  so a pattern cannot hang the server) are deterministic. `llm_judge` asks the model to grade
  free text from 1 to 5 against the case's criteria and passes at `minScore` (default 4). The
  graded answer is fenced as untrusted data; every grade comes with its reason so it can be
  audited.
- **Server-side scoring:** `POST /api/evals/stream` runs the cases one at a time through the
  same engine as a run and scores the full outputs on the server, streaming each case as it
  finishes. One evaluation runs per server at a time, and a request is capped at 300 model
  calls (pipeline calls plus judge calls).
- **Results:** case and check pass rates, per-node and per-scorer breakdowns, the judge's mean
  grade, p50/p95 case latency, and cost. Grading cost is reported apart from the pipeline's.
- **Comparison:** the last 10 finished evaluations are kept in the browser with a fingerprint
  of the pipeline (prompts, labels, sampling, wiring), the dataset, and the model. Any two can
  be compared case by case — regressions, fixes, and checks that moved — with the differences
  between them labeled.

In simulated mode outputs are placeholders, so scores measure the harness rather than the
prompts, and judge checks are reported as skipped instead of counted. The panel says so.

#### From the terminal

`npm run eval` runs the same evaluation without the application: same engine, scorers,
judge, and limits. It reads the model settings from the environment or `.env.local`, prints
one line per case, and writes a Markdown and a JSON report to `eval-reports/` (ignored by
git). The JSON keeps every check's full output; the Markdown lists each failing check with
the output it inspected.

```bash
npm run eval                                            # bundled dataset, demo pipeline
npm run eval -- --graph my-pipeline.json --dataset cases.json --fail-under 90
```

`--graph` takes a file exported from the editor, `--dataset` a bundled dataset id or a file,
and `--simulate` forces the simulator. `--fail-under` turns the case pass rate into an exit
code, so an evaluation can gate a change in CI. Exit codes: `0` done, `1` below the gate or
failed, `2` invalid input, `130` interrupted. Ctrl+C abandons the case in progress and still
writes the report of the cases scored so far.

## Features

- **Editing:** typed, per-variant configuration forms; cross-node `llmCoreRef` binding.
- **Diagnostics:** cycles, dangling/unbound references, incomplete config, template
  variable mismatches — click a finding to focus the node.
- **Run telemetry:** per-node state/latency/tokens/cost, aggregate run metrics including
  **critical-path latency** (longest dependency path) vs. cumulative compute time, and a
  capped run history.
- **Persistence:** the graph auto-saves to `localStorage` and survives reloads; import/export
  as JSON. Telemetry is never persisted (it is execution state, rehydrated to pristine).
- **Auto-layout:** topological layer layout.
- **Evaluations:** run a dataset of test cases against the pipeline, score outputs with
  deterministic checks or an LLM judge, and compare evaluations across prompt and model changes,
  from the UI or from the terminal with Markdown and JSON reports.
- **Observability:** export any recorded run as an **OpenTelemetry (OTLP/JSON) trace** — a root
  span for the run and a child span per node, with token/cost/latency attributes — ingestible by
  Jaeger, Tempo, or Grafana.

### Keyboard shortcuts

| Shortcut                 | Action                       |
| ------------------------ | ---------------------------- |
| `Ctrl/⌘ K`               | Command palette / node search|
| `Delete` / `Backspace`   | Delete selection             |
| `Esc`                    | Clear selection              |
| `Ctrl/⌘ D`               | Duplicate selected nodes     |
| `Ctrl/⌘ S`               | Export pipeline              |
| `Ctrl/⌘ Z`               | Undo                         |
| `Ctrl/⌘ Shift Z` / `Ctrl Y` | Redo                      |

Shortcuts are suppressed while typing in a field.

## Notes & limitations

- Cost figures (`MODEL_PRICING`, `GEMINI_PRICING` in `src/config/telemetry.ts`) are
  **estimates**; reconcile them with the provider's rate card before relying on them.
- An LLM Core's sampling settings apply to the core itself and to every Agent or Classifier
  bound to it through `llmCoreRef`. Its `provider`/`model` are informational — real
  execution uses the server-side `GEMINI_MODEL`.
- A run request is capped at 1 MB and 200 nodes; larger requests are rejected with `413`.
  An evaluation request is capped at 2.5 MB, 100 cases, and 300 model calls; a second
  concurrent evaluation is rejected with `429`. `npm run eval` applies the same case and
  model-call limits.
- LLM-judge grades are noisy and can be biased. Treat them as a signal to review, not a verdict.
- SSE on serverless platforms may hit request-duration limits; local `npm run dev` is unaffected.
- Each run can incur real API cost. Before exposing the app publicly, enable the access gate
  (`NEXUS_AUTH_USER` / `NEXUS_AUTH_PASSWORD`) and serve it over HTTPS. The gate is a single
  shared credential, not a user system.

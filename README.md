# Nexus AI Orchestrator

A production-grade, visual node-based debugger for multi-agent AI pipelines. It lets
engineers compose a pipeline as a graph, trace execution flow, inspect data payloads,
and analyze per-node telemetry — latency, token consumption, and cost — across the run.

Execution runs against a real backend (Google AI Studio / Gemini) when a key is
configured, and falls back to a built-in deterministic simulator otherwise, so the
application is fully functional with or without credentials.

## Tech stack

- **Framework:** Next.js 14 (App Router)
- **Language:** TypeScript (strict: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, etc.)
- **Graph engine:** React Flow (`@xyflow/react` v12)
- **State:** Zustand (slice-based)
- **UI:** Tailwind CSS + Radix UI (Shadcn-style primitives)
- **Tests:** Vitest

## Getting started

Requires **Node.js 20+**.

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

| Variable          | Required | Description                                                                 |
| ----------------- | -------- | --------------------------------------------------------------------------- |
| `GEMINI_API_KEY`  | No       | Google AI Studio key. When unset, execution falls back to the simulator.    |
| `GEMINI_MODEL`    | No       | Override the Gemini model (default `gemini-2.0-flash`).                      |

> **Security.** `GEMINI_API_KEY` is read **server-side only** (`process.env`) and is never
> prefixed with `NEXT_PUBLIC_`, so it is never shipped to the browser bundle. It is sent to
> Google via the `x-goog-api-key` header (not the URL) and is never logged. `.env.local` is
> gitignored; only the empty `.env.example` template is committed. **Never commit real keys.**

## Scripts

| Script               | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `npm run dev`        | Start the dev server                     |
| `npm run build`      | Production build                         |
| `npm run start`      | Serve the production build               |
| `npm run lint`       | ESLint (`next lint`)                     |
| `npm run type-check` | `tsc --noEmit` (strict)                  |
| `npm test`           | Run the Vitest suite                     |
| `npm run test:watch` | Vitest in watch mode                     |

## Architecture

```text
src/
├── app/                  # App Router: layout, workspace page, /api/runs/stream route
├── components/
│   ├── canvas/           # React Flow surface, custom node/edge, toolbar, palette
│   ├── inspector/        # Telemetry, diagnostics, run history, editable config forms
│   ├── shared/           # Layout primitives + workspace chrome
│   └── ui/               # Low-level design-system primitives
├── config/               # Immutable registries (node kinds, telemetry/pricing, demo)
├── hooks/                # Persistence, history, shortcuts, auto-layout, manipulation
├── server/               # Server-only modules (Gemini client) — never imported client-side
├── services/             # Run execution controller (SSE lifecycle)
├── store/                # Zustand store: slices + combined store and selectors
├── test/                 # Test factories
├── types/                # Domain models (graph, execution contract)
└── utils/                # Pure functions: validation, telemetry, analysis, serialization
```

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

`GET /api/runs/stream` is a Server-Sent Events endpoint that sequences the graph in
topological order and streams `TelemetryEvent` frames (one `running`, then `completed` or
`failed`, per node) plus a terminal `done` event.

- **Real mode** (`GEMINI_API_KEY` set): LLM-backed nodes (`AGENT`, `LLM_CORE`, `CLASSIFIER`)
  call Gemini and report real latency, token usage, and output. Requests are retried with
  backoff on transient failures (429/5xx) and bounded by a per-attempt timeout.
- **Simulated mode** (no key): deterministic per-kind telemetry, so the app runs without
  credentials. The active mode is shown live in the toolbar (`Gemini` / `Simulated`).

Output flows downstream: each node's input is the concatenation of its predecessors'
outputs (a fixed seed for sources). A failed node marks its transitive descendants
`skipped`. `failRate` (toolbar) injects faults to exercise that propagation.

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
- A node's configured `provider`/`model` is currently informational — real execution uses
  the server-side `GEMINI_MODEL`.
- The graph descriptor travels in the SSE URL query string; very large graphs/prompts would
  exceed URL limits. The intended evolution is a POST-to-start + GET-by-id handshake.
- SSE on serverless platforms may hit request-duration limits; local `npm run dev` is unaffected.
- The execution endpoint is unauthenticated; add a gate before exposing it publicly, since
  each run can incur real API cost.

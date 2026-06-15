# 1. Slice-based Zustand store with reference-preserving updates

- Status: Accepted
- Date: 2026-06-15

## Context

The application holds global state — the React Flow node/edge arrays, selection,
pipeline runs, and per-node telemetry — that changes at high frequency: during a run,
telemetry streams in one node at a time. The canvas may contain many nodes, and React
Flow re-renders a node only when its node object (or its `data`) reference changes.
A naive "replace the whole nodes array with fresh objects" update on every telemetry
tick would re-render every node on the canvas.

## Decision

Use a single Zustand store composed of decoupled **slices** (`graphUi`, `dataFlow`,
`history`) that share one `set`/`get`. Telemetry lives on `node.data.telemetry`.

The canonical per-node write, `updateNodeTelemetry`, maps the nodes array but returns
the **same object reference** for every untouched node and a new object only for the
changed node (`mapNodeById`). An unknown id resolves to a no-op that preserves the
array reference. Components subscribe through narrow selector hooks (`useShallow`
where a derived value is returned).

## Consequences

- A telemetry tick re-renders only the affected node and the inspector — never the
  whole canvas.
- Slices keep concerns isolated at authoring time while coordinating at runtime via
  the shared `get()` (e.g. the data-flow slice drives the graph-UI slice's telemetry write).
- Contributors must preserve the immutable-reference discipline; this is documented in
  code and locked by the store unit tests (sibling identity assertions).
- Selectors must not derive fresh array/object references without `useShallow`, or the
  reference-equality bail-out is defeated.

## Alternatives considered

- **Redux Toolkit** — more boilerplate; the immutable-update guarantee is similar.
- **React Context** — re-renders all consumers on any change; unsuitable for high-frequency telemetry.
- **Telemetry in a side map keyed by node id** — decouples telemetry from `node.data`,
  but complicates React Flow data binding and the inspector, and still needs careful
  reference handling for selective rendering.

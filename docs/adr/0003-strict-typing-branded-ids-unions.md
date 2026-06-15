# 3. Strict TypeScript: branded identifiers and discriminated unions

- Status: Accepted
- Date: 2026-06-15

## Context

The domain manipulates many string identifiers (node, edge, run) and five
heterogeneous node variants, each with its own configuration. Two bug classes are
likely: passing the wrong id kind into a function, and mishandling a node variant
(e.g. forgetting one in a switch).

## Decision

- Enable strict mode plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, and `noPropertyAccessFromIndexSignature`.
- Brand the identifiers: `NodeId`, `EdgeId`, `RunId` are nominal `string` subtypes with
  explicit `as*` constructors used only at boundaries (React Flow exposes `id` as plain `string`).
- Model node variants as a discriminated union derived from a `NODE_KIND` const map,
  with a compile-time coverage assertion that breaks if a kind and its data type drift.
- Declare node/edge `data` payloads as `type` aliases (not `interface`): React Flow's
  generic constrains data to `Record<string, unknown>`, which type-alias object literals
  satisfy via an implicit index signature but interfaces do not.
- Accept a few localized correlated-union casts where TypeScript cannot prove that a
  generic kind `K` corresponds to its union member; they are confined to factories and documented.

## Consequences

- Whole classes of bugs are caught at compile time; switches over node kinds are
  exhaustively checked.
- `noUncheckedIndexedAccess` forces explicit handling of "maybe absent" lookups, which
  matches the defensive-parsing posture at trust boundaries.
- Branded ids require explicit construction at boundaries — a deliberate, visible seam.
- A handful of documented casts remain; they are the pragmatic cost of correlated unions.

## Alternatives considered

- **Plain `string` ids** — zero safety against id mixing.
- **TS `enum`** — produces a runtime artifact and weaker ergonomics than a const map + union.
- **Runtime schema validation everywhere (e.g. Zod)** — runtime cost on hot paths; we
  instead validate only at trust boundaries (the wire parsers) with small type guards.

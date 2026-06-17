# 7. LLM execution behind a provider port (ports & adapters)

- Status: Accepted
- Date: 2026-06-15

## Context

The execution route initially called the Gemini client directly. That coupled the
engine to one vendor, made the node's configured `provider`/`model` purely
informational, and meant cost/pricing logic lived in the route. Supporting another
backend (OpenAI, Anthropic, a self-hosted model, or a test double) would have meant
editing the engine.

## Decision

Apply ports & adapters (hexagonal). Define an `LlmProvider` **port** that the engine
depends on exclusively. A provider is a *configured model endpoint* that owns its
model id, its token pricing, and its credentials; the per-call request carries only
the prompt and sampling parameters.

- Port: `src/server/llm/types.ts` (`LlmProvider`, `LlmGenerateRequest`,
  `LlmGenerateResult`, `LlmError`).
- Adapter: `src/server/llm/geminiProvider.ts` implements the port (fetch, retries,
  timeout, defensive response parsing, pricing).
- Resolution: `src/server/llm/resolveProvider.ts` selects the active provider from the
  server environment, returning `null` when none is configured (the engine's signal to
  use the deterministic simulator).

The route now calls `provider.generate(...)` and attributes cost via
`provider.pricing`; it never imports a vendor SDK.

## Consequences

- Adding a backend is additive: write an adapter and select it in the resolver — no
  change to the engine.
- The Gemini response parser is a pure, exported function, unit-tested without the network.
- Cost attribution is owned by the provider, removing a vendor constant from the route.
- The simulator fallback is expressed cleanly as "no provider resolved".
- A small indirection is added for the single provider that exists today — an
  intentional trade-off for extensibility and testability.

## Alternatives considered

- **Call the Gemini SDK/client directly from the route** — simplest, but couples the
  engine to one vendor and scatters pricing/credentials into the route.
- **A runtime plugin registry** — more flexible but over-engineered for a small, known
  set of providers selected by environment.

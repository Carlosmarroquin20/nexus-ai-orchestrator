# Architecture Decision Records

This directory captures the significant architectural decisions for Nexus AI
Orchestrator, in [Michael Nygard's ADR format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
Each record states the context, the decision, and its consequences (including the
alternatives weighed), so the reasoning behind the codebase is explicit and reviewable.

| #                                                        | Decision                                                       | Status   |
| -------------------------------------------------------- | -------------------------------------------------------------- | -------- |
| [0001](0001-slice-store-reference-preserving-updates.md) | Slice-based Zustand store with reference-preserving updates    | Accepted |
| [0002](0002-framework-agnostic-pure-core.md)             | Layered architecture with a framework-agnostic pure core       | Accepted |
| [0003](0003-strict-typing-branded-ids-unions.md)         | Strict TypeScript: branded identifiers and discriminated unions | Accepted |
| [0004](0004-telemetry-is-execution-state.md)             | Telemetry is execution state, not document state               | Accepted |
| [0005](0005-server-streamed-dual-execution-backend.md)   | Execution as a server-streamed dual backend (Gemini + simulator) | Accepted |
| [0006](0006-verification-strategy.md)                    | Verification strategy independent of manual QA                 | Accepted |

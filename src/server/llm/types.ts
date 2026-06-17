/**
 * LLM provider port (hexagonal architecture).
 *
 * The execution engine depends only on this interface, never on a concrete SDK.
 * Each backend (Gemini today; OpenAI/Anthropic/a mock tomorrow) ships an adapter
 * that implements `LlmProvider`. A provider is a *configured model endpoint*: it
 * owns its model id, its pricing, and its credentials — the per-call request only
 * carries the prompt and sampling parameters.
 *
 * Server-only: implementations hold credentials and must never be imported by a
 * client component.
 */

import type { TokenPricing } from '@/config/telemetry';

export interface LlmGenerateRequest {
  readonly prompt: string;
  readonly systemInstruction?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface LlmGenerateResult {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

export interface LlmProvider {
  /** Stable provider identifier, e.g. `'gemini'`. */
  readonly id: string;
  /** Resolved model id this provider targets. */
  readonly model: string;
  /** Token pricing for cost attribution; owned by the provider, not the engine. */
  readonly pricing: TokenPricing;
  generate(request: LlmGenerateRequest): Promise<LlmGenerateResult>;
}

/** Transport/generation failure raised by an adapter. `status` mirrors HTTP semantics. */
export class LlmError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

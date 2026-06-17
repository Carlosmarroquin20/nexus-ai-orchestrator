/**
 * Resolves the active LLM provider from the server environment. Returns `null`
 * when no provider is configured, which the execution engine treats as the
 * deterministic simulator fallback.
 *
 * Adding a provider is additive: implement the {@link LlmProvider} port in a new
 * adapter and select it here based on its own env var — no change to the engine.
 */

import { createGeminiProvider } from './geminiProvider';
import type { LlmProvider } from './types';

const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

export const resolveLlmProvider = (): LlmProvider | null => {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    return createGeminiProvider({ apiKey, model: process.env['GEMINI_MODEL'] ?? DEFAULT_GEMINI_MODEL });
  }
  return null;
};

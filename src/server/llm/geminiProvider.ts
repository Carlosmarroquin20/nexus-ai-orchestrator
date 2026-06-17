/**
 * Google AI Studio (Gemini) adapter for the {@link LlmProvider} port.
 *
 * SECURITY: the API key is held by the adapter (constructed from a server env var)
 * and sent via the `x-goog-api-key` header — never in the URL/query (which can
 * leak into logs). It is never logged or returned. Server-only.
 *
 * Resilience: each attempt is bounded by a timeout combined with the caller's
 * cancellation signal; transient failures (429/5xx, network) retry with
 * exponential backoff + jitter (honoring `Retry-After`), while caller aborts,
 * timeouts, and non-retryable errors fail fast.
 */

import { GEMINI_PRICING } from '@/config/telemetry';
import { isFiniteNumber, isRecord, isString } from '@/utils/guards';

import { LlmError, type LlmGenerateRequest, type LlmGenerateResult, type LlmProvider } from './types';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const RETRYABLE_STATUSES = new Set<number>([429, 500, 502, 503, 504]);

/** `finishReason` values that mean the generation was suppressed, not completed. */
const BLOCKED_FINISH_REASONS = new Set<string>([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
]);

const firstCandidate = (json: unknown): Record<string, unknown> | null => {
  if (!isRecord(json) || !Array.isArray(json['candidates'])) return null;
  const first = json['candidates'][0];
  return isRecord(first) ? first : null;
};

const extractText = (candidate: Record<string, unknown>): string => {
  const content = candidate['content'];
  if (!isRecord(content) || !Array.isArray(content['parts'])) return '';
  return content['parts']
    .map((part) => (isRecord(part) && isString(part['text']) ? part['text'] : ''))
    .join('');
};

const extractUsage = (json: unknown): { inputTokens: number; outputTokens: number } => {
  if (!isRecord(json)) return { inputTokens: 0, outputTokens: 0 };
  const meta = json['usageMetadata'];
  if (!isRecord(meta)) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: isFiniteNumber(meta['promptTokenCount']) ? meta['promptTokenCount'] : 0,
    outputTokens: isFiniteNumber(meta['candidatesTokenCount']) ? meta['candidatesTokenCount'] : 0,
  };
};

const extractBlockReason = (json: unknown): string | null => {
  if (!isRecord(json) || !isRecord(json['promptFeedback'])) return null;
  const reason = json['promptFeedback']['blockReason'];
  return isString(reason) ? reason : null;
};

/**
 * Pure parse of a Gemini `generateContent` response into a provider result.
 * Throws {@link LlmError} (422) on a suppressed generation (prompt block / safety
 * finish reason). Exported for unit testing without the network.
 */
export const parseGeminiResponse = (json: unknown, latencyMs: number): LlmGenerateResult => {
  const candidate = firstCandidate(json);
  if (candidate === null) {
    const blockReason = extractBlockReason(json);
    throw new LlmError(
      blockReason !== null ? `Gemini blocked the prompt (${blockReason}).` : 'Gemini returned no candidates.',
      422,
    );
  }
  const finishReason = isString(candidate['finishReason']) ? candidate['finishReason'] : null;
  if (finishReason !== null && BLOCKED_FINISH_REASONS.has(finishReason)) {
    throw new LlmError(`Gemini suppressed the output (${finishReason}).`, 422);
  }
  const { inputTokens, outputTokens } = extractUsage(json);
  return { text: extractText(candidate), inputTokens, outputTokens, latencyMs };
};

const abortableDelay = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

const backoffMs = (attempt: number, retryAfterHeader: string | null): number => {
  const retryAfterSeconds = retryAfterHeader !== null ? Number(retryAfterHeader) : Number.NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS);
  }
  const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.min(exponential + Math.floor(Math.random() * BASE_BACKOFF_MS), MAX_BACKOFF_MS);
};

const callGemini = async (
  apiKey: string,
  model: string,
  request: LlmGenerateRequest,
): Promise<LlmGenerateResult> => {
  const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`;
  const generationConfig: Record<string, unknown> = {
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
  };
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
    generationConfig,
    ...(request.systemInstruction !== undefined && request.systemInstruction.length > 0
      ? { systemInstruction: { parts: [{ text: request.systemInstruction }] } }
      : {}),
  });
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };

  let lastError: LlmError = new LlmError('Gemini request failed.', 0);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal =
      request.signal !== undefined ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;

    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: payload, signal });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new LlmError(`Gemini request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`, 408);
      }
      if (error instanceof Error && error.name === 'AbortError') throw error;
      lastError = new LlmError('Network error contacting Gemini.', 0);
      if (attempt < MAX_ATTEMPTS) {
        await abortableDelay(backoffMs(attempt, null), request.signal);
        continue;
      }
      throw lastError;
    }
    const latencyMs = Date.now() - started;

    if (response.ok) {
      return parseGeminiResponse((await response.json()) as unknown, latencyMs);
    }

    const detail = await response.text().catch(() => '');
    lastError = new LlmError(`Gemini API error ${response.status}: ${detail.slice(0, 200)}`, response.status);
    if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
      await abortableDelay(backoffMs(attempt, response.headers.get('retry-after')), request.signal);
      continue;
    }
    throw lastError;
  }

  throw lastError;
};

export interface GeminiProviderConfig {
  readonly apiKey: string;
  readonly model: string;
}

/** Constructs a Gemini-backed {@link LlmProvider}. */
export const createGeminiProvider = (config: GeminiProviderConfig): LlmProvider => ({
  id: 'gemini',
  model: config.model,
  pricing: GEMINI_PRICING,
  generate: (request) => callGemini(config.apiKey, config.model, request),
});

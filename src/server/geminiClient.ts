/**
 * Minimal server-only Google AI Studio (Gemini) client over the REST API.
 *
 * SECURITY: the API key is supplied by the caller from a server-side env var and
 * sent via the `x-goog-api-key` header — never in the URL/query string (which can
 * leak into access logs). It is never logged, never returned, and this module
 * must only be imported from server code (route handlers), never from a client
 * component. The error body surfaced on failure is provider-originated and does
 * not contain the key, but is truncated regardless.
 */

import { isFiniteNumber, isRecord, isString } from '@/utils/guards';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiRequest {
  readonly apiKey: string;
  readonly model: string;
  readonly prompt: string;
  readonly systemInstruction?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface GeminiResult {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

export class GeminiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

const extractText = (json: unknown): string => {
  if (!isRecord(json) || !Array.isArray(json['candidates'])) return '';
  const first = json['candidates'][0];
  if (!isRecord(first)) return '';
  const content = first['content'];
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

/** Calls `generateContent` and returns the response text plus real token usage and latency. */
export const generateWithGemini = async (request: GeminiRequest): Promise<GeminiResult> => {
  const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(request.model)}:generateContent`;

  const generationConfig: Record<string, unknown> = {
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
  };
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
    generationConfig,
    ...(request.systemInstruction !== undefined && request.systemInstruction.length > 0
      ? { systemInstruction: { parts: [{ text: request.systemInstruction }] } }
      : {}),
  };

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': request.apiKey },
      body: JSON.stringify(body),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
  } catch {
    throw new GeminiError('Network error contacting Gemini.', 0);
  }
  const latencyMs = Date.now() - started;

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new GeminiError(`Gemini API error ${response.status}: ${detail.slice(0, 200)}`, response.status);
  }

  const json = (await response.json()) as unknown;
  const { inputTokens, outputTokens } = extractUsage(json);
  return { text: extractText(json), inputTokens, outputTokens, latencyMs };
};

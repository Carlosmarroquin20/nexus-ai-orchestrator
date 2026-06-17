import { describe, expect, it } from 'vitest';

import { parseGeminiResponse } from '@/server/llm/geminiProvider';
import { LlmError } from '@/server/llm/types';

describe('parseGeminiResponse', () => {
  it('extracts text and token usage from a well-formed response', () => {
    const result = parseGeminiResponse(
      {
        candidates: [
          { content: { parts: [{ text: 'Hello ' }, { text: 'world' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 },
      },
      250,
    );
    expect(result).toEqual({ text: 'Hello world', inputTokens: 12, outputTokens: 7, latencyMs: 250 });
  });

  it('defaults token usage to zero when absent', () => {
    const result = parseGeminiResponse(
      { candidates: [{ content: { parts: [{ text: 'hi' }] } }] },
      10,
    );
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('throws LlmError(422) when the prompt was blocked', () => {
    expect(() => parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }, 5)).toThrow(LlmError);
    try {
      parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }, 5);
    } catch (error) {
      expect((error as LlmError).status).toBe(422);
      expect((error as LlmError).message).toContain('SAFETY');
    }
  });

  it('throws LlmError(422) on a suppressed finish reason', () => {
    expect(() =>
      parseGeminiResponse({ candidates: [{ content: { parts: [] }, finishReason: 'RECITATION' }] }, 5),
    ).toThrow(LlmError);
  });

  it('throws LlmError(422) when there are no candidates', () => {
    expect(() => parseGeminiResponse({}, 5)).toThrow(LlmError);
  });
});

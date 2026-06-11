import { describe, expect, it } from 'vitest';

import { makeEdge, makeNode } from '@/test/factories';
import { NODE_KIND } from '@/types/graph';
import { analyzeGraph, extractTemplateVariables } from '@/utils/graphDiagnostics';

describe('extractTemplateVariables', () => {
  it('extracts unique interpolation variables', () => {
    expect(extractTemplateVariables('Hi {{name}}, {{ name }} from {{ place }}').sort()).toEqual([
      'name',
      'place',
    ]);
  });

  it('returns empty when there are no variables', () => {
    expect(extractTemplateVariables('no variables here')).toEqual([]);
  });
});

describe('analyzeGraph', () => {
  it('reports nothing for a clean, fully-configured graph', () => {
    const llm = makeNode({ id: 'llm', kind: NODE_KIND.LLM_CORE, config: { model: 'claude-sonnet-4-6' } });
    const agent = makeNode({
      id: 'agent',
      kind: NODE_KIND.AGENT,
      config: { systemPrompt: 'do the thing', llmCoreRef: 'llm' },
    });
    expect(analyzeGraph([llm, agent], [makeEdge('llm', 'agent')])).toHaveLength(0);
  });

  it('flags a cycle', () => {
    const a = makeNode({ id: 'a', kind: NODE_KIND.PROMPT_TEMPLATE, config: { template: 't {{x}}', inputVariables: ['x'] } });
    const b = makeNode({ id: 'b', kind: NODE_KIND.PROMPT_TEMPLATE, config: { template: 't {{x}}', inputVariables: ['x'] } });
    const diagnostics = analyzeGraph([a, b], [makeEdge('a', 'b'), makeEdge('b', 'a')]);
    expect(diagnostics.some((d) => d.code === 'CYCLE')).toBe(true);
  });

  it('flags a dangling llmCoreRef', () => {
    const agent = makeNode({ id: 'agent', kind: NODE_KIND.AGENT, config: { systemPrompt: 'x', llmCoreRef: 'ghost' } });
    expect(analyzeGraph([agent], []).some((d) => d.code === 'INVALID_LLM_REF')).toBe(true);
  });

  it('flags an unbound agent with an empty system prompt', () => {
    const agent = makeNode({ id: 'agent', kind: NODE_KIND.AGENT, config: { systemPrompt: '', llmCoreRef: null } });
    const codes = analyzeGraph([agent], []).map((d) => d.code);
    expect(codes).toContain('UNBOUND_LLM_CORE');
    expect(codes).toContain('EMPTY_SYSTEM_PROMPT');
  });

  it('flags undeclared template variables', () => {
    const template = makeNode({
      id: 't',
      kind: NODE_KIND.PROMPT_TEMPLATE,
      config: { template: 'Hi {{name}}', inputVariables: [] },
    });
    expect(analyzeGraph([template], []).some((d) => d.code === 'UNDECLARED_VARS')).toBe(true);
  });

  it('orders errors before warnings', () => {
    const agent = makeNode({ id: 'agent', kind: NODE_KIND.AGENT, config: { systemPrompt: '', llmCoreRef: 'ghost' } });
    const sink = makeNode({ id: 'sink', kind: NODE_KIND.VECTOR_DB });
    const diagnostics = analyzeGraph([agent, sink], [makeEdge('agent', 'sink')]);
    const firstError = diagnostics.findIndex((d) => d.severity === 'error');
    const firstWarning = diagnostics.findIndex((d) => d.severity === 'warning');
    expect(firstError).toBeGreaterThanOrEqual(0);
    expect(firstWarning).toBeGreaterThan(firstError);
  });
});

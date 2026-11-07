import { describe, expect, it } from 'vitest';

import { createDemoPipeline } from '@/config/demoPipeline';
import { makeEdge, makeNode } from '@/test/factories';
import { NODE_KIND } from '@/types/graph';
import { buildExecutionDescriptor } from '@/utils/executionDescriptor';

const core = makeNode({
  id: 'core',
  kind: NODE_KIND.LLM_CORE,
  config: { temperature: 0.2, maxOutputTokens: 512 },
});

const paramsOf = (descriptor: ReturnType<typeof buildExecutionDescriptor>, id: string) =>
  descriptor.nodes.find((node) => node.id === id)!.params;

describe('buildExecutionDescriptor', () => {
  it('gives an agent the sampling settings of its bound LLM core', () => {
    const agent = makeNode({
      id: 'agent',
      kind: NODE_KIND.AGENT,
      config: { systemPrompt: 'be brief', llmCoreRef: 'core' },
    });
    expect(paramsOf(buildExecutionDescriptor([core, agent], []), 'agent')).toEqual({
      systemPrompt: 'be brief',
      temperature: 0.2,
      maxOutputTokens: 512,
    });
  });

  it('gives a classifier the sampling settings of its bound LLM core', () => {
    const classifier = makeNode({
      id: 'classifier',
      kind: NODE_KIND.CLASSIFIER,
      config: { labels: ['a', 'b'], llmCoreRef: 'core' },
    });
    expect(paramsOf(buildExecutionDescriptor([core, classifier], []), 'classifier')).toEqual({
      labels: ['a', 'b'],
      temperature: 0.2,
      maxOutputTokens: 512,
    });
  });

  it('sends no sampling settings for an unbound, dangling, or wrongly typed reference', () => {
    const other = makeNode({ id: 'other', kind: NODE_KIND.VECTOR_DB });
    const agent = (id: string, llmCoreRef: string | null) =>
      makeNode({ id, kind: NODE_KIND.AGENT, config: { systemPrompt: 'x', llmCoreRef } });
    const descriptor = buildExecutionDescriptor(
      [core, other, agent('unbound', null), agent('dangling', 'ghost'), agent('wrong', 'other')],
      [],
    );
    for (const id of ['unbound', 'dangling', 'wrong']) {
      expect(paramsOf(descriptor, id)).toEqual({ systemPrompt: 'x' });
    }
  });

  it('projects the remaining kinds and the edges unchanged', () => {
    const template = makeNode({
      id: 'template',
      kind: NODE_KIND.PROMPT_TEMPLATE,
      config: { template: 'Q: {{q}}' },
    });
    const store = makeNode({ id: 'store', kind: NODE_KIND.VECTOR_DB });
    const descriptor = buildExecutionDescriptor(
      [core, template, store],
      [makeEdge('store', 'template')],
    );
    expect(descriptor.nodes.map((node) => node.kind)).toEqual([
      NODE_KIND.LLM_CORE,
      NODE_KIND.PROMPT_TEMPLATE,
      NODE_KIND.VECTOR_DB,
    ]);
    expect(paramsOf(descriptor, 'core')).toEqual({ temperature: 0.2, maxOutputTokens: 512 });
    expect(paramsOf(descriptor, 'template')).toEqual({ template: 'Q: {{q}}' });
    expect(paramsOf(descriptor, 'store')).toEqual({});
    expect(descriptor.edges).toEqual([{ source: 'store', target: 'template' }]);
  });

  it('resolves every binding in the demo pipeline', () => {
    const { nodes, edges } = createDemoPipeline();
    const descriptor = buildExecutionDescriptor(nodes, edges);
    for (const node of descriptor.nodes) {
      if (node.kind === NODE_KIND.AGENT || node.kind === NODE_KIND.CLASSIFIER) {
        expect(node.params?.temperature).toBeTypeOf('number');
        expect(node.params?.maxOutputTokens).toBeTypeOf('number');
      }
    }
  });
});

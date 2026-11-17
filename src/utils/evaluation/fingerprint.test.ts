import { describe, expect, it } from 'vitest';

import type { ExecutionDescriptor } from '@/types/execution';
import { NODE_KIND } from '@/types/graph';
import type { EvalDataset } from '@/utils/evaluation/dataset';
import {
  canonicalJson,
  datasetFingerprint,
  fnv1a64,
  pipelineFingerprint,
} from '@/utils/evaluation/fingerprint';

const descriptor: ExecutionDescriptor = {
  nodes: [
    { id: 'tpl', kind: NODE_KIND.PROMPT_TEMPLATE, params: { template: 'Q: {{input}}' } },
    { id: 'core', kind: NODE_KIND.LLM_CORE, params: { temperature: 0.2, maxOutputTokens: 256, topP: 0.9 } },
    {
      id: 'cls',
      kind: NODE_KIND.CLASSIFIER,
      params: { labels: ['billing', 'technical'], temperature: 0.2, maxOutputTokens: 256, topP: 0.9 },
    },
  ],
  edges: [
    { source: 'tpl', target: 'cls' },
    { source: 'core', target: 'cls' },
  ],
};

const dataset: EvalDataset = {
  version: 1,
  name: 'Smoke',
  cases: [{ id: 'a', input: 'hi', checks: [{ scorer: 'equals', nodeId: 'cls', expected: 'billing' }] }],
};

describe('canonicalJson', () => {
  it('sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });

  it('drops undefined members like JSON.stringify', () => {
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
  });
});

describe('fnv1a64', () => {
  it('matches the published FNV-1a 64-bit test vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });
});

describe('pipelineFingerprint', () => {
  it('is a 16-digit hex digest', () => {
    expect(pipelineFingerprint(descriptor)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ignores node, edge, and key order', () => {
    const reordered: ExecutionDescriptor = {
      nodes: [...descriptor.nodes]
        .reverse()
        // Same members, inserted in reverse key order.
        .map((node) => Object.fromEntries(Object.entries(node).reverse()) as typeof node),
      edges: [...descriptor.edges].reverse(),
    };
    expect(pipelineFingerprint(reordered)).toBe(pipelineFingerprint(descriptor));
  });

  it('changes with any prompt, label, sampling, or wiring change', () => {
    const base = pipelineFingerprint(descriptor);
    const withParams = (id: string, patch: Record<string, unknown>): ExecutionDescriptor => ({
      ...descriptor,
      nodes: descriptor.nodes.map((node) =>
        node.id === id ? { ...node, params: { ...node.params, ...patch } } : node,
      ),
    });
    const variants: ExecutionDescriptor[] = [
      withParams('tpl', { template: 'Q:{{input}}' }),
      withParams('cls', { labels: ['technical', 'billing'] }),
      withParams('core', { temperature: 0.3 }),
      { ...descriptor, edges: [{ source: 'tpl', target: 'cls' }] },
    ];
    const fingerprints = variants.map(pipelineFingerprint);
    expect(fingerprints).not.toContain(base);
    expect(new Set(fingerprints).size).toBe(variants.length);
  });
});

describe('datasetFingerprint', () => {
  it('is stable for equal datasets and changes with any expectation', () => {
    expect(datasetFingerprint(structuredClone(dataset))).toBe(datasetFingerprint(dataset));
    const changed: EvalDataset = {
      ...dataset,
      cases: [{ ...dataset.cases[0]!, checks: [{ scorer: 'equals', nodeId: 'cls', expected: 'technical' }] }],
    };
    expect(datasetFingerprint(changed)).not.toBe(datasetFingerprint(dataset));
  });
});

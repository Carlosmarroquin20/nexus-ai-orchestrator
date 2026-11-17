import { describe, expect, it } from 'vitest';

import { createDemoPipeline } from '@/config/demoPipeline';
import { BUNDLED_DATASETS } from '@/config/evalDatasets';
import { findUnknownNodeIds, parseEvalDataset } from '@/utils/evaluation/dataset';

describe('BUNDLED_DATASETS', () => {
  it.each(BUNDLED_DATASETS.map((entry) => [entry.id, entry.raw] as const))(
    '%s parses and only references nodes of the demo pipeline',
    (_id, raw) => {
      const result = parseEvalDataset(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const demoNodeIds = new Set(createDemoPipeline().nodes.map((node) => node.id));
      expect(findUnknownNodeIds(result.dataset, demoNodeIds)).toEqual([]);
      // The client sends the parsed dataset; the server must read it back unchanged.
      expect(parseEvalDataset(JSON.parse(JSON.stringify(result.dataset)))).toEqual(result);
    },
  );

  it('uses unique ids', () => {
    const ids = BUNDLED_DATASETS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

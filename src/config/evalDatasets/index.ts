/**
 * Datasets shipped with the application, offered by the evaluations panel next
 * to importing a file (ADR 0010).
 *
 * Entries hold the raw JSON, not a parsed dataset: bundled and imported datasets
 * go through the same `parseEvalDataset`, so a bundled file gets no validation
 * shortcut. A test keeps every entry valid and aligned with the demo pipeline.
 */

import supportTriage from './support-triage.json';

export interface BundledDataset {
  /** Stable key for selection; not shown to the user. */
  readonly id: string;
  readonly raw: unknown;
}

export const BUNDLED_DATASETS: readonly BundledDataset[] = [{ id: 'support-triage', raw: supportTriage }];

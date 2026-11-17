/**
 * Configuration fingerprints for comparable evaluations (ADR 0010).
 *
 * An evaluation is only worth comparing with another when it is known what
 * changed between them. Each evaluation therefore records a fingerprint of the
 * pipeline it ran (topology, prompts, labels, sampling settings) and of the
 * dataset it ran against. Equal fingerprints mean equal configurations; a
 * comparison across different fingerprints is still allowed, but is labeled.
 *
 * The hash is 64-bit FNV-1a over the UTF-8 bytes of a canonical JSON encoding.
 * It identifies configurations; it does not authenticate them, and it is not a
 * cryptographic hash. With a capped local history of a handful of records, an
 * accidental collision is negligible. Pure and synchronous, so it runs in the
 * browser and in the command-line runner alike.
 */

import type { ExecutionDescriptor } from '@/types/execution';

import type { EvalDataset } from './dataset';

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

const encoder = new TextEncoder();

/** 64-bit FNV-1a of `text`'s UTF-8 bytes, as 16 lowercase hex digits. */
export const fnv1a64 = (text: string): string => {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of encoder.encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
};

/**
 * JSON with object keys sorted at every level, so two values that differ only in
 * key order encode identically. Array order is kept: it is meaningful (labels,
 * cases, checks) unless the caller sorts first.
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      // `undefined` members are dropped, as `JSON.stringify` does.
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Fingerprint of the pipeline configuration an evaluation runs. Node and edge
 * order in the editor carries no meaning for execution, so both are sorted
 * first: rearranging the canvas or re-adding an edge does not change it, while
 * any prompt, label, sampling, or wiring change does.
 */
export const pipelineFingerprint = (descriptor: ExecutionDescriptor): string => {
  const nodes = [...descriptor.nodes].sort((a, b) => compareStrings(a.id, b.id));
  const edges = [...descriptor.edges].sort(
    (a, b) => compareStrings(a.source, b.source) || compareStrings(a.target, b.target),
  );
  return fnv1a64(canonicalJson({ nodes, edges }));
};

/** Fingerprint of a parsed dataset, cases and checks in their declared order. */
export const datasetFingerprint = (dataset: EvalDataset): string => fnv1a64(canonicalJson(dataset));

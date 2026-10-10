/**
 * Structural (document-level) equality for graph snapshots.
 *
 * A node object's identity changes on every telemetry tick, selection toggle, and
 * React Flow measurement, none of which alter the authored document. Its
 * `position`, `data.label`, and `data.config` references, by contrast, change only
 * on a genuine edit, because every store action updates immutably. Comparing those
 * references (plus node/edge identity and order) yields an exact "did the document
 * change" signal in O(V + E) without diffing deep payloads.
 *
 * Shared by the undo recorder and the persistence writer so both agree on what
 * constitutes an edit. Pure and framework-agnostic.
 */

import type { NexusEdge, NexusNode } from '@/types/graph';

export interface GraphStructure {
  readonly nodes: readonly NexusNode[];
  readonly edges: readonly NexusEdge[];
}

const sameNodes = (a: readonly NexusNode[], b: readonly NexusNode[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    if (x.id !== y.id) return false;
    if (x.position !== y.position) return false;
    if (x.data.label !== y.data.label) return false;
    if (x.data.config !== y.data.config) return false;
  }
  return true;
};

const sameEdges = (a: readonly NexusEdge[], b: readonly NexusEdge[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    if (x.id !== y.id || x.source !== y.source || x.target !== y.target) return false;
  }
  return true;
};

/** True when both graphs describe the same document, ignoring telemetry and selection. */
export const isSameGraphStructure = (a: GraphStructure, b: GraphStructure): boolean =>
  sameNodes(a.nodes, b.nodes) && sameEdges(a.edges, b.edges);

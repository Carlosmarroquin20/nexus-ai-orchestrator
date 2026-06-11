/**
 * Pure layered (Sugiyama-style, horizontal) layout.
 *
 * Ranks nodes by longest path from a source so dependencies always flow
 * left-to-right (matching the node handle orientation: target-left, source-right).
 * Within a rank, nodes keep their input order and are vertically centered so
 * columns balance around a common axis. Cyclic graphs (which lack a valid linear
 * order) fall back to a square grid by input order.
 *
 * Returns positions keyed by node id; the caller applies them via the store.
 */

import { buildAdjacency, topologicalOrder } from './graphValidation';

export interface LayoutPosition {
  readonly x: number;
  readonly y: number;
}

const LAYER_GAP_X = 320;
const NODE_GAP_Y = 150;

export const computeLayeredLayout = (
  nodes: readonly { id: string }[],
  edges: readonly { source: string; target: string }[],
): Map<string, LayoutPosition> => {
  const positions = new Map<string, LayoutPosition>();
  if (nodes.length === 0) return positions;

  const adjacency = buildAdjacency(nodes, edges);
  const order = topologicalOrder(nodes, edges);

  const rank = new Map<string, number>();
  for (const node of nodes) rank.set(node.id, 0);

  if (order !== null) {
    // Longest-path ranking: a node sits one rank past its deepest predecessor.
    for (const id of order) {
      const current = rank.get(id) ?? 0;
      for (const next of adjacency.get(id) ?? []) {
        rank.set(next, Math.max(rank.get(next) ?? 0, current + 1));
      }
    }
  } else {
    // Cyclic fallback: square-ish grid in input order.
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    nodes.forEach((node, index) => rank.set(node.id, Math.floor(index / columns)));
  }

  // Bucket node ids by rank, preserving input order within each rank.
  const byRank = new Map<number, string[]>();
  for (const node of nodes) {
    const layer = rank.get(node.id) ?? 0;
    const bucket = byRank.get(layer);
    if (bucket === undefined) byRank.set(layer, [node.id]);
    else bucket.push(node.id);
  }

  for (const [layer, ids] of byRank) {
    const offsetY = -((ids.length - 1) / 2) * NODE_GAP_Y;
    ids.forEach((id, index) => {
      positions.set(id, { x: layer * LAYER_GAP_X, y: offsetY + index * NODE_GAP_Y });
    });
  }

  return positions;
};

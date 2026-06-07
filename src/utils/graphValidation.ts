/**
 * Graph topology validators and ordering algorithms.
 *
 * Operates on minimal structural shapes (`DirectedEdgeLike` / `NodeIdentified`)
 * rather than React Flow node/edge objects, so the algorithms stay independent of
 * the view model. React Flow exposes `source`/`target`/`id` as plain strings;
 * these functions accept that boundary directly and never depend on the `NodeId`
 * brand. All traversals are iterative to remain stack-safe on large pipelines.
 */

export interface DirectedEdgeLike {
  readonly source: string;
  readonly target: string;
}

export interface NodeIdentified {
  readonly id: string;
}

/** Builds a directed adjacency list (source -> targets). Complexity: O(V + E). */
export const buildAdjacency = (
  nodes: readonly NodeIdentified[],
  edges: readonly DirectedEdgeLike[],
): ReadonlyMap<string, readonly string[]> => {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of edges) {
    // Edges referencing nodes absent from `nodes` are tolerated and registered
    // lazily, so validation never throws on a transiently inconsistent snapshot.
    const bucket = adjacency.get(edge.source) ?? adjacency.set(edge.source, []).get(edge.source)!;
    bucket.push(edge.target);
    if (!adjacency.has(edge.target)) {
      adjacency.set(edge.target, []);
    }
  }
  return adjacency;
};

/**
 * Determines whether `target` is reachable from `source` over existing edges via
 * iterative DFS. Used to predict cycles before an edge is committed.
 */
const isReachable = (
  adjacency: ReadonlyMap<string, readonly string[]>,
  source: string,
  target: string,
): boolean => {
  const stack: string[] = [source];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!visited.has(neighbor)) stack.push(neighbor);
    }
  }
  return false;
};

/**
 * Predicts whether connecting `source -> target` would introduce a cycle, given
 * the current edge set. A self-connection is always reported as a cycle.
 *
 * Connect-guard contract: `onConnect` must reject the connection when this
 * returns `true`; the orchestrator graph is required to remain a DAG.
 */
export const wouldCreateCycle = (
  nodes: readonly NodeIdentified[],
  edges: readonly DirectedEdgeLike[],
  source: string,
  target: string,
): boolean => {
  if (source === target) return true;
  const adjacency = buildAdjacency(nodes, edges);
  // The new edge closes a loop iff `source` is already reachable from `target`.
  return isReachable(adjacency, target, source);
};

type VisitColor = 'white' | 'gray' | 'black';

/**
 * Detects whether the directed graph contains at least one cycle using an
 * iterative three-color DFS (white = undiscovered, gray = on the active path,
 * black = fully explored). Complexity: O(V + E).
 */
export const detectCycle = (
  nodes: readonly NodeIdentified[],
  edges: readonly DirectedEdgeLike[],
): boolean => {
  const adjacency = buildAdjacency(nodes, edges);
  const color = new Map<string, VisitColor>();
  for (const key of adjacency.keys()) color.set(key, 'white');

  for (const root of adjacency.keys()) {
    if (color.get(root) !== 'white') continue;

    // Explicit frame stack; the post-visit marker repaints a node black once all
    // of its descendants have been processed.
    const stack: Array<{ readonly node: string; readonly postVisit: boolean }> = [
      { node: root, postVisit: false },
    ];

    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.postVisit) {
        color.set(frame.node, 'black');
        continue;
      }
      if (color.get(frame.node) === 'gray') continue;

      color.set(frame.node, 'gray');
      stack.push({ node: frame.node, postVisit: true });

      for (const neighbor of adjacency.get(frame.node) ?? []) {
        const neighborColor = color.get(neighbor);
        if (neighborColor === 'gray') return true; // back edge -> cycle
        if (neighborColor === 'white') stack.push({ node: neighbor, postVisit: false });
      }
    }
  }
  return false;
};

/**
 * Produces a topological ordering of node ids via Kahn's algorithm, or `null`
 * if the graph is cyclic (and therefore has no valid linear execution order).
 * Complexity: O(V + E).
 */
export const topologicalOrder = (
  nodes: readonly NodeIdentified[],
  edges: readonly DirectedEdgeLike[],
): readonly string[] | null => {
  const adjacency = buildAdjacency(nodes, edges);
  const indegree = new Map<string, number>();
  for (const key of adjacency.keys()) indegree.set(key, 0);
  for (const targets of adjacency.values()) {
    for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [node, degree] of indegree) {
    if (degree === 0) queue.push(node);
  }

  const ordered: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    ordered.push(node);
    for (const neighbor of adjacency.get(node) ?? []) {
      const next = (indegree.get(neighbor) ?? 0) - 1;
      indegree.set(neighbor, next);
      if (next === 0) queue.push(neighbor);
    }
  }

  // A residual node count below the vertex count indicates a cycle absorbed the rest.
  return ordered.length === indegree.size ? ordered : null;
};

/**
 * Connection admissibility check for `onConnect`. Rejects self-loops, duplicate
 * parallel edges, and any connection that would violate the DAG invariant.
 */
export const isAdmissibleConnection = (
  nodes: readonly NodeIdentified[],
  edges: readonly DirectedEdgeLike[],
  source: string,
  target: string,
): boolean => {
  if (source === target) return false;
  const duplicate = edges.some((edge) => edge.source === source && edge.target === target);
  if (duplicate) return false;
  return !wouldCreateCycle(nodes, edges, source, target);
};

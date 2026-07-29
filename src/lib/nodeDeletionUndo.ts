export interface UndoableGraphNode {
  id: string;
  type?: string | null;
  parentId?: string;
}

export interface UndoableGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface NodeDeletionSnapshot<
  TNode extends UndoableGraphNode,
  TEdge extends UndoableGraphEdge,
> {
  nodes: TNode[];
  edges: TEdge[];
  removedNodeIds: string[];
  nodeOrder: string[];
  edgeOrder: string[];
}

/** Capture deleted nodes plus group children whose parent/position will change. */
export function captureNodeDeletion<
  TNode extends UndoableGraphNode,
  TEdge extends UndoableGraphEdge,
>(
  nodes: TNode[],
  edges: TEdge[],
  requestedNodeIds: string[],
): NodeDeletionSnapshot<TNode, TEdge> | null {
  const existingIds = new Set(nodes.map((node) => node.id));
  const removedNodeIds = Array.from(new Set(requestedNodeIds.filter((id) => existingIds.has(id))));
  if (!removedNodeIds.length) return null;

  const removedIds = new Set(removedNodeIds);
  const removedGroupIds = new Set(
    nodes.filter((node) => removedIds.has(node.id) && node.type === "group").map((node) => node.id),
  );
  const affectedNodeIds = new Set(removedNodeIds);
  for (const node of nodes) {
    if (node.parentId && removedGroupIds.has(node.parentId)) affectedNodeIds.add(node.id);
  }

  return {
    nodes: nodes.filter((node) => affectedNodeIds.has(node.id)),
    edges: edges.filter((edge) => removedIds.has(edge.source) || removedIds.has(edge.target)),
    removedNodeIds,
    nodeOrder: nodes.map((node) => node.id),
    edgeOrder: edges.map((edge) => edge.id),
  };
}

function mergeInOriginalOrder<T extends { id: string }>(
  current: T[],
  restored: T[],
  originalOrder: string[],
): T[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  const restoredById = new Map(restored.map((item) => [item.id, item]));
  const used = new Set<string>();
  const merged: T[] = [];

  for (const id of originalOrder) {
    const item = restoredById.get(id) ?? currentById.get(id);
    if (!item || used.has(id)) continue;
    merged.push(item);
    used.add(id);
  }
  for (const item of current) {
    if (used.has(item.id)) continue;
    merged.push(item);
    used.add(item.id);
  }
  for (const item of restored) {
    if (used.has(item.id)) continue;
    merged.push(item);
    used.add(item.id);
  }
  return merged;
}

/** Restore the deletion without rolling back unrelated edits made afterward. */
export function restoreNodeDeletion<
  TNode extends UndoableGraphNode,
  TEdge extends UndoableGraphEdge,
>(
  currentNodes: TNode[],
  currentEdges: TEdge[],
  snapshot: NodeDeletionSnapshot<TNode, TEdge>,
): { nodes: TNode[]; edges: TEdge[] } {
  const nodes = mergeInOriginalOrder(currentNodes, snapshot.nodes, snapshot.nodeOrder);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const restorableEdges = snapshot.edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );
  const edges = mergeInOriginalOrder(currentEdges, restorableEdges, snapshot.edgeOrder);
  return { nodes, edges };
}

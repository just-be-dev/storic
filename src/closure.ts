import type { Lens, PathStep, ReachabilityRow } from "./types.ts";

type Edge = { to: string; lensId: string; direction: "forward" | "backward" };

export function computeTransitiveClosure(lenses: Lens[]): ReachabilityRow[] {
  // Build undirected adjacency list — lenses are bidirectional
  const adj = new Map<string, Edge[]>();

  const addEdge = (from: string, to: string, lensId: string, direction: "forward" | "backward") => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push({ to, lensId, direction });
  };

  for (const lens of lenses) {
    addEdge(lens.from_schema, lens.to_schema, lens.id, "forward");
    addEdge(lens.to_schema, lens.from_schema, lens.id, "backward");
  }

  const rows: ReachabilityRow[] = [];
  const allNodes = new Set(adj.keys());

  for (const start of allNodes) {
    // BFS from each node to find all reachable nodes + shortest path
    const visited = new Set<string>([start]);
    const queue: Array<{ node: string; path: PathStep[] }> = [
      { node: start, path: [] },
    ];

    while (queue.length > 0) {
      const { node, path } = queue.shift()!;

      for (const { to, lensId, direction } of adj.get(node) ?? []) {
        if (!visited.has(to)) {
          visited.add(to);
          const newPath: PathStep[] = [...path, { lens_id: lensId, direction }];
          rows.push({ from_schema: start, to_schema: to, path: newPath });
          queue.push({ node: to, path: newPath });
        }
      }
    }
  }

  return rows;
}

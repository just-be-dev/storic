import type { LensPath, LensPathStep } from "./types.ts";

// ─── Internal Edge Type ─────────────────────────────────────────────────────

interface LensEdge {
  readonly toType: string;
  readonly transform: (data: unknown) => unknown;
}

// ─── Lens Graph ─────────────────────────────────────────────────────────────

/**
 * In-memory bidirectional graph of lens relationships between schema versions.
 *
 * Supports BFS-based pathfinding to discover the shortest transformation
 * chain between any two connected schema versions.
 */
export class LensGraph {
  private readonly adjacency = new Map<string, LensEdge[]>();
  private readonly pathCache = new Map<string, LensPath | null>();

  /**
   * Register a bidirectional lens edge between two types.
   *
   * Both `forward` and `backward` directions are added to the adjacency list.
   */
  register(edge: {
    readonly fromType: string;
    readonly toType: string;
    readonly forward: (data: unknown) => unknown;
    readonly backward: (data: unknown) => unknown;
  }): void {
    // Ensure both nodes exist in the adjacency map
    if (!this.adjacency.has(edge.fromType)) {
      this.adjacency.set(edge.fromType, []);
    }
    if (!this.adjacency.has(edge.toType)) {
      this.adjacency.set(edge.toType, []);
    }

    // Forward edge: fromType → toType
    this.adjacency.get(edge.fromType)!.push({
      toType: edge.toType,
      transform: edge.forward,
    });

    // Backward edge: toType → fromType (reversed)
    this.adjacency.get(edge.toType)!.push({
      toType: edge.fromType,
      transform: edge.backward,
    });

    // Invalidate cached paths
    this.pathCache.clear();
  }

  /**
   * Get all types reachable from the given type (including the type itself).
   *
   * Uses BFS to traverse the full connected component.
   */
  getConnectedTypes(type: string): string[] {
    const visited = new Set<string>([type]);
    const queue = [type];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = this.adjacency.get(current) ?? [];

      for (const edge of neighbors) {
        if (!visited.has(edge.toType)) {
          visited.add(edge.toType);
          queue.push(edge.toType);
        }
      }
    }

    return Array.from(visited);
  }

  /**
   * Find the shortest transformation path between two types.
   *
   * Returns `null` if no path exists. Returns `{ steps: [] }` if the types
   * are the same (identity path).
   *
   * Results are cached for repeated lookups.
   */
  getPath(fromType: string, toType: string): LensPath | null {
    if (fromType === toType) {
      return { steps: [] };
    }

    const cacheKey = `${fromType}→${toType}`;
    const cached = this.pathCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // BFS to find shortest path
    const visited = new Set<string>([fromType]);
    const queue: Array<{ type: string; path: LensPathStep[] }> = [{ type: fromType, path: [] }];

    while (queue.length > 0) {
      const { type, path } = queue.shift()!;
      const neighbors = this.adjacency.get(type) ?? [];

      for (const edge of neighbors) {
        const nextStep: LensPathStep = {
          fromType: type,
          toType: edge.toType,
          transform: edge.transform,
        };

        if (edge.toType === toType) {
          const result: LensPath = { steps: [...path, nextStep] };
          this.pathCache.set(cacheKey, result);
          return result;
        }

        if (!visited.has(edge.toType)) {
          visited.add(edge.toType);
          queue.push({
            type: edge.toType,
            path: [...path, nextStep],
          });
        }
      }
    }

    this.pathCache.set(cacheKey, null);
    return null;
  }

  /**
   * Get all types that have been registered in the graph.
   */
  getAllTypes(): string[] {
    return Array.from(this.adjacency.keys());
  }
}

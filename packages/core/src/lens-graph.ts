import type { LensPath, LensPathStep } from "./types.ts";

// ─── Internal Edge Type ─────────────────────────────────────────────────────

interface LensEdge {
  readonly toTag: string;
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
   * Register a bidirectional lens edge between two tags.
   *
   * Both `forward` and `backward` directions are added to the adjacency list.
   */
  register(edge: {
    readonly fromTag: string;
    readonly toTag: string;
    readonly forward: (data: unknown) => unknown;
    readonly backward: (data: unknown) => unknown;
  }): void {
    // Ensure both nodes exist in the adjacency map
    if (!this.adjacency.has(edge.fromTag)) {
      this.adjacency.set(edge.fromTag, []);
    }
    if (!this.adjacency.has(edge.toTag)) {
      this.adjacency.set(edge.toTag, []);
    }

    // Forward edge: fromTag → toTag
    this.adjacency.get(edge.fromTag)!.push({
      toTag: edge.toTag,
      transform: edge.forward,
    });

    // Backward edge: toTag → fromTag (reversed)
    this.adjacency.get(edge.toTag)!.push({
      toTag: edge.fromTag,
      transform: edge.backward,
    });

    // Invalidate cached paths
    this.pathCache.clear();
  }

  /**
   * Get all tags reachable from the given tag (including the tag itself).
   *
   * Uses BFS to traverse the full connected component.
   */
  getConnectedTags(tag: string): string[] {
    const visited = new Set<string>([tag]);
    const queue = [tag];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = this.adjacency.get(current) ?? [];

      for (const edge of neighbors) {
        if (!visited.has(edge.toTag)) {
          visited.add(edge.toTag);
          queue.push(edge.toTag);
        }
      }
    }

    return Array.from(visited);
  }

  /**
   * Find the shortest transformation path between two tags.
   *
   * Returns `null` if no path exists. Returns `{ steps: [] }` if the tags
   * are the same (identity path).
   *
   * Results are cached for repeated lookups.
   */
  getPath(fromTag: string, toTag: string): LensPath | null {
    if (fromTag === toTag) {
      return { steps: [] };
    }

    const cacheKey = `${fromTag}→${toTag}`;
    const cached = this.pathCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // BFS to find shortest path
    const visited = new Set<string>([fromTag]);
    const queue: Array<{ tag: string; path: LensPathStep[] }> = [
      { tag: fromTag, path: [] },
    ];

    while (queue.length > 0) {
      const { tag, path } = queue.shift()!;
      const neighbors = this.adjacency.get(tag) ?? [];

      for (const edge of neighbors) {
        const nextStep: LensPathStep = {
          fromTag: tag,
          toTag: edge.toTag,
          transform: edge.transform,
        };

        if (edge.toTag === toTag) {
          const result: LensPath = { steps: [...path, nextStep] };
          this.pathCache.set(cacheKey, result);
          return result;
        }

        if (!visited.has(edge.toTag)) {
          visited.add(edge.toTag);
          queue.push({
            tag: edge.toTag,
            path: [...path, nextStep],
          });
        }
      }
    }

    this.pathCache.set(cacheKey, null);
    return null;
  }

  /**
   * Get all tags that have been registered in the graph.
   */
  getAllTags(): string[] {
    return Array.from(this.adjacency.keys());
  }
}

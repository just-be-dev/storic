import { test, expect, describe } from "bun:test";
import { computeTransitiveClosure } from "../src/closure.ts";
import type { Lens } from "../src/types.ts";

const lens = (
  id: string,
  from: string,
  to: string,
): Lens => ({
  id,
  from_schema: from,
  to_schema: to,
  forward: "(d) => d",
  backward: "(d) => d",
});

describe("computeTransitiveClosure", () => {
  test("returns empty array for no lenses", () => {
    expect(computeTransitiveClosure([])).toEqual([]);
  });

  test("single lens produces two reachability rows (forward + backward)", () => {
    const rows = computeTransitiveClosure([lens("L1", "A", "B")]);
    expect(rows).toHaveLength(2);

    const ab = rows.find((r) => r.from_schema === "A" && r.to_schema === "B");
    const ba = rows.find((r) => r.from_schema === "B" && r.to_schema === "A");

    expect(ab).toBeDefined();
    expect(ab!.path).toEqual([{ lens_id: "L1", direction: "forward" }]);

    expect(ba).toBeDefined();
    expect(ba!.path).toEqual([{ lens_id: "L1", direction: "backward" }]);
  });

  test("chain A->B->C produces transitive paths", () => {
    const rows = computeTransitiveClosure([
      lens("L1", "A", "B"),
      lens("L2", "B", "C"),
    ]);

    // Should have: A->B, B->A, B->C, C->B, A->C, C->A = 6 rows
    expect(rows).toHaveLength(6);

    const ac = rows.find((r) => r.from_schema === "A" && r.to_schema === "C");
    expect(ac).toBeDefined();
    expect(ac!.path).toEqual([
      { lens_id: "L1", direction: "forward" },
      { lens_id: "L2", direction: "forward" },
    ]);

    const ca = rows.find((r) => r.from_schema === "C" && r.to_schema === "A");
    expect(ca).toBeDefined();
    expect(ca!.path).toEqual([
      { lens_id: "L2", direction: "backward" },
      { lens_id: "L1", direction: "backward" },
    ]);
  });

  test("finds shortest path when multiple paths exist", () => {
    // A->B via L1, B->C via L2, A->C via L3 (direct)
    const rows = computeTransitiveClosure([
      lens("L1", "A", "B"),
      lens("L2", "B", "C"),
      lens("L3", "A", "C"),
    ]);

    // A->C should use direct lens L3 (1 step) not L1+L2 (2 steps)
    const ac = rows.find((r) => r.from_schema === "A" && r.to_schema === "C");
    expect(ac).toBeDefined();
    expect(ac!.path).toHaveLength(1);
    expect(ac!.path[0].lens_id).toBe("L3");
  });

  test("disconnected graphs produce no cross-paths", () => {
    const rows = computeTransitiveClosure([
      lens("L1", "A", "B"),
      lens("L2", "C", "D"),
    ]);

    // Only A<->B and C<->D, no A<->C, A<->D, etc.
    expect(rows).toHaveLength(4);
    const crossPath = rows.find(
      (r) =>
        (r.from_schema === "A" && r.to_schema === "C") ||
        (r.from_schema === "A" && r.to_schema === "D"),
    );
    expect(crossPath).toBeUndefined();
  });

  test("diamond graph A->B, A->C, B->D, C->D", () => {
    const rows = computeTransitiveClosure([
      lens("L1", "A", "B"),
      lens("L2", "A", "C"),
      lens("L3", "B", "D"),
      lens("L4", "C", "D"),
    ]);

    // All 4 nodes should be reachable from each other = 4*3 = 12 rows
    expect(rows).toHaveLength(12);

    // A->D should be 2 steps (either via B or C, whichever BFS finds first)
    const ad = rows.find((r) => r.from_schema === "A" && r.to_schema === "D");
    expect(ad).toBeDefined();
    expect(ad!.path).toHaveLength(2);
  });
});

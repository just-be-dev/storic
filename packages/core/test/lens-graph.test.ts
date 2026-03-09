import { test, expect, describe } from "bun:test";
import { LensGraph } from "../src/lens-graph.ts";

describe("LensGraph", () => {
  test("getConnectedTypes returns only the type itself when no lenses exist", () => {
    const graph = new LensGraph();
    expect(graph.getConnectedTypes("Person.v1")).toEqual(["Person.v1"]);
  });

  test("getConnectedTypes returns connected types", () => {
    const graph = new LensGraph();
    graph.register({
      fromType: "Person.v1",
      toType: "Person.v2",
      forward: (d) => d,
      backward: (d) => d,
    });

    const connected = graph.getConnectedTypes("Person.v1");
    expect(connected).toContain("Person.v1");
    expect(connected).toContain("Person.v2");
    expect(connected).toHaveLength(2);
  });

  test("getConnectedTypes works from either direction", () => {
    const graph = new LensGraph();
    graph.register({
      fromType: "Person.v1",
      toType: "Person.v2",
      forward: (d) => d,
      backward: (d) => d,
    });

    const fromV2 = graph.getConnectedTypes("Person.v2");
    expect(fromV2).toContain("Person.v1");
    expect(fromV2).toContain("Person.v2");
  });

  test("getConnectedTypes follows transitive connections", () => {
    const graph = new LensGraph();
    graph.register({
      fromType: "A.v1",
      toType: "A.v2",
      forward: (d) => d,
      backward: (d) => d,
    });
    graph.register({
      fromType: "A.v2",
      toType: "A.v3",
      forward: (d) => d,
      backward: (d) => d,
    });

    const connected = graph.getConnectedTypes("A.v1");
    expect(connected).toContain("A.v1");
    expect(connected).toContain("A.v2");
    expect(connected).toContain("A.v3");
    expect(connected).toHaveLength(3);
  });

  test("getPath returns empty steps for same type", () => {
    const graph = new LensGraph();
    const path = graph.getPath("Person.v1", "Person.v1");
    expect(path).toEqual({ steps: [] });
  });

  test("getPath returns null for disconnected types", () => {
    const graph = new LensGraph();
    const path = graph.getPath("Person.v1", "User.v1");
    expect(path).toBeNull();
  });

  test("getPath finds direct connection", () => {
    const graph = new LensGraph();
    graph.register({
      fromType: "Person.v1",
      toType: "Person.v2",
      forward: (d: any) => ({ ...d, version: 2 }),
      backward: (d: any) => ({ ...d, version: 1 }),
    });

    const path = graph.getPath("Person.v1", "Person.v2");
    expect(path).not.toBeNull();
    expect(path!.steps).toHaveLength(1);
    expect(path!.steps[0].fromType).toBe("Person.v1");
    expect(path!.steps[0].toType).toBe("Person.v2");

    // Forward transform
    const result = path!.steps[0].transform({ name: "Alice" });
    expect(result).toEqual({ name: "Alice", version: 2 });
  });

  test("getPath finds backward connection", () => {
    const graph = new LensGraph();
    graph.register({
      fromType: "Person.v1",
      toType: "Person.v2",
      forward: (d: any) => ({ ...d, version: 2 }),
      backward: (d: any) => ({ ...d, version: 1 }),
    });

    const path = graph.getPath("Person.v2", "Person.v1");
    expect(path).not.toBeNull();
    expect(path!.steps).toHaveLength(1);

    // Backward transform
    const result = path!.steps[0].transform({ name: "Alice" });
    expect(result).toEqual({ name: "Alice", version: 1 });
  });

  test("getPath finds multi-hop path", () => {
    const graph = new LensGraph();
    graph.register({
      fromType: "A.v1",
      toType: "A.v2",
      forward: (d) => d,
      backward: (d) => d,
    });
    graph.register({
      fromType: "A.v2",
      toType: "A.v3",
      forward: (d) => d,
      backward: (d) => d,
    });

    const path = graph.getPath("A.v1", "A.v3");
    expect(path).not.toBeNull();
    expect(path!.steps).toHaveLength(2);
    expect(path!.steps[0].fromType).toBe("A.v1");
    expect(path!.steps[0].toType).toBe("A.v2");
    expect(path!.steps[1].fromType).toBe("A.v2");
    expect(path!.steps[1].toType).toBe("A.v3");
  });

  test("getPath caches results", () => {
    const graph = new LensGraph();
    graph.register({
      fromType: "A.v1",
      toType: "A.v2",
      forward: (d) => d,
      backward: (d) => d,
    });

    const path1 = graph.getPath("A.v1", "A.v2");
    const path2 = graph.getPath("A.v1", "A.v2");
    expect(path1).toBe(path2); // Same reference (cached)
  });

  test("getAllTypes returns all registered types", () => {
    const graph = new LensGraph();
    graph.register({
      fromType: "A.v1",
      toType: "A.v2",
      forward: (d) => d,
      backward: (d) => d,
    });

    const types = graph.getAllTypes();
    expect(types).toContain("A.v1");
    expect(types).toContain("A.v2");
  });
});

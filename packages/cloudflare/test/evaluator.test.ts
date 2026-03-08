import { test, expect, describe } from "bun:test";
import {
  generateEvaluatorModule,
  EvaluatorModuleError,
} from "../src/evaluator-worker.ts";

describe("generateEvaluatorModule", () => {
  test("simple expression, no bindings", () => {
    const code = generateEvaluatorModule("2 + 2", {});
    expect(code).toContain("(() => (2 + 2))()");
    expect(code).toContain("export default");
  });

  test("injects bindings as IIFE arguments", () => {
    const code = generateEvaluatorModule("x + y", { x: 10, y: 20 });
    expect(code).toContain("((x, y) => (x + y))(10, 20)");
  });

  test("handles object bindings", () => {
    const code = generateEvaluatorModule(
      "(data) => data.first + ' ' + data.last",
      { data: { first: "Alice", last: "Smith" } },
    );
    expect(code).toContain('((data) => ((data) => data.first');
    expect(code).toContain('{"first":"Alice","last":"Smith"}');
  });

  test("wraps in try/catch for runtime errors", () => {
    const code = generateEvaluatorModule("x.toString()", { x: 42 });
    expect(code).toContain("try {");
    expect(code).toContain("} catch (e) {");
    expect(code).toContain("__error");
  });

  test("returns valid module with fetch handler", () => {
    const code = generateEvaluatorModule("42", {});
    expect(code).toContain("export default {");
    expect(code).toContain("fetch()");
    expect(code).toContain("Response.json({ result: __result })");
  });

  test("fetch handler catches non-serializable results", () => {
    const code = generateEvaluatorModule("() => 1", {});
    // The fetch handler should have a try/catch around Response.json
    expect(code).toContain("Result is not JSON-serializable");
  });
});

describe("generateEvaluatorModule validation", () => {
  test("rejects binding name that is not a valid identifier", () => {
    expect(() =>
      generateEvaluatorModule("x", { "not valid!": 1 }),
    ).toThrow(EvaluatorModuleError);
    expect(() =>
      generateEvaluatorModule("x", { "not valid!": 1 }),
    ).toThrow("not a valid JavaScript identifier");
  });

  test("rejects binding name starting with a number", () => {
    expect(() =>
      generateEvaluatorModule("x", { "1abc": 1 }),
    ).toThrow(EvaluatorModuleError);
  });

  test("accepts valid identifier binding names", () => {
    expect(() =>
      generateEvaluatorModule("x + _y + $z", { x: 1, _y: 2, $z: 3 }),
    ).not.toThrow();
  });

  test("rejects non-JSON-serializable binding value (undefined)", () => {
    expect(() =>
      generateEvaluatorModule("x", { x: undefined }),
    ).toThrow(EvaluatorModuleError);
    expect(() =>
      generateEvaluatorModule("x", { x: undefined }),
    ).toThrow("non-JSON-serializable");
  });

  test("rejects non-JSON-serializable binding value (function)", () => {
    expect(() =>
      generateEvaluatorModule("x", { x: () => 1 }),
    ).toThrow(EvaluatorModuleError);
    expect(() =>
      generateEvaluatorModule("x", { x: () => 1 }),
    ).toThrow("non-JSON-serializable");
  });

  test("accepts null binding value", () => {
    // null is valid JSON
    expect(() =>
      generateEvaluatorModule("x", { x: null }),
    ).not.toThrow();
    const code = generateEvaluatorModule("x", { x: null });
    expect(code).toContain("((x) => (x))(null)");
  });

  test("rejects injection attempt in binding name", () => {
    expect(() =>
      generateEvaluatorModule("x", { "a) { evil(); } //": 1 }),
    ).toThrow(EvaluatorModuleError);
  });
});

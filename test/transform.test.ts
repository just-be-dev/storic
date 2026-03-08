import { test, expect, describe } from "bun:test";
import { Effect, Exit } from "effect";
import { applyTransform, applyLensChain } from "../src/transform.ts";
import { JsEvaluator } from "../src/evaluator.ts";

const run = <A, E>(effect: Effect.Effect<A, E, JsEvaluator>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, JsEvaluator.Eval));

const runExit = <A, E>(
  effect: Effect.Effect<A, E, JsEvaluator>,
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromise(Effect.exit(Effect.provide(effect, JsEvaluator.Eval)));

describe("applyTransform", () => {
  test("applies a simple identity transform", async () => {
    const result = await run(applyTransform("(d) => d", { x: 1 }));
    expect(result).toEqual({ x: 1 });
  });

  test("applies a mapping transform", async () => {
    const result = await run(
      applyTransform(
        "(d) => ({ full: d.first + ' ' + d.last })",
        { first: "Alice", last: "Smith" },
      ),
    );
    expect(result).toEqual({ full: "Alice Smith" });
  });

  test("fails with TransformError for invalid JS", async () => {
    const exit = await runExit(applyTransform("not valid js(((", { x: 1 }));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("fails with TransformError for runtime error in transform", async () => {
    const exit = await runExit(
      applyTransform("(d) => d.foo.bar.baz", {}),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("applyLensChain", () => {
  test("applies a single-step forward chain", async () => {
    const lensMap = new Map([
      ["L1", {
        forward: "(d) => ({ fullName: d.first + ' ' + d.last })",
        backward: "(d) => ({ first: d.fullName.split(' ')[0], last: d.fullName.split(' ')[1] })",
      }],
    ]);

    const result = await run(
      applyLensChain(
        [{ lens_id: "L1", direction: "forward" }],
        lensMap,
        { first: "Alice", last: "Smith" },
      ),
    );
    expect(result).toEqual({ fullName: "Alice Smith" });
  });

  test("applies a single-step backward chain", async () => {
    const lensMap = new Map([
      ["L1", {
        forward: "(d) => ({ fullName: d.first + ' ' + d.last })",
        backward: "(d) => ({ first: d.fullName.split(' ')[0], last: d.fullName.split(' ')[1] })",
      }],
    ]);

    const result = await run(
      applyLensChain(
        [{ lens_id: "L1", direction: "backward" }],
        lensMap,
        { fullName: "Alice Smith" },
      ),
    );
    expect(result).toEqual({ first: "Alice", last: "Smith" });
  });

  test("applies a multi-step chain", async () => {
    const lensMap = new Map([
      ["L1", {
        forward: "(d) => ({ ...d, fullName: d.first + ' ' + d.last })",
        backward: "(d) => d",
      }],
      ["L2", {
        forward: "(d) => ({ name: d.fullName, email: d.email })",
        backward: "(d) => d",
      }],
    ]);

    const result = await run(
      applyLensChain(
        [
          { lens_id: "L1", direction: "forward" },
          { lens_id: "L2", direction: "forward" },
        ],
        lensMap,
        { first: "Alice", last: "Smith", email: "a@b.com" },
      ),
    );
    expect(result).toEqual({ name: "Alice Smith", email: "a@b.com" });
  });

  test("fails when lens_id not in map", async () => {
    const exit = await runExit(
      applyLensChain(
        [{ lens_id: "MISSING", direction: "forward" }],
        new Map(),
        {},
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

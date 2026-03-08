import { test, expect, describe } from "bun:test";
import { Effect } from "effect";
import { parseSchema, validate } from "../src/validate.ts";
import { JsEvaluator } from "../src/evaluator.ts";

const run = <A, E>(effect: Effect.Effect<A, E, JsEvaluator>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, JsEvaluator.Eval));

describe("parseSchema", () => {
  test("parses a valid struct schema def", async () => {
    const schema = await run(
      parseSchema(`S.Struct({ name: S.String, age: S.Number })`),
    );
    expect(schema).toBeDefined();
  });

  test("fails with SchemaDefEvalError for invalid def", async () => {
    const tag = await run(
      parseSchema(`not_a_valid_expression!!!`).pipe(
        Effect.map(() => "success" as const),
        Effect.catchTag("SchemaDefEvalError", () =>
          Effect.succeed("SchemaDefEvalError" as const),
        ),
      ),
    );
    expect(tag).toBe("SchemaDefEvalError");
  });
});

describe("validate", () => {
  test("succeeds for valid data against struct schema", async () => {
    await run(
      validate(`S.Struct({ name: S.String })`, { name: "Alice" }),
    );
  });

  test("fails with ValidationError for mismatched data", async () => {
    const tag = await run(
      validate(`S.Struct({ name: S.String })`, { name: 42 }).pipe(
        Effect.map(() => "success" as const),
        Effect.catchTag("ValidationError", () =>
          Effect.succeed("ValidationError" as const),
        ),
      ),
    );
    expect(tag).toBe("ValidationError");
  });

  test("fails with ValidationError for missing required field", async () => {
    const tag = await run(
      validate(`S.Struct({ name: S.String, age: S.Number })`, {
        name: "Alice",
      }).pipe(
        Effect.map(() => "success" as const),
        Effect.catchTag("ValidationError", () =>
          Effect.succeed("ValidationError" as const),
        ),
      ),
    );
    expect(tag).toBe("ValidationError");
  });
});

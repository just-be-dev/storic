import { Effect, Schema } from "effect";
import { SchemaDefEvalError, ValidationError } from "./errors.ts";
import { JsEvaluator } from "./evaluator.ts";

/**
 * Parse a schema definition string (e.g. `S.Struct({ name: S.String })`)
 * into an Effect Schema.
 *
 * The `S` binding refers to `Schema` from "effect" and is provided
 * to the expression via the `JsEvaluator` service.
 */
export const parseSchema = (
  def: string
): Effect.Effect<Schema.Any, SchemaDefEvalError, JsEvaluator> =>
  Effect.gen(function* () {
    const evaluator = yield* JsEvaluator;
    const result = yield* evaluator.evaluate(def, { S: Schema }).pipe(
      Effect.catchTag("TransformError", (err) =>
        Effect.fail(
          new SchemaDefEvalError({
            reason: `Failed to evaluate schema def: ${err.reason}`,
          })
        )
      )
    );
    return result as Schema.Any;
  });

/**
 * Validate `data` against a schema definition string.
 * Succeeds with void, or fails with ValidationError | SchemaDefEvalError.
 */
export const validate = (
  def: string,
  data: unknown
): Effect.Effect<void, ValidationError | SchemaDefEvalError, JsEvaluator> =>
  Effect.gen(function* () {
    const schema = yield* parseSchema(def);
    yield* Effect.try({
      try: () => Schema.decodeUnknownSync(schema)(data),
      catch: (cause) =>
        new ValidationError({
          message:
            cause instanceof Schema.SchemaError
              ? cause.message
              : `Validation failed: ${cause}`,
        }),
    });
  });

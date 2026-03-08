import { Effect, Schema } from "effect";
import { SchemaDefEvalError, ValidationError } from "./errors.ts";

/**
 * Parse a schema definition string (e.g. `S.Struct({ name: S.String })`)
 * into an Effect Schema. The `S` binding refers to `Schema` from "effect".
 */
export const parseSchema = (
  def: string
): Effect.Effect<Schema.Any, SchemaDefEvalError> =>
  Effect.try({
    try: () => {
      // eslint-disable-next-line no-new-func
      const fn = new Function("S", `return (${def})`);
      return fn(Schema) as Schema.Any;
    },
    catch: (cause) =>
      new SchemaDefEvalError({
        reason: `Failed to evaluate schema def: ${cause}`,
      }),
  });

/**
 * Validate `data` against a schema definition string.
 * Succeeds with void, or fails with ValidationError | SchemaDefEvalError.
 */
export const validate = (
  def: string,
  data: unknown
): Effect.Effect<void, ValidationError | SchemaDefEvalError> =>
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

import { Schema } from "effect";

/** Schema not found by id */
export class SchemaNotFoundError extends Schema.TaggedErrorClass<SchemaNotFoundError>()(
  "SchemaNotFoundError",
  { schemaId: Schema.String }
) {}

/** Entity not found by id */
export class EntityNotFoundError extends Schema.TaggedErrorClass<EntityNotFoundError>()(
  "EntityNotFoundError",
  { entityId: Schema.String }
) {}

/** Schema validation failed */
export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()(
  "ValidationError",
  { message: Schema.String }
) {}

/** No lens path exists between two schemas */
export class LensPathNotFoundError extends Schema.TaggedErrorClass<LensPathNotFoundError>()(
  "LensPathNotFoundError",
  {
    fromSchema: Schema.String,
    toSchema: Schema.String,
  }
) {}

/** Evaluating a schema def string (new Function) failed */
export class SchemaDefEvalError extends Schema.TaggedErrorClass<SchemaDefEvalError>()(
  "SchemaDefEvalError",
  { reason: Schema.String }
) {}

/** Applying a lens transform function failed */
export class TransformError extends Schema.TaggedErrorClass<TransformError>()(
  "TransformError",
  { reason: Schema.String }
) {}

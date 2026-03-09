import { Schema } from "effect";

/** Entity not found by id. */
export class EntityNotFoundError extends Schema.TaggedErrorClass<EntityNotFoundError>()(
  "EntityNotFoundError",
  { entityId: Schema.String, message: Schema.String },
) {}

/** Schema validation failed. */
export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()(
  "ValidationError",
  { message: Schema.String },
) {}

/** No lens path exists between two schema versions. */
export class LensPathNotFoundError extends Schema.TaggedErrorClass<LensPathNotFoundError>()(
  "LensPathNotFoundError",
  {
    fromType: Schema.String,
    toType: Schema.String,
    message: Schema.String,
  },
) {}

/** Applying a lens transformation failed. */
export class TransformError extends Schema.TaggedErrorClass<TransformError>()(
  "TransformError",
  { reason: Schema.String },
) {}

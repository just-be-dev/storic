export { Store } from "./store.ts";
export type { StoreShape, StoreError } from "./store.ts";
export {
  SchemaNotFoundError,
  EntityNotFoundError,
  ValidationError,
  LensPathNotFoundError,
  SchemaDefEvalError,
  TransformError,
} from "./errors.ts";
export type {
  Schema,
  Lens,
  Entity,
  PathStep,
  ReachabilityRow,
  UpdateMode,
  CreateEntityOptions,
  GetEntityOptions,
  ListEntitiesOptions,
  RegisterLensOptions,
} from "./types.ts";
export { validate, parseSchema } from "./validate.ts";
export { hashDef } from "./hash.ts";

// ─── Core Store ─────────────────────────────────────────────────────────────
export { Store } from "./store.ts";
export type { StoreShape, StoreError } from "./store.ts";

// ─── Lens ───────────────────────────────────────────────────────────────────
export { defineLens } from "./lens.ts";

// ─── Schema Registry ────────────────────────────────────────────────────────
export { SchemaRegistry, getTag } from "./schema-registry.ts";

// ─── Annotations ────────────────────────────────────────────────────────────
export {
  extractFieldMetadata,
  getIndexedFields,
} from "./annotations.ts";
export type { FieldMetadata } from "./annotations.ts";

// ─── Errors ─────────────────────────────────────────────────────────────────
export {
  EntityNotFoundError,
  ValidationError,
  LensPathNotFoundError,
  TransformError,
} from "./errors.ts";

// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  AnyTaggedStruct,
  EntityRecord,
  Lens,
  LensPath,
  LensPathStep,
  StoreConfig,
  UpdateMode,
} from "./types.ts";

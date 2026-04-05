// ─── Core Store ─────────────────────────────────────────────────────────────
export { Store } from "./store.ts";
export type { StoreShape, StoreError } from "./store.ts";

// ─── Persistence ────────────────────────────────────────────────────────────
export { Persistence } from "./persistence.ts";
export type {
  PersistenceShape,
  PersistenceRecord,
  StoredRecord,
  IndexSpec,
  InitSpec,
  QueryParams,
  Filter,
  FilterOp,
  TypePatch,
  PatchParams,
} from "./persistence.ts";
export { computeIndexSpecs } from "./compute-indexes.ts";

// ─── Lens ───────────────────────────────────────────────────────────────────
export { defineLens } from "./lens.ts";

// ─── Schema Registry ────────────────────────────────────────────────────────
export { SchemaRegistry, getTag } from "./schema-registry.ts";

// ─── Annotations ────────────────────────────────────────────────────────────
export { extractFieldMetadata, getIndexedFields } from "./annotations.ts";
export type { FieldMetadata } from "./annotations.ts";

// ─── Errors ─────────────────────────────────────────────────────────────────
export {
  EntityNotFoundError,
  ValidationError,
  LensPathNotFoundError,
  TransformError,
  PersistenceError,
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

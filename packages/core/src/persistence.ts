import { Effect, ServiceMap } from "effect";
import type { PersistenceError } from "./errors.ts";

// ─── Persistence Record Types ──────────────────────────────────────────────

/** A record to be stored — no schema knowledge, just raw data. */
export interface PersistenceRecord {
  readonly id: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** A record as returned from storage, with timestamps. */
export interface StoredRecord extends PersistenceRecord {
  readonly created_at: number;
  readonly updated_at: number;
}

// ─── Index Specification ───────────────────────────────────────────────────

/** Backend-agnostic index specification. */
export interface IndexSpec {
  /** Index name, e.g. "Person_v1__email" */
  readonly name: string;
  /** Field path in the data object, e.g. "email" or "address.city" */
  readonly fieldPath: string;
  /** Type discriminator value, e.g. "Person.v1" */
  readonly typeDiscriminator: string;
}

/** Specification passed to initialize. */
export interface InitSpec {
  readonly indexes: ReadonlyArray<IndexSpec>;
}

// ─── Filters ───────────────────────────────────────────────────────────────

/** Supported filter operators. */
export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "like";

/** A single filter condition on a data field. */
export interface Filter {
  /** Field path in the data object, e.g. "email" or "address.city" */
  readonly field: string;
  /** Comparison operator. */
  readonly op: FilterOp;
  /** Value to compare against. For "in", this should be an array. */
  readonly value: unknown;
}

// ─── Query Parameters ──────────────────────────────────────────────────────

/** Structured query parameters for loading entities by type. */
export interface QueryParams {
  readonly types: ReadonlyArray<string>;
  readonly filters?: ReadonlyArray<Filter>;
  readonly limit?: number;
  readonly offset?: number;
}

// ─── Patch Parameters ──────────────────────────────────────────────────────

/** A per-type patch entry. */
export interface TypePatch {
  readonly type: string;
  readonly patch: Record<string, unknown>;
  readonly filters?: ReadonlyArray<Filter>;
}

/** Parameters for a batch patch operation. */
export interface PatchParams {
  readonly patches: ReadonlyArray<TypePatch>;
}

// ─── Persistence Service ───────────────────────────────────────────────────

export interface PersistenceShape {
  /**
   * Initialize the persistence backend.
   * Creates storage structures and applies the declared indexes.
   */
  readonly initialize: (spec: InitSpec) => Effect.Effect<void, PersistenceError>;

  /** Insert a new record. */
  readonly put: (record: PersistenceRecord) => Effect.Effect<StoredRecord, PersistenceError>;

  /** Fetch a single record by ID. Returns null if not found. */
  readonly get: (id: string) => Effect.Effect<StoredRecord | null, PersistenceError>;

  /** Query records by type(s) with optional field-level filters. */
  readonly query: (params: QueryParams) => Effect.Effect<Array<StoredRecord>, PersistenceError>;

  /** Update a record's type and data. */
  readonly update: (
    id: string,
    record: { readonly type: string; readonly data: Record<string, unknown> },
  ) => Effect.Effect<StoredRecord, PersistenceError>;

  /**
   * Merge-patch records matching the given types and optional filters.
   * Each entry patches matching records of that type.
   * Implementations should execute atomically (e.g. in a transaction).
   * Returns total number of rows affected.
   */
  readonly patch: (params: PatchParams) => Effect.Effect<number, PersistenceError>;

  /** Delete a record by ID. */
  readonly remove: (id: string) => Effect.Effect<void, PersistenceError>;
}

export class Persistence extends ServiceMap.Service<Persistence, PersistenceShape>()(
  "storic/Persistence",
) {}

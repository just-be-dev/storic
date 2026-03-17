import { Effect, Layer, Schema, ServiceMap } from "effect";
import {
  EntityNotFoundError,
  LensPathNotFoundError,
  PersistenceError,
  TransformError,
  ValidationError,
} from "./errors.ts";
import { computeIndexSpecs } from "./compute-indexes.ts";
import { Persistence } from "./persistence.ts";
import type { Filter, TypePatch } from "./persistence.ts";
import { SchemaRegistry, getTag } from "./schema-registry.ts";
import type { AnyTaggedStruct, EntityRecord, LensPath, StoreConfig, UpdateMode } from "./types.ts";

// ─── Internal validation helper ─────────────────────────────────────────────

/**
 * Validate data against a schema using decodeUnknownSync.
 * Casts internally to avoid DecodingServices constraint on generics.
 */
function validateSync(schema: AnyTaggedStruct, data: unknown): void {
  const decode = Schema.decodeUnknownSync(schema as any);
  decode(data);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const generateId = (): string => crypto.randomUUID();

/**
 * Apply a lens path to transform data from one schema version to another.
 */
function applyLensPath(path: LensPath, data: unknown): Effect.Effect<unknown, TransformError> {
  return Effect.gen(function* () {
    let current = data;

    for (const step of path.steps) {
      try {
        current = step.transform(current);
      } catch (error) {
        return yield* new TransformError({
          reason: `Failed to transform from ${step.fromType} to ${step.toType}: ${error}`,
        });
      }
    }

    return current;
  });
}

/**
 * Get the set of user-facing field names from a TaggedStruct schema (excludes _tag).
 */
function getFieldNames(schema: AnyTaggedStruct): Set<string> {
  const names = new Set(Object.keys(schema.fields));
  names.delete("_tag");
  return names;
}

// ─── Store Error Union ──────────────────────────────────────────────────────

export type StoreError =
  | EntityNotFoundError
  | LensPathNotFoundError
  | ValidationError
  | TransformError
  | PersistenceError;

// ─── Store Service Shape ────────────────────────────────────────────────────

export interface StoreShape {
  /** Save an entity. The `_tag` field is added automatically. */
  readonly saveEntity: <T extends AnyTaggedStruct>(
    schema: T,
    data: Omit<Schema.Schema.Type<T>, "_tag">,
    opts?: { readonly id?: string },
  ) => Effect.Effect<EntityRecord<T>, ValidationError | PersistenceError>;

  /** Load a single entity by ID, projected to the given schema version. */
  readonly loadEntity: <T extends AnyTaggedStruct>(
    schema: T,
    id: string,
  ) => Effect.Effect<
    EntityRecord<T>,
    | EntityNotFoundError
    | LensPathNotFoundError
    | TransformError
    | ValidationError
    | PersistenceError
  >;

  /**
   * Load all entities of a schema type, including connected versions
   * auto-converted via lenses.
   *
   * **Pagination caveat:** When multiple schema versions are connected via
   * lenses, `limit` and `offset` apply to the combined SQL query across all
   * connected types. This means page boundaries may produce uneven type
   * distributions (e.g., a page could contain only V1 records). For
   * predictable pagination, filter to fields present in all versions or
   * query a single unconnected type.
   */
  readonly loadEntities: <T extends AnyTaggedStruct>(
    schema: T,
    opts?: {
      readonly filters?: ReadonlyArray<Filter>;
      readonly limit?: number;
      readonly offset?: number;
    },
  ) => Effect.Effect<
    Array<EntityRecord<T>>,
    LensPathNotFoundError | TransformError | ValidationError | PersistenceError
  >;

  /**
   * Update an entity's data.
   *
   * **Schema migration on write:** If the entity was stored as a different
   * schema version, it will be projected to the target schema via lenses,
   * the update applied, and the result stored as the target schema version.
   * The stored `type` will change to match the target schema.
   */
  readonly updateEntity: {
    /** Update with merge mode (default) — partial data is merged with existing. */
    <T extends AnyTaggedStruct>(
      schema: T,
      id: string,
      data: Partial<Omit<Schema.Schema.Type<T>, "_tag">>,
      opts?: { readonly mode?: "merge" },
    ): Effect.Effect<
      EntityRecord<T>,
      | EntityNotFoundError
      | LensPathNotFoundError
      | TransformError
      | ValidationError
      | PersistenceError
    >;

    /** Update with replace mode — full data replaces the existing entity. */
    <T extends AnyTaggedStruct>(
      schema: T,
      id: string,
      data: Omit<Schema.Schema.Type<T>, "_tag">,
      opts: { readonly mode: "replace" },
    ): Effect.Effect<
      EntityRecord<T>,
      | EntityNotFoundError
      | LensPathNotFoundError
      | TransformError
      | ValidationError
      | PersistenceError
    >;
  };

  /**
   * Patch all entities reachable from the given schema type.
   * For each connected schema version, only fields that exist in that
   * version are applied. Optional filters narrow which records are patched.
   * Returns the total number of records updated.
   *
   * **Note:** Patches are applied at the SQL level via `json_patch` and
   * bypass schema validation. Callers are responsible for ensuring patch
   * values conform to schema field types. For validated updates, use
   * `updateEntity` on individual records.
   */
  readonly patchEntities: <T extends AnyTaggedStruct>(
    schema: T,
    patch: Partial<Omit<Schema.Schema.Type<T>, "_tag">>,
    opts?: { readonly filters?: ReadonlyArray<Filter> },
  ) => Effect.Effect<number, PersistenceError>;

  /** Delete an entity by ID. */
  readonly deleteEntity: (id: string) => Effect.Effect<void, PersistenceError>;
}

// ─── Store Service ──────────────────────────────────────────────────────────

export class Store extends ServiceMap.Service<Store, StoreShape>()("datastore/Store") {
  /**
   * Create a Store layer from a StoreConfig and a Persistence backend.
   *
   * On initialization:
   * 1. Builds the schema registry and lens graph
   * 2. Computes index specs from schema annotations
   * 3. Calls persistence.initialize() with the index specs
   */
  static readonly layer = (
    config: StoreConfig,
  ): Layer.Layer<Store, PersistenceError, Persistence> =>
    Layer.effect(
      Store,
      Effect.gen(function* () {
        const persistence = yield* Persistence;

        // ── Schema Registry ─────────────────────────────────────────────
        const registry = new SchemaRegistry(config);

        // ── Compute and apply indexes ───────────────────────────────────
        const indexes = computeIndexSpecs(registry);
        yield* persistence.initialize({ indexes });

        // ── Implementation ──────────────────────────────────────────────

        const saveEntity = <T extends AnyTaggedStruct>(
          schema: T,
          data: Omit<Schema.Schema.Type<T>, "_tag">,
          opts?: { readonly id?: string },
        ): Effect.Effect<EntityRecord<T>, ValidationError | PersistenceError> =>
          Effect.gen(function* () {
            const tag = getTag(schema);
            const fullData = { _tag: tag, ...data } as unknown as Schema.Schema.Type<T>;

            // Validate using the schema
            try {
              validateSync(schema, fullData);
            } catch (error) {
              return yield* new ValidationError({
                message: `Validation failed for ${tag}: ${error}`,
              });
            }

            const id = opts?.id ?? generateId();

            const stored = yield* persistence.put({
              id,
              type: tag,
              data: fullData as unknown as Record<string, unknown>,
            });

            return {
              id: stored.id,
              data: stored.data as unknown as Schema.Schema.Type<T>,
              created_at: stored.created_at,
              updated_at: stored.updated_at,
            };
          });

        const loadEntity = <T extends AnyTaggedStruct>(
          schema: T,
          id: string,
        ): Effect.Effect<
          EntityRecord<T>,
          | EntityNotFoundError
          | LensPathNotFoundError
          | TransformError
          | ValidationError
          | PersistenceError
        > =>
          Effect.gen(function* () {
            const stored = yield* persistence.get(id);

            if (!stored) {
              return yield* new EntityNotFoundError({
                entityId: id,
                message: `Entity not found: ${id}`,
              });
            }

            const targetTag = getTag(schema);
            const storedType = stored.type;

            let converted: Schema.Schema.Type<T>;
            if (storedType === targetTag) {
              converted = stored.data as unknown as Schema.Schema.Type<T>;
            } else {
              const path = registry.getPath(storedType, targetTag);
              if (!path) {
                return yield* new LensPathNotFoundError({
                  fromType: storedType,
                  toType: targetTag,
                  message: `No lens path from ${storedType} to ${targetTag}`,
                });
              }
              converted = (yield* applyLensPath(path, stored.data)) as Schema.Schema.Type<T>;
            }

            // Validate lens output against target schema
            if (storedType !== targetTag) {
              try {
                validateSync(schema, converted);
              } catch (error) {
                return yield* new ValidationError({
                  message: `Lens output validation failed for ${targetTag}: ${error}`,
                });
              }
            }

            return {
              id: stored.id,
              data: converted,
              created_at: stored.created_at,
              updated_at: stored.updated_at,
            };
          });

        const loadEntities = <T extends AnyTaggedStruct>(
          schema: T,
          opts?: {
            readonly filters?: ReadonlyArray<Filter>;
            readonly limit?: number;
            readonly offset?: number;
          },
        ): Effect.Effect<
          Array<EntityRecord<T>>,
          LensPathNotFoundError | TransformError | ValidationError | PersistenceError
        > =>
          Effect.gen(function* () {
            const targetTag = getTag(schema);
            const filters = opts?.filters;

            // Get all tags connected via lenses, excluding types that
            // don't have all filtered fields (to avoid silently widening results)
            const connectedTags = registry.getConnectedTags(targetTag).filter((tag) => {
              if (!filters?.length) return true;
              const tagSchema = registry.getSchemaByTag(tag);
              if (!tagSchema) return false;
              const fieldNames = getFieldNames(tagSchema);
              return filters.every((f) => fieldNames.has(f.field));
            });

            // Query for all connected types
            const rows = yield* persistence.query({
              types: connectedTags,
              filters,
              limit: opts?.limit,
              offset: opts?.offset,
            });

            // Transform each row to the target schema
            const results: Array<EntityRecord<T>> = [];

            for (const row of rows) {
              let converted: Schema.Schema.Type<T>;
              if (row.type === targetTag) {
                converted = row.data as unknown as Schema.Schema.Type<T>;
              } else {
                const path = registry.getPath(row.type, targetTag);
                if (!path) {
                  return yield* new LensPathNotFoundError({
                    fromType: row.type,
                    toType: targetTag,
                    message: `No lens path from ${row.type} to ${targetTag}`,
                  });
                }
                converted = (yield* applyLensPath(path, row.data)) as Schema.Schema.Type<T>;

                // Validate lens output against target schema
                try {
                  validateSync(schema, converted);
                } catch (error) {
                  return yield* new ValidationError({
                    message: `Lens output validation failed for ${targetTag} (from ${row.type}): ${error}`,
                  });
                }
              }

              results.push({
                id: row.id,
                data: converted,
                created_at: row.created_at,
                updated_at: row.updated_at,
              });
            }

            return results;
          });

        const updateEntity = <T extends AnyTaggedStruct>(
          schema: T,
          id: string,
          data: Partial<Omit<Schema.Schema.Type<T>, "_tag">>,
          opts?: { readonly mode?: UpdateMode },
        ): Effect.Effect<
          EntityRecord<T>,
          | EntityNotFoundError
          | LensPathNotFoundError
          | TransformError
          | ValidationError
          | PersistenceError
        > =>
          Effect.gen(function* () {
            const targetTag = getTag(schema);

            // Fetch existing entity
            const stored = yield* persistence.get(id);

            if (!stored) {
              return yield* new EntityNotFoundError({
                entityId: id,
                message: `Entity not found: ${id}`,
              });
            }

            const storedType = stored.type;

            // Project existing data to target schema if needed
            let projected: Record<string, unknown>;
            if (storedType === targetTag) {
              projected = stored.data;
            } else {
              const path = registry.getPath(storedType, targetTag);
              if (!path) {
                return yield* new LensPathNotFoundError({
                  fromType: storedType,
                  toType: targetTag,
                  message: `No lens path from ${storedType} to ${targetTag}`,
                });
              }
              projected = (yield* applyLensPath(path, stored.data)) as Record<string, unknown>;
            }

            // Apply update
            const mode = opts?.mode ?? "merge";
            const newData =
              mode === "merge"
                ? ({ ...projected, ...data, _tag: targetTag } as unknown as Schema.Schema.Type<T>)
                : ({ ...data, _tag: targetTag } as unknown as Schema.Schema.Type<T>);

            // Validate
            try {
              validateSync(schema, newData);
            } catch (error) {
              return yield* new ValidationError({
                message: `Validation failed for ${targetTag}: ${error}`,
              });
            }

            // Persist (always stored as the target schema version)
            const updated = yield* persistence.update(id, {
              type: targetTag,
              data: newData as unknown as Record<string, unknown>,
            });

            return {
              id: updated.id,
              data: updated.data as unknown as Schema.Schema.Type<T>,
              created_at: updated.created_at,
              updated_at: updated.updated_at,
            };
          });

        const patchEntities = <T extends AnyTaggedStruct>(
          schema: T,
          patch: Partial<Omit<Schema.Schema.Type<T>, "_tag">>,
          opts?: { readonly filters?: ReadonlyArray<Filter> },
        ): Effect.Effect<number, PersistenceError> =>
          Effect.gen(function* () {
            const targetTag = getTag(schema);
            const connectedTags = registry.getConnectedTags(targetTag);
            const patchKeys = Object.keys(patch);
            const filters = opts?.filters;

            const patches: TypePatch[] = [];

            for (const tag of connectedTags) {
              const tagSchema = registry.getSchemaByTag(tag);
              if (!tagSchema) continue;

              const fieldNames = getFieldNames(tagSchema);

              // Skip this type entirely if any filter references a field
              // that doesn't exist — avoids silently widening the patch scope
              if (filters?.length) {
                const allFiltersApplicable = filters.every((f) => fieldNames.has(f.field));
                if (!allFiltersApplicable) continue;
              }

              // Filter patch to only include fields present in this schema version
              const filtered: Record<string, unknown> = {};
              let hasKeys = false;

              for (const key of patchKeys) {
                if (fieldNames.has(key)) {
                  filtered[key] = (patch as Record<string, unknown>)[key];
                  hasKeys = true;
                }
              }

              if (hasKeys) {
                patches.push({
                  type: tag,
                  patch: filtered,
                  filters,
                });
              }
            }

            if (patches.length === 0) return 0;

            return yield* persistence.patch({ patches });
          });

        const deleteEntity = (id: string): Effect.Effect<void, PersistenceError> =>
          persistence.remove(id);

        // ── Return service ──────────────────────────────────────────────

        return Store.of({
          saveEntity,
          loadEntity,
          loadEntities,
          updateEntity,
          patchEntities,
          deleteEntity,
        });
      }),
    );
}

import { Effect, Layer, Schema, ServiceMap } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  EntityNotFoundError,
  LensPathNotFoundError,
  TransformError,
  ValidationError,
} from "./errors.ts";
import { syncIndexes } from "./index-sync.ts";
import { SchemaRegistry, getTag } from "./schema-registry.ts";
import type {
  AnyTaggedStruct,
  EntityRecord,
  LensPath,
  StoreConfig,
  UpdateMode,
} from "./types.ts";

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

/** Parse a DB row into an EntityRecord. */
function deserializeRow<T extends AnyTaggedStruct>(
  row: Record<string, unknown>,
): EntityRecord<T> {
  return {
    id: row.id as string,
    data: JSON.parse(row.data as string) as Schema.Schema.Type<T>,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

/**
 * Apply a lens path to transform data from one schema version to another.
 */
function applyLensPath(
  path: LensPath,
  data: unknown,
): Effect.Effect<unknown, TransformError> {
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

// ─── Store Error Union ──────────────────────────────────────────────────────

export type StoreError =
  | EntityNotFoundError
  | LensPathNotFoundError
  | ValidationError
  | TransformError
  | SqlError;

// ─── Store Service Shape ────────────────────────────────────────────────────

export interface StoreShape {
  /** Save an entity. The `_tag` field is added automatically. */
  readonly saveEntity: <T extends AnyTaggedStruct>(
    schema: T,
    data: Omit<Schema.Schema.Type<T>, "_tag">,
    opts?: { readonly id?: string },
  ) => Effect.Effect<EntityRecord<T>, ValidationError | SqlError>;

  /** Load a single entity by ID, projected to the given schema version. */
  readonly loadEntity: <T extends AnyTaggedStruct>(
    schema: T,
    id: string,
  ) => Effect.Effect<
    EntityRecord<T>,
    EntityNotFoundError | LensPathNotFoundError | TransformError | SqlError
  >;

  /**
   * Load all entities of a schema type, including connected versions
   * auto-converted via lenses.
   */
  readonly loadEntities: <T extends AnyTaggedStruct>(
    schema: T,
    opts?: { readonly limit?: number; readonly offset?: number },
  ) => Effect.Effect<
    Array<EntityRecord<T>>,
    LensPathNotFoundError | TransformError | SqlError
  >;

  /** Update an entity's data. */
  readonly updateEntity: <T extends AnyTaggedStruct>(
    schema: T,
    id: string,
    data: Partial<Omit<Schema.Schema.Type<T>, "_tag">>,
    opts?: { readonly mode?: UpdateMode },
  ) => Effect.Effect<
    EntityRecord<T>,
    | EntityNotFoundError
    | LensPathNotFoundError
    | TransformError
    | ValidationError
    | SqlError
  >;

  /** Delete an entity by ID. */
  readonly deleteEntity: (
    id: string,
  ) => Effect.Effect<void, SqlError>;
}

// ─── Store Service ──────────────────────────────────────────────────────────

export class Store extends ServiceMap.Service<Store, StoreShape>()(
  "datastore/Store",
) {
  /**
   * Create a Store layer from a StoreConfig and a SqlClient.
   *
   * On initialization:
   * 1. Creates the `entities` table (if not exists)
   * 2. Builds the schema registry and lens graph
   * 3. Auto-syncs indexes from schema annotations
   */
  static readonly layer = (
    config: StoreConfig,
  ): Layer.Layer<Store, SqlError, SqlClient> =>
    Layer.effect(
      Store,
      Effect.gen(function* () {
        const sql = yield* SqlClient;

        // ── DDL ─────────────────────────────────────────────────────────
        yield* sql.unsafe(`
          CREATE TABLE IF NOT EXISTS entities (
            id         TEXT PRIMARY KEY,
            type       TEXT NOT NULL,
            data       JSON NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
          )
        `);
        yield* sql.unsafe(`
          CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)
        `);

        // ── Schema Registry ─────────────────────────────────────────────
        const registry = new SchemaRegistry(config);

        // ── Auto-sync indexes ───────────────────────────────────────────
        yield* syncIndexes(registry);

        // ── Implementation ──────────────────────────────────────────────

        const saveEntity = <T extends AnyTaggedStruct>(
          schema: T,
          data: Omit<Schema.Schema.Type<T>, "_tag">,
          opts?: { readonly id?: string },
        ): Effect.Effect<EntityRecord<T>, ValidationError | SqlError> =>
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

            yield* sql`
              INSERT INTO entities (id, type, data)
              VALUES (${id}, ${tag}, ${JSON.stringify(fullData)})
            `;

            const rows = yield* sql<
              Record<string, unknown>
            >`SELECT * FROM entities WHERE id = ${id}`;

            return deserializeRow<T>(rows[0]);
          });

        const loadEntity = <T extends AnyTaggedStruct>(
          schema: T,
          id: string,
        ): Effect.Effect<
          EntityRecord<T>,
          | EntityNotFoundError
          | LensPathNotFoundError
          | TransformError
          | SqlError
        > =>
          Effect.gen(function* () {
            const rows = yield* sql<
              Record<string, unknown>
            >`SELECT * FROM entities WHERE id = ${id}`;

            if (rows.length === 0) {
              return yield* new EntityNotFoundError({
                entityId: id,
                message: `Entity not found: ${id}`,
              });
            }

            const row = rows[0];
            const targetTag = getTag(schema);
            const storedType = row.type as string;
            const parsed = JSON.parse(row.data as string);

            let converted: Schema.Schema.Type<T>;
            if (storedType === targetTag) {
              converted = parsed;
            } else {
              const path = registry.getPath(storedType, targetTag);
              if (!path) {
                return yield* new LensPathNotFoundError({
                  fromType: storedType,
                  toType: targetTag,
                  message: `No lens path from ${storedType} to ${targetTag}`,
                });
              }
              converted = (yield* applyLensPath(
                path,
                parsed,
              )) as Schema.Schema.Type<T>;
            }

            return {
              id: row.id as string,
              data: converted,
              created_at: row.created_at as number,
              updated_at: row.updated_at as number,
            };
          });

        const loadEntities = <T extends AnyTaggedStruct>(
          schema: T,
          opts?: { readonly limit?: number; readonly offset?: number },
        ): Effect.Effect<
          Array<EntityRecord<T>>,
          LensPathNotFoundError | TransformError | SqlError
        > =>
          Effect.gen(function* () {
            const targetTag = getTag(schema);

            // Get all tags connected via lenses
            const connectedTags = registry.getConnectedTags(targetTag);

            // Query for all connected types
            const rows = yield* sql<Record<string, unknown>>`
              SELECT * FROM entities
              WHERE type IN ${sql.in(connectedTags)}
              ORDER BY created_at DESC
              ${opts?.limit != null ? sql.unsafe(`LIMIT ${opts.limit}`) : sql.unsafe("")}
              ${opts?.offset != null ? sql.unsafe(`OFFSET ${opts.offset}`) : sql.unsafe("")}
            `;

            // Transform each row to the target schema
            const results: Array<EntityRecord<T>> = [];

            for (const row of rows) {
              const storedType = row.type as string;
              const parsed = JSON.parse(row.data as string);

              let converted: Schema.Schema.Type<T>;
              if (storedType === targetTag) {
                converted = parsed;
              } else {
                const path = registry.getPath(storedType, targetTag);
                if (!path) {
                  return yield* new LensPathNotFoundError({
                    fromType: storedType,
                    toType: targetTag,
                    message: `No lens path from ${storedType} to ${targetTag}`,
                  });
                }
                converted = (yield* applyLensPath(
                  path,
                  parsed,
                )) as Schema.Schema.Type<T>;
              }

              results.push({
                id: row.id as string,
                data: converted,
                created_at: row.created_at as number,
                updated_at: row.updated_at as number,
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
          | SqlError
        > =>
          Effect.gen(function* () {
            const targetTag = getTag(schema);

            // Fetch existing entity
            const rows = yield* sql<
              Record<string, unknown>
            >`SELECT * FROM entities WHERE id = ${id}`;

            if (rows.length === 0) {
              return yield* new EntityNotFoundError({
                entityId: id,
                message: `Entity not found: ${id}`,
              });
            }

            const row = rows[0];
            const storedType = row.type as string;
            const existingData = JSON.parse(row.data as string);

            // Project existing data to target schema if needed
            let projected: Record<string, unknown>;
            if (storedType === targetTag) {
              projected = existingData;
            } else {
              const path = registry.getPath(storedType, targetTag);
              if (!path) {
                return yield* new LensPathNotFoundError({
                  fromType: storedType,
                  toType: targetTag,
                  message: `No lens path from ${storedType} to ${targetTag}`,
                });
              }
              projected = (yield* applyLensPath(
                path,
                existingData,
              )) as Record<string, unknown>;
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
            yield* sql`
              UPDATE entities
              SET type = ${targetTag},
                  data = ${JSON.stringify(newData)},
                  updated_at = unixepoch()
              WHERE id = ${id}
            `;

            const updated = yield* sql<
              Record<string, unknown>
            >`SELECT * FROM entities WHERE id = ${id}`;

            return deserializeRow<T>(updated[0]);
          });

        const deleteEntity = (
          id: string,
        ): Effect.Effect<void, SqlError> =>
          Effect.gen(function* () {
            yield* sql`DELETE FROM entities WHERE id = ${id}`;
          });

        // ── Return service ──────────────────────────────────────────────

        return Store.of({
          saveEntity,
          loadEntity,
          loadEntities,
          updateEntity,
          deleteEntity,
        });
      }),
    );
}

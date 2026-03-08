import { Effect, Layer, ServiceMap } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { hashDef, generateId } from "./hash.ts";
import { computeTransitiveClosure } from "./closure.ts";
import { applyLensChain } from "./transform.ts";
import { validate } from "./validate.ts";
import {
  SchemaNotFoundError,
  EntityNotFoundError,
  LensPathNotFoundError,
  ValidationError,
  SchemaDefEvalError,
  TransformError,
} from "./errors.ts";
import type {
  Schema,
  Lens,
  Entity,
  PathStep,
  UpdateMode,
  CreateEntityOptions,
  GetEntityOptions,
  ListEntitiesOptions,
  RegisterLensOptions,
} from "./types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const now = (): number => Math.floor(Date.now() / 1000);

const deserializeEntity = (row: Record<string, unknown>): Entity => ({
  id: row.id as string,
  schema_id: row.schema_id as string,
  data: JSON.parse(row.data as string),
  created_at: row.created_at as number,
  updated_at: row.updated_at as number,
});

// ─── Store errors (union of all possible errors) ─────────────────────────────

export type StoreError =
  | SchemaNotFoundError
  | EntityNotFoundError
  | LensPathNotFoundError
  | ValidationError
  | SchemaDefEvalError
  | TransformError
  | SqlError;

// ─── Store service shape ─────────────────────────────────────────────────────

export interface StoreShape {
  // Schema operations
  readonly registerSchema: (
    name: string,
    def: string
  ) => Effect.Effect<Schema, SqlError>;

  readonly getSchema: (
    id: string
  ) => Effect.Effect<Schema, SchemaNotFoundError | SqlError>;

  readonly listSchemas: () => Effect.Effect<Schema[], SqlError>;

  // Lens operations
  readonly registerLens: (
    opts: RegisterLensOptions
  ) => Effect.Effect<Lens, SqlError>;

  readonly getLens: (
    id: string
  ) => Effect.Effect<Lens | undefined, SqlError>;

  readonly listLenses: () => Effect.Effect<Lens[], SqlError>;

  // Entity operations
  readonly createEntity: (
    schemaId: string,
    data: Record<string, unknown>,
    opts?: CreateEntityOptions
  ) => Effect.Effect<
    Entity,
    SchemaNotFoundError | ValidationError | SchemaDefEvalError | SqlError
  >;

  readonly getEntity: (
    id: string,
    opts?: GetEntityOptions
  ) => Effect.Effect<
    Entity,
    EntityNotFoundError | LensPathNotFoundError | TransformError | SqlError
  >;

  readonly updateEntity: (
    id: string,
    data: Record<string, unknown>,
    opts?: { mode?: UpdateMode; validate?: boolean }
  ) => Effect.Effect<
    Entity,
    | EntityNotFoundError
    | SchemaNotFoundError
    | ValidationError
    | SchemaDefEvalError
    | SqlError
  >;

  readonly deleteEntity: (id: string) => Effect.Effect<void, SqlError>;

  readonly listEntities: (
    schemaId: string,
    opts?: ListEntitiesOptions
  ) => Effect.Effect<
    Entity[],
    LensPathNotFoundError | TransformError | SqlError
  >;

  // Index operations
  readonly createIndex: (
    indexName: string,
    jsonPath: string,
    tableName?: string
  ) => Effect.Effect<void, SqlError>;

  readonly dropIndex: (indexName: string) => Effect.Effect<void, SqlError>;

  readonly listIndexes: () => Effect.Effect<string[], SqlError>;
}

// ─── Store service ───────────────────────────────────────────────────────────

export class Store extends ServiceMap.Service<Store, StoreShape>()(
  "nosql-sqlite/Store"
) {
  /** Create a Store layer from a SqlClient layer. */
  static readonly layer: Layer.Layer<Store, SqlError, SqlClient> = Layer.effect(
    Store,
    Effect.gen(function* () {
      const sql = yield* SqlClient;

      // ── DDL migration ───────────────────────────────────────────────
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS schemas (
          id   TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          def  TEXT NOT NULL
        )
      `);
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS lenses (
          id          TEXT PRIMARY KEY,
          from_schema TEXT NOT NULL REFERENCES schemas(id),
          to_schema   TEXT NOT NULL REFERENCES schemas(id),
          forward     TEXT NOT NULL,
          backward    TEXT NOT NULL,
          UNIQUE (from_schema, to_schema)
        )
      `);
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS schema_reachability (
          from_schema TEXT NOT NULL REFERENCES schemas(id),
          to_schema   TEXT NOT NULL REFERENCES schemas(id),
          path        TEXT NOT NULL,
          PRIMARY KEY (from_schema, to_schema)
        )
      `);
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS entities (
          id         TEXT PRIMARY KEY,
          schema_id  TEXT NOT NULL REFERENCES schemas(id),
          data       JSON NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      yield* sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_entities_schema
          ON entities(schema_id)
      `);

      // ── Internal helpers ────────────────────────────────────────────

      const getSchemaById = (
        id: string
      ): Effect.Effect<Schema, SchemaNotFoundError | SqlError> =>
        Effect.gen(function* () {
          const rows = yield* sql<Schema>`SELECT * FROM schemas WHERE id = ${id}`;
          if (rows.length === 0) {
            return yield* new SchemaNotFoundError({ schemaId: id });
          }
          return rows[0];
        });

      const listAllLenses = (): Effect.Effect<Lens[], SqlError> =>
        Effect.map(sql<Lens>`SELECT * FROM lenses`, (rows) => [...rows]);

      const rebuildReachability = (): Effect.Effect<void, SqlError> =>
        Effect.gen(function* () {
          const lenses = yield* listAllLenses();
          const reachRows = computeTransitiveClosure(lenses);

          yield* sql.unsafe(`DELETE FROM schema_reachability`);

          for (const row of reachRows) {
            yield* sql`
              INSERT OR REPLACE INTO schema_reachability (from_schema, to_schema, path)
              VALUES (${row.from_schema}, ${row.to_schema}, ${JSON.stringify(row.path)})
            `;
          }
        });

      const getLensMap = (): Effect.Effect<
        Map<string, { forward: string; backward: string }>,
        SqlError
      > =>
        Effect.gen(function* () {
          const lenses = yield* listAllLenses();
          return new Map(
            lenses.map((l) => [
              l.id,
              { forward: l.forward, backward: l.backward },
            ])
          );
        });

      const getPath = (
        fromSchema: string,
        toSchema: string
      ): Effect.Effect<PathStep[] | null, SqlError> =>
        Effect.gen(function* () {
          if (fromSchema === toSchema) return [];
          const rows = yield* sql<{
            path: string;
          }>`SELECT path FROM schema_reachability WHERE from_schema = ${fromSchema} AND to_schema = ${toSchema}`;
          if (rows.length === 0) return null;
          return JSON.parse(rows[0].path) as PathStep[];
        });

      const getAllSourceSchemas = (
        targetSchema: string
      ): Effect.Effect<string[], SqlError> =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            from_schema: string;
          }>`SELECT from_schema FROM schema_reachability WHERE to_schema = ${targetSchema}`;
          return [targetSchema, ...rows.map((r) => r.from_schema)];
        });

      const project = (
        entity: Entity,
        targetSchemaId: string
      ): Effect.Effect<
        Record<string, unknown>,
        LensPathNotFoundError | TransformError | SqlError
      > =>
        Effect.gen(function* () {
          const path = yield* getPath(entity.schema_id, targetSchemaId);
          if (path === null) {
            return yield* new LensPathNotFoundError({
              fromSchema: entity.schema_id,
              toSchema: targetSchemaId,
            });
          }
          if (path.length === 0) return entity.data;
          const lm = yield* getLensMap();
          return (yield* applyLensChain(path, lm, entity.data)) as Record<
            string,
            unknown
          >;
        });

      // ── Service implementation ──────────────────────────────────────

      const registerSchema = (
        name: string,
        def: string
      ): Effect.Effect<Schema, SqlError> =>
        Effect.gen(function* () {
          const trimmed = def.trim();
          const id = hashDef(trimmed);
          yield* sql`INSERT OR IGNORE INTO schemas (id, name, def) VALUES (${id}, ${name}, ${trimmed})`;
          return { id, name, def: trimmed } satisfies Schema;
        });

      const registerLens = (
        opts: RegisterLensOptions
      ): Effect.Effect<Lens, SqlError> =>
        Effect.gen(function* () {
          const existing = yield* sql<Lens>`SELECT * FROM lenses WHERE from_schema = ${opts.from} AND to_schema = ${opts.to}`;
          if (existing.length > 0) return existing[0];

          const id = generateId();

          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO lenses (id, from_schema, to_schema, forward, backward)
                VALUES (${id}, ${opts.from}, ${opts.to}, ${opts.forward}, ${opts.backward})
              `;
              yield* rebuildReachability();
            })
          );

          return {
            id,
            from_schema: opts.from,
            to_schema: opts.to,
            forward: opts.forward,
            backward: opts.backward,
          } satisfies Lens;
        });

      const getLensById = (
        id: string
      ): Effect.Effect<Lens | undefined, SqlError> =>
        Effect.gen(function* () {
          const rows = yield* sql<Lens>`SELECT * FROM lenses WHERE id = ${id}`;
          return rows.length > 0 ? rows[0] : undefined;
        });

      const createEntity = (
        schemaId: string,
        data: Record<string, unknown>,
        opts: CreateEntityOptions = {}
      ): Effect.Effect<
        Entity,
        SchemaNotFoundError | ValidationError | SchemaDefEvalError | SqlError
      > =>
        Effect.gen(function* () {
          const schema = yield* getSchemaById(schemaId);

          if (opts.validate !== false) {
            yield* validate(schema.def, data);
          }

          const id = opts.id ?? generateId();
          const ts = now();

          yield* sql`
            INSERT INTO entities (id, schema_id, data, created_at, updated_at)
            VALUES (${id}, ${schemaId}, ${JSON.stringify(data)}, ${ts}, ${ts})
          `;

          return {
            id,
            schema_id: schemaId,
            data,
            created_at: ts,
            updated_at: ts,
          } satisfies Entity;
        });

      const getEntity = (
        id: string,
        opts: GetEntityOptions = {}
      ): Effect.Effect<
        Entity,
        EntityNotFoundError | LensPathNotFoundError | TransformError | SqlError
      > =>
        Effect.gen(function* () {
          const rows = yield* sql<
            Record<string, unknown>
          >`SELECT * FROM entities WHERE id = ${id}`;
          if (rows.length === 0) {
            return yield* new EntityNotFoundError({ entityId: id });
          }

          const entity = deserializeEntity(rows[0]);

          if (opts.as && opts.as !== entity.schema_id) {
            entity.data = yield* project(entity, opts.as);
          }

          return entity;
        });

      const updateEntity = (
        id: string,
        data: Record<string, unknown>,
        opts: { mode?: UpdateMode; validate?: boolean } = {}
      ): Effect.Effect<
        Entity,
        | EntityNotFoundError
        | SchemaNotFoundError
        | ValidationError
        | SchemaDefEvalError
        | SqlError
      > =>
        Effect.gen(function* () {
          const rows = yield* sql<
            Record<string, unknown>
          >`SELECT * FROM entities WHERE id = ${id}`;
          if (rows.length === 0) {
            return yield* new EntityNotFoundError({ entityId: id });
          }

          const existing = deserializeEntity(rows[0]);
          const mode = opts.mode ?? "merge";
          const newData =
            mode === "merge" ? { ...existing.data, ...data } : data;

          if (opts.validate !== false) {
            const schema = yield* getSchemaById(existing.schema_id);
            yield* validate(schema.def, newData);
          }

          const ts = now();
          yield* sql`UPDATE entities SET data = ${JSON.stringify(newData)}, updated_at = ${ts} WHERE id = ${id}`;

          return { ...existing, data: newData, updated_at: ts };
        });

      const deleteEntity = (id: string): Effect.Effect<void, SqlError> =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM entities WHERE id = ${id}`;
        });

      const listEntities = (
        schemaId: string,
        opts: ListEntitiesOptions = {}
      ): Effect.Effect<
        Entity[],
        LensPathNotFoundError | TransformError | SqlError
      > =>
        Effect.gen(function* () {
          const sourceSchemas = yield* getAllSourceSchemas(schemaId);

          const rows = yield* sql<
            Record<string, unknown>
          >`SELECT * FROM entities WHERE schema_id IN ${sql.in(sourceSchemas)}`;

          const targetSchema = opts.as ?? schemaId;
          const entities: Entity[] = [];

          for (const row of rows) {
            const entity = deserializeEntity(row);
            if (entity.schema_id !== targetSchema) {
              entity.data = yield* project(entity, targetSchema);
            }
            entities.push(entity);
          }

          return entities;
        });

      const createIndex = (
        indexName: string,
        jsonPath: string,
        tableName = "entities"
      ): Effect.Effect<void, SqlError> =>
        Effect.gen(function* () {
          yield* sql.unsafe(
            `CREATE INDEX IF NOT EXISTS "${indexName}" ON ${tableName}(json_extract(data, '${jsonPath}'))`
          );
        });

      const dropIndex = (indexName: string): Effect.Effect<void, SqlError> =>
        Effect.gen(function* () {
          yield* sql.unsafe(`DROP INDEX IF EXISTS "${indexName}"`);
        });

      const listIndexes = (): Effect.Effect<string[], SqlError> =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            name: string;
          }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entities'`;
          return rows.map((r) => r.name);
        });

      // ── Return service shape ────────────────────────────────────────

      return Store.of({
        registerSchema,
        getSchema: getSchemaById,
        listSchemas: () => Effect.map(sql<Schema>`SELECT * FROM schemas`, (rows) => [...rows]),
        registerLens,
        getLens: getLensById,
        listLenses: listAllLenses,
        createEntity,
        getEntity,
        updateEntity,
        deleteEntity,
        listEntities,
        createIndex,
        dropIndex,
        listIndexes,
      });
    })
  );
}

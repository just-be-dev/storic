import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { Persistence, PersistenceError } from "@storic/core";
import type {
  InitSpec,
  PatchParams,
  PersistenceRecord,
  QueryParams,
  StoredRecord,
} from "@storic/core";
import { compileFilters } from "./filter-sql.ts";

/**
 * Parse a database row into a StoredRecord.
 * Handles JSON deserialization of the data column.
 */
function rowToStoredRecord(row: Record<string, unknown>): StoredRecord {
  return {
    id: row.id as string,
    type: row.type as string,
    data: JSON.parse(row.data as string) as Record<string, unknown>,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

/**
 * Persistence implementation backed by Effect's SqlClient.
 *
 * Uses a single `entities` table with JSON data column.
 * Suitable for any SQL backend that SqlClient supports (SQLite, Postgres, etc.).
 */
export const sqlPersistenceLayer: Layer.Layer<
  Persistence,
  PersistenceError,
  SqlClient
> = Layer.effect(
  Persistence,
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const initialize = (spec: InitSpec) =>
      Effect.gen(function* () {
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

        const expectedIndexes = new Set<string>();

        for (const idx of spec.indexes) {
          expectedIndexes.add(idx.name);
          yield* sql.unsafe(
            `CREATE INDEX IF NOT EXISTS "${idx.name}" ` +
              `ON entities(json_extract(data, '$.${idx.fieldPath}')) ` +
              `WHERE type = '${idx.typeDiscriminator}'`,
          );
        }

        const existingIndexes = yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entities' AND name LIKE 'idx_%'`;

        for (const { name } of existingIndexes) {
          if (name !== "idx_entities_type" && !expectedIndexes.has(name)) {
            yield* sql.unsafe(`DROP INDEX "${name}"`);
          }
        }
      }).pipe(
        Effect.mapError(
          (error) =>
            new PersistenceError({
              message: `Initialization failed: ${error}`,
              cause: error,
            }),
        ),
      );

    const put = (record: PersistenceRecord) =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO entities (id, type, data)
          VALUES (${record.id}, ${record.type}, ${JSON.stringify(record.data)})
        `;

        const rows = yield* sql<
          Record<string, unknown>
        >`SELECT * FROM entities WHERE id = ${record.id}`;

        return rowToStoredRecord(rows[0]);
      }).pipe(
        Effect.mapError(
          (error) =>
            new PersistenceError({
              message: `Put failed for ${record.id}: ${error}`,
              cause: error,
            }),
        ),
      );

    const get = (id: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<
          Record<string, unknown>
        >`SELECT * FROM entities WHERE id = ${id}`;

        if (rows.length === 0) return null;
        return rowToStoredRecord(rows[0]);
      }).pipe(
        Effect.mapError(
          (error) =>
            new PersistenceError({
              message: `Get failed for ${id}: ${error}`,
              cause: error,
            }),
        ),
      );

    const query = (params: QueryParams) =>
      Effect.gen(function* () {
        const compiled = compileFilters(params.filters);

        let whereClause = `type IN (${params.types.map(() => "?").join(", ")})`;
        const bindValues: unknown[] = [...params.types];

        if (compiled) {
          whereClause += ` AND ${compiled.sql}`;
          bindValues.push(...compiled.values);
        }

        let stmt = `SELECT * FROM entities WHERE ${whereClause} ORDER BY created_at DESC`;

        if (params.limit != null) {
          stmt += ` LIMIT ${params.limit}`;
        }
        if (params.offset != null) {
          stmt += ` OFFSET ${params.offset}`;
        }

        const rows = yield* sql.unsafe<Record<string, unknown>>(
          stmt,
          bindValues,
        );

        return rows.map(rowToStoredRecord);
      }).pipe(
        Effect.mapError(
          (error) =>
            new PersistenceError({
              message: `Query failed: ${error}`,
              cause: error,
            }),
        ),
      );

    const update = (
      id: string,
      record: { readonly type: string; readonly data: Record<string, unknown> },
    ) =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE entities
          SET type = ${record.type},
              data = ${JSON.stringify(record.data)},
              updated_at = unixepoch()
          WHERE id = ${id}
        `;

        const rows = yield* sql<
          Record<string, unknown>
        >`SELECT * FROM entities WHERE id = ${id}`;

        return rowToStoredRecord(rows[0]);
      }).pipe(
        Effect.mapError(
          (error) =>
            new PersistenceError({
              message: `Update failed for ${id}: ${error}`,
              cause: error,
            }),
        ),
      );

    const patch = (params: PatchParams) =>
      Effect.gen(function* () {
        if (params.patches.length === 0) return 0;

        let totalAffected = 0;

        for (const entry of params.patches) {
          const compiled = compileFilters(entry.filters);

          let whereClause = `type = ?`;
          const bindValues: unknown[] = [entry.type];

          if (compiled) {
            whereClause += ` AND ${compiled.sql}`;
            bindValues.push(...compiled.values);
          }

          const result = yield* sql.unsafe<Record<string, unknown>>(
            `UPDATE entities ` +
              `SET data = json_patch(data, ?), updated_at = unixepoch() ` +
              `WHERE ${whereClause} ` +
              `RETURNING id`,
            [JSON.stringify(entry.patch), ...bindValues],
          );
          totalAffected += result.length;
        }

        return totalAffected;
      }).pipe(
        Effect.mapError(
          (error) =>
            new PersistenceError({
              message: `Patch failed: ${error}`,
              cause: error,
            }),
        ),
      );

    const remove = (id: string) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM entities WHERE id = ${id}`;
      }).pipe(
        Effect.mapError(
          (error) =>
            new PersistenceError({
              message: `Remove failed for ${id}: ${error}`,
              cause: error,
            }),
        ),
      );

    return Persistence.of({
      initialize,
      put,
      get,
      query,
      update,
      patch,
      remove,
    });
  }),
);

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SchemaRegistry } from "./schema-registry.ts";
import { getIndexedFields } from "./annotations.ts";

/**
 * Compute the expected index name for a field on a tagged type.
 *
 * Format: `idx_{type_with_dots_replaced}__{field}`
 * Example: `idx_Person_v1__email`
 */
function indexName(type: string, field: string): string {
  return `idx_${type.replace(/\./g, "_")}__${field}`;
}

/**
 * Synchronize SQLite expression indexes based on schema annotations.
 *
 * - Creates indexes for fields annotated with `{ index: true }`
 * - Drops indexes that are no longer declared in annotations
 * - Skips the built-in `idx_entities_type` index
 */
export const syncIndexes = (
  registry: SchemaRegistry,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    // Compute the full set of expected indexes
    const expectedIndexes = new Set<string>();

    for (const tag of registry.getAllTags()) {
      const schema = registry.getSchemaByTag(tag);
      if (!schema) continue;

      const indexedFields = getIndexedFields(schema);

      for (const field of indexedFields) {
        const name = indexName(tag, field);
        expectedIndexes.add(name);

        yield* sql.unsafe(
          `CREATE INDEX IF NOT EXISTS "${name}" ` +
            `ON entities(json_extract(data, '$.${field}')) ` +
            `WHERE type = '${tag}'`,
        );
      }
    }

    // Drop orphaned indexes (those starting with idx_ but not in expected set)
    const existingIndexes = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entities' AND name LIKE 'idx_%'`;

    for (const { name } of existingIndexes) {
      if (name !== "idx_entities_type" && !expectedIndexes.has(name)) {
        yield* sql.unsafe(`DROP INDEX "${name}"`);
      }
    }
  });

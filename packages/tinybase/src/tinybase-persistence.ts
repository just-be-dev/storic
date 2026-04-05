import { createStore, type Store as TinyBaseStore } from "tinybase";
import { Effect, Layer, Ref, ServiceMap } from "effect";
import { Persistence, PersistenceError } from "@storic/core";
import type {
  IndexSpec,
  InitSpec,
  PatchParams,
  PersistenceRecord,
  QueryParams,
  StoredRecord,
} from "@storic/core";
import { getNestedValue, matchesFilters, validateFieldName } from "./filter.ts";

// ─── TinyBaseStore Service ───────────────────────────────────────────────────

export interface TinyBaseStoreShape {
  /** The underlying TinyBase Store instance. */
  readonly store: Ref.Ref<TinyBaseStore>;
}

/**
 * Service providing access to the TinyBase Store backing the persistence layer.
 *
 * Access the `store` ref directly for TinyBase's built-in persistence,
 * synchronization, or reactive features:
 *
 * @example
 * ```ts
 * const { store: storeRef } = yield* TinyBaseStoreService;
 * const tinyStore = yield* Ref.get(storeRef);
 *
 * // Use TinyBase's built-in persistence
 * const persister = createSessionPersister(tinyStore, "my-app");
 * await persister.save();
 *
 * // Or use TinyBase's synchronizers
 * const synchronizer = createWsSynchronizer(tinyStore, ws);
 * ```
 */
export class TinyBaseStoreService extends ServiceMap.Service<
  TinyBaseStoreService,
  TinyBaseStoreShape
>()("storic/TinyBaseStore") {
  /** Create a layer with a fresh empty TinyBase Store. */
  static fresh(): Layer.Layer<TinyBaseStoreService> {
    return Layer.effect(
      TinyBaseStoreService,
      Effect.gen(function* () {
        const tinyStore = createStore();
        const store = yield* Ref.make(tinyStore);
        return TinyBaseStoreService.of({ store });
      }),
    );
  }

  /** Create a layer from an existing TinyBase Store instance. */
  static fromStore(tinyStore: TinyBaseStore): Layer.Layer<TinyBaseStoreService> {
    return Layer.effect(
      TinyBaseStoreService,
      Effect.gen(function* () {
        const store = yield* Ref.make(tinyStore);
        return TinyBaseStoreService.of({ store });
      }),
    );
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** TinyBase table name for storing entities. */
const ENTITIES_TABLE = "entities";

/** TinyBase table name for the byType inverted index. */
const BY_TYPE_TABLE = "byType";

/** Cell names in the entities table. */
const CELL = {
  type: "type",
  data: "data",
  created_at: "created_at",
  updated_at: "updated_at",
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function parseData(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

function rowToStoredRecord(
  id: string,
  type: string,
  dataJson: string,
  created_at: number,
  updated_at: number,
): StoredRecord {
  return {
    id,
    type,
    data: parseData(dataJson),
    created_at,
    updated_at,
  };
}

/**
 * Apply a JSON Merge Patch (RFC 7396) to a plain object.
 * Returns a new object with the patch applied.
 */
function applyMergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key]) &&
      result[key] !== null
    ) {
      result[key] = applyMergePatch(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Persistence Layer ───────────────────────────────────────────────────────

/**
 * Persistence implementation backed by a TinyBase Store.
 *
 * Architecture:
 * - **entities table**: one row per entity, with cells for type, data (JSON),
 *   created_at, and updated_at.
 * - **byType table**: inverted index from type discriminator → entity IDs.
 *   Each type gets a row, entity IDs are stored as cells with value "1".
 *
 * Query optimization:
 * - Type filtering uses the byType table → O(matching IDs).
 * - `eq` / `in` filters on indexed fields narrow candidates via in-memory
 *   inverted indexes before loading entity data.
 * - Non-indexed filters are applied in-memory after loading.
 */
export const tinybasePersistenceLayer: Layer.Layer<
  Persistence,
  PersistenceError,
  TinyBaseStoreService
> = Layer.effect(
  Persistence,
  Effect.gen(function* () {
    const { store: storeRef } = yield* TinyBaseStoreService;

    // Index configuration — populated during initialize
    // (type, fieldPath) → indexName
    const indexLookup = new Map<string, string>();
    // type → [{ indexName, fieldPath }]
    const typeIndexes = new Map<string, Array<{ indexName: string; fieldPath: string }>>();
    // In-memory field indexes: indexName → { stringifiedValue → Set<entityId> }
    const fieldIndexes = new Map<string, Map<string, Set<string>>>();

    /** Extract indexed field values for a given type from entity data. */
    function extractIndexedValues(
      type: string,
      data: Record<string, unknown>,
    ): Record<string, string> {
      const specs = typeIndexes.get(type);
      if (!specs) return {};
      const values: Record<string, string> = {};
      for (const { indexName, fieldPath } of specs) {
        const value = getNestedValue(data, fieldPath);
        if (value != null) {
          values[indexName] = String(value);
        }
      }
      return values;
    }

    /** Add index entries for an entity. */
    function addIndexEntries(id: string, indexed: Record<string, string>): void {
      for (const [idxName, val] of Object.entries(indexed)) {
        let idxMap = fieldIndexes.get(idxName);
        if (!idxMap) {
          idxMap = new Map();
          fieldIndexes.set(idxName, idxMap);
        }
        let ids = idxMap.get(val);
        if (!ids) {
          ids = new Set();
          idxMap.set(val, ids);
        }
        ids.add(id);
      }
    }

    /** Remove index entries for an entity. */
    function removeIndexEntries(id: string, indexed: Record<string, string>): void {
      for (const [idxName, val] of Object.entries(indexed)) {
        const idxMap = fieldIndexes.get(idxName);
        if (!idxMap) continue;
        const ids = idxMap.get(val);
        if (!ids) continue;
        ids.delete(id);
        if (ids.size === 0) idxMap.delete(val);
      }
    }

    // ── Persistence methods ──────────────────────────────────────────────

    const initialize = (spec: InitSpec) =>
      Effect.gen(function* () {
        // Clear index config for idempotency
        indexLookup.clear();
        typeIndexes.clear();
        fieldIndexes.clear();

        for (const idx of spec.indexes) {
          if (!validateFieldName(idx.fieldPath)) {
            return yield* new PersistenceError({
              message: `Invalid field path in index spec: "${idx.fieldPath}"`,
            });
          }
          if (!validateFieldName(idx.typeDiscriminator)) {
            return yield* new PersistenceError({
              message: `Invalid type discriminator in index spec: "${idx.typeDiscriminator}"`,
            });
          }

          indexLookup.set(`${idx.typeDiscriminator}::${idx.fieldPath}`, idx.name);
          const existing = typeIndexes.get(idx.typeDiscriminator) ?? [];
          existing.push({ indexName: idx.name, fieldPath: idx.fieldPath });
          typeIndexes.set(idx.typeDiscriminator, existing);
        }

        // Rebuild field indexes from existing data
        const store = yield* Ref.get(storeRef);
        const rowIds = store.getRowIds(ENTITIES_TABLE);
        for (const id of rowIds) {
          const row = store.getRow(ENTITIES_TABLE, id);
          const type = row[CELL.type] as string;
          const data = parseData(row[CELL.data] as string);
          const indexed = extractIndexedValues(type, data);
          addIndexEntries(id, indexed);
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
        const now = nowUnix();
        const store = yield* Ref.get(storeRef);
        const dataJson = JSON.stringify(record.data);

        // Insert row into entities table
        store.setRow(ENTITIES_TABLE, record.id, {
          [CELL.type]: record.type,
          [CELL.data]: dataJson,
          [CELL.created_at]: now,
          [CELL.updated_at]: now,
        });

        // Update byType index
        store.setCell(BY_TYPE_TABLE, record.type, record.id, 1);

        // Update field indexes
        const indexed = extractIndexedValues(record.type, record.data);
        addIndexEntries(record.id, indexed);

        return {
          id: record.id,
          type: record.type,
          data: { ...record.data },
          created_at: now,
          updated_at: now,
        } satisfies StoredRecord;
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
        const store = yield* Ref.get(storeRef);
        const row = store.getRow(ENTITIES_TABLE, id);

        // TinyBase returns an empty object for missing rows
        if (!row[CELL.type]) return null;

        return rowToStoredRecord(
          id,
          row[CELL.type] as string,
          row[CELL.data] as string,
          row[CELL.created_at] as number,
          row[CELL.updated_at] as number,
        );
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
        const store = yield* Ref.get(storeRef);

        // Step 1: Collect candidate IDs from byType index
        const candidateIds = new Set<string>();
        for (const type of params.types) {
          const typeRow = store.getRow(BY_TYPE_TABLE, type);
          for (const id of Object.keys(typeRow)) {
            candidateIds.add(id);
          }
        }
        if (candidateIds.size === 0) return [];

        // Step 2: Narrow candidates using indexed field filters (eq / in)
        if (params.filters) {
          for (const filter of params.filters) {
            if (filter.op !== "eq" && filter.op !== "in") continue;

            let allTypesIndexed = true;
            for (const type of params.types) {
              if (!indexLookup.has(`${type}::${filter.field}`)) {
                allTypesIndexed = false;
                break;
              }
            }
            if (!allTypesIndexed) continue;

            const matchingIds = new Set<string>();
            const valuesToCheck =
              filter.op === "in" ? (filter.value as unknown[]).map(String) : [String(filter.value)];

            for (const type of params.types) {
              const idxName = indexLookup.get(`${type}::${filter.field}`)!;
              const idxMap = fieldIndexes.get(idxName);
              if (!idxMap) continue;
              for (const val of valuesToCheck) {
                const ids = idxMap.get(val);
                if (!ids) continue;
                for (const id of ids) {
                  matchingIds.add(id);
                }
              }
            }

            for (const id of candidateIds) {
              if (!matchingIds.has(id)) {
                candidateIds.delete(id);
              }
            }
            if (candidateIds.size === 0) return [];
          }
        }

        // Step 3: Load entity data, apply filters, build results
        let results: StoredRecord[] = [];
        for (const id of candidateIds) {
          const row = store.getRow(ENTITIES_TABLE, id);
          if (!row[CELL.type]) continue;

          const data = parseData(row[CELL.data] as string);
          if (!matchesFilters(data, params.filters)) continue;

          results.push({
            id,
            type: row[CELL.type] as string,
            data,
            created_at: row[CELL.created_at] as number,
            updated_at: row[CELL.updated_at] as number,
          });
        }

        // Sort by created_at descending (consistent with SQL layer)
        results.sort((a, b) => b.created_at - a.created_at);

        if (params.offset != null) {
          results = results.slice(params.offset);
        }
        if (params.limit != null) {
          results = results.slice(0, params.limit);
        }

        return results;
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
      record: {
        readonly type: string;
        readonly data: Record<string, unknown>;
      },
    ) =>
      Effect.gen(function* () {
        const now = nowUnix();
        const store = yield* Ref.get(storeRef);
        const existingRow = store.getRow(ENTITIES_TABLE, id);

        if (!existingRow[CELL.type]) {
          return yield* new PersistenceError({
            message: `Update failed: entity ${id} not found`,
          });
        }

        const oldType = existingRow[CELL.type] as string;
        const oldData = parseData(existingRow[CELL.data] as string);
        const oldIndexed = extractIndexedValues(oldType, oldData);

        const dataJson = JSON.stringify(record.data);

        // Update entity row
        store.setRow(ENTITIES_TABLE, id, {
          [CELL.type]: record.type,
          [CELL.data]: dataJson,
          [CELL.created_at]: existingRow[CELL.created_at] as number,
          [CELL.updated_at]: now,
        });

        // Update byType index if type changed
        if (oldType !== record.type) {
          store.delCell(BY_TYPE_TABLE, oldType, id);
          // Clean up empty type row
          if (Object.keys(store.getRow(BY_TYPE_TABLE, oldType)).length === 0) {
            store.delRow(BY_TYPE_TABLE, oldType);
          }
          store.setCell(BY_TYPE_TABLE, record.type, id, 1);
        }

        // Update field indexes
        removeIndexEntries(id, oldIndexed);
        const newIndexed = extractIndexedValues(record.type, record.data);
        addIndexEntries(id, newIndexed);

        return {
          id,
          type: record.type,
          data: { ...record.data },
          created_at: existingRow[CELL.created_at] as number,
          updated_at: now,
        } satisfies StoredRecord;
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

        const store = yield* Ref.get(storeRef);
        let totalPatched = 0;

        for (const entry of params.patches) {
          // Use byType index to narrow candidates
          const typeRow = store.getRow(BY_TYPE_TABLE, entry.type);
          const candidateIds = Object.keys(typeRow);

          for (const id of candidateIds) {
            const row = store.getRow(ENTITIES_TABLE, id);
            if (!row[CELL.type]) continue;

            const data = parseData(row[CELL.data] as string);
            if (!matchesFilters(data, entry.filters)) continue;

            // Apply merge patch
            const patched = applyMergePatch(data, entry.patch);
            const patchedJson = JSON.stringify(patched);

            // Update old indexes
            const oldIndexed = extractIndexedValues(entry.type, data);
            removeIndexEntries(id, oldIndexed);

            // Write updated data
            store.setCell(ENTITIES_TABLE, id, CELL.data, patchedJson);
            store.setCell(ENTITIES_TABLE, id, CELL.updated_at, nowUnix());

            // Add new indexes
            const newIndexed = extractIndexedValues(entry.type, patched);
            addIndexEntries(id, newIndexed);

            totalPatched++;
          }
        }

        return totalPatched;
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
        const store = yield* Ref.get(storeRef);
        const row = store.getRow(ENTITIES_TABLE, id);

        if (row[CELL.type]) {
          const type = row[CELL.type] as string;
          const data = parseData(row[CELL.data] as string);

          // Remove field indexes
          const indexed = extractIndexedValues(type, data);
          removeIndexEntries(id, indexed);

          // Remove from byType index
          store.delCell(BY_TYPE_TABLE, type, id);
          if (Object.keys(store.getRow(BY_TYPE_TABLE, type)).length === 0) {
            store.delRow(BY_TYPE_TABLE, type);
          }
        }

        // Remove entity row
        store.delRow(ENTITIES_TABLE, id);
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

// ─── Convenience API ──────────────────────────────────────────────────────────

/**
 * Convenience layer constructors for TinyBase-backed persistence.
 *
 * @example
 * ```ts
 * // Fresh — empty TinyBase Store
 * const PersistenceLive = TinyBasePersistence.layer();
 *
 * // From existing TinyBase Store (e.g. already loaded via a persister)
 * const PersistenceLive = TinyBasePersistence.fromStore(existingStore);
 *
 * // Wire up the Store the same way as SQL
 * const StoreLive = Store.layer(config).pipe(Layer.provide(PersistenceLive));
 * ```
 */
export class TinyBasePersistence {
  /** Create a fresh persistence layer with an empty TinyBase Store. */
  static layer(): Layer.Layer<Persistence | TinyBaseStoreService, PersistenceError> {
    const docs = TinyBaseStoreService.fresh();
    return Layer.mergeAll(tinybasePersistenceLayer.pipe(Layer.provide(docs)), docs);
  }

  /** Create a persistence layer from an existing TinyBase Store. */
  static fromStore(
    tinyStore: TinyBaseStore,
  ): Layer.Layer<Persistence | TinyBaseStoreService, PersistenceError> {
    const docs = TinyBaseStoreService.fromStore(tinyStore);
    return Layer.mergeAll(tinybasePersistenceLayer.pipe(Layer.provide(docs)), docs);
  }
}

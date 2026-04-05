import * as A from "@automerge/automerge";
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

// ─── Document Types ──────────────────────────────────────────────────────────

/** Metadata for a single entity stored in the catalog document. */
export interface CatalogEntry {
  type: string;
  created_at: number;
  updated_at: number;
  /** Snapshot of indexed field values: indexName → stringified value. */
  indexedValues: Record<string, string>;
}

/**
 * The catalog Automerge document.
 * Stores entity metadata and inverted indexes — no entity data.
 */
export interface CatalogDoc {
  /** Entity metadata keyed by entity ID. */
  entries: Record<string, CatalogEntry>;
  /** Type → { entityId: true } for fast type-based lookups. */
  byType: Record<string, Record<string, boolean>>;
  /** indexName → { stringifiedValue: { entityId: true } } inverted index. */
  fieldIndexes: Record<string, Record<string, Record<string, boolean>>>;
  [key: string]: unknown;
}

/** Per-entity Automerge document containing only the entity's data. */
export interface EntityDoc {
  data: Record<string, unknown>;
  [key: string]: unknown;
}

/** Serialized state for save/restore of all Automerge documents. */
export interface SavedState {
  readonly catalog: Uint8Array;
  readonly entities: ReadonlyArray<readonly [string, Uint8Array]>;
}

// ─── AutomergeDocs Service ───────────────────────────────────────────────────

export interface AutomergeDocsShape {
  /** The catalog document (entity metadata + indexes). */
  readonly catalog: Ref.Ref<A.Doc<CatalogDoc>>;
  /** Map of entity ID → entity Automerge document. */
  readonly entities: Ref.Ref<Map<string, A.Doc<EntityDoc>>>;
}

/**
 * Service managing the Automerge documents backing the persistence layer.
 *
 * Each entity gets its own Automerge document (independently syncable),
 * while a shared catalog document tracks metadata and inverted indexes.
 *
 * Access `catalog` and `entities` refs directly for sync/save operations:
 *
 * @example
 * ```ts
 * import * as A from "@automerge/automerge";
 *
 * const { catalog, entities } = yield* AutomergeDocs;
 * const catalogDoc = yield* Ref.get(catalog);
 * const catalogBytes = A.save(catalogDoc);
 *
 * const entityMap = yield* Ref.get(entities);
 * for (const [id, doc] of entityMap) {
 *   const bytes = A.save(doc);        // save each entity doc
 * }
 * ```
 */
export class AutomergeDocs extends ServiceMap.Service<AutomergeDocs, AutomergeDocsShape>()(
  "storic/AutomergeDocs",
) {
  /** Create a layer with fresh empty documents. */
  static fresh(): Layer.Layer<AutomergeDocs> {
    return Layer.effect(
      AutomergeDocs,
      Effect.gen(function* () {
        const catalogDoc = A.from<CatalogDoc>({
          entries: {},
          byType: {},
          fieldIndexes: {},
        });
        const catalog = yield* Ref.make(catalogDoc);
        const entities = yield* Ref.make(new Map<string, A.Doc<EntityDoc>>());
        return AutomergeDocs.of({ catalog, entities });
      }),
    );
  }

  /** Create a layer by loading previously saved state. */
  static fromSaved(state: SavedState): Layer.Layer<AutomergeDocs> {
    return Layer.effect(
      AutomergeDocs,
      Effect.gen(function* () {
        const catalogDoc = A.load<CatalogDoc>(state.catalog);
        const catalog = yield* Ref.make(catalogDoc);
        const entityMap = new Map<string, A.Doc<EntityDoc>>();
        for (const [id, bytes] of state.entities) {
          entityMap.set(id, A.load<EntityDoc>(bytes));
        }
        const entities = yield* Ref.make(entityMap);
        return AutomergeDocs.of({ catalog, entities });
      }),
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/** Convert automerge proxy/frozen data to a plain JS object via JSON roundtrip. */
function toPlain(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/**
 * Apply a JSON Merge Patch (RFC 7396) to an Automerge proxy object.
 * Mutates `target` in-place within an Automerge change callback,
 * giving per-field CRDT merge semantics.
 */
function applyMergePatch(target: any, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete target[key];
    } else if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key]) &&
      target[key] !== null
    ) {
      applyMergePatch(target[key], value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

/**
 * Apply per-field diff from `newData` onto an Automerge proxy `target`.
 * Preserves CRDT merge semantics by only touching changed fields,
 * unlike wholesale replacement which tombstones all existing keys.
 */
function applyObjectDiff(target: any, newData: Record<string, unknown>): void {
  // Delete keys present in target but absent in newData
  for (const key of Object.keys(target)) {
    if (!(key in newData)) {
      delete target[key];
    }
  }
  // Set keys that differ or are new
  for (const [key, value] of Object.entries(newData)) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof target[key] === "object" &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      applyObjectDiff(target[key], value as Record<string, unknown>);
    } else if (target[key] !== value) {
      target[key] = value;
    }
  }
}

// ─── Persistence Layer ───────────────────────────────────────────────────────

/**
 * Persistence implementation backed by Automerge CRDT documents.
 *
 * Architecture:
 * - **Catalog doc**: one shared Automerge document with entity metadata,
 *   a `byType` inverted index, and per-field inverted indexes.
 * - **Entity docs**: one Automerge document per entity containing its data.
 *
 * Query optimization:
 * - Type filtering uses the `byType` index → O(matching IDs).
 * - `eq` / `in` filters on indexed fields narrow candidates via inverted
 *   indexes before loading any entity docs.
 * - Non-indexed filters are applied in-memory after loading.
 */
export const automergePersistenceLayer: Layer.Layer<Persistence, PersistenceError, AutomergeDocs> =
  Layer.effect(
    Persistence,
    Effect.gen(function* () {
      const { catalog: catalogRef, entities: entitiesRef } = yield* AutomergeDocs;

      // Index configuration — populated during initialize
      // (type, fieldPath) → indexName
      const indexLookup = new Map<string, string>();
      // type → [{ indexName, fieldPath }]
      const typeIndexes = new Map<string, Array<{ indexName: string; fieldPath: string }>>();

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

      /** Add index entries for an entity in the catalog change proxy. */
      function addIndexEntries(d: CatalogDoc, id: string, indexed: Record<string, string>): void {
        for (const [idxName, val] of Object.entries(indexed)) {
          if (!d.fieldIndexes[idxName]) {
            (d.fieldIndexes as any)[idxName] = {};
          }
          if (!d.fieldIndexes[idxName][val]) {
            (d.fieldIndexes[idxName] as any)[val] = {};
          }
          (d.fieldIndexes[idxName][val] as any)[id] = true;
        }
      }

      /** Remove index entries for an entity from the catalog change proxy. */
      function removeIndexEntries(
        d: CatalogDoc,
        id: string,
        indexed: Record<string, string>,
      ): void {
        for (const [idxName, val] of Object.entries(indexed)) {
          const fieldIdx = d.fieldIndexes[idxName];
          if (!fieldIdx?.[val]) continue;
          delete fieldIdx[val][id];
          if (Object.keys(fieldIdx[val]).length === 0) {
            delete fieldIdx[val];
          }
        }
      }

      // ── Persistence methods ──────────────────────────────────────────────

      const initialize = (spec: InitSpec) =>
        Effect.gen(function* () {
          // Clear index config for idempotency (#7)
          indexLookup.clear();
          typeIndexes.clear();

          const expectedIndexNames = new Set<string>();

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

            // Populate index configuration
            indexLookup.set(`${idx.typeDiscriminator}::${idx.fieldPath}`, idx.name);
            const existing = typeIndexes.get(idx.typeDiscriminator) ?? [];
            existing.push({ indexName: idx.name, fieldPath: idx.fieldPath });
            typeIndexes.set(idx.typeDiscriminator, existing);
            expectedIndexNames.add(idx.name);
          }

          // Ensure catalog structure exists + clean up stale indexes (#8)
          yield* Ref.update(catalogRef, (doc) =>
            A.change(doc, (d) => {
              if (!d.entries) (d as any).entries = {};
              if (!d.byType) (d as any).byType = {};
              if (!d.fieldIndexes) (d as any).fieldIndexes = {};

              // Remove stale field indexes not in current spec
              for (const idxName of Object.keys(d.fieldIndexes)) {
                if (!expectedIndexNames.has(idxName)) {
                  delete d.fieldIndexes[idxName];
                }
              }
            }),
          );
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
        Effect.uninterruptible(
          Effect.gen(function* () {
            const now = nowUnix();

            // Create the entity's own Automerge document
            const entityDoc = A.from<EntityDoc>({ data: record.data });
            const entityMap = yield* Ref.get(entitiesRef);
            entityMap.set(record.id, entityDoc);
            yield* Ref.set(entitiesRef, entityMap);

            // Update catalog: metadata + indexes
            const indexed = extractIndexedValues(record.type, record.data);
            yield* Ref.update(catalogRef, (doc) =>
              A.change(doc, (d) => {
                (d.entries as any)[record.id] = {
                  type: record.type,
                  created_at: now,
                  updated_at: now,
                  indexedValues: indexed,
                };

                // byType index
                if (!d.byType[record.type]) {
                  (d.byType as any)[record.type] = {};
                }
                (d.byType[record.type] as any)[record.id] = true;

                // Field indexes
                addIndexEntries(d, record.id, indexed);
              }),
            );

            return {
              id: record.id,
              type: record.type,
              data: { ...record.data },
              created_at: now,
              updated_at: now,
            } satisfies StoredRecord;
          }),
        ).pipe(
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
          const catalog = yield* Ref.get(catalogRef);
          const entry = catalog.entries[id];
          if (!entry) return null;

          const entityMap = yield* Ref.get(entitiesRef);
          const entityDoc = entityMap.get(id);
          if (!entityDoc) return null;

          return {
            id,
            type: entry.type,
            data: toPlain(entityDoc.data),
            created_at: entry.created_at,
            updated_at: entry.updated_at,
          } satisfies StoredRecord;
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
          const catalog = yield* Ref.get(catalogRef);
          const entityMap = yield* Ref.get(entitiesRef);

          // Step 1: Collect candidate IDs from byType index
          const candidateIds = new Set<string>();
          for (const type of params.types) {
            const typeIds = catalog.byType[type];
            if (typeIds) {
              for (const id of Object.keys(typeIds)) {
                candidateIds.add(id);
              }
            }
          }
          if (candidateIds.size === 0) return [];

          // Step 2: Narrow candidates using indexed field filters (eq / in)
          if (params.filters) {
            for (const filter of params.filters) {
              // Only optimize eq and in on indexed fields
              if (filter.op !== "eq" && filter.op !== "in") continue;

              // Check if this field is indexed for ALL queried types
              let allTypesIndexed = true;
              for (const type of params.types) {
                if (!indexLookup.has(`${type}::${filter.field}`)) {
                  allTypesIndexed = false;
                  break;
                }
              }
              if (!allTypesIndexed) continue;

              // Collect IDs matching the filter from field indexes
              const matchingIds = new Set<string>();
              const valuesToCheck =
                filter.op === "in"
                  ? (filter.value as unknown[]).map(String)
                  : [String(filter.value)];

              for (const type of params.types) {
                const idxName = indexLookup.get(`${type}::${filter.field}`)!;
                const fieldIdx = catalog.fieldIndexes[idxName];
                if (!fieldIdx) continue;
                for (const val of valuesToCheck) {
                  const valueIds = fieldIdx[val];
                  if (!valueIds) continue;
                  for (const id of Object.keys(valueIds)) {
                    matchingIds.add(id);
                  }
                }
              }

              // Intersect with candidates
              for (const id of candidateIds) {
                if (!matchingIds.has(id)) {
                  candidateIds.delete(id);
                }
              }
              if (candidateIds.size === 0) return [];
            }
          }

          // Step 3: Load entity docs for remaining candidates, filter before toPlain (#6)
          let results: StoredRecord[] = [];
          for (const id of candidateIds) {
            const entry = catalog.entries[id];
            if (!entry) continue;
            const entityDoc = entityMap.get(id);
            if (!entityDoc) continue;

            // Filter on automerge proxy data directly, only toPlain for results
            if (!matchesFilters(entityDoc.data as Record<string, unknown>, params.filters))
              continue;

            results.push({
              id,
              type: entry.type,
              data: toPlain(entityDoc.data),
              created_at: entry.created_at,
              updated_at: entry.updated_at,
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
        Effect.uninterruptible(
          Effect.gen(function* () {
            const now = nowUnix();

            // Read current catalog entry for old index values
            const catalog = yield* Ref.get(catalogRef);
            const oldEntry = catalog.entries[id];
            if (!oldEntry) {
              return yield* new PersistenceError({
                message: `Update failed: entity ${id} not found`,
              });
            }

            // Per-field diff to preserve CRDT merge semantics (#1)
            const entityMap = yield* Ref.get(entitiesRef);
            const existing = entityMap.get(id);
            if (existing) {
              const updated = A.change(existing, (d) => {
                applyObjectDiff(d.data, record.data);
              });
              entityMap.set(id, updated);
              yield* Ref.set(entitiesRef, entityMap);
            }

            // Update catalog: metadata + indexes
            const oldIndexed = toPlain(oldEntry.indexedValues ?? {}) as Record<string, string>;
            const newIndexed = extractIndexedValues(record.type, record.data);

            yield* Ref.update(catalogRef, (doc) =>
              A.change(doc, (d) => {
                const entry = d.entries[id];
                if (!entry) return;

                // Update byType if type changed
                if (entry.type !== record.type) {
                  delete d.byType[entry.type]?.[id];
                  if (!d.byType[record.type]) {
                    (d.byType as any)[record.type] = {};
                  }
                  (d.byType[record.type] as any)[id] = true;
                }

                entry.type = record.type;
                entry.updated_at = now;

                // Update field indexes
                removeIndexEntries(d, id, oldIndexed);
                addIndexEntries(d, id, newIndexed);
                (entry as any).indexedValues = newIndexed;
              }),
            );

            return {
              id,
              type: record.type,
              data: { ...record.data },
              created_at: oldEntry.created_at,
              updated_at: now,
            } satisfies StoredRecord;
          }),
        ).pipe(
          Effect.mapError(
            (error) =>
              new PersistenceError({
                message: `Update failed for ${id}: ${error}`,
                cause: error,
              }),
          ),
        );

      const patch = (params: PatchParams) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (params.patches.length === 0) return 0;

            const catalog = yield* Ref.get(catalogRef);
            const entityMap = yield* Ref.get(entitiesRef);

            // Determine matching entities and apply patches to their docs
            interface PatchedInfo {
              id: string;
              type: string;
              newData: Record<string, unknown>;
              oldIndexed: Record<string, string>;
            }
            const patched: PatchedInfo[] = [];

            for (const entry of params.patches) {
              // Use byType index to narrow candidates (#4)
              const candidateIds = catalog.byType[entry.type];
              if (!candidateIds) continue;

              for (const id of Object.keys(candidateIds)) {
                const catEntry = catalog.entries[id];
                if (!catEntry) continue;

                const entityDoc = entityMap.get(id);
                if (!entityDoc) continue;

                // Filter on proxy data directly, avoid toPlain before filtering
                if (!matchesFilters(entityDoc.data as Record<string, unknown>, entry.filters))
                  continue;

                // Apply patch to the entity's own automerge doc
                const newDoc = A.change(entityDoc, (d) => {
                  applyMergePatch(d.data, entry.patch);
                });
                entityMap.set(id, newDoc);

                patched.push({
                  id,
                  type: catEntry.type,
                  newData: toPlain(newDoc.data),
                  oldIndexed: toPlain(catEntry.indexedValues ?? {}) as Record<string, string>,
                });
              }
            }

            if (patched.length === 0) return 0;

            // Commit updated entity docs (mutated in-place)
            yield* Ref.set(entitiesRef, entityMap);

            // Update catalog: timestamps + indexes
            yield* Ref.update(catalogRef, (doc) =>
              A.change(doc, (d) => {
                const now = nowUnix();
                for (const p of patched) {
                  const entry = d.entries[p.id];
                  if (!entry) continue;
                  entry.updated_at = now;

                  const newIndexed = extractIndexedValues(p.type, p.newData);
                  removeIndexEntries(d, p.id, p.oldIndexed);
                  addIndexEntries(d, p.id, newIndexed);
                  (entry as any).indexedValues = newIndexed;
                }
              }),
            );

            return patched.length;
          }),
        ).pipe(
          Effect.mapError(
            (error) =>
              new PersistenceError({
                message: `Patch failed: ${error}`,
                cause: error,
              }),
          ),
        );

      const remove = (id: string) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            // Read catalog entry for cleanup
            const catalog = yield* Ref.get(catalogRef);
            const entry = catalog.entries[id];

            // Remove entity doc (mutate in-place)
            const entityMap = yield* Ref.get(entitiesRef);
            entityMap.delete(id);
            yield* Ref.set(entitiesRef, entityMap);

            // Remove from catalog
            if (entry) {
              const indexed = toPlain(entry.indexedValues ?? {}) as Record<string, string>;
              yield* Ref.update(catalogRef, (doc) =>
                A.change(doc, (d) => {
                  // Remove from byType + clean up empty bucket (#9)
                  if (d.byType[entry.type]) {
                    delete d.byType[entry.type][id];
                    if (Object.keys(d.byType[entry.type]).length === 0) {
                      delete d.byType[entry.type];
                    }
                  }
                  // Remove field index entries
                  removeIndexEntries(d, id, indexed);
                  // Remove catalog entry
                  delete d.entries[id];
                }),
              );
            }
          }),
        ).pipe(
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
 * Snapshot the current Automerge document state for persistence or sync.
 *
 * @example
 * ```ts
 * const state = yield* saveState;
 * // later: AutomergePersistence.fromSaved(state)
 * ```
 */
export const saveState: Effect.Effect<SavedState, never, AutomergeDocs> = Effect.gen(function* () {
  const { catalog, entities } = yield* AutomergeDocs;
  const catalogDoc = yield* Ref.get(catalog);
  const entityMap = yield* Ref.get(entities);
  return {
    catalog: A.save(catalogDoc),
    entities: Array.from(entityMap.entries()).map(([id, doc]) => [id, A.save(doc)] as const),
  } satisfies SavedState;
});

/**
 * Convenience layer constructors that mirror the SQL persistence API.
 *
 * @example
 * ```ts
 * // Fresh — like sqlPersistenceLayer with an empty database
 * const PersistenceLive = AutomergePersistence.layer();
 *
 * // From saved state — like pointing at an existing database file
 * const PersistenceLive = AutomergePersistence.fromSaved(state);
 *
 * // Wire up the Store the same way as SQL
 * const StoreLive = Store.layer(config).pipe(Layer.provide(PersistenceLive));
 * ```
 */
export class AutomergePersistence {
  /** Create a fresh persistence layer with empty Automerge documents. */
  static layer(): Layer.Layer<Persistence | AutomergeDocs, PersistenceError> {
    const docs = AutomergeDocs.fresh();
    return Layer.mergeAll(automergePersistenceLayer.pipe(Layer.provide(docs)), docs);
  }

  /** Create a persistence layer from previously saved state. */
  static fromSaved(state: SavedState): Layer.Layer<Persistence | AutomergeDocs, PersistenceError> {
    const docs = AutomergeDocs.fromSaved(state);
    return Layer.mergeAll(automergePersistenceLayer.pipe(Layer.provide(docs)), docs);
  }
}

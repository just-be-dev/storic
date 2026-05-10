import { Effect, Layer, Schema, Context, Stream } from "effect";
import {
  EntityNotFoundError,
  LensPathNotFoundError,
  PersistenceError,
  TransformError,
  ValidationError,
} from "./errors.ts";
import { computeIndexSpecs } from "./compute-indexes.ts";
import { entitySchemas } from "./entity.ts";
import { Persistence } from "./persistence.ts";
import type { Filter, TypePatch } from "./persistence.ts";
import { SchemaRegistry, getTag } from "./schema-registry.ts";
import { EntityBus } from "./entity-bus.ts";
import type { ChangeEvent } from "./change-event.ts";
import type {
  AnyTaggedStruct,
  Entity,
  EntityRecord,
  Lens,
  LensPath,
  StoreConfig,
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
  /**
   * Save an entity. The `_tag` field is added automatically.
   *
   * Defaults to the entity's `schema`. Pass `{ as: SchemaVN }` to save under a
   * specific schema version reachable from the entity.
   */
  readonly saveEntity: {
    <E extends Entity>(
      entity: E,
      data: Omit<Schema.Schema.Type<E["schema"]>, "_tag">,
      opts?: { readonly id?: string },
    ): Effect.Effect<EntityRecord<E["schema"]>, ValidationError | PersistenceError>;

    <As extends AnyTaggedStruct>(
      entity: Entity,
      data: Omit<Schema.Schema.Type<As>, "_tag">,
      opts: { readonly id?: string; readonly as: As },
    ): Effect.Effect<EntityRecord<As>, ValidationError | PersistenceError>;
  };

  /**
   * Load a single entity by ID, projected to the entity's default schema
   * (or the schema given by `{ as }`).
   */
  readonly loadEntity: {
    <E extends Entity>(
      entity: E,
      id: string,
      opts?: Record<string, never>,
    ): Effect.Effect<
      EntityRecord<E["schema"]>,
      | EntityNotFoundError
      | LensPathNotFoundError
      | TransformError
      | ValidationError
      | PersistenceError
    >;

    <As extends AnyTaggedStruct>(
      entity: Entity,
      id: string,
      opts: { readonly as: As },
    ): Effect.Effect<
      EntityRecord<As>,
      | EntityNotFoundError
      | LensPathNotFoundError
      | TransformError
      | ValidationError
      | PersistenceError
    >;
  };

  /**
   * Load all entities of this entity type, including older schema versions
   * auto-converted via lenses. Scoped to the entity's own schemas only.
   *
   * **Pagination caveat:** When multiple schema versions exist, `limit` and
   * `offset` apply to the combined query across all versions. For predictable
   * pagination, filter to fields present in every version.
   */
  readonly loadEntities: {
    <E extends Entity>(
      entity: E,
      opts?: {
        readonly filters?: ReadonlyArray<Filter>;
        readonly limit?: number;
        readonly offset?: number;
      },
    ): Effect.Effect<
      Array<EntityRecord<E["schema"]>>,
      LensPathNotFoundError | TransformError | ValidationError | PersistenceError
    >;

    <As extends AnyTaggedStruct>(
      entity: Entity,
      opts: {
        readonly filters?: ReadonlyArray<Filter>;
        readonly limit?: number;
        readonly offset?: number;
        readonly as: As;
      },
    ): Effect.Effect<
      Array<EntityRecord<As>>,
      LensPathNotFoundError | TransformError | ValidationError | PersistenceError
    >;
  };

  /**
   * Update an entity's data.
   *
   * **Schema migration on write:** If the entity was stored as a different
   * schema version, it is projected via lenses, the update applied, and the
   * result stored as the target schema version.
   */
  readonly updateEntity: {
    // Default schema, merge mode (default)
    <E extends Entity>(
      entity: E,
      id: string,
      data: Partial<Omit<Schema.Schema.Type<E["schema"]>, "_tag">>,
      opts?: { readonly mode?: "merge" },
    ): Effect.Effect<
      EntityRecord<E["schema"]>,
      | EntityNotFoundError
      | LensPathNotFoundError
      | TransformError
      | ValidationError
      | PersistenceError
    >;

    // Default schema, replace mode
    <E extends Entity>(
      entity: E,
      id: string,
      data: Omit<Schema.Schema.Type<E["schema"]>, "_tag">,
      opts: { readonly mode: "replace" },
    ): Effect.Effect<
      EntityRecord<E["schema"]>,
      | EntityNotFoundError
      | LensPathNotFoundError
      | TransformError
      | ValidationError
      | PersistenceError
    >;

    // Explicit schema, merge mode
    <As extends AnyTaggedStruct>(
      entity: Entity,
      id: string,
      data: Partial<Omit<Schema.Schema.Type<As>, "_tag">>,
      opts: { readonly mode?: "merge"; readonly as: As },
    ): Effect.Effect<
      EntityRecord<As>,
      | EntityNotFoundError
      | LensPathNotFoundError
      | TransformError
      | ValidationError
      | PersistenceError
    >;

    // Explicit schema, replace mode
    <As extends AnyTaggedStruct>(
      entity: Entity,
      id: string,
      data: Omit<Schema.Schema.Type<As>, "_tag">,
      opts: { readonly mode: "replace"; readonly as: As },
    ): Effect.Effect<
      EntityRecord<As>,
      | EntityNotFoundError
      | LensPathNotFoundError
      | TransformError
      | ValidationError
      | PersistenceError
    >;
  };

  /**
   * Patch entities of this entity type. For each schema version, only fields
   * that exist in that version are applied. Optional filters narrow which
   * records are patched.
   *
   * **Note:** Patches bypass schema validation — callers are responsible for
   * ensuring patch values conform to schema field types.
   */
  readonly patchEntities: {
    <E extends Entity>(
      entity: E,
      patch: Partial<Omit<Schema.Schema.Type<E["schema"]>, "_tag">>,
      opts?: { readonly filters?: ReadonlyArray<Filter> },
    ): Effect.Effect<number, PersistenceError>;

    <As extends AnyTaggedStruct>(
      entity: Entity,
      patch: Partial<Omit<Schema.Schema.Type<As>, "_tag">>,
      opts: { readonly filters?: ReadonlyArray<Filter>; readonly as: As },
    ): Effect.Effect<number, PersistenceError>;
  };

  /** Delete an entity by ID. */
  readonly deleteEntity: (id: string) => Effect.Effect<void, PersistenceError>;

  /**
   * Subscribe to changes for a single entity by id. Emits the current value
   * immediately, then re-emits whenever a relevant change occurs. Emits `null`
   * when the entity is deleted or doesn't exist.
   */
  readonly subscribeEntity: {
    <E extends Entity>(
      entity: E,
      id: string,
      opts?: Record<string, never>,
    ): Stream.Stream<
      EntityRecord<E["schema"]> | null,
      LensPathNotFoundError | TransformError | ValidationError | PersistenceError
    >;

    <As extends AnyTaggedStruct>(
      entity: Entity,
      id: string,
      opts: { readonly as: As },
    ): Stream.Stream<
      EntityRecord<As> | null,
      LensPathNotFoundError | TransformError | ValidationError | PersistenceError
    >;
  };

  /**
   * Subscribe to a query result. Emits the current list immediately, then
   * re-emits whenever a record of the entity's type changes.
   */
  readonly subscribeEntities: {
    <E extends Entity>(
      entity: E,
      opts?: {
        readonly filters?: ReadonlyArray<Filter>;
        readonly limit?: number;
        readonly offset?: number;
      },
    ): Stream.Stream<
      Array<EntityRecord<E["schema"]>>,
      LensPathNotFoundError | TransformError | ValidationError | PersistenceError
    >;

    <As extends AnyTaggedStruct>(
      entity: Entity,
      opts: {
        readonly filters?: ReadonlyArray<Filter>;
        readonly limit?: number;
        readonly offset?: number;
        readonly as: As;
      },
    ): Stream.Stream<
      Array<EntityRecord<As>>,
      LensPathNotFoundError | TransformError | ValidationError | PersistenceError
    >;
  };
}

// ─── Store Service ──────────────────────────────────────────────────────────

export class Store extends Context.Service<Store, StoreShape>()("datastore/Store") {
  /**
   * Create a Store layer from a StoreConfig and a Persistence backend.
   *
   * On initialization:
   * 1. Flattens entities into schemas + lenses
   * 2. Builds the schema registry and lens graph
   * 3. Computes index specs from schema annotations
   * 4. Calls persistence.initialize() with the index specs
   */
  static readonly layer = (
    config: StoreConfig,
  ): Layer.Layer<Store, PersistenceError, Persistence> =>
    Layer.effect(
      Store,
      Effect.gen(function* () {
        const persistence = yield* Persistence;

        // ── Notification bus ────────────────────────────────────────────
        // If the backend implements `subscribe`, use it as the source of
        // truth and do NOT self-publish on mutations. Otherwise, run the
        // self-publish path: bus is filled by Store after each mutation.
        const bus = yield* EntityBus.make;
        const selfPublish = persistence.subscribe === undefined;

        if (!selfPublish) {
          const sub = persistence.subscribe!({});
          const pump: Effect.Effect<void, never, never> = sub.pipe(
            Stream.runForEach((event: ChangeEvent) => bus.publish(event)),
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                if (typeof console !== "undefined") {
                  console.warn(
                    "[storic] backend change-stream pump failed; subscribers will stop receiving events",
                    cause,
                  );
                }
              }),
            ),
          );
          yield* Effect.forkScoped(pump);
        }

        // ── Flatten entities into schemas + lenses ──────────────────────
        const schemas: AnyTaggedStruct[] = [];
        const lenses: Lens[] = [];
        const seenTags = new Set<string>();
        const entitySchemaTags = new Map<Entity, ReadonlyArray<string>>();

        for (const entity of config.entities) {
          const schemasOfEntity = entitySchemas(entity);
          entitySchemaTags.set(
            entity,
            schemasOfEntity.map((s) => getTag(s)),
          );
          for (const s of schemasOfEntity) {
            const tag = getTag(s);
            if (!seenTags.has(tag)) {
              seenTags.add(tag);
              schemas.push(s);
            }
          }
          for (const lens of entity.lenses) {
            lenses.push(lens);
          }
        }

        // ── Schema Registry ─────────────────────────────────────────────
        const registry = new SchemaRegistry({ schemas, lenses });

        // ── Compute and apply indexes ───────────────────────────────────
        const indexes = computeIndexSpecs(registry);
        yield* persistence.initialize({ indexes });

        // ── Resolve target schema for an op (entity.schema or opts.as) ──
        const resolveSchema = (
          entity: Entity,
          asOpt: AnyTaggedStruct | undefined,
        ): AnyTaggedStruct => asOpt ?? entity.schema;

        // ── Implementation ──────────────────────────────────────────────

        const saveEntity = ((
          entity: Entity,
          data: Record<string, unknown>,
          opts?: { readonly id?: string; readonly as?: AnyTaggedStruct },
        ): Effect.Effect<EntityRecord<AnyTaggedStruct>, ValidationError | PersistenceError> =>
          Effect.gen(function* () {
            const schema = resolveSchema(entity, opts?.as);
            const tag = getTag(schema);
            const fullData = { _tag: tag, ...data } as Record<string, unknown>;

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
              data: fullData,
            });

            if (selfPublish) {
              yield* bus.publish({
                kind: "put",
                id: stored.id,
                type: stored.type,
                record: stored,
              });
            }

            return {
              id: stored.id,
              data: stored.data as unknown as Schema.Schema.Type<AnyTaggedStruct>,
              created_at: stored.created_at,
              updated_at: stored.updated_at,
            };
          })) as StoreShape["saveEntity"];

        const loadEntity = ((
          entity: Entity,
          id: string,
          opts?: { readonly as?: AnyTaggedStruct },
        ): Effect.Effect<
          EntityRecord<AnyTaggedStruct>,
          | EntityNotFoundError
          | LensPathNotFoundError
          | TransformError
          | ValidationError
          | PersistenceError
        > =>
          Effect.gen(function* () {
            const schema = resolveSchema(entity, opts?.as);
            const stored = yield* persistence.get(id);

            if (!stored) {
              return yield* new EntityNotFoundError({
                entityId: id,
                message: `Entity not found: ${id}`,
              });
            }

            const targetTag = getTag(schema);
            const storedType = stored.type;

            let converted: Record<string, unknown>;
            if (storedType === targetTag) {
              converted = stored.data;
            } else {
              const path = registry.getPath(storedType, targetTag);
              if (!path) {
                return yield* new LensPathNotFoundError({
                  fromType: storedType,
                  toType: targetTag,
                  message: `No lens path from ${storedType} to ${targetTag}`,
                });
              }
              converted = (yield* applyLensPath(path, stored.data)) as Record<string, unknown>;

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
              data: converted as unknown as Schema.Schema.Type<AnyTaggedStruct>,
              created_at: stored.created_at,
              updated_at: stored.updated_at,
            };
          })) as StoreShape["loadEntity"];

        const loadEntities = ((
          entity: Entity,
          opts?: {
            readonly filters?: ReadonlyArray<Filter>;
            readonly limit?: number;
            readonly offset?: number;
            readonly as?: AnyTaggedStruct;
          },
        ): Effect.Effect<
          Array<EntityRecord<AnyTaggedStruct>>,
          LensPathNotFoundError | TransformError | ValidationError | PersistenceError
        > =>
          Effect.gen(function* () {
            const schema = resolveSchema(entity, opts?.as);
            const targetTag = getTag(schema);
            const filters = opts?.filters;

            // Scope to this entity's own schemas (not the global lens graph)
            const entityTags = entitySchemaTags.get(entity) ?? [getTag(entity.schema)];

            // Drop tags that don't have all filtered fields
            const eligibleTags = entityTags.filter((tag) => {
              if (!filters?.length) return true;
              const tagSchema = registry.getSchemaByTag(tag);
              if (!tagSchema) return false;
              const fieldNames = getFieldNames(tagSchema);
              return filters.every((f) => fieldNames.has(f.field));
            });

            const rows = yield* persistence.query({
              types: eligibleTags,
              filters,
              limit: opts?.limit,
              offset: opts?.offset,
            });

            const results: Array<EntityRecord<AnyTaggedStruct>> = [];

            for (const row of rows) {
              let converted: Record<string, unknown>;
              if (row.type === targetTag) {
                converted = row.data;
              } else {
                const path = registry.getPath(row.type, targetTag);
                if (!path) {
                  return yield* new LensPathNotFoundError({
                    fromType: row.type,
                    toType: targetTag,
                    message: `No lens path from ${row.type} to ${targetTag}`,
                  });
                }
                converted = (yield* applyLensPath(path, row.data)) as Record<string, unknown>;

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
                data: converted as unknown as Schema.Schema.Type<AnyTaggedStruct>,
                created_at: row.created_at,
                updated_at: row.updated_at,
              });
            }

            return results;
          })) as StoreShape["loadEntities"];

        const updateEntity = ((
          entity: Entity,
          id: string,
          data: Record<string, unknown>,
          opts?: { readonly mode?: "merge" | "replace"; readonly as?: AnyTaggedStruct },
        ): Effect.Effect<
          EntityRecord<AnyTaggedStruct>,
          | EntityNotFoundError
          | LensPathNotFoundError
          | TransformError
          | ValidationError
          | PersistenceError
        > =>
          Effect.gen(function* () {
            const schema = resolveSchema(entity, opts?.as);
            const targetTag = getTag(schema);

            const stored = yield* persistence.get(id);

            if (!stored) {
              return yield* new EntityNotFoundError({
                entityId: id,
                message: `Entity not found: ${id}`,
              });
            }

            const storedType = stored.type;

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

            const mode = opts?.mode ?? "merge";
            const newData =
              mode === "merge"
                ? { ...projected, ...data, _tag: targetTag }
                : { ...data, _tag: targetTag };

            try {
              validateSync(schema, newData);
            } catch (error) {
              return yield* new ValidationError({
                message: `Validation failed for ${targetTag}: ${error}`,
              });
            }

            const updated = yield* persistence.update(id, {
              type: targetTag,
              data: newData,
            });

            if (selfPublish) {
              yield* bus.publish({
                kind: "update",
                id: updated.id,
                type: updated.type,
                record: updated,
              });
            }

            return {
              id: updated.id,
              data: updated.data as unknown as Schema.Schema.Type<AnyTaggedStruct>,
              created_at: updated.created_at,
              updated_at: updated.updated_at,
            };
          })) as StoreShape["updateEntity"];

        const patchEntities = ((
          entity: Entity,
          patch: Record<string, unknown>,
          opts?: {
            readonly filters?: ReadonlyArray<Filter>;
            readonly as?: AnyTaggedStruct;
          },
        ): Effect.Effect<number, PersistenceError> =>
          Effect.gen(function* () {
            // `as` exists for type-inference symmetry; patchEntities doesn't
            // actually use a target schema at runtime — it walks all of the
            // entity's schemas and patches per-version.
            void opts?.as;

            const entityTags = entitySchemaTags.get(entity) ?? [getTag(entity.schema)];
            const patchKeys = Object.keys(patch);
            const filters = opts?.filters;

            const patches: TypePatch[] = [];

            for (const tag of entityTags) {
              const tagSchema = registry.getSchemaByTag(tag);
              if (!tagSchema) continue;

              const fieldNames = getFieldNames(tagSchema);

              if (filters?.length) {
                const allFiltersApplicable = filters.every((f) => fieldNames.has(f.field));
                if (!allFiltersApplicable) continue;
              }

              const filtered: Record<string, unknown> = {};
              let hasKeys = false;

              for (const key of patchKeys) {
                if (fieldNames.has(key)) {
                  filtered[key] = patch[key];
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

            const affected = yield* persistence.patch({ patches });

            if (selfPublish && affected > 0) {
              for (const p of patches) {
                yield* bus.publish({ kind: "bulk", type: p.type });
              }
            }

            return affected;
          })) as StoreShape["patchEntities"];

        const deleteEntity = (id: string): Effect.Effect<void, PersistenceError> =>
          Effect.gen(function* () {
            const stored = selfPublish ? yield* persistence.get(id) : null;
            yield* persistence.remove(id);
            if (selfPublish) {
              yield* bus.publish({ kind: "delete", id, type: stored?.type ?? null });
            }
          });

        // ── Subscriptions ───────────────────────────────────────────────
        // Each subscriber gets:
        //   1. an immediate emission of the current value
        //   2. re-emissions on every relevant bus event (re-load is the
        //      simplest correct strategy and avoids per-event lens math)
        //
        // We acquire the bus subscription *before* running the initial
        // reload, so events published during the reload window are buffered
        // (not dropped) and drained immediately after the snapshot emits.

        const subscribeEntity = ((
          entity: Entity,
          id: string,
          opts?: { readonly as?: AnyTaggedStruct },
        ) => {
          const tags = new Set(entitySchemaTags.get(entity) ?? [getTag(entity.schema)]);

          const loaded = (loadEntity as any)(entity, id, opts) as Effect.Effect<
            EntityRecord<AnyTaggedStruct>,
            | EntityNotFoundError
            | LensPathNotFoundError
            | TransformError
            | ValidationError
            | PersistenceError
          >;
          const reload: Effect.Effect<
            EntityRecord<AnyTaggedStruct> | null,
            LensPathNotFoundError | TransformError | ValidationError | PersistenceError
          > = loaded.pipe(
            Effect.catchTag("EntityNotFoundError", () =>
              Effect.succeed(null as EntityRecord<AnyTaggedStruct> | null),
            ),
          );

          return Stream.unwrap(
            Effect.map(bus.subscribe(), (live) =>
              Stream.concat(
                Stream.fromEffect(reload),
                live.pipe(
                  Stream.filter((ev): boolean => {
                    if (ev.kind === "bulk") return tags.has(ev.type);
                    return ev.id === id;
                  }),
                  Stream.mapEffect(() => reload),
                ),
              ),
            ),
          );
        }) as StoreShape["subscribeEntity"];

        const subscribeEntities = ((
          entity: Entity,
          opts?: {
            readonly filters?: ReadonlyArray<Filter>;
            readonly limit?: number;
            readonly offset?: number;
            readonly as?: AnyTaggedStruct;
          },
        ) => {
          const tags = new Set(entitySchemaTags.get(entity) ?? [getTag(entity.schema)]);

          const reload = (loadEntities as any)(entity, opts);

          return Stream.unwrap(
            Effect.map(bus.subscribe(), (live) =>
              Stream.concat(
                Stream.fromEffect(reload),
                live.pipe(
                  Stream.filter((ev): boolean => {
                    if (ev.kind === "bulk") return tags.has(ev.type);
                    if (ev.kind === "delete") return ev.type === null || tags.has(ev.type);
                    return tags.has(ev.type);
                  }),
                  Stream.mapEffect(() => reload),
                ),
              ),
            ),
          );
        }) as StoreShape["subscribeEntities"];

        // ── Return service ──────────────────────────────────────────────

        return Store.of({
          saveEntity,
          loadEntity,
          loadEntities,
          updateEntity,
          patchEntities,
          deleteEntity,
          subscribeEntity,
          subscribeEntities,
        });
      }),
    );
}

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Schema } from "effect";
import { Store } from "@storic/core";
import type { StoreConfig, AnyTaggedStruct, Entity, EntityRecord, Filter } from "@storic/core";
import type { StoricDO } from "./storic-object.ts";
import { doStubPersistence } from "./stub-persistence.ts";

/**
 * Build a Store layer that talks to a StoricDO instance via RPC.
 *
 * The namespace is used to resolve a named DO instance. All schema/lens
 * knowledge stays caller-side — the DO is a generic persistence backend.
 *
 * @example
 * ```ts
 * import { Store } from "@storic/core";
 * import { makeStoreLayer } from "@storic/cloudflare";
 *
 * const layer = makeStoreLayer(env.STORE, "my-store", { entities: [Person] });
 * ```
 */
export const makeStoreLayer = (
  ns: DurableObjectNamespace<StoricDO>,
  name: string,
  config: StoreConfig,
): Layer.Layer<Store> => {
  const stub = ns.get(ns.idFromName(name));
  return Store.layer(config).pipe(Layer.provide(doStubPersistence(stub)), Layer.orDie);
};

/**
 * Create an async Store client backed by a named StoricDO instance.
 *
 * Binds the namespace, instance name, and entities once, then exposes every
 * Store operation as a plain `Promise`-returning method.
 *
 * @example
 * ```ts
 * import { defineEntity } from "@storic/core";
 * import { createStore } from "@storic/cloudflare";
 *
 * const Person = defineEntity({ schema: PersonV2, lenses: [PersonV1toV2] });
 * const store = createStore(env.STORE, "my-store", { entities: [Person] });
 * const alice = await store.saveEntity(Person, { fullName: "Alice", ... });
 * const all   = await store.loadEntities(Person);
 * ```
 */
export const createStore = (
  ns: DurableObjectNamespace<StoricDO>,
  name: string,
  config: StoreConfig,
) => {
  const layer = makeStoreLayer(ns, name, config);

  const run = <A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, layer));

  function saveEntity<E extends Entity>(
    entity: E,
    data: Omit<Schema.Schema.Type<E["schema"]>, "_tag">,
    opts?: { readonly id?: string },
  ): Promise<EntityRecord<E["schema"]>>;
  function saveEntity<As extends AnyTaggedStruct>(
    entity: Entity,
    data: Omit<Schema.Schema.Type<As>, "_tag">,
    opts: { readonly id?: string; readonly as: As },
  ): Promise<EntityRecord<As>>;
  function saveEntity(entity: Entity, data: any, opts?: any): Promise<any> {
    return run(Store.use((s) => (s.saveEntity as any)(entity, data, opts)));
  }

  function loadEntity<E extends Entity>(
    entity: E,
    id: string,
    opts?: Record<string, never>,
  ): Promise<EntityRecord<E["schema"]>>;
  function loadEntity<As extends AnyTaggedStruct>(
    entity: Entity,
    id: string,
    opts: { readonly as: As },
  ): Promise<EntityRecord<As>>;
  function loadEntity(entity: Entity, id: string, opts?: any): Promise<any> {
    return run(Store.use((s) => (s.loadEntity as any)(entity, id, opts)));
  }

  function loadEntities<E extends Entity>(
    entity: E,
    opts?: {
      readonly filters?: ReadonlyArray<Filter>;
      readonly limit?: number;
      readonly offset?: number;
    },
  ): Promise<Array<EntityRecord<E["schema"]>>>;
  function loadEntities<As extends AnyTaggedStruct>(
    entity: Entity,
    opts: {
      readonly filters?: ReadonlyArray<Filter>;
      readonly limit?: number;
      readonly offset?: number;
      readonly as: As;
    },
  ): Promise<Array<EntityRecord<As>>>;
  function loadEntities(entity: Entity, opts?: any): Promise<any> {
    return run(Store.use((s) => (s.loadEntities as any)(entity, opts)));
  }

  function updateEntity<E extends Entity>(
    entity: E,
    id: string,
    data: Partial<Omit<Schema.Schema.Type<E["schema"]>, "_tag">>,
    opts?: { readonly mode?: "merge" },
  ): Promise<EntityRecord<E["schema"]>>;
  function updateEntity<E extends Entity>(
    entity: E,
    id: string,
    data: Omit<Schema.Schema.Type<E["schema"]>, "_tag">,
    opts: { readonly mode: "replace" },
  ): Promise<EntityRecord<E["schema"]>>;
  function updateEntity<As extends AnyTaggedStruct>(
    entity: Entity,
    id: string,
    data: Partial<Omit<Schema.Schema.Type<As>, "_tag">>,
    opts: { readonly mode?: "merge"; readonly as: As },
  ): Promise<EntityRecord<As>>;
  function updateEntity<As extends AnyTaggedStruct>(
    entity: Entity,
    id: string,
    data: Omit<Schema.Schema.Type<As>, "_tag">,
    opts: { readonly mode: "replace"; readonly as: As },
  ): Promise<EntityRecord<As>>;
  function updateEntity(entity: Entity, id: string, data: any, opts?: any): Promise<any> {
    return run(Store.use((s) => (s.updateEntity as any)(entity, id, data, opts)));
  }

  function patchEntities<E extends Entity>(
    entity: E,
    patch: Partial<Omit<Schema.Schema.Type<E["schema"]>, "_tag">>,
    opts?: { readonly filters?: ReadonlyArray<Filter> },
  ): Promise<number>;
  function patchEntities<As extends AnyTaggedStruct>(
    entity: Entity,
    patch: Partial<Omit<Schema.Schema.Type<As>, "_tag">>,
    opts: { readonly filters?: ReadonlyArray<Filter>; readonly as: As },
  ): Promise<number>;
  function patchEntities(entity: Entity, patch: any, opts?: any): Promise<number> {
    return run(Store.use((s) => (s.patchEntities as any)(entity, patch, opts)));
  }

  return {
    /** Run a custom Store effect. Escape hatch for advanced use. */
    run,

    /** The underlying Store layer, for use in Effect pipelines. */
    layer,

    /** Save an entity. The `_tag` field is added automatically. */
    saveEntity,

    /** Load a single entity by ID. */
    loadEntity,

    /** Load all entities of an entity type, with lens-based auto-conversion. */
    loadEntities,

    /** Update an entity's data (merge by default, or replace). */
    updateEntity,

    /** Batch-patch entities of an entity type. */
    patchEntities,

    /** Delete an entity by ID. */
    deleteEntity: (id: string): Promise<void> => run(Store.use((s) => s.deleteEntity(id))),
  };
};

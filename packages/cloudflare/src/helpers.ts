import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Schema } from "effect";
import { Store } from "@storic/core";
import type { StoreConfig, AnyTaggedStruct, EntityRecord, Filter } from "@storic/core";
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
 * import { makeStoreLayer, Store } from "@storic/cloudflare";
 *
 * const layer = makeStoreLayer(env.STORE, "my-store", storeConfig);
 * const entities = await Effect.runPromise(
 *   Effect.provide(Store.use((s) => s.loadEntities(PersonV2)), layer),
 * );
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
 * Binds the namespace, instance name, and schema config once, then
 * exposes every Store operation as a plain `Promise`-returning method.
 *
 * @example
 * ```ts
 * import { createStore } from "@storic/cloudflare";
 *
 * const store = createStore(env.STORE, "my-store", storeConfig);
 * const alice = await store.saveEntity(PersonV1, { firstName: "Alice", ... });
 * const all   = await store.loadEntities(PersonV2);
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

  return {
    /** Run a custom Store effect. Escape hatch for advanced use. */
    run,

    /** The underlying Store layer, for use in Effect pipelines. */
    layer,

    /** Save an entity. The `_tag` field is added automatically. */
    saveEntity: <T extends AnyTaggedStruct>(
      schema: T,
      data: Omit<Schema.Schema.Type<T>, "_tag">,
      opts?: { readonly id?: string },
    ): Promise<EntityRecord<T>> => run(Store.use((s) => s.saveEntity(schema, data, opts))),

    /** Load a single entity by ID, projected to the given schema version. */
    loadEntity: <T extends AnyTaggedStruct>(schema: T, id: string): Promise<EntityRecord<T>> =>
      run(Store.use((s) => s.loadEntity(schema, id))),

    /** Load all entities of a schema type, with lens-based auto-conversion. */
    loadEntities: <T extends AnyTaggedStruct>(
      schema: T,
      opts?: {
        readonly filters?: ReadonlyArray<Filter>;
        readonly limit?: number;
        readonly offset?: number;
      },
    ): Promise<Array<EntityRecord<T>>> => run(Store.use((s) => s.loadEntities(schema, opts))),

    /** Update an entity's data (merge by default, or replace). */
    updateEntity: <T extends AnyTaggedStruct>(
      schema: T,
      id: string,
      data: Partial<Omit<Schema.Schema.Type<T>, "_tag">>,
      opts?: { readonly mode?: "merge" | "replace" },
    ): Promise<EntityRecord<T>> =>
      run(Store.use((s) => s.updateEntity(schema, id, data, opts as any))),

    /** Batch-patch all entities reachable from the given schema type. */
    patchEntities: <T extends AnyTaggedStruct>(
      schema: T,
      patch: Partial<Omit<Schema.Schema.Type<T>, "_tag">>,
      opts?: { readonly filters?: ReadonlyArray<Filter> },
    ): Promise<number> => run(Store.use((s) => s.patchEntities(schema, patch, opts))),

    /** Delete an entity by ID. */
    deleteEntity: (id: string): Promise<void> => run(Store.use((s) => s.deleteEntity(id))),
  };
};

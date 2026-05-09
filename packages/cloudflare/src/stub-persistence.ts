import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Persistence, PersistenceError } from "@storic/core";
import type { StoricDO } from "./storic-object.ts";

/**
 * Persistence layer backed by RPC calls to a {@link StoricDO} stub.
 *
 * Compose with `Store.layer(config)` to get a fully functional Store
 * where schema/lens knowledge stays caller-side and storage lives in the DO.
 *
 * @example
 * ```ts
 * import { Store } from "@storic/core";
 * import { doStubPersistence } from "@storic/cloudflare";
 *
 * const stub = env.STORE.get(env.STORE.idFromName("my-store"));
 * const storeLayer = Store.layer(config).pipe(
 *   Layer.provide(doStubPersistence(stub)),
 * );
 * ```
 */
export const doStubPersistence = (stub: DurableObjectStub<StoricDO>): Layer.Layer<Persistence> =>
  Layer.succeed(
    Persistence,
    Persistence.of({
      initialize: (spec) =>
        Effect.tryPromise({
          try: () => stub.initialize(spec),
          catch: (error) => new PersistenceError({ message: String(error) }),
        }),

      put: (record) =>
        Effect.tryPromise({
          try: () => stub.put(record),
          catch: (error) => new PersistenceError({ message: String(error) }),
        }),

      get: (id) =>
        Effect.tryPromise({
          try: () => stub.get(id),
          catch: (error) => new PersistenceError({ message: String(error) }),
        }),

      query: (params) =>
        Effect.tryPromise({
          try: () => stub.query(params),
          catch: (error) => new PersistenceError({ message: String(error) }),
        }),

      update: (id, record) =>
        Effect.tryPromise({
          try: () => stub.update(id, record),
          catch: (error) => new PersistenceError({ message: String(error) }),
        }),

      patch: (params) =>
        Effect.tryPromise({
          try: () => stub.patch(params),
          catch: (error) => new PersistenceError({ message: String(error) }),
        }),

      remove: (id) =>
        Effect.tryPromise({
          try: () => stub.remove(id),
          catch: (error) => new PersistenceError({ message: String(error) }),
        }),
    }),
  );

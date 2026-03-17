import * as Layer from "effect/Layer";
import { Persistence, PersistenceError } from "@storic/core";
import { sqlPersistenceLayer } from "@storic/sql";
import { sqlStorageLayer } from "./sql-storage-client.ts";

/**
 * Persistence implementation backed by Cloudflare Durable Object's SqlStorage.
 *
 * This is a thin wrapper that provides the DO's `SqlStorage` as the `SqlClient`
 * dependency for the shared SQL persistence implementation from `@storic/sql`.
 *
 * @example
 * ```ts
 * import { doStoragePersistence } from "@storic/cloudflare";
 *
 * const persistenceLayer = doStoragePersistence(ctx.storage.sql);
 * const storeLayer = Store.layer(config).pipe(Layer.provide(persistenceLayer));
 * ```
 */
export const doStoragePersistence = (
  storage: SqlStorage,
): Layer.Layer<Persistence, PersistenceError> =>
  sqlPersistenceLayer.pipe(Layer.provide(sqlStorageLayer(storage)));

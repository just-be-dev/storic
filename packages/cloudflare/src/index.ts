/**
 * @storic/cloudflare
 *
 * Helper utilities for using Storic with Cloudflare Durable Objects.
 *
 * Provides:
 * - `StoricDO` — Generic DO that exposes Persistence as RPC methods
 * - `doStubPersistence` — Persistence layer backed by RPC to a StoricDO stub
 * - `doStoragePersistence` — Persistence layer backed by DO's SqlStorage (direct)
 * - `sqlStorageLayer` — Low-level SqlClient adapter (for advanced use)
 */

export { StoricDO, StoricObject } from "./storic-object.ts";
export { doStubPersistence } from "./stub-persistence.ts";
export { makeStoreLayer, createStore } from "./helpers.ts";
export { doStoragePersistence } from "./persistence.ts";
export { sqlStorageLayer } from "./sql-storage-client.ts";

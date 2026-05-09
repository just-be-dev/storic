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

// ─── Cloudflare-specific ────────────────────────────────────────────────────
export { StoricDO, StoricObject } from "./storic-object.ts";
export { doStubPersistence } from "./stub-persistence.ts";
export { makeStoreLayer, createStore } from "./helpers.ts";
export { doStoragePersistence } from "./persistence.ts";
export { sqlStorageLayer } from "./sql-storage-client.ts";

// ─── Re-export core for convenience ─────────────────────────────────────────
export {
  Store,
  Persistence,
  defineLens,
  defineEntity,
  entitySchemas,
  SchemaRegistry,
  getTag,
} from "@storic/core";
export type {
  AnyTaggedStruct,
  Entity,
  EntityRecord,
  Lens,
  StoreConfig,
  PersistenceShape,
  PersistenceRecord,
  StoredRecord,
  IndexSpec,
  InitSpec,
  QueryParams,
} from "@storic/core";

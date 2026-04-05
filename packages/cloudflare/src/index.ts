/**
 * @storic/cloudflare
 *
 * Helper utilities for using Storic with Cloudflare Durable Objects.
 *
 * Provides:
 * - `doStoragePersistence` — Persistence implementation backed by DO's SqlStorage
 * - `StoricDO` — Base class for DOs with automatic Store setup
 * - `sqlStorageLayer` — Low-level SqlClient adapter (for advanced use)
 */

// ─── Cloudflare-specific ────────────────────────────────────────────────────
export { doStoragePersistence } from "./persistence.ts";
export { StoricDO, StoricObject } from "./storic-object.ts";
export { sqlStorageLayer } from "./sql-storage-client.ts";

// ─── Re-export core for convenience ─────────────────────────────────────────
export { Store, Persistence, defineLens, SchemaRegistry, getTag } from "@storic/core";
export type {
  AnyTaggedStruct,
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

/**
 * @storic/cloudflare
 *
 * Helper utilities for using Storic with Cloudflare Durable Objects.
 *
 * Provides:
 * - `sqlStorageLayer` — Effect SqlClient backed by DO's sync SqlStorage
 * - `StoricObject` — Base class for DOs with automatic Store setup
 */

// ─── Cloudflare-specific ────────────────────────────────────────────────────
export { sqlStorageLayer } from "./sql-storage-client.ts";
export { StoricObject } from "./storic-object.ts";

// ─── Re-export core for convenience ─────────────────────────────────────────
export { Store, defineLens, SchemaRegistry, getTag } from "@storic/core";
export type {
  AnyTaggedStruct,
  EntityRecord,
  Lens,
  StoreConfig,
} from "@storic/core";

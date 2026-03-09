/**
 * @storic/cloudflare
 *
 * Helper utilities for using Storic with Cloudflare Durable Objects.
 *
 * This package is a placeholder for future Cloudflare-specific integrations
 * such as:
 * - Durable Object storage adapter
 * - D1 database adapter
 * - KV caching layer
 *
 * For now, use `@storic/core` directly with a compatible SqlClient layer.
 */

// Re-export core for convenience
export { Store, defineLens, SchemaRegistry, getTag } from "@storic/core";
export type {
  AnyTaggedStruct,
  EntityRecord,
  Lens,
  StoreConfig,
} from "@storic/core";

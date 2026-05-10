import type { StoredRecord } from "./persistence.ts";

/**
 * A change event emitted when a record is created, updated, or deleted.
 *
 * Backends with native change-notification capability emit these via
 * `Persistence.subscribe`. The Store fans them out to per-entity subscribers.
 *
 * - "put" / "update": carries the full updated record
 * - "delete": carries id and last-known type (null if unknown)
 * - "bulk": signals "some records of this type changed but per-id events are
 *   not available" — used for batch operations like `patchEntities`. Subscribers
 *   should re-query on receiving a "bulk" event for their type.
 */
export type ChangeEvent =
  | {
      readonly kind: "put" | "update";
      readonly id: string;
      readonly type: string;
      readonly record: StoredRecord;
    }
  | {
      readonly kind: "delete";
      readonly id: string;
      /** Last known type if available, otherwise null. */
      readonly type: string | null;
    }
  | {
      readonly kind: "bulk";
      readonly type: string;
    };

/**
 * Filter spec for a backend subscription.
 *
 * Empty spec (`{}`) means "all changes". `types` narrows by record type
 * (allowing the backend to skip events for unrelated entities). `id` further
 * narrows to a single record.
 */
export interface SubscribeSpec {
  readonly types?: ReadonlyArray<string>;
  readonly id?: string;
}

/**
 * Per-runtime promise cache for first-render suspense. Keys are
 * caller-built strings encoding the entity, id (if any), schema
 * version, and query options. Cleared automatically when the runtime
 * is GC'd.
 *
 * Tradeoff: entries are never invalidated on bus events. A component that
 * unmounts and immediately remounts after a mutation will read the stale
 * cached promise on first render before the live stream re-emits the
 * current value. This is intentional — invalidating per-event would defeat
 * the suspense-once-per-key model and add complexity for a transient flash.
 * `useEntity`/`useEntities` paper over the gap by returning the live value
 * (when present) in preference to the cached `initial`.
 */

const caches = new WeakMap<object, Map<string, Promise<unknown>>>();

export function getRuntimeCache(runtime: object): Map<string, Promise<unknown>> {
  let m = caches.get(runtime);
  if (!m) {
    m = new Map();
    caches.set(runtime, m);
  }
  return m;
}

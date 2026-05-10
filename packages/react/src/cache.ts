/**
 * Per-runtime promise cache for first-render suspense. Keys are
 * caller-built strings encoding the entity, id (if any), schema
 * version, and query options. Cleared automatically when the runtime
 * is GC'd.
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

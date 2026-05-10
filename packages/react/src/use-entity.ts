import { Effect, Stream } from "effect";
import { use } from "react";
import { Store } from "@storic/core";
import type { AnyTaggedStruct, Entity, EntityRecord, StoreError } from "@storic/core";
import { useStoricRuntime, useStoricStore } from "./provider.tsx";
import { useStreamState } from "./sync-external-store.ts";
import { getRuntimeCache } from "./cache.ts";

export interface UseEntityOptions<As extends AnyTaggedStruct = AnyTaggedStruct> {
  readonly as?: As;
}

/**
 * Read a single entity by id.
 *
 * **Suspends on first render** — wrap the consuming subtree in
 * `<Suspense fallback={...}>`. After the initial load, the value is kept
 * live: subsequent mutations to this entity (from any component) cause a
 * re-render with the new value.
 *
 * Errors during initial load throw to the nearest `<ErrorBoundary>`.
 * Returns `null` if the entity does not exist.
 */
export function useEntity<E extends Entity>(
  entity: E,
  id: string,
  opts?: { readonly as?: undefined },
): EntityRecord<E["schema"]> | null;

export function useEntity<As extends AnyTaggedStruct>(
  entity: Entity,
  id: string,
  opts: { readonly as: As },
): EntityRecord<As> | null;

export function useEntity(entity: Entity, id: string, opts?: UseEntityOptions): unknown {
  const runtime = useStoricRuntime();
  const store = useStoricStore();
  const asTag = opts?.as ? (opts.as.fields._tag.schema.literal as string) : "__default__";
  const entityTag = entity.schema.fields._tag.schema.literal as string;
  const key = `entity:${entityTag}:${id}:${asTag}`;

  // ── First-render suspension ────────────────────────────────────────────
  const cache = getRuntimeCache(runtime);
  let promise = cache.get(key);
  if (!promise) {
    const loadEff = Effect.gen(function* () {
      const s = yield* Store;
      return yield* (s.loadEntity as any)(entity, id, opts);
    }) as Effect.Effect<unknown, StoreError, Store>;
    promise = runtime.runPromise(
      loadEff.pipe(
        Effect.catchTag("EntityNotFoundError", () => Effect.succeed(null)),
      ) as Effect.Effect<unknown, never, Store>,
    );
    cache.set(key, promise);
  }
  const initial = use(promise) as EntityRecord<AnyTaggedStruct> | null;

  // ── Live updates after initial load ────────────────────────────────────
  const makeStream = () =>
    (store.subscribeEntity as any)(entity, id, opts) as Stream.Stream<
      EntityRecord<AnyTaggedStruct> | null,
      StoreError,
      Store
    >;

  const live = useStreamState(runtime, makeStream, [runtime, store, entity, id, asTag]);

  if (live.error) throw live.error;
  return live.data === undefined ? initial : live.data;
}

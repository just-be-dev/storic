import { Effect, Stream } from "effect";
import { use } from "react";
import { Store } from "@storic/core";
import type { AnyTaggedStruct, Entity, EntityRecord, Filter, StoreError } from "@storic/core";
import { useStoricRuntime, useStoricStore } from "./provider.tsx";
import { useStreamState } from "./sync-external-store.ts";
import { getRuntimeCache } from "./cache.ts";

export interface UseEntitiesOptions<As extends AnyTaggedStruct = AnyTaggedStruct> {
  readonly filters?: ReadonlyArray<Filter>;
  readonly limit?: number;
  readonly offset?: number;
  readonly as?: As;
}

/**
 * Read a list of entities matching the optional query.
 *
 * **Suspends on first render** — wrap the consuming subtree in
 * `<Suspense fallback={...}>`. After the initial load, the value is kept
 * live: any mutation that affects matching entities re-renders this hook.
 *
 * Errors during initial load throw to the nearest `<ErrorBoundary>`.
 */
export function useEntities<E extends Entity>(
  entity: E,
  opts?: UseEntitiesOptions & { readonly as?: undefined },
): ReadonlyArray<EntityRecord<E["schema"]>>;

export function useEntities<As extends AnyTaggedStruct>(
  entity: Entity,
  opts: UseEntitiesOptions<As> & { readonly as: As },
): ReadonlyArray<EntityRecord<As>>;

export function useEntities(entity: Entity, opts?: UseEntitiesOptions): unknown {
  const runtime = useStoricRuntime();
  const store = useStoricStore();
  const asTag = opts?.as ? (opts.as.fields._tag.schema.literal as string) : "__default__";
  const entityTag = entity.schema.fields._tag.schema.literal as string;
  const filterKey = opts?.filters ? JSON.stringify(opts.filters) : "";
  const queryKey = `${asTag}:${opts?.limit ?? ""}:${opts?.offset ?? ""}:${filterKey}`;
  const key = `entities:${entityTag}:${queryKey}`;

  // ── First-render suspension ────────────────────────────────────────────
  const cache = getRuntimeCache(runtime);
  let promise = cache.get(key);
  if (!promise) {
    const eff = Effect.gen(function* () {
      const s = yield* Store;
      return yield* (s.loadEntities as any)(entity, opts);
    }) as Effect.Effect<unknown, StoreError, Store>;
    promise = runtime.runPromise(eff as Effect.Effect<unknown, never, Store>);
    cache.set(key, promise);
  }
  const initial = use(promise) as ReadonlyArray<EntityRecord<AnyTaggedStruct>>;

  // ── Live updates after initial load ────────────────────────────────────
  const makeStream = () =>
    (store.subscribeEntities as any)(entity, opts) as Stream.Stream<
      ReadonlyArray<EntityRecord<AnyTaggedStruct>>,
      StoreError,
      Store
    >;

  const live = useStreamState(runtime, makeStream, [runtime, store, entity, queryKey]);

  if (live.error) throw live.error;
  return live.data === undefined ? initial : live.data;
}

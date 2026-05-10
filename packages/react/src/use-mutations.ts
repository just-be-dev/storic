import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { Store } from "@storic/core";
import type { AnyTaggedStruct, Entity, EntityRecord, Filter, StoreError } from "@storic/core";
import { useStoricRuntime } from "./provider.tsx";

export interface MutationState<A> {
  readonly status: "idle" | "pending" | "success" | "error";
  readonly error: StoreError | undefined;
  readonly data: A | undefined;
}

const idleState: MutationState<unknown> = {
  status: "idle",
  error: undefined,
  data: undefined,
};

function useRunMutation<A, Args extends ReadonlyArray<unknown>>(
  build: (...args: Args) => Effect.Effect<A, StoreError, Store>,
): readonly [(...args: Args) => Promise<A>, MutationState<A>] {
  const runtime = useStoricRuntime();
  const [state, setState] = useState<MutationState<A>>(idleState as MutationState<A>);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const safeSet = (next: MutationState<A>) => {
    if (mounted.current) setState(next);
  };

  const run = useCallback(
    async (...args: Args): Promise<A> => {
      safeSet({ status: "pending", error: undefined, data: undefined });
      try {
        const result = await runtime.runPromise(build(...args));
        safeSet({ status: "success", error: undefined, data: result });
        return result;
      } catch (err) {
        safeSet({
          status: "error",
          error: err as StoreError,
          data: undefined,
        });
        throw err;
      }
    },
    // build typically references stable module-scope entities; callers may
    // wrap in useCallback if they construct it dynamically.
    [runtime, build],
  );

  return [run, state] as const;
}

// ─── useSaveEntity ──────────────────────────────────────────────────────────

export function useSaveEntity<E extends Entity>(
  entity: E,
): readonly [
  (
    data: Omit<E["schema"]["Type"], "_tag">,
    opts?: { readonly id?: string },
  ) => Promise<EntityRecord<E["schema"]>>,
  MutationState<EntityRecord<E["schema"]>>,
];

export function useSaveEntity<As extends AnyTaggedStruct>(
  entity: Entity,
  as: As,
): readonly [
  (data: Omit<As["Type"], "_tag">, opts?: { readonly id?: string }) => Promise<EntityRecord<As>>,
  MutationState<EntityRecord<As>>,
];

export function useSaveEntity(entity: Entity, as?: AnyTaggedStruct) {
  return useRunMutation(
    (data: Record<string, unknown>, opts?: { readonly id?: string }) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const fullOpts = as ? { ...opts, as } : opts;
        return yield* (store.saveEntity as any)(entity, data, fullOpts);
      }) as Effect.Effect<EntityRecord<AnyTaggedStruct>, StoreError, Store>,
  );
}

// ─── useUpdateEntity ────────────────────────────────────────────────────────

export function useUpdateEntity<E extends Entity>(
  entity: E,
): readonly [
  (
    id: string,
    data: Partial<Omit<E["schema"]["Type"], "_tag">>,
    opts?: { readonly mode?: "merge" | "replace" },
  ) => Promise<EntityRecord<E["schema"]>>,
  MutationState<EntityRecord<E["schema"]>>,
];

export function useUpdateEntity<As extends AnyTaggedStruct>(
  entity: Entity,
  as: As,
): readonly [
  (
    id: string,
    data: Partial<Omit<As["Type"], "_tag">>,
    opts?: { readonly mode?: "merge" | "replace" },
  ) => Promise<EntityRecord<As>>,
  MutationState<EntityRecord<As>>,
];

export function useUpdateEntity(entity: Entity, as?: AnyTaggedStruct) {
  return useRunMutation(
    (id: string, data: Record<string, unknown>, opts?: { readonly mode?: "merge" | "replace" }) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const fullOpts = as ? { ...opts, as } : opts;
        return yield* (store.updateEntity as any)(entity, id, data, fullOpts);
      }) as Effect.Effect<EntityRecord<AnyTaggedStruct>, StoreError, Store>,
  );
}

// ─── usePatchEntities ───────────────────────────────────────────────────────

export function usePatchEntities<E extends Entity>(
  entity: E,
): readonly [
  (
    patch: Partial<Omit<E["schema"]["Type"], "_tag">>,
    opts?: { readonly filters?: ReadonlyArray<Filter> },
  ) => Promise<number>,
  MutationState<number>,
];

export function usePatchEntities<As extends AnyTaggedStruct>(
  entity: Entity,
  as: As,
): readonly [
  (
    patch: Partial<Omit<As["Type"], "_tag">>,
    opts?: { readonly filters?: ReadonlyArray<Filter> },
  ) => Promise<number>,
  MutationState<number>,
];

export function usePatchEntities(entity: Entity, as?: AnyTaggedStruct) {
  return useRunMutation(
    (patch: Record<string, unknown>, opts?: { readonly filters?: ReadonlyArray<Filter> }) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const fullOpts = as ? { ...opts, as } : opts;
        return yield* (store.patchEntities as any)(entity, patch, fullOpts);
      }) as Effect.Effect<number, StoreError, Store>,
  );
}

// ─── useDeleteEntity ────────────────────────────────────────────────────────

export function useDeleteEntity(): readonly [(id: string) => Promise<void>, MutationState<void>] {
  return useRunMutation((id: string) =>
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.deleteEntity(id);
    }),
  );
}

import { Effect, Stream } from "effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import type { AsyncResult } from "effect/unstable/reactivity/AsyncResult";
import { Store } from "@storic/core";
import type { AnyTaggedStruct, Entity, EntityRecord, Filter, StoreError } from "@storic/core";

// ─── Internal helpers ───────────────────────────────────────────────────────

const subscribeEntityStream = (
  entity: Entity,
  id: string,
  opts?: { readonly as?: AnyTaggedStruct },
): Stream.Stream<EntityRecord<AnyTaggedStruct> | null, StoreError, Store> =>
  Stream.unwrap(
    Effect.map(Store.asEffect(), (store) => (store.subscribeEntity as any)(entity, id, opts)),
  );

const subscribeEntitiesStream = (
  entity: Entity,
  opts?: {
    readonly filters?: ReadonlyArray<Filter>;
    readonly limit?: number;
    readonly offset?: number;
    readonly as?: AnyTaggedStruct;
  },
): Stream.Stream<ReadonlyArray<EntityRecord<AnyTaggedStruct>>, StoreError, Store> =>
  Stream.unwrap(
    Effect.map(Store.asEffect(), (store) => (store.subscribeEntities as any)(entity, opts)),
  );

// ─── entityAtom ─────────────────────────────────────────────────────────────

/**
 * Build a per-id atom factory for live single-entity reads. Returns a
 * memoized function `(id) => Atom<AsyncResult<EntityRecord | null, StoreError>>`.
 *
 * The atom is auto-disposed when no component reads it (subject to the
 * runtime's idle TTL). Mutations through `saveEntityAtom`/`updateEntityAtom`
 * etc. propagate via the Store's notification bus and re-emit on this atom.
 */
export function entityAtom<E extends Entity>(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: E,
): (id: string) => Atom.Atom<AsyncResult<EntityRecord<E["schema"]> | null, StoreError>>;

export function entityAtom<As extends AnyTaggedStruct>(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: Entity,
  as: As,
): (id: string) => Atom.Atom<AsyncResult<EntityRecord<As> | null, StoreError>>;

export function entityAtom(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: Entity,
  as?: AnyTaggedStruct,
) {
  const opts = as ? { as } : undefined;
  return Atom.family((id: string) => runtime.atom(subscribeEntityStream(entity, id, opts) as any));
}

// ─── entitiesAtom ───────────────────────────────────────────────────────────

/**
 * Build an atom for a live entity list. Pass `opts` once at construction
 * time. For dynamic queries, wrap in `Atom.family`:
 *
 * ```ts
 * const peopleByEmail = Atom.family((email: string) =>
 *   entitiesAtom(runtime, Person, {
 *     filters: [{ field: "email", op: "eq", value: email }],
 *   }),
 * );
 * ```
 */
export function entitiesAtom<E extends Entity>(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: E,
  opts?: {
    readonly filters?: ReadonlyArray<Filter>;
    readonly limit?: number;
    readonly offset?: number;
  },
): Atom.Atom<AsyncResult<ReadonlyArray<EntityRecord<E["schema"]>>, StoreError>>;

export function entitiesAtom<As extends AnyTaggedStruct>(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: Entity,
  opts: {
    readonly filters?: ReadonlyArray<Filter>;
    readonly limit?: number;
    readonly offset?: number;
    readonly as: As;
  },
): Atom.Atom<AsyncResult<ReadonlyArray<EntityRecord<As>>, StoreError>>;

export function entitiesAtom(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: Entity,
  opts?: {
    readonly filters?: ReadonlyArray<Filter>;
    readonly limit?: number;
    readonly offset?: number;
    readonly as?: AnyTaggedStruct;
  },
) {
  return runtime.atom(subscribeEntitiesStream(entity, opts) as any);
}

// ─── Mutation atom argument types ───────────────────────────────────────────

export interface SaveEntityArgs<E extends AnyTaggedStruct = AnyTaggedStruct> {
  readonly data: Omit<E["Type"], "_tag">;
  readonly id?: string;
}

export interface UpdateEntityArgs<E extends AnyTaggedStruct = AnyTaggedStruct> {
  readonly id: string;
  readonly data: Partial<Omit<E["Type"], "_tag">>;
  readonly mode?: "merge" | "replace";
}

export interface PatchEntitiesArgs<E extends AnyTaggedStruct = AnyTaggedStruct> {
  readonly patch: Partial<Omit<E["Type"], "_tag">>;
  readonly filters?: ReadonlyArray<Filter>;
}

// ─── Mutation atoms ─────────────────────────────────────────────────────────

export function saveEntityAtom<E extends Entity>(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: E,
): Atom.AtomResultFn<SaveEntityArgs<E["schema"]>, EntityRecord<E["schema"]>, StoreError>;

export function saveEntityAtom<As extends AnyTaggedStruct>(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: Entity,
  as: As,
): Atom.AtomResultFn<SaveEntityArgs<As>, EntityRecord<As>, StoreError>;

export function saveEntityAtom(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: Entity,
  as?: AnyTaggedStruct,
) {
  const fn = (args: SaveEntityArgs) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const opts = as ? { id: args.id, as } : args.id !== undefined ? { id: args.id } : undefined;
      return yield* (store.saveEntity as any)(entity, args.data, opts);
    }) as Effect.Effect<EntityRecord<AnyTaggedStruct>, StoreError, Store>;
  return runtime.fn(fn);
}

export function updateEntityAtom<E extends Entity>(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: E,
): Atom.AtomResultFn<UpdateEntityArgs<E["schema"]>, EntityRecord<E["schema"]>, StoreError>;

export function updateEntityAtom<As extends AnyTaggedStruct>(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: Entity,
  as: As,
): Atom.AtomResultFn<UpdateEntityArgs<As>, EntityRecord<As>, StoreError>;

export function updateEntityAtom(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: Entity,
  as?: AnyTaggedStruct,
) {
  const fn = (args: UpdateEntityArgs) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const opts = as
        ? { mode: args.mode, as }
        : args.mode !== undefined
          ? { mode: args.mode }
          : undefined;
      return yield* (store.updateEntity as any)(entity, args.id, args.data, opts);
    }) as Effect.Effect<EntityRecord<AnyTaggedStruct>, StoreError, Store>;
  return runtime.fn(fn);
}

export function patchEntitiesAtom<E extends Entity>(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: E,
): Atom.AtomResultFn<PatchEntitiesArgs<E["schema"]>, number, StoreError>;

export function patchEntitiesAtom<As extends AnyTaggedStruct>(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: Entity,
  as: As,
): Atom.AtomResultFn<PatchEntitiesArgs<As>, number, StoreError>;

export function patchEntitiesAtom(
  runtime: Atom.AtomRuntime<Store, never>,
  entity: Entity,
  as?: AnyTaggedStruct,
) {
  const fn = (args: PatchEntitiesArgs) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const opts = as
        ? { filters: args.filters, as }
        : args.filters !== undefined
          ? { filters: args.filters }
          : undefined;
      return yield* (store.patchEntities as any)(entity, args.patch, opts);
    }) as Effect.Effect<number, StoreError, Store>;
  return runtime.fn(fn);
}

export function deleteEntityAtom(
  runtime: Atom.AtomRuntime<Store, never>,
): Atom.AtomResultFn<string, void, StoreError> {
  const fn = (id: string): Effect.Effect<void, StoreError, Store> =>
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.deleteEntity(id);
    });
  return runtime.fn(fn);
}

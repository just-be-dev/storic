import { Effect, Fiber, Stream } from "effect";
import { useEffect, useRef } from "react";
import { getTag } from "@storic/core";
import type { AnyTaggedStruct, Entity, EntityRecord, Filter } from "@storic/core";
import { useStoricRuntime, useStoricStore } from "./provider.tsx";

/**
 * Subscribe to a single entity's changes for side effects only — does NOT
 * cause the component to re-render. Useful for syncing entity state to
 * external systems (URL, analytics, websocket fan-out, etc).
 *
 * The subscription re-runs only when `entity`, `id`, or the projection
 * schema in `opts.as` change. `onChange` is captured by ref, so passing
 * an inline callback is safe — the latest version is always invoked.
 */
export function useEntityListener<E extends Entity>(
  entity: E,
  id: string,
  onChange: (record: EntityRecord<E["schema"]> | null) => void,
): void;

export function useEntityListener<As extends AnyTaggedStruct>(
  entity: Entity,
  id: string,
  onChange: (record: EntityRecord<As> | null) => void,
  opts: { readonly as: As },
): void;

export function useEntityListener(
  entity: Entity,
  id: string,
  onChange: (record: EntityRecord<AnyTaggedStruct> | null) => void,
  opts?: { readonly as?: AnyTaggedStruct },
): void {
  const runtime = useStoricRuntime();
  const store = useStoricStore();

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const asTag = opts?.as ? getTag(opts.as) : "__default__";

  useEffect(() => {
    const stream = (store.subscribeEntity as any)(entity, id, opts) as Stream.Stream<
      EntityRecord<AnyTaggedStruct> | null,
      unknown,
      unknown
    >;
    const fiber = runtime.runFork(
      stream.pipe(
        Stream.runForEach((record) =>
          Effect.sync(() => onChangeRef.current(record as EntityRecord<AnyTaggedStruct> | null)),
        ),
        Effect.catch(() => Effect.void),
      ) as Effect.Effect<void, never, never>,
    );
    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
    // `opts` is intentionally not in deps — `asTag` is its only relevant
    // identity-stable projection. The opts object passed at re-subscribe
    // time is captured fresh inside the effect.
  }, [runtime, store, entity, id, asTag]);
}

export interface UseEntitiesListenerOptions<As extends AnyTaggedStruct = AnyTaggedStruct> {
  readonly filters?: ReadonlyArray<Filter>;
  readonly limit?: number;
  readonly offset?: number;
  readonly as?: As;
}

/**
 * Subscribe to a query result for side effects only — does NOT cause the
 * component to re-render.
 *
 * The subscription re-runs only when `entity` or any field of `opts`
 * (filters, limit, offset, projection schema) changes — opts is tracked
 * via deep value comparison, so passing an inline object on each render
 * is safe. `onChange` is captured by ref, so inline callbacks are safe too.
 */
export function useEntitiesListener<E extends Entity>(
  entity: E,
  opts: UseEntitiesListenerOptions | undefined,
  onChange: (records: ReadonlyArray<EntityRecord<E["schema"]>>) => void,
): void;

export function useEntitiesListener<As extends AnyTaggedStruct>(
  entity: Entity,
  opts: UseEntitiesListenerOptions<As> & { readonly as: As },
  onChange: (records: ReadonlyArray<EntityRecord<As>>) => void,
): void;

export function useEntitiesListener(
  entity: Entity,
  opts: UseEntitiesListenerOptions | undefined,
  onChange: (records: ReadonlyArray<EntityRecord<AnyTaggedStruct>>) => void,
): void {
  const runtime = useStoricRuntime();
  const store = useStoricStore();

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const asTag = opts?.as ? getTag(opts.as) : "__default__";
  const filterKey = opts?.filters ? JSON.stringify(opts.filters) : "";
  const queryKey = `${asTag}:${opts?.limit ?? ""}:${opts?.offset ?? ""}:${filterKey}`;

  useEffect(() => {
    const stream = (store.subscribeEntities as any)(entity, opts) as Stream.Stream<
      ReadonlyArray<EntityRecord<AnyTaggedStruct>>,
      unknown,
      unknown
    >;
    const fiber = runtime.runFork(
      stream.pipe(
        Stream.runForEach((records) =>
          Effect.sync(() =>
            onChangeRef.current(records as ReadonlyArray<EntityRecord<AnyTaggedStruct>>),
          ),
        ),
        Effect.catch(() => Effect.void),
      ) as Effect.Effect<void, never, never>,
    );
    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
    // `opts` itself is excluded from deps; `queryKey` captures every
    // field that influences the subscription identity.
  }, [runtime, store, entity, queryKey]);
}

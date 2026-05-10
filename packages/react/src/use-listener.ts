import { Effect, Fiber, Stream } from "effect";
import { useEffect } from "react";
import type { AnyTaggedStruct, Entity, EntityRecord, Filter } from "@storic/core";
import { useStoricRuntime, useStoricStore } from "./provider.tsx";

/**
 * Subscribe to a single entity's changes for side effects only — does NOT
 * cause the component to re-render. Useful for syncing entity state to
 * external systems (URL, analytics, websocket fan-out, etc).
 */
export function useEntityListener<E extends Entity>(
  entity: E,
  id: string,
  onChange: (record: EntityRecord<E["schema"]> | null) => void,
  deps: ReadonlyArray<unknown>,
): void;

export function useEntityListener<As extends AnyTaggedStruct>(
  entity: Entity,
  id: string,
  onChange: (record: EntityRecord<As> | null) => void,
  deps: ReadonlyArray<unknown>,
  opts: { readonly as: As },
): void;

export function useEntityListener(
  entity: Entity,
  id: string,
  onChange: (record: EntityRecord<AnyTaggedStruct> | null) => void,
  deps: ReadonlyArray<unknown>,
  opts?: { readonly as?: AnyTaggedStruct },
): void {
  const runtime = useStoricRuntime();
  const store = useStoricStore();

  useEffect(() => {
    const stream = (store.subscribeEntity as any)(entity, id, opts) as Stream.Stream<
      EntityRecord<AnyTaggedStruct> | null,
      unknown,
      unknown
    >;
    const fiber = runtime.runFork(
      stream.pipe(
        Stream.runForEach((record) =>
          Effect.sync(() => onChange(record as EntityRecord<AnyTaggedStruct> | null)),
        ),
        Effect.catch(() => Effect.void),
      ) as Effect.Effect<void, never, never>,
    );
    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, store, entity, id, ...deps]);
}

/**
 * Subscribe to a query result for side effects only — does NOT cause the
 * component to re-render.
 */
export function useEntitiesListener<E extends Entity>(
  entity: E,
  opts:
    | {
        readonly filters?: ReadonlyArray<Filter>;
        readonly limit?: number;
        readonly offset?: number;
      }
    | undefined,
  onChange: (records: ReadonlyArray<EntityRecord<E["schema"]>>) => void,
  deps: ReadonlyArray<unknown>,
): void {
  const runtime = useStoricRuntime();
  const store = useStoricStore();

  useEffect(() => {
    const stream = (store.subscribeEntities as any)(entity, opts) as Stream.Stream<
      ReadonlyArray<EntityRecord<AnyTaggedStruct>>,
      unknown,
      unknown
    >;
    const fiber = runtime.runFork(
      stream.pipe(
        Stream.runForEach((records) =>
          Effect.sync(() => onChange(records as ReadonlyArray<EntityRecord<AnyTaggedStruct>>)),
        ),
        Effect.catch(() => Effect.void),
      ) as Effect.Effect<void, never, never>,
    );
    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, store, entity, ...deps]);
}

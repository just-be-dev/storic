import { Effect, Fiber, ManagedRuntime, Stream } from "effect";
import { useMemo, useSyncExternalStore } from "react";
import type { Store } from "@storic/core";

export interface StreamState<A, E> {
  readonly data: A | undefined;
  readonly error: E | undefined;
  readonly isLoading: boolean;
}

const initialState: StreamState<unknown, unknown> = {
  data: undefined,
  error: undefined,
  isLoading: true,
};

/**
 * Subscribe to an Effect `Stream` from a React component, surfacing the
 * latest emission, error (if any), and loading state.
 *
 * The stream is started lazily on first subscribe and torn down (via fiber
 * interrupt) when the last subscriber unmounts. Snapshot identity is stable
 * between emissions so React skips re-renders correctly.
 */
export function useStreamState<A, E>(
  runtime: ManagedRuntime.ManagedRuntime<Store, never>,
  makeStream: () => Stream.Stream<A, E, Store>,
  deps: ReadonlyArray<unknown>,
): StreamState<A, E> {
  const sub = useMemo(() => {
    let snapshot: StreamState<A, E> = initialState as StreamState<A, E>;
    const listeners = new Set<() => void>();
    let fiber: Fiber.Fiber<unknown, unknown> | null = null;

    const notify = () => {
      for (const l of listeners) l();
    };

    return {
      subscribe(cb: () => void): () => void {
        listeners.add(cb);
        if (fiber === null) {
          const stream = makeStream();
          const program = stream.pipe(
            Stream.runForEach((value: A) =>
              Effect.sync(() => {
                snapshot = { data: value, error: undefined, isLoading: false };
                notify();
              }),
            ),
            Effect.catch((err: E) =>
              Effect.sync(() => {
                snapshot = { data: snapshot.data, error: err, isLoading: false };
                notify();
              }),
            ),
          );
          fiber = runtime.runFork(program as Effect.Effect<void, never, Store>);
        }
        return () => {
          listeners.delete(cb);
          if (listeners.size === 0 && fiber) {
            runtime.runFork(Fiber.interrupt(fiber));
            fiber = null;
            snapshot = initialState as StreamState<A, E>;
          }
        };
      },
      getSnapshot(): StreamState<A, E> {
        return snapshot;
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return useSyncExternalStore(sub.subscribe, sub.getSnapshot, sub.getSnapshot);
}

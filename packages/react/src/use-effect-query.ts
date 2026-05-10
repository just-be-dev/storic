import { Effect, Fiber } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { Store } from "@storic/core";
import { useStoricRuntime } from "./provider.tsx";
import type { StreamState } from "./sync-external-store.ts";

/**
 * Run an arbitrary `Effect<A, E, Store>` and surface its result as React
 * state. The effect is re-run whenever `deps` change.
 */
export function useEffectQuery<A, E>(
  effect: Effect.Effect<A, E, Store>,
  deps: ReadonlyArray<unknown>,
): StreamState<A, E> {
  const runtime = useStoricRuntime();
  const [state, setState] = useState<StreamState<A, E>>({
    data: undefined,
    error: undefined,
    isLoading: true,
  });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, isLoading: true }));
    const fiber = runtime.runFork(effect);
    fiber.addObserver((exit) => {
      if (cancelled) return;
      if (exit._tag === "Success") {
        setState({ data: exit.value, error: undefined, isLoading: false });
      } else {
        // Extract first failure cause; defects bubble as-is.
        setState((prev) => ({
          data: prev.data,
          error: exit.cause as unknown as E,
          isLoading: false,
        }));
      }
    });
    return () => {
      cancelled = true;
      runtime.runFork(Fiber.interrupt(fiber));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, ...deps]);

  return state;
}

/**
 * Build an Effect on demand and run it via a memoized callback. Mirrors
 * the mutation-hook ergonomics for arbitrary Effect programs.
 */
export function useEffectCallback<A, E, Args extends ReadonlyArray<unknown>>(
  build: (...args: Args) => Effect.Effect<A, E, Store>,
): readonly [(...args: Args) => Promise<A>, StreamState<A, E>] {
  const runtime = useStoricRuntime();
  const [state, setState] = useState<StreamState<A, E>>({
    data: undefined,
    error: undefined,
    isLoading: false,
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const safeSet = (next: StreamState<A, E>) => {
    if (mounted.current) setState(next);
  };

  const run = useCallback(
    async (...args: Args): Promise<A> => {
      safeSet({ data: undefined, error: undefined, isLoading: true });
      try {
        const result = await runtime.runPromise(build(...args));
        safeSet({ data: result, error: undefined, isLoading: false });
        return result;
      } catch (err) {
        safeSet({ data: undefined, error: err as E, isLoading: false });
        throw err;
      }
    },
    [runtime, build],
  );

  return [run, state] as const;
}

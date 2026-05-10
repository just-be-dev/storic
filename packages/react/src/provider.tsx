import { ManagedRuntime } from "effect";
import { Store, type StoreShape } from "@storic/core";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface StoricContextValue {
  readonly runtime: ManagedRuntime.ManagedRuntime<Store, never>;
  readonly store: StoreShape;
}

const StoricContext = createContext<StoricContextValue | null>(null);

export interface StoricProviderProps {
  /**
   * A `ManagedRuntime` whose layer provides `Store` (and therefore
   * `Persistence`). Construct with `ManagedRuntime.make(StoreLive)`.
   */
  readonly runtime: ManagedRuntime.ManagedRuntime<Store, never>;
  /**
   * Optional UI to render while the runtime resolves the `Store` service
   * for the first time. Defaults to `null`.
   */
  readonly fallback?: ReactNode;
  readonly children: ReactNode;
}

/**
 * Provides a Storic store to the component tree. Resolves the `Store`
 * service from the supplied runtime and renders `children` once ready.
 *
 * @example
 * ```tsx
 * const runtime = ManagedRuntime.make(StoreLive);
 *
 * <StoricProvider runtime={runtime} fallback={<Loading />}>
 *   <App />
 * </StoricProvider>
 * ```
 */
export function StoricProvider({ runtime, fallback = null, children }: StoricProviderProps) {
  const [store, setStore] = useState<StoreShape | null>(null);

  useEffect(() => {
    let cancelled = false;
    runtime.runPromise(Store.asEffect()).then(
      (s) => {
        if (!cancelled) setStore(s);
      },
      () => {
        // Layer construction failures surface here. Surface via a console
        // warning; consumers wanting structured handling should resolve the
        // Store themselves before mounting.
        if (typeof console !== "undefined") {
          console.warn("[storic] Failed to resolve Store from runtime");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runtime]);

  const value = useMemo<StoricContextValue | null>(
    () => (store ? { runtime, store } : null),
    [runtime, store],
  );

  if (!value) return <>{fallback}</>;
  return <StoricContext.Provider value={value}>{children}</StoricContext.Provider>;
}

/** Read the resolved `StoreShape` from context. Throws if no provider. */
export function useStoricStore(): StoreShape {
  const ctx = useContext(StoricContext);
  if (!ctx) throw new Error("useStoricStore: no <StoricProvider> in tree");
  return ctx.store;
}

/** Read the runtime from context. Throws if no provider. */
export function useStoricRuntime(): ManagedRuntime.ManagedRuntime<Store, never> {
  const ctx = useContext(StoricContext);
  if (!ctx) throw new Error("useStoricRuntime: no <StoricProvider> in tree");
  return ctx.runtime;
}

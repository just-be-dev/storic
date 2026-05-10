import "./setup.ts";
import { test, expect, describe } from "bun:test";
import { afterEach } from "bun:test";
import { Suspense } from "react";
import { Effect } from "effect";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Store } from "@storic/core";
import { StoricProvider, useEffectCallback, useEffectQuery } from "../src/index.ts";
import { makeTestRuntime, Person, PersonV1 } from "./test-helper.ts";
import type { ManagedRuntime } from "effect";

afterEach(() => cleanup());

function withProvider(runtime: ManagedRuntime.ManagedRuntime<Store, never>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <StoricProvider runtime={runtime}>
        <Suspense fallback={null}>{children}</Suspense>
      </StoricProvider>
    );
  };
}

describe("useEffectQuery", () => {
  test("runs an arbitrary Effect against the Store and surfaces the result", async () => {
    const { runtime, store, dispose } = await makeTestRuntime();
    try {
      await runtime.runPromise(
        (store.saveEntity as any)(
          Person,
          { firstName: "EQ", lastName: "1", email: "eq@1.com" },
          { as: PersonV1 },
        ),
      );

      let lastState: any = null;
      function TestView() {
        lastState = useEffectQuery(
          Effect.gen(function* () {
            const s = yield* Store;
            const all = yield* (s.loadEntities as any)(Person, { as: PersonV1 });
            return (all as ReadonlyArray<any>).length;
          }),
          [],
        );
        return null;
      }
      render(<TestView />, { wrapper: withProvider(runtime) });

      await waitFor(() => {
        expect(lastState.isLoading).toBe(false);
      });
      expect(lastState.data).toBe(1);
      expect(lastState.error).toBeUndefined();
    } finally {
      await dispose();
    }
  });
});

describe("useEffectCallback", () => {
  test("returns a memoized runner that drives state through pending→success", async () => {
    const { runtime, dispose } = await makeTestRuntime();
    try {
      let runFn: ((args: any) => Promise<any>) | null = null;
      let lastState: any = null;
      function TestView() {
        const [run, state] = useEffectCallback((args: { x: number }) =>
          Effect.gen(function* () {
            yield* Effect.sleep("5 millis");
            return args.x * 2;
          }),
        );
        runFn = run as any;
        lastState = state;
        return null;
      }
      render(<TestView />, { wrapper: withProvider(runtime) });
      await waitFor(() => expect(runFn).toBeTypeOf("function"));

      expect(lastState.isLoading).toBe(false);
      expect(lastState.data).toBeUndefined();

      let result = -1;
      await act(async () => {
        result = await runFn!({ x: 21 });
      });
      expect(result).toBe(42);
      expect(lastState.data).toBe(42);
      expect(lastState.error).toBeUndefined();
    } finally {
      await dispose();
    }
  });
});

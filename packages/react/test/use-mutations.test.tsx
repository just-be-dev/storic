import "./setup.ts";
import { test, expect, describe } from "bun:test";
import { afterEach } from "bun:test";
import { Suspense } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  StoricProvider,
  useEntities,
  useEntity,
  usePatchEntities,
  useSaveEntity,
} from "../src/index.ts";
import { makeTestRuntime, Person, PersonV1 } from "./test-helper.ts";
import type { ManagedRuntime } from "effect";
import type { Store } from "@storic/core";

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

describe("usePatchEntities", () => {
  test("patches matching records and triggers a list re-render", async () => {
    const { runtime, store, dispose } = await makeTestRuntime();
    try {
      for (let i = 0; i < 3; i++) {
        await runtime.runPromise(
          (store.saveEntity as any)(
            Person,
            { firstName: "P", lastName: `${i}`, email: "old@x.com" },
            { as: PersonV1 },
          ),
        );
      }

      let listValue: ReadonlyArray<unknown> = [];
      let patchFn: ((p: any, o?: any) => Promise<number>) | null = null;
      function TestView() {
        listValue = useEntities(Person, { as: PersonV1 });
        const [patch] = usePatchEntities(Person, PersonV1);
        patchFn = patch;
        return null;
      }
      render(<TestView />, { wrapper: withProvider(runtime) });

      await waitFor(() => expect(listValue).toHaveLength(3));
      await waitFor(() => expect(patchFn).toBeTypeOf("function"));

      let affected = 0;
      await act(async () => {
        affected = await patchFn!({ email: "new@x.com" });
      });
      expect(affected).toBe(3);

      await waitFor(() => {
        for (const r of listValue) {
          expect((r as any).data.email).toBe("new@x.com");
        }
      });
    } finally {
      await dispose();
    }
  });
});

describe("useSaveEntity error state", () => {
  test("status switches to 'error' on validation failure and the call rejects", async () => {
    const { runtime, dispose } = await makeTestRuntime();
    try {
      let saveFn: ((d: any, o?: any) => Promise<any>) | null = null;
      let lastState: any = null;
      function TestView() {
        const [save, state] = useSaveEntity(Person, PersonV1);
        saveFn = save;
        lastState = state;
        return null;
      }
      render(<TestView />, { wrapper: withProvider(runtime) });
      await waitFor(() => expect(saveFn).toBeTypeOf("function"));

      let threw: unknown = null;
      await act(async () => {
        try {
          // firstName must be string — pass a number to trigger ValidationError
          await saveFn!({ firstName: 42, lastName: "X", email: "x@x.com" });
        } catch (err) {
          threw = err;
        }
      });
      expect(threw).not.toBeNull();
      expect(lastState.status).toBe("error");
      expect(lastState.error).toBeDefined();
    } finally {
      await dispose();
    }
  });
});

describe("hooks-based runtime: cross-component live updates", () => {
  test("a save in one component updates a useEntity reader in another", async () => {
    const { runtime, dispose } = await makeTestRuntime();
    try {
      const id = "shared-1";
      let readerValue: unknown = "unset";
      let saveFn: ((d: any, o?: any) => Promise<any>) | null = null;

      function Reader() {
        readerValue = useEntity(Person, id, { as: PersonV1 });
        return null;
      }
      function Writer() {
        const [save] = useSaveEntity(Person, PersonV1);
        saveFn = save;
        return null;
      }

      render(
        <>
          <Writer />
          <Reader />
        </>,
        { wrapper: withProvider(runtime) },
      );

      await waitFor(() => expect(readerValue).toBeNull());
      await waitFor(() => expect(saveFn).toBeTypeOf("function"));

      await act(async () => {
        await saveFn!({ firstName: "Cross", lastName: "Cmp", email: "cross@cmp.com" }, { id });
      });

      await waitFor(() => {
        expect((readerValue as any)?.data?.email).toBe("cross@cmp.com");
      });
    } finally {
      await dispose();
    }
  });
});

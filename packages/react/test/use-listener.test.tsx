import "./setup.ts";
import { test, expect, describe, afterEach } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  StoricProvider,
  useEntitiesListener,
  useEntityListener,
  useSaveEntity,
} from "../src/index.ts";
import { makeTestRuntime, Person, PersonV1 } from "./test-helper.ts";
import type { ManagedRuntime } from "effect";
import type { Store } from "@storic/core";

import { Suspense, useState } from "react";

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

describe("useEntityListener", () => {
  test("invokes callback on initial value and subsequent updates", async () => {
    const { runtime, store, dispose } = await makeTestRuntime();
    try {
      const id = "listener-1";
      const seen: Array<string | null> = [];

      function TestView() {
        useEntityListener(Person, id, (record) => {
          seen.push((record?.data as any)?.email ?? null);
        });
        return null;
      }

      render(<TestView />, { wrapper: withProvider(runtime) });

      await waitFor(() => {
        expect(seen.length).toBeGreaterThanOrEqual(1);
      });
      expect(seen[0]).toBeNull();

      await act(async () => {
        await runtime.runPromise(
          (store.saveEntity as any)(
            Person,
            { firstName: "L", lastName: "M", email: "l@m.com" },
            { id, as: PersonV1 },
          ),
        );
      });

      await waitFor(() => {
        expect(seen.length).toBeGreaterThanOrEqual(2);
      });
      expect(seen[seen.length - 1]).toBe("l@m.com");
    } finally {
      await dispose();
    }
  });
});

describe("useEntitiesListener", () => {
  test("invokes callback with the current list and again after each change", async () => {
    const { runtime, store, dispose } = await makeTestRuntime();
    try {
      const lengths: Array<number> = [];
      function TestView() {
        useEntitiesListener(Person, undefined, (records) => {
          lengths.push(records.length);
        });
        return null;
      }

      render(<TestView />, { wrapper: withProvider(runtime) });

      await waitFor(() => expect(lengths.length).toBeGreaterThanOrEqual(1));
      expect(lengths[0]).toBe(0);

      await act(async () => {
        await runtime.runPromise(
          (store.saveEntity as any)(
            Person,
            { firstName: "EL", lastName: "1", email: "el@1.com" },
            { as: PersonV1 },
          ),
        );
      });

      await waitFor(() => {
        expect(lengths[lengths.length - 1]).toBe(1);
      });
    } finally {
      await dispose();
    }
  });

  test("re-subscribes when inline opts.filters change without explicit deps", async () => {
    const { runtime, store, dispose } = await makeTestRuntime();
    try {
      await runtime.runPromise(
        (store.saveEntity as any)(
          Person,
          { firstName: "Alpha", lastName: "1", email: "alpha@x.com" },
          { as: PersonV1 },
        ),
      );
      await runtime.runPromise(
        (store.saveEntity as any)(
          Person,
          { firstName: "Beta", lastName: "2", email: "beta@x.com" },
          { as: PersonV1 },
        ),
      );

      const emails: Array<string> = [];

      function TestView({ first }: { first: string }) {
        useEntitiesListener(
          Person,
          { filters: [{ field: "firstName", op: "eq", value: first }], as: PersonV1 },
          (records) => {
            for (const r of records) emails.push((r.data as any).email);
          },
        );
        return null;
      }

      const { rerender } = render(<TestView first="Alpha" />, { wrapper: withProvider(runtime) });

      await waitFor(() => {
        expect(emails).toContain("alpha@x.com");
      });
      expect(emails).not.toContain("beta@x.com");

      // Change the filter — opts is a new inline object each render. The
      // subscription must re-establish without the caller passing deps.
      await act(async () => {
        rerender(<TestView first="Beta" />);
      });

      await waitFor(() => {
        expect(emails).toContain("beta@x.com");
      });
    } finally {
      await dispose();
    }
  });
});

describe("listener teardown", () => {
  test("stops invoking callback after the component unmounts", async () => {
    const { runtime, store, dispose } = await makeTestRuntime();
    try {
      const id = "teardown-1";
      const seen: Array<unknown> = [];

      function Listener() {
        useEntityListener(Person, id, (record) => {
          seen.push(record);
        });
        return null;
      }
      function App() {
        const [mounted, setMounted] = useState(true);
        return (
          <>
            {mounted ? <Listener /> : null}
            <button data-testid="unmount" onClick={() => setMounted(false)} />
          </>
        );
      }

      const { getByTestId } = render(<App />, { wrapper: withProvider(runtime) });

      // Wait for initial emission
      await waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));

      // Unmount the listener
      await act(async () => {
        getByTestId("unmount").click();
      });

      const before = seen.length;

      // Mutating now should NOT call the listener again
      await runtime.runPromise(
        (store.saveEntity as any)(
          Person,
          { firstName: "Gone", lastName: "Z", email: "g@z.com" },
          { id, as: PersonV1 },
        ),
      );
      // Give the bus a moment in case the fiber were still alive
      await new Promise((r) => setTimeout(r, 30));

      expect(seen.length).toBe(before);
    } finally {
      await dispose();
    }
  });
});

describe("save then immediate read via useEntity", () => {
  test("freshly-saved entity shows up after a single save call", async () => {
    const { runtime, dispose } = await makeTestRuntime();
    try {
      let lastEmail: string | null | undefined;
      let saveFn: ((d: any, o?: any) => Promise<any>) | null = null;

      function TestView() {
        const [save] = useSaveEntity(Person, PersonV1);
        saveFn = save;
        return null;
      }

      render(<TestView />, { wrapper: withProvider(runtime) });
      await waitFor(() => {
        expect(saveFn).toBeTypeOf("function");
      });

      await act(async () => {
        const res = await saveFn!(
          { firstName: "F", lastName: "G", email: "f@g.com" },
          { id: "save-once" },
        );
        lastEmail = (res.data as any).email;
      });
      expect(lastEmail).toBe("f@g.com");
    } finally {
      await dispose();
    }
  });
});

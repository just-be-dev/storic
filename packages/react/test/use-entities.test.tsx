import "./setup.ts";
import { test, expect, describe } from "bun:test";
import { Suspense } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach } from "bun:test";
import { StoricProvider, useEntities } from "../src/index.ts";
import { makeTestRuntime, Person, PersonV1, PersonV2 } from "./test-helper.ts";
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

describe("useEntities (filters / pagination / lens)", () => {
  test("filters narrow results to matching field values", async () => {
    const { runtime, store, dispose } = await makeTestRuntime();
    try {
      // Seed three people, two share an email
      await runtime.runPromise(
        (store.saveEntity as any)(
          Person,
          { firstName: "A", lastName: "1", email: "a@a.com" },
          { as: PersonV1 },
        ),
      );
      await runtime.runPromise(
        (store.saveEntity as any)(
          Person,
          { firstName: "A", lastName: "2", email: "a@a.com" },
          { as: PersonV1 },
        ),
      );
      await runtime.runPromise(
        (store.saveEntity as any)(
          Person,
          { firstName: "B", lastName: "1", email: "b@b.com" },
          { as: PersonV1 },
        ),
      );

      let lastValue: ReadonlyArray<unknown> = [];
      function TestView() {
        lastValue = useEntities(Person, {
          as: PersonV1,
          filters: [{ field: "email", op: "eq", value: "a@a.com" }],
        });
        return null;
      }
      render(<TestView />, { wrapper: withProvider(runtime) });

      await waitFor(() => {
        expect(lastValue).toHaveLength(2);
      });
      for (const r of lastValue) {
        expect((r as any).data.email).toBe("a@a.com");
      }
    } finally {
      await dispose();
    }
  });

  test("limit + offset paginate results", async () => {
    const { runtime, store, dispose } = await makeTestRuntime();
    try {
      for (let i = 0; i < 5; i++) {
        await runtime.runPromise(
          (store.saveEntity as any)(
            Person,
            { firstName: `P${i}`, lastName: "x", email: `p${i}@x.com` },
            { as: PersonV1 },
          ),
        );
      }

      let firstPage: ReadonlyArray<unknown> = [];
      function FirstPage() {
        firstPage = useEntities(Person, { as: PersonV1, limit: 2, offset: 0 });
        return null;
      }
      render(<FirstPage />, { wrapper: withProvider(runtime) });
      await waitFor(() => expect(firstPage).toHaveLength(2));
    } finally {
      await dispose();
    }
  });

  test("auto-projects across schema versions via lenses", async () => {
    const { runtime, store, dispose } = await makeTestRuntime();
    try {
      // Stored as v1, queried as v2
      await runtime.runPromise(
        (store.saveEntity as any)(
          Person,
          { firstName: "X", lastName: "Y", email: "xy@z.com" },
          { as: PersonV1 },
        ),
      );

      let lastValue: ReadonlyArray<unknown> = [];
      function TestView() {
        lastValue = useEntities(Person, { as: PersonV2 });
        return null;
      }
      render(<TestView />, { wrapper: withProvider(runtime) });

      await waitFor(() => expect(lastValue).toHaveLength(1));
      const rec = lastValue[0] as any;
      expect(rec.data._tag).toBe("Person.v2");
      expect(rec.data.fullName).toBe("X Y");
    } finally {
      await dispose();
    }
  });

  test("re-renders live when an entity matching the query is updated", async () => {
    const { runtime, store, dispose } = await makeTestRuntime();
    try {
      const saved = await runtime.runPromise(
        (store.saveEntity as any)(
          Person,
          { firstName: "Live", lastName: "Q", email: "live@q.com" },
          { as: PersonV1 },
        ),
      );

      let lastValue: ReadonlyArray<unknown> = [];
      function TestView() {
        lastValue = useEntities(Person, { as: PersonV1 });
        return null;
      }
      render(<TestView />, { wrapper: withProvider(runtime) });

      await waitFor(() => expect(lastValue).toHaveLength(1));

      await act(async () => {
        await runtime.runPromise(
          (store.updateEntity as any)(
            Person,
            saved.id,
            { email: "updated@q.com" },
            { as: PersonV1 },
          ),
        );
      });

      await waitFor(() => {
        expect((lastValue[0] as any).data.email).toBe("updated@q.com");
      });
    } finally {
      await dispose();
    }
  });
});

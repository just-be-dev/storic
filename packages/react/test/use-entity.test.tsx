import "./setup.ts";
import { test, expect, describe, afterEach } from "bun:test";
import { Suspense, useState } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";

afterEach(() => cleanup());
import {
  StoricProvider,
  useEntity,
  useEntities,
  useSaveEntity,
  useUpdateEntity,
  useDeleteEntity,
} from "../src/index.ts";
import { makeTestRuntime, Person, PersonV1 } from "./test-helper.ts";
import type { ManagedRuntime } from "effect";
import type { Store } from "@storic/core";

function withProvider(runtime: ManagedRuntime.ManagedRuntime<Store, never>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <StoricProvider runtime={runtime}>
        <Suspense fallback={<div data-testid="fallback">loading</div>}>{children}</Suspense>
      </StoricProvider>
    );
  };
}

describe("useEntity (suspense + live)", () => {
  test("suspends initially, returns null when missing, then live-updates on save", async () => {
    const { runtime, store, dispose } = await makeTestRuntime();
    try {
      const id = "person-1";
      let lastValue: unknown = "unset";
      function TestView() {
        lastValue = useEntity(Person, id, { as: PersonV1 });
        return null;
      }
      render(<TestView />, { wrapper: withProvider(runtime) });

      // Suspense fallback shows during initial load; once resolved the
      // value is null (entity missing).
      await waitFor(() => {
        expect(lastValue).toBeNull();
      });

      await act(async () => {
        await runtime.runPromise(
          (store.saveEntity as any)(
            Person,
            { firstName: "A", lastName: "B", email: "a@b.com" },
            { id, as: PersonV1 },
          ),
        );
      });

      // Live update: bus event re-emits, hook re-renders with the saved value
      await waitFor(() => {
        expect((lastValue as any)?.data?.email).toBe("a@b.com");
      });
    } finally {
      await dispose();
    }
  });
});

describe("useEntities (suspense + live)", () => {
  test("suspends initially, returns [] when empty, then re-renders on save and delete", async () => {
    const { runtime, store, dispose } = await makeTestRuntime();
    try {
      let lastValue: ReadonlyArray<unknown> = [];
      function TestView() {
        lastValue = useEntities(Person, { as: PersonV1 });
        return null;
      }
      render(<TestView />, { wrapper: withProvider(runtime) });

      await waitFor(() => {
        expect(lastValue).toEqual([]);
      });

      let savedId = "";
      await act(async () => {
        const saved = await runtime.runPromise(
          (store.saveEntity as any)(
            Person,
            { firstName: "X", lastName: "Y", email: "x@y.com" },
            { as: PersonV1 },
          ),
        );
        savedId = saved.id;
      });

      await waitFor(() => {
        expect(lastValue).toHaveLength(1);
      });

      await act(async () => {
        await runtime.runPromise(store.deleteEntity(savedId));
      });

      await waitFor(() => {
        expect(lastValue).toHaveLength(0);
      });
    } finally {
      await dispose();
    }
  });
});

describe("mutation hooks drive live useEntity re-renders", () => {
  test("save → update → delete cycle", async () => {
    const { runtime, dispose } = await makeTestRuntime();
    try {
      let view: any;
      function Reader({ id }: { id: string }) {
        const value = useEntity(Person, id, { as: PersonV1 });
        view = { ...view, value };
        return null;
      }
      function Controls() {
        const [id, setId] = useState<string | null>(null);
        const [save] = useSaveEntity(Person, PersonV1);
        const [update] = useUpdateEntity(Person, PersonV1);
        const [del] = useDeleteEntity();
        view = { ...view, id, setId, save, update, del };
        return id ? <Reader id={id} /> : null;
      }
      render(<Controls />, { wrapper: withProvider(runtime) });

      await waitFor(() => {
        expect(view?.save).toBeTypeOf("function");
      });

      let createdId = "";
      await act(async () => {
        const res = await view.save({
          firstName: "P",
          lastName: "Q",
          email: "p@q.com",
        });
        createdId = res.id;
        view.setId(createdId);
      });

      await waitFor(() => {
        expect((view.value as any)?.data?.email).toBe("p@q.com");
      });

      await act(async () => {
        await view.update(createdId, { email: "new@p.com" });
      });
      await waitFor(() => {
        expect((view.value as any)?.data?.email).toBe("new@p.com");
      });

      await act(async () => {
        await view.del(createdId);
      });
      await waitFor(() => {
        expect(view.value).toBeNull();
      });
    } finally {
      await dispose();
    }
  });
});

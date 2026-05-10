import "./setup.ts";
import { test, expect, describe } from "bun:test";
import { Suspense } from "react";
import { Layer } from "effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import { cleanup } from "@testing-library/react";
import { afterEach } from "bun:test";
import { layer as sqliteLayer } from "@effect/sql-sqlite-bun/SqliteClient";
import { act, render, waitFor } from "@testing-library/react";
import { RegistryProvider, useAtomSet, useAtomSuspense } from "@effect/atom-react";
import { Store } from "@storic/core";
import { sqlPersistenceLayer } from "@storic/sql";
import {
  entityAtom,
  entitiesAtom,
  saveEntityAtom,
  updateEntityAtom,
  patchEntitiesAtom,
  deleteEntityAtom,
} from "../src/atom/index.ts";
import { Person, PersonV1, PersonV2 } from "./test-helper.ts";

afterEach(() => cleanup());

function makeRuntime() {
  const SqlLive = sqliteLayer({ filename: ":memory:" });
  const PersistenceLive = sqlPersistenceLayer.pipe(Layer.provide(SqlLive));
  const StoreLive = Store.layer({ entities: [Person] }).pipe(
    Layer.provide(PersistenceLive),
    Layer.provide(SqlLive),
    Layer.orDie,
  );
  // Use a fresh memo map per runtime so test runtimes don't share cached layers.
  const factory = Atom.context({ memoMap: Layer.makeMemoMapUnsafe() });
  return factory(StoreLive as any) as Atom.AtomRuntime<Store, never>;
}

describe("@storic/react/atom", () => {
  test("entityAtom suspends, then live-updates after a saveEntityAtom call", async () => {
    const runtime = makeRuntime();
    const personById = entityAtom(runtime, Person, PersonV1);
    const savePerson = saveEntityAtom(runtime, Person, PersonV1);
    const id = "atom-person-1";

    let viewedEmail: string | null | undefined = "unset";
    let saveFn: ((args: any) => Promise<any>) | null = null;

    function Reader() {
      const result = useAtomSuspense(personById(id));
      viewedEmail = result.value === null ? null : (result.value?.data as any)?.email;
      return null;
    }
    function Saver() {
      saveFn = useAtomSet(savePerson, { mode: "promise" }) as any;
      return null;
    }

    render(
      <RegistryProvider>
        <Saver />
        <Suspense fallback={null}>
          <Reader />
        </Suspense>
      </RegistryProvider>,
    );

    await waitFor(() => {
      expect(viewedEmail).toBeNull();
    });
    await waitFor(() => {
      expect(saveFn).toBeTypeOf("function");
    });

    await act(async () => {
      await saveFn!({
        data: { firstName: "Atomic", lastName: "Z", email: "atom@z.com" },
        id,
      });
    });

    await waitFor(() => {
      expect(viewedEmail).toBe("atom@z.com");
    });
  });

  test("entitiesAtom re-renders on save and delete", async () => {
    const runtime = makeRuntime();
    const peopleAtom = entitiesAtom(runtime, Person, { as: PersonV1 });
    const savePerson = saveEntityAtom(runtime, Person, PersonV1);
    const delPerson = deleteEntityAtom(runtime);

    let lastCount = -1;
    let saveFn: ((args: any) => Promise<any>) | null = null;
    let delFn: ((id: string) => Promise<any>) | null = null;

    function Reader() {
      const result = useAtomSuspense(peopleAtom);
      lastCount = result.value?.length ?? -1;
      return null;
    }
    function Controls() {
      saveFn = useAtomSet(savePerson, { mode: "promise" }) as any;
      delFn = useAtomSet(delPerson, { mode: "promise" }) as any;
      return null;
    }

    render(
      <RegistryProvider>
        <Controls />
        <Suspense fallback={null}>
          <Reader />
        </Suspense>
      </RegistryProvider>,
    );

    await waitFor(() => {
      expect(lastCount).toBe(0);
    });
    await waitFor(() => {
      expect(saveFn).toBeTypeOf("function");
    });

    let newId = "";
    await act(async () => {
      const res = await saveFn!({
        data: { firstName: "L", lastName: "M", email: "l@m.com" },
      });
      newId = res.id;
    });

    await waitFor(() => {
      expect(lastCount).toBe(1);
    });

    await act(async () => {
      await delFn!(newId);
    });

    await waitFor(() => {
      expect(lastCount).toBe(0);
    });
  });

  test("updateEntityAtom mutates and propagates to entityAtom subscribers", async () => {
    const runtime = makeRuntime();
    const personById = entityAtom(runtime, Person, PersonV1);
    const savePerson = saveEntityAtom(runtime, Person, PersonV1);
    const updatePerson = updateEntityAtom(runtime, Person, PersonV1);
    const id = "atom-update-1";

    let viewedEmail: string | null | undefined = "unset";
    let saveFn: ((args: any) => Promise<any>) | null = null;
    let updateFn: ((args: any) => Promise<any>) | null = null;

    function Reader() {
      const result = useAtomSuspense(personById(id));
      viewedEmail = result.value === null ? null : (result.value?.data as any)?.email;
      return null;
    }
    function Controls() {
      saveFn = useAtomSet(savePerson, { mode: "promise" }) as any;
      updateFn = useAtomSet(updatePerson, { mode: "promise" }) as any;
      return null;
    }
    render(
      <RegistryProvider>
        <Controls />
        <Suspense fallback={null}>
          <Reader />
        </Suspense>
      </RegistryProvider>,
    );

    await waitFor(() => expect(viewedEmail).toBeNull());
    await waitFor(() => expect(updateFn).toBeTypeOf("function"));

    await act(async () => {
      await saveFn!({
        data: { firstName: "U", lastName: "P", email: "u@p.com" },
        id,
      });
    });
    await waitFor(() => expect(viewedEmail).toBe("u@p.com"));

    await act(async () => {
      await updateFn!({ id, data: { email: "u2@p.com" } });
    });
    await waitFor(() => expect(viewedEmail).toBe("u2@p.com"));
  });

  test("patchEntitiesAtom updates all matching records and re-renders entitiesAtom", async () => {
    const runtime = makeRuntime();
    const peopleAtom = entitiesAtom(runtime, Person, { as: PersonV1 });
    const savePerson = saveEntityAtom(runtime, Person, PersonV1);
    const patchPeople = patchEntitiesAtom(runtime, Person, PersonV1);

    let lastEmails: ReadonlyArray<string> = [];
    let saveFn: ((args: any) => Promise<any>) | null = null;
    let patchFn: ((args: any) => Promise<any>) | null = null;

    function Reader() {
      const result = useAtomSuspense(peopleAtom);
      lastEmails = (result.value ?? []).map((r) => (r.data as any).email);
      return null;
    }
    function Controls() {
      saveFn = useAtomSet(savePerson, { mode: "promise" }) as any;
      patchFn = useAtomSet(patchPeople, { mode: "promise" }) as any;
      return null;
    }
    render(
      <RegistryProvider>
        <Controls />
        <Suspense fallback={null}>
          <Reader />
        </Suspense>
      </RegistryProvider>,
    );

    await waitFor(() => expect(lastEmails).toEqual([]));
    await waitFor(() => expect(patchFn).toBeTypeOf("function"));

    await act(async () => {
      await saveFn!({ data: { firstName: "A", lastName: "1", email: "old@x.com" } });
      await saveFn!({ data: { firstName: "B", lastName: "2", email: "old@x.com" } });
    });
    await waitFor(() => expect(lastEmails).toHaveLength(2));

    await act(async () => {
      await patchFn!({ patch: { email: "new@x.com" } });
    });
    await waitFor(() => {
      expect(lastEmails.every((e) => e === "new@x.com")).toBe(true);
    });
  });

  test("entityAtom with explicit `as` projects via lenses", async () => {
    const runtime = makeRuntime();
    // Save under v1
    const savePersonV1 = saveEntityAtom(runtime, Person, PersonV1);
    // Read as v2
    const personV2ById = entityAtom(runtime, Person, PersonV2);
    const id = "atom-lens-1";

    let viewed: any = "unset";
    let saveFn: ((args: any) => Promise<any>) | null = null;

    function Reader() {
      const r = useAtomSuspense(personV2ById(id));
      viewed = r.value;
      return null;
    }
    function Saver() {
      saveFn = useAtomSet(savePersonV1, { mode: "promise" }) as any;
      return null;
    }

    render(
      <RegistryProvider>
        <Saver />
        <Suspense fallback={null}>
          <Reader />
        </Suspense>
      </RegistryProvider>,
    );

    await waitFor(() => expect(viewed).toBeNull());
    await waitFor(() => expect(saveFn).toBeTypeOf("function"));

    await act(async () => {
      await saveFn!({
        data: { firstName: "Lens", lastName: "Z", email: "lens@z.com" },
        id,
      });
    });

    await waitFor(() => {
      expect(viewed?.data?._tag).toBe("Person.v2");
      expect(viewed?.data?.fullName).toBe("Lens Z");
    });
  });

  test("two readers of the same entityAtom(id) share state", async () => {
    const runtime = makeRuntime();
    const personById = entityAtom(runtime, Person, PersonV1);
    const savePerson = saveEntityAtom(runtime, Person, PersonV1);
    const id = "atom-shared-1";

    let v1: any = "unset";
    let v2: any = "unset";
    let saveFn: ((args: any) => Promise<any>) | null = null;

    function ReaderA() {
      v1 = useAtomSuspense(personById(id)).value;
      return null;
    }
    function ReaderB() {
      v2 = useAtomSuspense(personById(id)).value;
      return null;
    }
    function Saver() {
      saveFn = useAtomSet(savePerson, { mode: "promise" }) as any;
      return null;
    }

    render(
      <RegistryProvider>
        <Saver />
        <Suspense fallback={null}>
          <ReaderA />
          <ReaderB />
        </Suspense>
      </RegistryProvider>,
    );

    await waitFor(() => {
      expect(v1).toBeNull();
      expect(v2).toBeNull();
    });
    await waitFor(() => expect(saveFn).toBeTypeOf("function"));

    await act(async () => {
      await saveFn!({
        data: { firstName: "Shared", lastName: "Z", email: "shared@z.com" },
        id,
      });
    });

    await waitFor(() => {
      expect((v1 as any)?.data?.email).toBe("shared@z.com");
      expect((v2 as any)?.data?.email).toBe("shared@z.com");
    });
    // Same atom reference across the two readers (Atom.family memoizes by key).
    expect(personById(id)).toBe(personById(id));
  });
});

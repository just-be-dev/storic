import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer, Schema } from "effect";
import { Store, Persistence, defineLens } from "@storic/core";
import type { StoreConfig } from "@storic/core";
import { doStubPersistence } from "../src/stub-persistence.ts";
import { doStoragePersistence } from "../src/persistence.ts";

// ─── Mock SqlStorage ───────────────────────────────────────────────────────

function makeMockSqlStorage(): SqlStorage {
  const db = new Database(":memory:");
  return {
    get databaseSize() {
      return 0;
    },
    exec(query: string, ...bindings: any[]) {
      const stmt = db.query(query);
      const rows = stmt.all(...bindings) as Record<string, any>[];
      const columnNames = stmt.columnNames;
      let index = 0;
      return {
        toArray() {
          return rows;
        },
        one() {
          return rows[0];
        },
        next() {
          if (index < rows.length) {
            return { value: rows[index++] };
          }
          return { done: true as const };
        },
        raw() {
          return rows.map((row) => columnNames.map((col) => row[col]))[Symbol.iterator]();
        },
        columnNames,
        get rowsRead() {
          return rows.length;
        },
        get rowsWritten() {
          return 0;
        },
        [Symbol.iterator]() {
          return rows[Symbol.iterator]();
        },
      } as unknown as SqlStorageCursor<any>;
    },
    Cursor: class {} as any,
    Statement: class {} as any,
  };
}

// ─── Mock stub (same as stub-persistence tests) ────────────────────────────

function makeMockStub() {
  const storage = makeMockSqlStorage();
  const persistenceLayer = doStoragePersistence(storage).pipe(Layer.orDie);

  const run = <A, E>(effect: Effect.Effect<A, E, Persistence>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, persistenceLayer));

  return {
    initialize: (spec: any) => run(Persistence.use((p) => p.initialize(spec))),
    put: (record: any) => run(Persistence.use((p) => p.put(record))),
    get: (id: string) => run(Persistence.use((p) => p.get(id))),
    query: (params: any) => run(Persistence.use((p) => p.query(params))),
    update: (id: string, record: any) => run(Persistence.use((p) => p.update(id, record))),
    patch: (params: any) => run(Persistence.use((p) => p.patch(params))),
    remove: (id: string) => run(Persistence.use((p) => p.remove(id))),
  } as unknown as DurableObjectStub<any>;
}

// ─── Mock DurableObjectNamespace ───────────────────────────────────────────

/**
 * Creates a mock DurableObjectNamespace that returns mock stubs.
 * Each unique name gets its own isolated stub (separate database).
 */
function makeMockNamespace(): DurableObjectNamespace<any> {
  const stubs = new Map<string, DurableObjectStub<any>>();

  return {
    idFromName(name: string) {
      return { name } as any;
    },
    get(id: any) {
      const name = id.name as string;
      if (!stubs.has(name)) {
        stubs.set(name, makeMockStub());
      }
      return stubs.get(name)!;
    },
  } as unknown as DurableObjectNamespace<any>;
}

// ─── Test Schemas ──────────────────────────────────────────────────────────

const PersonV1 = Schema.TaggedStruct("Person.v1", {
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
});

const PersonV2 = Schema.TaggedStruct("Person.v2", {
  fullName: Schema.String,
  email: Schema.String,
  age: Schema.Number,
});

const PersonV1toV2 = defineLens(PersonV1, PersonV2, {
  decode: (v1) => ({
    fullName: `${v1.firstName} ${v1.lastName}`,
    email: v1.email,
    age: 0,
  }),
  encode: (v2) => ({
    firstName: v2.fullName.split(" ")[0],
    lastName: v2.fullName.split(" ").slice(1).join(" "),
    email: v2.email,
  }),
});

const testConfig: StoreConfig = {
  schemas: [PersonV1, PersonV2],
  lenses: [PersonV1toV2],
};

// ─── Import helpers under test ─────────────────────────────────────────────
// We can't import createStore/makeStoreLayer directly because they expect
// real CF types. Instead we test the same logic by composing the pieces
// that createStore uses internally.

function createTestStore(ns: DurableObjectNamespace<any>, name: string, config: StoreConfig) {
  const stub = ns.get(ns.idFromName(name));
  const layer = Store.layer(config).pipe(Layer.provide(doStubPersistence(stub)), Layer.orDie);

  const run = <A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, layer));

  return {
    run,
    saveEntity: (schema: any, data: any, opts?: any) =>
      run(Store.use((s) => s.saveEntity(schema, data, opts))),
    loadEntity: (schema: any, id: string) => run(Store.use((s) => s.loadEntity(schema, id))),
    loadEntities: (schema: any, opts?: any) => run(Store.use((s) => s.loadEntities(schema, opts))),
    updateEntity: (schema: any, id: string, data: any, opts?: any) =>
      run(Store.use((s) => s.updateEntity(schema, id, data, opts))),
    patchEntities: (schema: any, patch: any, opts?: any) =>
      run(Store.use((s) => s.patchEntities(schema, patch, opts))),
    deleteEntity: (id: string) => run(Store.use((s) => s.deleteEntity(id))),
  };
}

// ─── Tests: createStore client API ─────────────────────────────────────────

describe("createStore", () => {
  test("saveEntity returns entity with id and timestamps", async () => {
    const ns = makeMockNamespace();
    const store = createTestStore(ns, "test", testConfig);

    const entity = await store.saveEntity(PersonV1, {
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
    });

    expect(entity.id).toBeDefined();
    expect(entity.data._tag).toBe("Person.v1");
    expect(entity.data.firstName).toBe("Alice");
    expect(entity.created_at).toBeNumber();
    expect(entity.updated_at).toBeNumber();
  });

  test("loadEntity retrieves a saved entity", async () => {
    const ns = makeMockNamespace();
    const store = createTestStore(ns, "test", testConfig);

    const saved = await store.saveEntity(PersonV1, {
      firstName: "Bob",
      lastName: "Jones",
      email: "bob@example.com",
    });

    const loaded = await store.loadEntity(PersonV1, saved.id);
    expect(loaded.data).toEqual(saved.data);
  });

  test("loadEntity with cross-version projection", async () => {
    const ns = makeMockNamespace();
    const store = createTestStore(ns, "test", testConfig);

    const saved = await store.saveEntity(PersonV1, {
      firstName: "Carol",
      lastName: "White",
      email: "carol@example.com",
    });

    const asV2 = await store.loadEntity(PersonV2, saved.id);
    expect(asV2.data._tag).toBe("Person.v2");
    expect(asV2.data.fullName).toBe("Carol White");
    expect(asV2.data.age).toBe(0);
  });

  test("loadEntities returns all matching entities", async () => {
    const ns = makeMockNamespace();
    const store = createTestStore(ns, "test", testConfig);

    await store.saveEntity(PersonV1, {
      firstName: "A",
      lastName: "B",
      email: "ab@example.com",
    });
    await store.saveEntity(PersonV2, {
      fullName: "C D",
      email: "cd@example.com",
      age: 30,
    });

    const all = await store.loadEntities(PersonV2);
    expect(all).toHaveLength(2);
    for (const e of all) {
      expect(e.data._tag).toBe("Person.v2");
    }
  });

  test("loadEntities with limit and offset", async () => {
    const ns = makeMockNamespace();
    const store = createTestStore(ns, "test", testConfig);

    for (let i = 0; i < 5; i++) {
      await store.saveEntity(PersonV2, {
        fullName: `Person ${i}`,
        email: `p${i}@example.com`,
        age: 20 + i,
      });
    }

    const page = await store.loadEntities(PersonV2, { limit: 2, offset: 1 });
    expect(page).toHaveLength(2);
  });

  test("updateEntity merges by default", async () => {
    const ns = makeMockNamespace();
    const store = createTestStore(ns, "test", testConfig);

    const saved = await store.saveEntity(PersonV2, {
      fullName: "Diana Prince",
      email: "diana@example.com",
      age: 30,
    });

    const updated = await store.updateEntity(PersonV2, saved.id, { age: 31 });
    expect(updated.data.fullName).toBe("Diana Prince");
    expect(updated.data.email).toBe("diana@example.com");
    expect(updated.data.age).toBe(31);
  });

  test("patchEntities updates all matching records", async () => {
    const ns = makeMockNamespace();
    const store = createTestStore(ns, "test", testConfig);

    await store.saveEntity(PersonV2, {
      fullName: "E F",
      email: "ef@example.com",
      age: 10,
    });
    await store.saveEntity(PersonV2, {
      fullName: "G H",
      email: "gh@example.com",
      age: 20,
    });

    const count = await store.patchEntities(PersonV2, { age: 50 });
    expect(count).toBe(2);

    const all = await store.loadEntities(PersonV2);
    for (const e of all) {
      expect(e.data.age).toBe(50);
    }
  });

  test("deleteEntity removes the entity", async () => {
    const ns = makeMockNamespace();
    const store = createTestStore(ns, "test", testConfig);

    const saved = await store.saveEntity(PersonV1, {
      firstName: "Gone",
      lastName: "Soon",
      email: "gone@example.com",
    });

    await store.deleteEntity(saved.id);

    await expect(store.loadEntity(PersonV1, saved.id)).rejects.toThrow();
  });

  test("loadEntity rejects for missing entity", async () => {
    const ns = makeMockNamespace();
    const store = createTestStore(ns, "test", testConfig);

    await expect(store.loadEntity(PersonV1, "nonexistent")).rejects.toThrow();
  });

  test("run escape hatch executes custom effects", async () => {
    const ns = makeMockNamespace();
    const store = createTestStore(ns, "test", testConfig);

    await store.saveEntity(PersonV1, {
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
    });

    const count = await store.run(
      Store.use((s) => Effect.map(s.loadEntities(PersonV2), (entities) => entities.length)),
    );

    expect(count).toBe(1);
  });

  test("separate DO names have isolated storage", async () => {
    const ns = makeMockNamespace();
    const storeA = createTestStore(ns, "store-a", testConfig);
    const storeB = createTestStore(ns, "store-b", testConfig);

    await storeA.saveEntity(PersonV1, {
      firstName: "Only",
      lastName: "InA",
      email: "a@example.com",
    });

    const inA = await storeA.loadEntities(PersonV2);
    const inB = await storeB.loadEntities(PersonV2);

    expect(inA).toHaveLength(1);
    expect(inB).toHaveLength(0);
  });
});

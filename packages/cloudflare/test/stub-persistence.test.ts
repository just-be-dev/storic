import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer, Schema } from "effect";
import { Store, Persistence, PersistenceError, defineLens } from "@storic/core";
import type {
  StoreConfig,
  PersistenceRecord,
  QueryParams,
  PatchParams,
  InitSpec,
} from "@storic/core";
import { doStubPersistence } from "../src/stub-persistence.ts";
import { doStoragePersistence } from "../src/persistence.ts";
import { sqlStorageLayer } from "../src/sql-storage-client.ts";

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

// ─── Mock StoricDO stub ────────────────────────────────────────────────────

/**
 * Creates a mock that mimics StoricDO's public RPC surface backed by
 * in-memory persistence. This simulates calling through a DO stub
 * without needing the Cloudflare runtime.
 */
function makeMockStub() {
  const storage = makeMockSqlStorage();
  const persistenceLayer = doStoragePersistence(storage).pipe(Layer.orDie);

  const run = <A, E>(effect: Effect.Effect<A, E, Persistence>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, persistenceLayer));

  return {
    initialize: (spec: InitSpec) => run(Persistence.use((p) => p.initialize(spec))),
    put: (record: PersistenceRecord) => run(Persistence.use((p) => p.put(record))),
    get: (id: string) => run(Persistence.use((p) => p.get(id))),
    query: (params: QueryParams) => run(Persistence.use((p) => p.query(params))),
    update: (id: string, record: { type: string; data: Record<string, unknown> }) =>
      run(Persistence.use((p) => p.update(id, record))),
    patch: (params: PatchParams) => run(Persistence.use((p) => p.patch(params))),
    remove: (id: string) => run(Persistence.use((p) => p.remove(id))),
  } as unknown as DurableObjectStub<any>;
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

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeStubStoreLayer(stub: DurableObjectStub<any> = makeMockStub()) {
  return Store.layer(testConfig).pipe(Layer.provide(doStubPersistence(stub)), Layer.orDie);
}

function runStubStore<A, E>(
  effect: Effect.Effect<A, E, Store>,
  stub?: DurableObjectStub<any>,
): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, makeStubStoreLayer(stub)));
}

// ─── Tests: doStubPersistence ──────────────────────────────────────────────

describe("doStubPersistence", () => {
  test("provides a Persistence layer that initializes via stub", async () => {
    const stub = makeMockStub();
    const layer = doStubPersistence(stub);
    const result = await Effect.runPromise(
      Effect.provide(
        Persistence.use((p) => p.initialize({ indexes: [] })),
        layer,
      ),
    );
    expect(result).toBeUndefined();
  });

  test("put and get round-trip through stub", async () => {
    const stub = makeMockStub();
    const layer = doStubPersistence(stub);

    // Initialize first (create tables)
    await Effect.runPromise(
      Effect.provide(
        Persistence.use((p) => p.initialize({ indexes: [] })),
        layer,
      ),
    );

    const stored = await Effect.runPromise(
      Effect.provide(
        Persistence.use((p) =>
          p.put({ id: "test-1", type: "Person.v1", data: { _tag: "Person.v1", name: "Alice" } }),
        ),
        layer,
      ),
    );

    expect(stored.id).toBe("test-1");
    expect(stored.type).toBe("Person.v1");
    expect(stored.data).toEqual({ _tag: "Person.v1", name: "Alice" });
    expect(stored.created_at).toBeNumber();
    expect(stored.updated_at).toBeNumber();

    const loaded = await Effect.runPromise(
      Effect.provide(
        Persistence.use((p) => p.get("test-1")),
        layer,
      ),
    );

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("test-1");
    expect(loaded!.data).toEqual({ _tag: "Person.v1", name: "Alice" });
  });

  test("get returns null for missing records", async () => {
    const stub = makeMockStub();
    const layer = doStubPersistence(stub);

    await Effect.runPromise(
      Effect.provide(
        Persistence.use((p) => p.initialize({ indexes: [] })),
        layer,
      ),
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Persistence.use((p) => p.get("nonexistent")),
        layer,
      ),
    );

    expect(result).toBeNull();
  });

  test("query filters by type", async () => {
    const stub = makeMockStub();
    const layer = doStubPersistence(stub);

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const p = yield* Persistence;
          yield* p.initialize({ indexes: [] });
          yield* p.put({ id: "a", type: "TypeA", data: { _tag: "TypeA", x: 1 } });
          yield* p.put({ id: "b", type: "TypeB", data: { _tag: "TypeB", y: 2 } });
          yield* p.put({ id: "c", type: "TypeA", data: { _tag: "TypeA", x: 3 } });
        }),
        layer,
      ),
    );

    const results = await Effect.runPromise(
      Effect.provide(
        Persistence.use((p) => p.query({ types: ["TypeA"] })),
        layer,
      ),
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.type === "TypeA")).toBe(true);
  });

  test("update changes data and type", async () => {
    const stub = makeMockStub();
    const layer = doStubPersistence(stub);

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const p = yield* Persistence;
          yield* p.initialize({ indexes: [] });
          yield* p.put({ id: "u1", type: "V1", data: { _tag: "V1", a: 1 } });
        }),
        layer,
      ),
    );

    const updated = await Effect.runPromise(
      Effect.provide(
        Persistence.use((p) => p.update("u1", { type: "V2", data: { _tag: "V2", b: 2 } })),
        layer,
      ),
    );

    expect(updated.type).toBe("V2");
    expect(updated.data).toEqual({ _tag: "V2", b: 2 });
  });

  test("remove deletes a record", async () => {
    const stub = makeMockStub();
    const layer = doStubPersistence(stub);

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const p = yield* Persistence;
          yield* p.initialize({ indexes: [] });
          yield* p.put({ id: "d1", type: "X", data: { _tag: "X" } });
          yield* p.remove("d1");
        }),
        layer,
      ),
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Persistence.use((p) => p.get("d1")),
        layer,
      ),
    );

    expect(result).toBeNull();
  });

  test("patch updates matching records", async () => {
    const stub = makeMockStub();
    const layer = doStubPersistence(stub);

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const p = yield* Persistence;
          yield* p.initialize({ indexes: [] });
          yield* p.put({ id: "p1", type: "T", data: { _tag: "T", score: 10 } });
          yield* p.put({ id: "p2", type: "T", data: { _tag: "T", score: 20 } });
        }),
        layer,
      ),
    );

    const count = await Effect.runPromise(
      Effect.provide(
        Persistence.use((p) => p.patch({ patches: [{ type: "T", patch: { score: 99 } }] })),
        layer,
      ),
    );

    expect(count).toBe(2);

    const results = await Effect.runPromise(
      Effect.provide(
        Persistence.use((p) => p.query({ types: ["T"] })),
        layer,
      ),
    );

    for (const r of results) {
      expect(r.data.score).toBe(99);
    }
  });

  test("wraps stub errors in PersistenceError", async () => {
    // Create a stub that rejects on every call
    const failingStub = {
      initialize: () => Promise.reject(new Error("connection lost")),
      put: () => Promise.reject(new Error("connection lost")),
      get: () => Promise.reject(new Error("connection lost")),
      query: () => Promise.reject(new Error("connection lost")),
      update: () => Promise.reject(new Error("connection lost")),
      patch: () => Promise.reject(new Error("connection lost")),
      remove: () => Promise.reject(new Error("connection lost")),
    } as unknown as DurableObjectStub<any>;

    const layer = doStubPersistence(failingStub);

    const result = await Effect.runPromise(
      Effect.provide(
        Persistence.use((p) => p.get("any")).pipe(
          Effect.map(() => "ok" as const),
          Effect.catchTag("PersistenceError", (e) => Effect.succeed(e.message)),
        ),
        layer,
      ),
    );

    expect(result).toContain("connection lost");
  });
});

// ─── Tests: doStubPersistence → Store integration ──────────────────────────

describe("doStubPersistence → Store", () => {
  test("saveEntity and loadEntity work through stub", async () => {
    const result = await runStubStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        return yield* store.loadEntity(PersonV1, saved.id);
      }),
    );

    expect(result.data).toEqual({
      _tag: "Person.v1",
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
    });
  });

  test("cross-version loading via lenses works through stub", async () => {
    const result = await runStubStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Bob",
          lastName: "Jones",
          email: "bob@example.com",
        });
        return yield* store.loadEntity(PersonV2, saved.id);
      }),
    );

    expect(result.data).toEqual({
      _tag: "Person.v2",
      fullName: "Bob Jones",
      email: "bob@example.com",
      age: 0,
    });
  });

  test("loadEntities returns all versions projected through stub", async () => {
    const result = await runStubStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        yield* store.saveEntity(PersonV2, {
          fullName: "Bob Jones",
          email: "bob@example.com",
          age: 30,
        });
        return yield* store.loadEntities(PersonV2);
      }),
    );

    expect(result).toHaveLength(2);
    for (const entity of result) {
      expect(entity.data._tag).toBe("Person.v2");
      expect(entity.data.fullName).toBeDefined();
    }
  });

  test("updateEntity with merge mode through stub", async () => {
    const result = await runStubStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV2, {
          fullName: "Carol White",
          email: "carol@example.com",
          age: 25,
        });
        return yield* store.updateEntity(PersonV2, saved.id, { age: 26 });
      }),
    );

    expect(result.data.fullName).toBe("Carol White");
    expect(result.data.age).toBe(26);
    expect(result.data.email).toBe("carol@example.com");
  });

  test("deleteEntity through stub", async () => {
    const result = await runStubStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Dave",
          lastName: "Brown",
          email: "dave@example.com",
        });
        yield* store.deleteEntity(saved.id);
        return yield* store.loadEntity(PersonV1, saved.id).pipe(
          Effect.map(() => "found" as const),
          Effect.catchTag("EntityNotFoundError", () => Effect.succeed("not-found" as const)),
        );
      }),
    );

    expect(result).toBe("not-found");
  });

  test("patchEntities through stub", async () => {
    const result = await runStubStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(PersonV2, {
          fullName: "A B",
          email: "a@b.com",
          age: 10,
        });
        yield* store.saveEntity(PersonV2, {
          fullName: "C D",
          email: "c@d.com",
          age: 20,
        });
        const count = yield* store.patchEntities(PersonV2, { age: 99 });
        const all = yield* store.loadEntities(PersonV2);
        return { count, all };
      }),
    );

    expect(result.count).toBe(2);
    for (const entity of result.all) {
      expect(entity.data.age).toBe(99);
    }
  });

  test("saveEntity with custom id through stub", async () => {
    const result = await runStubStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(
          PersonV1,
          { firstName: "Eve", lastName: "Fox", email: "eve@fox.com" },
          { id: "custom-id-123" },
        );
        return saved;
      }),
    );

    expect(result.id).toBe("custom-id-123");
  });

  test("loadEntities with filters through stub", async () => {
    const result = await runStubStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(PersonV2, {
          fullName: "Alice Smith",
          email: "alice@example.com",
          age: 25,
        });
        yield* store.saveEntity(PersonV2, {
          fullName: "Bob Jones",
          email: "bob@example.com",
          age: 35,
        });
        return yield* store.loadEntities(PersonV2, {
          filters: [{ field: "email", op: "eq", value: "bob@example.com" }],
        });
      }),
    );

    expect(result).toHaveLength(1);
    expect(result[0].data.fullName).toBe("Bob Jones");
  });

  test("cross-version update migrates stored schema through stub", async () => {
    const result = await runStubStore(
      Effect.gen(function* () {
        const store = yield* Store;
        // Save as V1
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Grace",
          lastName: "Hopper",
          email: "grace@example.com",
        });
        // Update as V2 (should migrate)
        const updated = yield* store.updateEntity(PersonV2, saved.id, {
          age: 85,
        });
        return updated;
      }),
    );

    expect(result.data._tag).toBe("Person.v2");
    expect(result.data.fullName).toBe("Grace Hopper");
    expect(result.data.age).toBe(85);
  });
});

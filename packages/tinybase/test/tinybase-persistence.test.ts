import { test, expect, describe } from "bun:test";
import { Effect, Layer, Ref, Schema } from "effect";
import { Store, Persistence, PersistenceError, defineLens } from "@storic/core";
import type { StoreConfig } from "@storic/core";
import { TinyBaseStoreService, tinybasePersistenceLayer } from "../src/index.ts";

// ─── Test Schemas ────────────────────────────────────────────────────────────

const PersonV1 = Schema.TaggedStruct("Person.v1", {
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String.annotate({ index: true }),
});

const PersonV2 = Schema.TaggedStruct("Person.v2", {
  fullName: Schema.String,
  email: Schema.String.annotate({ index: true }),
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

// ─── Test Helpers ────────────────────────────────────────────────────────────

const makeTestLayer = (config: StoreConfig = testConfig) => {
  const StoreServiceLive = TinyBaseStoreService.fresh();
  const PersistenceLive = tinybasePersistenceLayer.pipe(Layer.provide(StoreServiceLive));
  const StoreLive = Store.layer(config).pipe(Layer.provide(PersistenceLive));
  return Layer.mergeAll(StoreLive, PersistenceLive, StoreServiceLive);
};

const runStore = <A, E>(
  effect: Effect.Effect<A, E, Store | Persistence | TinyBaseStoreService>,
  config?: StoreConfig,
): Promise<A> => Effect.runPromise(Effect.provide(effect, makeTestLayer(config)));

// ─── Persistence Layer: put & get ────────────────────────────────────────────

describe("put & get", () => {
  test("put inserts and get retrieves", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        const stored = yield* persistence.put({
          id: "test-1",
          type: "Person.v1",
          data: {
            _tag: "Person.v1",
            firstName: "Alice",
            lastName: "Smith",
            email: "alice@example.com",
          },
        });

        expect(stored.id).toBe("test-1");
        expect(stored.type).toBe("Person.v1");
        expect(stored.data).toEqual({
          _tag: "Person.v1",
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        expect(stored.created_at).toBeGreaterThan(0);

        const fetched = yield* persistence.get("test-1");
        expect(fetched).not.toBeNull();
        expect(fetched!.data).toEqual(stored.data);
      }),
    );
  });

  test("get returns null for missing id", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });
        return yield* persistence.get("nonexistent");
      }),
    );
    expect(result).toBeNull();
  });
});

// ─── Query ───────────────────────────────────────────────────────────────────

describe("query", () => {
  test("query by type returns matching records", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "p1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@b.com" },
        });
        yield* persistence.put({
          id: "p2",
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Bob Jones", email: "b@c.com", age: 30 },
        });

        const v1s = yield* persistence.query({ types: ["Person.v1"] });
        expect(v1s).toHaveLength(1);
        expect(v1s[0].id).toBe("p1");

        const all = yield* persistence.query({ types: ["Person.v1", "Person.v2"] });
        expect(all).toHaveLength(2);
      }),
    );
  });

  test("query with eq filter", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "p1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@b.com" },
        });
        yield* persistence.put({
          id: "p2",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Bob", lastName: "Jones", email: "b@c.com" },
        });

        const results = yield* persistence.query({
          types: ["Person.v1"],
          filters: [{ field: "firstName", op: "eq", value: "Alice" }],
        });
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe("p1");
      }),
    );
  });

  test("query with limit and offset", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        for (let i = 0; i < 5; i++) {
          yield* persistence.put({
            id: `p${i}`,
            type: "Person.v1",
            data: {
              _tag: "Person.v1",
              firstName: `Person${i}`,
              lastName: "X",
              email: `p${i}@x.com`,
            },
          });
        }

        const page = yield* persistence.query({
          types: ["Person.v1"],
          limit: 2,
          offset: 1,
        });
        expect(page).toHaveLength(2);
      }),
    );
  });

  test("query with indexed eq filter uses index", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({
          indexes: [
            { name: "idx_Person_v1__email", fieldPath: "email", typeDiscriminator: "Person.v1" },
          ],
        });

        yield* persistence.put({
          id: "p1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@b.com" },
        });
        yield* persistence.put({
          id: "p2",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Bob", lastName: "Jones", email: "b@c.com" },
        });

        const results = yield* persistence.query({
          types: ["Person.v1"],
          filters: [{ field: "email", op: "eq", value: "a@b.com" }],
        });
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe("p1");
      }),
    );
  });
});

// ─── Update ──────────────────────────────────────────────────────────────────

describe("update", () => {
  test("update changes data and bumps updated_at", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        const original = yield* persistence.put({
          id: "u1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@b.com" },
        });

        const updated = yield* persistence.update("u1", {
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Jones", email: "a@b.com" },
        });

        expect(updated.data.lastName).toBe("Jones");
        expect(updated.created_at).toBe(original.created_at);
        expect(updated.updated_at).toBeGreaterThanOrEqual(original.updated_at);
      }),
    );
  });

  test("update fails for missing entity", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });
        return yield* persistence.update("missing", {
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "X", lastName: "Y", email: "x@y.com" },
        });
      }).pipe(Effect.flip),
    );
    expect(result).toBeInstanceOf(PersistenceError);
  });
});

// ─── Patch ───────────────────────────────────────────────────────────────────

describe("patch", () => {
  test("patch applies merge-patch to matching entities", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "p1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "old@a.com" },
        });
        yield* persistence.put({
          id: "p2",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Bob", lastName: "Jones", email: "old@b.com" },
        });

        const count = yield* persistence.patch({
          patches: [
            {
              type: "Person.v1",
              patch: { email: "new@all.com" },
            },
          ],
        });

        expect(count).toBe(2);

        const p1 = yield* persistence.get("p1");
        expect(p1!.data.email).toBe("new@all.com");
        const p2 = yield* persistence.get("p2");
        expect(p2!.data.email).toBe("new@all.com");
      }),
    );
  });

  test("patch with filters only affects matching rows", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "p1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@b.com" },
        });
        yield* persistence.put({
          id: "p2",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Bob", lastName: "Jones", email: "b@c.com" },
        });

        const count = yield* persistence.patch({
          patches: [
            {
              type: "Person.v1",
              patch: { email: "patched@x.com" },
              filters: [{ field: "firstName", op: "eq", value: "Alice" }],
            },
          ],
        });

        expect(count).toBe(1);

        const p1 = yield* persistence.get("p1");
        expect(p1!.data.email).toBe("patched@x.com");
        const p2 = yield* persistence.get("p2");
        expect(p2!.data.email).toBe("b@c.com");
      }),
    );
  });
});

// ─── Remove ──────────────────────────────────────────────────────────────────

describe("remove", () => {
  test("remove deletes entity", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "r1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@b.com" },
        });

        yield* persistence.remove("r1");

        const fetched = yield* persistence.get("r1");
        expect(fetched).toBeNull();

        const results = yield* persistence.query({ types: ["Person.v1"] });
        expect(results).toHaveLength(0);
      }),
    );
  });

  test("remove nonexistent id is a no-op", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });
        yield* persistence.remove("nonexistent");
      }),
    );
  });
});

// ─── Store Integration ───────────────────────────────────────────────────────

describe("Store integration", () => {
  test("save and load entity through Store", async () => {
    await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });

        expect(saved.data._tag).toBe("Person.v1");
        expect(saved.data.firstName).toBe("Alice");

        const loaded = yield* store.loadEntity(PersonV1, saved.id);
        expect(loaded.data).toEqual(saved.data);
      }),
    );
  });

  test("load entity with lens transformation", async () => {
    await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });

        // Load as V2 — should transform via lens
        const asV2 = yield* store.loadEntity(PersonV2, saved.id);
        expect(asV2.data._tag).toBe("Person.v2");
        expect(asV2.data.fullName).toBe("Alice Smith");
        expect(asV2.data.email).toBe("alice@example.com");
        expect(asV2.data.age).toBe(0);
      }),
    );
  });

  test("loadEntities returns all versions transformed", async () => {
    await runStore(
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

        const allAsV2 = yield* store.loadEntities(PersonV2);
        expect(allAsV2).toHaveLength(2);
        for (const e of allAsV2) {
          expect(e.data._tag).toBe("Person.v2");
        }
      }),
    );
  });

  test("updateEntity merges fields", async () => {
    await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });

        const updated = yield* store.updateEntity(PersonV1, saved.id, {
          lastName: "Jones",
        });

        expect(updated.data.firstName).toBe("Alice");
        expect(updated.data.lastName).toBe("Jones");
        expect(updated.data.email).toBe("alice@example.com");
      }),
    );
  });

  test("deleteEntity removes entity", async () => {
    await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });

        yield* store.deleteEntity(saved.id);

        const result = yield* store.loadEntities(PersonV1);
        expect(result).toHaveLength(0);
      }),
    );
  });
});

// ─── TinyBase Store Access ───────────────────────────────────────────────────

describe("TinyBaseStoreService", () => {
  test("exposes underlying TinyBase Store", async () => {
    await runStore(
      Effect.gen(function* () {
        const { store: storeRef } = yield* TinyBaseStoreService;
        const tinyStore = yield* Ref.get(storeRef);

        // Store should exist and be a TinyBase Store
        expect(tinyStore).toBeDefined();
        expect(typeof tinyStore.getTable).toBe("function");
        expect(typeof tinyStore.setRow).toBe("function");
      }),
    );
  });

  test("entities are visible in the TinyBase Store", async () => {
    await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const { store: storeRef } = yield* TinyBaseStoreService;

        yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });

        const tinyStore = yield* Ref.get(storeRef);
        const rowIds = tinyStore.getRowIds("entities");
        expect(rowIds).toHaveLength(1);
      }),
    );
  });
});

import { test, expect, describe } from "bun:test";
import * as A from "@automerge/automerge";
import { Effect, Layer, Ref, Schema } from "effect";
import { Store, Persistence, PersistenceError, defineLens } from "@storic/core";
import type { StoreConfig } from "@storic/core";
import {
  AutomergeDocs,
  automergePersistenceLayer,
  type CatalogDoc,
  type EntityDoc,
} from "../src/index.ts";

// ─── Test Schemas ─────────────���──────────────────────────────────────────────

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

// ─── Test Helpers ────���───────────────────────────────────────────────────────

const makeTestLayer = (config: StoreConfig = testConfig) => {
  const DocsLive = AutomergeDocs.fresh();
  const PersistenceLive = automergePersistenceLayer.pipe(Layer.provide(DocsLive));
  const StoreLive = Store.layer(config).pipe(Layer.provide(PersistenceLive));
  return Layer.mergeAll(StoreLive, PersistenceLive, DocsLive);
};

const runStore = <A, E>(
  effect: Effect.Effect<A, E, Store | Persistence | AutomergeDocs>,
  config?: StoreConfig,
): Promise<A> => Effect.runPromise(Effect.provide(effect, makeTestLayer(config)));

// ─── Persistence Layer: put & get ───────────���────────────────────────────────

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

  test("each entity has its own automerge doc", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "a",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@x.com" },
        });
        yield* persistence.put({
          id: "b",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Bob", lastName: "Jones", email: "b@x.com" },
        });

        const { entities } = yield* AutomergeDocs;
        const map = yield* Ref.get(entities);
        expect(map.size).toBe(2);
        expect(map.has("a")).toBe(true);
        expect(map.has("b")).toBe(true);

        // Docs are independent automerge documents
        const docA = map.get("a")!;
        const docB = map.get("b")!;
        expect(A.getActorId(docA)).not.toBe(A.getActorId(docB));
      }),
    );
  });
});

// ─── Persistence Layer: query ────────────────────────────────────────────────

describe("query", () => {
  test("filters by type using byType index", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "a",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@x.com" },
        });
        yield* persistence.put({
          id: "b",
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Bob Jones", email: "b@x.com", age: 30 },
        });

        const v1Only = yield* persistence.query({ types: ["Person.v1"] });
        expect(v1Only).toHaveLength(1);
        expect(v1Only[0].id).toBe("a");

        const both = yield* persistence.query({ types: ["Person.v1", "Person.v2"] });
        expect(both).toHaveLength(2);
      }),
    );
  });

  test("narrows by indexed field eq filter", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({
          indexes: [
            { name: "idx_Person_v1__email", fieldPath: "email", typeDiscriminator: "Person.v1" },
          ],
        });

        yield* persistence.put({
          id: "a",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "alice@x.com" },
        });
        yield* persistence.put({
          id: "b",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Bob", lastName: "Jones", email: "bob@x.com" },
        });

        const results = yield* persistence.query({
          types: ["Person.v1"],
          filters: [{ field: "email", op: "eq", value: "alice@x.com" }],
        });
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe("a");
      }),
    );
  });

  test("narrows by indexed field in filter", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({
          indexes: [
            { name: "idx_Person_v1__email", fieldPath: "email", typeDiscriminator: "Person.v1" },
          ],
        });

        yield* persistence.put({
          id: "a",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "alice@x.com" },
        });
        yield* persistence.put({
          id: "b",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Bob", lastName: "Jones", email: "bob@x.com" },
        });
        yield* persistence.put({
          id: "c",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Carol", lastName: "White", email: "carol@x.com" },
        });

        const results = yield* persistence.query({
          types: ["Person.v1"],
          filters: [{ field: "email", op: "in", value: ["alice@x.com", "carol@x.com"] }],
        });
        expect(results).toHaveLength(2);
        expect(results.map((r) => r.id).sort()).toEqual(["a", "c"]);
      }),
    );
  });

  test("non-indexed filters still work via in-memory scan", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "a",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@x.com" },
        });
        yield* persistence.put({
          id: "b",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Bob", lastName: "Jones", email: "b@x.com" },
        });

        const results = yield* persistence.query({
          types: ["Person.v1"],
          filters: [{ field: "firstName", op: "eq", value: "Alice" }],
        });
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe("a");
      }),
    );
  });

  test("limit and offset", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        for (let i = 0; i < 5; i++) {
          yield* persistence.put({
            id: `item-${i}`,
            type: "Person.v1",
            data: { _tag: "Person.v1", firstName: `P${i}`, lastName: "T", email: `p${i}@x.com` },
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
});

// ─── Persistence Layer: update ───────────────────────────────────────────────

describe("update", () => {
  test("modifies type and data", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "u-1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@x.com" },
        });

        const updated = yield* persistence.update("u-1", {
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Alice Smith", email: "a@x.com", age: 30 },
        });

        expect(updated.type).toBe("Person.v2");
        expect(updated.data).toEqual({
          _tag: "Person.v2",
          fullName: "Alice Smith",
          email: "a@x.com",
          age: 30,
        });
      }),
    );
  });

  test("update maintains indexes correctly", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({
          indexes: [
            { name: "idx_Person_v1__email", fieldPath: "email", typeDiscriminator: "Person.v1" },
          ],
        });

        yield* persistence.put({
          id: "u-1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "old@x.com" },
        });

        yield* persistence.update("u-1", {
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "new@x.com" },
        });

        // Old email should not match
        const oldResults = yield* persistence.query({
          types: ["Person.v1"],
          filters: [{ field: "email", op: "eq", value: "old@x.com" }],
        });
        expect(oldResults).toHaveLength(0);

        // New email should match
        const newResults = yield* persistence.query({
          types: ["Person.v1"],
          filters: [{ field: "email", op: "eq", value: "new@x.com" }],
        });
        expect(newResults).toHaveLength(1);
        expect(newResults[0].id).toBe("u-1");
      }),
    );
  });
});

// ─── Persistence Layer: patch ────────────────────────────────────────────────

describe("patch", () => {
  test("applies merge-patch to matching entities", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "p-1",
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Alice Smith", email: "a@x.com", age: 25 },
        });
        yield* persistence.put({
          id: "p-2",
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Bob Jones", email: "b@x.com", age: 30 },
        });

        const affected = yield* persistence.patch({
          patches: [{ type: "Person.v2", patch: { age: 99 } }],
        });
        expect(affected).toBe(2);

        const alice = yield* persistence.get("p-1");
        expect((alice!.data as any).age).toBe(99);

        const bob = yield* persistence.get("p-2");
        expect((bob!.data as any).age).toBe(99);
      }),
    );
  });

  test("patch with filters only affects matching entities", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "p-1",
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Alice Smith", email: "a@x.com", age: 25 },
        });
        yield* persistence.put({
          id: "p-2",
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Bob Jones", email: "b@x.com", age: 30 },
        });

        const affected = yield* persistence.patch({
          patches: [
            {
              type: "Person.v2",
              patch: { age: 99 },
              filters: [{ field: "email", op: "eq", value: "a@x.com" }],
            },
          ],
        });
        expect(affected).toBe(1);

        const alice = yield* persistence.get("p-1");
        expect((alice!.data as any).age).toBe(99);

        const bob = yield* persistence.get("p-2");
        expect((bob!.data as any).age).toBe(30);
      }),
    );
  });

  test("patch updates field indexes", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({
          indexes: [
            { name: "idx_Person_v2__email", fieldPath: "email", typeDiscriminator: "Person.v2" },
          ],
        });

        yield* persistence.put({
          id: "p-1",
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Alice", email: "old@x.com", age: 25 },
        });

        yield* persistence.patch({
          patches: [{ type: "Person.v2", patch: { email: "new@x.com" } }],
        });

        const oldResults = yield* persistence.query({
          types: ["Person.v2"],
          filters: [{ field: "email", op: "eq", value: "old@x.com" }],
        });
        expect(oldResults).toHaveLength(0);

        const newResults = yield* persistence.query({
          types: ["Person.v2"],
          filters: [{ field: "email", op: "eq", value: "new@x.com" }],
        });
        expect(newResults).toHaveLength(1);
      }),
    );
  });
});

// ��── Persistence Layer: remove ─────────────────────────────────────────���─────

describe("remove", () => {
  test("deletes entity by id", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "r-1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@x.com" },
        });

        yield* persistence.remove("r-1");
        const result = yield* persistence.get("r-1");
        expect(result).toBeNull();
      }),
    );
  });

  test("remove cleans up entity doc and catalog indexes", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({
          indexes: [
            { name: "idx_Person_v1__email", fieldPath: "email", typeDiscriminator: "Person.v1" },
          ],
        });

        yield* persistence.put({
          id: "r-1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@x.com" },
        });

        yield* persistence.remove("r-1");

        // Entity doc should be gone
        const { entities } = yield* AutomergeDocs;
        const map = yield* Ref.get(entities);
        expect(map.has("r-1")).toBe(false);

        // Should not appear in queries
        const results = yield* persistence.query({ types: ["Person.v1"] });
        expect(results).toHaveLength(0);
      }),
    );
  });
});

// ─── Store Integration ─────────��─────────────────────────────────────────────

describe("Store integration", () => {
  test("saveEntity and loadEntity", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });

        expect(saved.id).toBeDefined();
        expect(saved.data._tag).toBe("Person.v1");

        return yield* store.loadEntity(PersonV1, saved.id);
      }),
    );

    expect(entity.data.firstName).toBe("Alice");
  });

  test("loadEntity applies lens transformation", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        return yield* store.loadEntity(PersonV2, saved.id);
      }),
    );

    expect(entity.data.fullName).toBe("Alice Smith");
    expect(entity.data.age).toBe(0);
  });

  test("loadEntities across schema versions", async () => {
    const entities = await runStore(
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

    expect(entities).toHaveLength(2);
    expect(entities.every((e) => "fullName" in e.data)).toBe(true);
  });
});

// ─── Automerge CRDT Features ───────────────────────────���─────────────────────

describe("Automerge CRDT features", () => {
  test("save and load all docs preserves data", async () => {
    const DocsLive = AutomergeDocs.fresh();
    const PersistenceLive = automergePersistenceLayer.pipe(Layer.provide(DocsLive));
    const TestLayer = Layer.mergeAll(PersistenceLive, DocsLive);

    // Save state from first session
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "s-1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@x.com" },
        });

        const { catalog, entities } = yield* AutomergeDocs;
        const catalogDoc = yield* Ref.get(catalog);
        const entityMap = yield* Ref.get(entities);

        return {
          catalog: A.save(catalogDoc),
          entities: Array.from(entityMap.entries()).map(([id, doc]) => [id, A.save(doc)] as const),
        };
      }).pipe(Effect.provide(TestLayer)),
    );

    // Restore in a new session
    const LoadedLive = AutomergeDocs.fromSaved(saved);
    const LoadedPersistence = automergePersistenceLayer.pipe(Layer.provide(LoadedLive));
    const LoadedLayer = Layer.mergeAll(LoadedPersistence, LoadedLive);

    const entity = await Effect.runPromise(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        return yield* persistence.get("s-1");
      }).pipe(Effect.provide(LoadedLayer)),
    );

    expect(entity).not.toBeNull();
    expect(entity!.data).toEqual({
      _tag: "Person.v1",
      firstName: "Alice",
      lastName: "Smith",
      email: "a@x.com",
    });
  });

  test("entity docs merge independently", async () => {
    // Create an entity doc base and fork it
    const base = A.from<EntityDoc>({ data: { name: "Alice", score: 0 } });
    const fork1 = A.clone(base);
    const fork2 = A.clone(base);

    // Two peers make non-conflicting changes to the same entity
    const changed1 = A.change(fork1, (d) => {
      (d.data as any).score = 10;
    });
    const changed2 = A.change(fork2, (d) => {
      (d.data as any).title = "Engineer";
    });

    // Merge combines both changes
    const merged = A.merge(changed1, changed2);
    expect((merged.data as any).score).toBe(10);
    expect((merged.data as any).title).toBe("Engineer");
    expect((merged.data as any).name).toBe("Alice");
  });

  test("catalog doc tracks metadata separately from entity data", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "m-1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@x.com" },
        });

        const { catalog } = yield* AutomergeDocs;
        const catalogDoc = yield* Ref.get(catalog);

        // Catalog has metadata but not entity data
        const entry = catalogDoc.entries["m-1"];
        expect(entry.type).toBe("Person.v1");
        expect(entry.created_at).toBeGreaterThan(0);
        expect((entry as any).data).toBeUndefined();
      }),
    );
  });

  test("update preserves per-field CRDT merge semantics", async () => {
    // Create a base entity doc, fork it, update different fields on each fork,
    // merge — both changes should be present.
    const base = A.from<EntityDoc>({ data: { name: "Alice", score: 0, level: 1 } });

    // Fork 1: update via per-field diff (simulating our update method)
    const fork1 = A.change(A.clone(base), (d) => {
      (d.data as any).score = 42;
    });

    // Fork 2: update a different field
    const fork2 = A.change(A.clone(base), (d) => {
      (d.data as any).level = 5;
    });

    // Merge both forks — both field changes should survive
    const merged = A.merge(fork1, fork2);
    expect((merged.data as any).name).toBe("Alice");
    expect((merged.data as any).score).toBe(42);
    expect((merged.data as any).level).toBe(5);
  });
});

// ─── Correctness & Robustness ───────────────────────────────────────────────

describe("initialize idempotency", () => {
  test("calling initialize twice does not duplicate index entries", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        const indexes = [
          { name: "idx_Person_v1__email", fieldPath: "email", typeDiscriminator: "Person.v1" },
        ];

        yield* persistence.initialize({ indexes });
        yield* persistence.initialize({ indexes });

        yield* persistence.put({
          id: "dup-1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@x.com" },
        });

        // Query should return exactly 1 result, not duplicates
        const results = yield* persistence.query({
          types: ["Person.v1"],
          filters: [{ field: "email", op: "eq", value: "a@x.com" }],
        });
        expect(results).toHaveLength(1);
      }),
    );
  });
});

describe("remove cleans up empty byType buckets", () => {
  test("byType bucket is deleted after removing the last entity of a type", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "only-one",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@x.com" },
        });

        yield* persistence.remove("only-one");

        const { catalog } = yield* AutomergeDocs;
        const catalogDoc = yield* Ref.get(catalog);
        expect(catalogDoc.byType["Person.v1"]).toBeUndefined();
      }),
    );
  });
});

describe("stale index cleanup", () => {
  test("re-initialize removes stale field indexes from catalog", async () => {
    const DocsLive = AutomergeDocs.fresh();
    const PersistenceLive = automergePersistenceLayer.pipe(Layer.provide(DocsLive));
    const TestLayer = Layer.mergeAll(PersistenceLive, DocsLive);

    await Effect.runPromise(
      Effect.gen(function* () {
        const persistence = yield* Persistence;

        // First init with an index
        yield* persistence.initialize({
          indexes: [
            { name: "idx_Person_v1__email", fieldPath: "email", typeDiscriminator: "Person.v1" },
          ],
        });

        yield* persistence.put({
          id: "si-1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@x.com" },
        });

        // Verify the index exists
        const { catalog } = yield* AutomergeDocs;
        let catalogDoc = yield* Ref.get(catalog);
        expect(catalogDoc.fieldIndexes["idx_Person_v1__email"]).toBeDefined();

        // Re-initialize without the old index
        yield* persistence.initialize({ indexes: [] });

        catalogDoc = yield* Ref.get(catalog);
        expect(catalogDoc.fieldIndexes["idx_Person_v1__email"]).toBeUndefined();
      }).pipe(Effect.provide(TestLayer)),
    );
  });
});

// ─── Error & Edge Cases ─────────────────────────────────────────────────────

describe("update edge cases", () => {
  test("update on nonexistent entity returns PersistenceError", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        return yield* persistence
          .update("no-such-id", {
            type: "Person.v1",
            data: { _tag: "Person.v1", firstName: "X", lastName: "Y", email: "x@y.com" },
          })
          .pipe(
            Effect.map(() => "ok" as const),
            Effect.catchTag("PersistenceError", (e) => Effect.succeed(e)),
          );
      }),
    );

    expect(result).not.toBe("ok");
    expect((result as PersistenceError).message).toContain("Update failed");
  });

  test("update that adds and removes keys via applyObjectDiff", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "diff-1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@x.com" },
        });

        // Update with different shape: remove firstName/lastName, add fullName/age
        yield* persistence.update("diff-1", {
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Alice Smith", email: "a@x.com", age: 30 },
        });

        const fetched = yield* persistence.get("diff-1");
        expect(fetched).not.toBeNull();
        expect(fetched!.data).toEqual({
          _tag: "Person.v2",
          fullName: "Alice Smith",
          email: "a@x.com",
          age: 30,
        });
        // Old keys should be gone
        expect((fetched!.data as any).firstName).toBeUndefined();
        expect((fetched!.data as any).lastName).toBeUndefined();
      }),
    );
  });
});

describe("remove edge cases", () => {
  test("remove of nonexistent id is a no-op", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        // Should not throw
        yield* persistence.remove("does-not-exist");

        // Store is still functional
        const results = yield* persistence.query({ types: ["Person.v1"] });
        expect(results).toHaveLength(0);
      }),
    );
  });
});

describe("patch edge cases", () => {
  test("patch with nested object merge", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "nest-1",
          type: "Person.v1",
          data: {
            _tag: "Person.v1",
            firstName: "Alice",
            lastName: "Smith",
            email: "a@x.com",
            address: { city: "NYC", state: "NY" },
          },
        });

        // Patch nested field — should merge, not replace the whole address
        yield* persistence.patch({
          patches: [
            {
              type: "Person.v1",
              patch: { address: { zip: "10001" } },
            },
          ],
        });

        const fetched = yield* persistence.get("nest-1");
        const address = (fetched!.data as any).address;
        expect(address.city).toBe("NYC");
        expect(address.state).toBe("NY");
        expect(address.zip).toBe("10001");
      }),
    );
  });

  test("patch with null deletes a key", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "null-1",
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Alice", email: "a@x.com", age: 25 },
        });

        yield* persistence.patch({
          patches: [{ type: "Person.v2", patch: { age: null } }],
        });

        const fetched = yield* persistence.get("null-1");
        expect((fetched!.data as any).age).toBeUndefined();
        expect((fetched!.data as any).fullName).toBe("Alice");
      }),
    );
  });

  test("patch only targets the correct type via byType index", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "t-1",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Alice", lastName: "Smith", email: "a@x.com" },
        });
        yield* persistence.put({
          id: "t-2",
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Bob", email: "b@x.com", age: 30 },
        });

        // Patch only Person.v2 entities
        const affected = yield* persistence.patch({
          patches: [{ type: "Person.v2", patch: { age: 99 } }],
        });
        expect(affected).toBe(1);

        // Person.v1 entity should be untouched
        const alice = yield* persistence.get("t-1");
        expect((alice!.data as any).age).toBeUndefined();

        const bob = yield* persistence.get("t-2");
        expect((bob!.data as any).age).toBe(99);
      }),
    );
  });
});

describe("query edge cases", () => {
  test("indexed eq filter combined with non-indexed gt filter", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({
          indexes: [
            { name: "idx_Person_v2__email", fieldPath: "email", typeDiscriminator: "Person.v2" },
          ],
        });

        yield* persistence.put({
          id: "combo-1",
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Alice", email: "team@x.com", age: 25 },
        });
        yield* persistence.put({
          id: "combo-2",
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Bob", email: "team@x.com", age: 35 },
        });
        yield* persistence.put({
          id: "combo-3",
          type: "Person.v2",
          data: { _tag: "Person.v2", fullName: "Carol", email: "other@x.com", age: 40 },
        });

        // eq on indexed email + gt on non-indexed age
        const results = yield* persistence.query({
          types: ["Person.v2"],
          filters: [
            { field: "email", op: "eq", value: "team@x.com" },
            { field: "age", op: "gt", value: 30 },
          ],
        });
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe("combo-2");
      }),
    );
  });

  test("like filter works through automerge proxy data", async () => {
    await runStore(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        yield* persistence.initialize({ indexes: [] });

        yield* persistence.put({
          id: "like-1",
          type: "Person.v1",
          data: {
            _tag: "Person.v1",
            firstName: "Alice",
            lastName: "Smith",
            email: "alice@example.com",
          },
        });
        yield* persistence.put({
          id: "like-2",
          type: "Person.v1",
          data: { _tag: "Person.v1", firstName: "Bob", lastName: "Jones", email: "bob@test.com" },
        });
        yield* persistence.put({
          id: "like-3",
          type: "Person.v1",
          data: {
            _tag: "Person.v1",
            firstName: "Carol",
            lastName: "White",
            email: "carol@example.com",
          },
        });

        const results = yield* persistence.query({
          types: ["Person.v1"],
          filters: [{ field: "email", op: "like", value: "%@example.com" }],
        });
        expect(results).toHaveLength(2);
        expect(results.map((r) => r.id).sort()).toEqual(["like-1", "like-3"]);
      }),
    );
  });
});

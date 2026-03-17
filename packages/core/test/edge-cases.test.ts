import { test, expect, describe } from "bun:test";
import { Effect, Schema } from "effect";
import { Store } from "../src/index.ts";
import type { StoreConfig } from "../src/index.ts";
import { runStore, PersonV1, PersonV2 } from "./test-helper.ts";

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("Store: edge cases", () => {
  test("loadEntities returns empty array when no entities exist", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.loadEntities(PersonV1);
      }),
    );

    expect(entities).toEqual([]);
  });

  test("loadEntities with limit", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(PersonV1, {
          firstName: "A",
          lastName: "A",
          email: "a@example.com",
        });
        yield* store.saveEntity(PersonV1, {
          firstName: "B",
          lastName: "B",
          email: "b@example.com",
        });
        yield* store.saveEntity(PersonV1, {
          firstName: "C",
          lastName: "C",
          email: "c@example.com",
        });
        return yield* store.loadEntities(PersonV1, { limit: 2 });
      }),
    );

    expect(entities).toHaveLength(2);
  });

  test("loadEntities with offset", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(PersonV1, {
          firstName: "A",
          lastName: "A",
          email: "a@example.com",
        });
        yield* store.saveEntity(PersonV1, {
          firstName: "B",
          lastName: "B",
          email: "b@example.com",
        });
        yield* store.saveEntity(PersonV1, {
          firstName: "C",
          lastName: "C",
          email: "c@example.com",
        });
        return yield* store.loadEntities(PersonV1, { limit: 10, offset: 1 });
      }),
    );

    expect(entities).toHaveLength(2);
  });

  test("deleteEntity on nonexistent id does not error", async () => {
    // delete is a no-op for missing IDs (SQL DELETE WHERE id = ? affects 0 rows)
    await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.deleteEntity("nonexistent-id");
      }),
    );
  });

  test("saveEntity with duplicate custom id fails", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(
          PersonV1,
          { firstName: "A", lastName: "A", email: "a@a.com" },
          { id: "dup" },
        );
        return yield* store
          .saveEntity(PersonV1, { firstName: "B", lastName: "B", email: "b@b.com" }, { id: "dup" })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catchTag("PersistenceError", () => Effect.succeed("PersistenceError" as const)),
          );
      }),
    );

    expect(tag).toBe("PersistenceError");
  });

  test("loadEntities with empty in filter returns no results", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        return yield* store.loadEntities(PersonV1, {
          filters: [{ field: "email", op: "in", value: [] }],
        });
      }),
    );

    expect(entities).toEqual([]);
  });

  test("loadEntities with multiple combined filters", async () => {
    const entities = await runStore(
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
          age: 30,
        });
        yield* store.saveEntity(PersonV2, {
          fullName: "Charlie Brown",
          email: "charlie@other.com",
          age: 35,
        });

        return yield* store.loadEntities(PersonV2, {
          filters: [
            { field: "age", op: "gte", value: 25 },
            { field: "email", op: "like", value: "%@example.com" },
          ],
        });
      }),
    );

    expect(entities).toHaveLength(2);
    const names = entities.map((e) => e.data.fullName).sort();
    expect(names).toEqual(["Alice Smith", "Bob Jones"]);
  });

  test("filter with invalid field name returns PersistenceError", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        return yield* store
          .loadEntities(PersonV1, {
            filters: [{ field: "email'; DROP TABLE entities; --", op: "eq", value: "x" }],
          })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catchTag("PersistenceError", () => Effect.succeed("PersistenceError" as const)),
          );
      }),
    );

    expect(tag).toBe("PersistenceError");
  });

  test("patchEntities returns 0 when no entities match filter", async () => {
    const affected = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        return yield* store.patchEntities(
          PersonV1,
          { email: "redacted@example.com" },
          { filters: [{ field: "firstName", op: "eq", value: "Nonexistent" }] },
        );
      }),
    );

    expect(affected).toBe(0);
  });

  test("updateEntity timestamps are updated", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });

        const updated = yield* store.updateEntity(PersonV1, saved.id, {
          email: "alice2@example.com",
        });

        return {
          savedCreated: saved.created_at,
          savedUpdated: saved.updated_at,
          updatedCreated: updated.created_at,
          updatedUpdated: updated.updated_at,
        };
      }),
    );

    // created_at should not change
    expect(result.updatedCreated).toBe(result.savedCreated);
    // updated_at should be >= saved updated_at (could be same second)
    expect(result.updatedUpdated).toBeGreaterThanOrEqual(result.savedUpdated);
  });
});

// ─── Schema registry edge cases ─────────────────────────────────────────────

describe("Store: schema registry", () => {
  test("store with no lenses works for single-type operations", async () => {
    const SimpleSchema = Schema.TaggedStruct("Simple.v1", {
      value: Schema.String,
    });

    const config: StoreConfig = { schemas: [SimpleSchema], lenses: [] };

    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(SimpleSchema, { value: "hello" });
        return yield* store.loadEntity(SimpleSchema, saved.id);
      }),
      config,
    );

    expect(entity.data.value).toBe("hello");
  });

  test("store with multiple disconnected schema groups", async () => {
    const TypeA = Schema.TaggedStruct("TypeA.v1", { a: Schema.String });
    const TypeB = Schema.TaggedStruct("TypeB.v1", { b: Schema.Number });

    const config: StoreConfig = {
      schemas: [TypeA, TypeB],
      lenses: [],
    };

    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(TypeA, { a: "hello" });
        yield* store.saveEntity(TypeB, { b: 42 });

        const as = yield* store.loadEntities(TypeA);
        const bs = yield* store.loadEntities(TypeB);

        return { aCount: as.length, bCount: bs.length };
      }),
      config,
    );

    expect(result.aCount).toBe(1);
    expect(result.bCount).toBe(1);
  });
});

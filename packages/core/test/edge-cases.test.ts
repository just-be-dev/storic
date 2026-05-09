import { test, expect, describe } from "bun:test";
import { Effect, Schema } from "effect";
import { Store, defineEntity } from "../src/index.ts";
import { runStore, Person, PersonV1 } from "./test-helper.ts";

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("Store: edge cases", () => {
  test("loadEntities returns empty array when no entities exist", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.loadEntities(Person, { as: PersonV1 });
      }),
    );

    expect(entities).toEqual([]);
  });

  test("loadEntities with limit", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(
          Person,
          {
            firstName: "A",
            lastName: "A",
            email: "a@example.com",
          },
          { as: PersonV1 },
        );
        yield* store.saveEntity(
          Person,
          {
            firstName: "B",
            lastName: "B",
            email: "b@example.com",
          },
          { as: PersonV1 },
        );
        yield* store.saveEntity(
          Person,
          {
            firstName: "C",
            lastName: "C",
            email: "c@example.com",
          },
          { as: PersonV1 },
        );
        return yield* store.loadEntities(Person, { limit: 2, as: PersonV1 });
      }),
    );

    expect(entities).toHaveLength(2);
  });

  test("loadEntities with offset", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(
          Person,
          {
            firstName: "A",
            lastName: "A",
            email: "a@example.com",
          },
          { as: PersonV1 },
        );
        yield* store.saveEntity(
          Person,
          {
            firstName: "B",
            lastName: "B",
            email: "b@example.com",
          },
          { as: PersonV1 },
        );
        yield* store.saveEntity(
          Person,
          {
            firstName: "C",
            lastName: "C",
            email: "c@example.com",
          },
          { as: PersonV1 },
        );
        return yield* store.loadEntities(Person, { limit: 10, offset: 1, as: PersonV1 });
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
          Person,
          { firstName: "A", lastName: "A", email: "a@a.com" },
          { id: "dup", as: PersonV1 },
        );
        return yield* store
          .saveEntity(
            Person,
            { firstName: "B", lastName: "B", email: "b@b.com" },
            { id: "dup", as: PersonV1 },
          )
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
        yield* store.saveEntity(
          Person,
          {
            firstName: "Alice",
            lastName: "Smith",
            email: "alice@example.com",
          },
          { as: PersonV1 },
        );
        return yield* store.loadEntities(Person, {
          filters: [{ field: "email", op: "in", value: [] }],
          as: PersonV1,
        });
      }),
    );

    expect(entities).toEqual([]);
  });

  test("loadEntities with multiple combined filters", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(Person, {
          fullName: "Alice Smith",
          email: "alice@example.com",
          age: 25,
        });
        yield* store.saveEntity(Person, {
          fullName: "Bob Jones",
          email: "bob@example.com",
          age: 30,
        });
        yield* store.saveEntity(Person, {
          fullName: "Charlie Brown",
          email: "charlie@other.com",
          age: 35,
        });

        return yield* store.loadEntities(Person, {
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
        yield* store.saveEntity(
          Person,
          {
            firstName: "Alice",
            lastName: "Smith",
            email: "alice@example.com",
          },
          { as: PersonV1 },
        );
        return yield* store
          .loadEntities(Person, {
            filters: [{ field: "email'; DROP TABLE entities; --", op: "eq", value: "x" }],
            as: PersonV1,
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
        yield* store.saveEntity(
          Person,
          {
            firstName: "Alice",
            lastName: "Smith",
            email: "alice@example.com",
          },
          { as: PersonV1 },
        );
        return yield* store.patchEntities(
          Person,
          { email: "redacted@example.com" },
          { filters: [{ field: "firstName", op: "eq", value: "Nonexistent" }], as: PersonV1 },
        );
      }),
    );

    expect(affected).toBe(0);
  });

  test("updateEntity timestamps are updated", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(
          Person,
          {
            firstName: "Alice",
            lastName: "Smith",
            email: "alice@example.com",
          },
          { as: PersonV1 },
        );

        const updated = yield* store.updateEntity(
          Person,
          saved.id,
          {
            email: "alice2@example.com",
          },
          { as: PersonV1 },
        );

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
    const Simple = defineEntity({ schema: SimpleSchema });

    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(Simple, { value: "hello" });
        return yield* store.loadEntity(Simple, saved.id);
      }),
      { entities: [Simple] },
    );

    expect(entity.data.value).toBe("hello");
  });

  test("store with multiple disconnected schema groups", async () => {
    const TypeASchema = Schema.TaggedStruct("TypeA.v1", { a: Schema.String });
    const TypeBSchema = Schema.TaggedStruct("TypeB.v1", { b: Schema.Number });
    const TypeA = defineEntity({ schema: TypeASchema });
    const TypeB = defineEntity({ schema: TypeBSchema });

    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(TypeA, { a: "hello" });
        yield* store.saveEntity(TypeB, { b: 42 });

        const as = yield* store.loadEntities(TypeA);
        const bs = yield* store.loadEntities(TypeB);

        return { aCount: as.length, bCount: bs.length };
      }),
      { entities: [TypeA, TypeB] },
    );

    expect(result.aCount).toBe(1);
    expect(result.bCount).toBe(1);
  });
});

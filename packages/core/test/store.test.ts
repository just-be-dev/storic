import { test, expect, describe } from "bun:test";
import { Effect, Schema } from "effect";
import { Store } from "../src/index.ts";
import {
  runStore,
  PersonV1,
  PersonV2,
  PersonV1toV2,
  testConfig,
} from "./test-helper.ts";

// ─── Save & Load ────────────────────────────────────────────────────────────

describe("Store: saveEntity & loadEntity", () => {
  test("saveEntity persists and returns entity with data", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
      }),
    );

    expect(entity.id).toBeDefined();
    expect(entity.data).toEqual({
      _tag: "Person.v1",
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
    });
    expect(entity.created_at).toBeGreaterThan(0);
    expect(entity.updated_at).toBeGreaterThan(0);
  });

  test("saveEntity with custom id", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.saveEntity(
          PersonV1,
          {
            firstName: "Bob",
            lastName: "Jones",
            email: "bob@example.com",
          },
          { id: "custom-id" },
        );
      }),
    );

    expect(entity.id).toBe("custom-id");
  });

  test("saveEntity validates data against schema", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store
          .saveEntity(PersonV1, {
            firstName: 42 as any,
            lastName: "Smith",
            email: "alice@example.com",
          })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catchTag("ValidationError", () =>
              Effect.succeed("ValidationError" as const),
            ),
          );
      }),
    );

    expect(tag).toBe("ValidationError");
  });

  test("loadEntity retrieves by id in same schema version", async () => {
    const entity = await runStore(
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

    expect(entity.data.firstName).toBe("Alice");
    expect(entity.data.lastName).toBe("Smith");
  });

  test("loadEntity fails with EntityNotFoundError for unknown id", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.loadEntity(PersonV1, "nonexistent").pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("EntityNotFoundError", () =>
            Effect.succeed("EntityNotFoundError" as const),
          ),
        );
      }),
    );

    expect(tag).toBe("EntityNotFoundError");
  });
});

// ─── Cross-Version Loading ──────────────────────────────────────────────────

describe("Store: cross-version loading with lenses", () => {
  test("loadEntity converts V1 data to V2 via lens", async () => {
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

    expect(entity.data).toEqual({
      _tag: "Person.v2",
      fullName: "Alice Smith",
      email: "alice@example.com",
      age: 0,
    });
  });

  test("loadEntity converts V2 data to V1 via lens", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV2, {
          fullName: "Bob Jones",
          email: "bob@example.com",
          age: 30,
        });
        return yield* store.loadEntity(PersonV1, saved.id);
      }),
    );

    expect(entity.data).toEqual({
      _tag: "Person.v1",
      firstName: "Bob",
      lastName: "Jones",
      email: "bob@example.com",
    });
  });

  test("loadEntity fails with LensPathNotFoundError when no path exists", async () => {
    const UnrelatedSchema = Schema.TaggedStruct("Unrelated.v1", {
      value: Schema.String,
    });

    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        return yield* store.loadEntity(UnrelatedSchema, saved.id).pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("LensPathNotFoundError", () =>
            Effect.succeed("LensPathNotFoundError" as const),
          ),
        );
      }),
      {
        schemas: [PersonV1, PersonV2, UnrelatedSchema],
        lenses: [PersonV1toV2],
      },
    );

    expect(tag).toBe("LensPathNotFoundError");
  });
});

// ─── loadEntities (Multi-Version) ───────────────────────────────────────────

describe("Store: loadEntities (multi-version queries)", () => {
  test("loadEntities returns entities of the same version", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        yield* store.saveEntity(PersonV1, {
          firstName: "Bob",
          lastName: "Jones",
          email: "bob@example.com",
        });
        return yield* store.loadEntities(PersonV1);
      }),
    );

    expect(entities).toHaveLength(2);
    expect(entities.every((e) => e.data._tag === "Person.v1")).toBe(true);
  });

  test("loadEntities(PersonV2) includes V1 entities converted via lens", async () => {
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
    // All entities should be projected to V2 format
    expect(entities.every((e) => e.data._tag === "Person.v2")).toBe(true);

    const names = entities.map((e) => e.data.fullName).sort();
    expect(names).toEqual(["Alice Smith", "Bob Jones"]);
  });

  test("loadEntities(PersonV1) includes V2 entities converted via lens", async () => {
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
        return yield* store.loadEntities(PersonV1);
      }),
    );

    expect(entities).toHaveLength(2);
    expect(entities.every((e) => e.data._tag === "Person.v1")).toBe(true);

    const firstNames = entities.map((e) => e.data.firstName).sort();
    expect(firstNames).toEqual(["Alice", "Bob"]);
  });

  test("loadEntities with no lenses returns only matching type", async () => {
    const IsolatedSchema = Schema.TaggedStruct("Isolated.v1", {
      value: Schema.String,
    });

    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        yield* store.saveEntity(IsolatedSchema, {
          value: "test",
        });
        return yield* store.loadEntities(IsolatedSchema);
      }),
      {
        schemas: [PersonV1, PersonV2, IsolatedSchema],
        lenses: [PersonV1toV2],
      },
    );

    expect(entities).toHaveLength(1);
    expect(entities[0].data.value).toBe("test");
  });
});

// ─── Update ─────────────────────────────────────────────────────────────────

describe("Store: updateEntity", () => {
  test("updateEntity with merge mode", async () => {
    const updated = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        return yield* store.updateEntity(PersonV1, saved.id, {
          email: "alice2@example.com",
        });
      }),
    );

    expect(updated.data.firstName).toBe("Alice");
    expect(updated.data.email).toBe("alice2@example.com");
  });

  test("updateEntity with replace mode", async () => {
    const updated = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV2, {
          fullName: "Alice Smith",
          email: "alice@example.com",
          age: 25,
        });
        return yield* store.updateEntity(
          PersonV2,
          saved.id,
          {
            fullName: "Alice Johnson",
            email: "alice@example.com",
            age: 26,
          },
          { mode: "replace" },
        );
      }),
    );

    expect(updated.data.fullName).toBe("Alice Johnson");
    expect(updated.data.age).toBe(26);
  });

  test("updateEntity fails for nonexistent entity", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store
          .updateEntity(PersonV1, "nonexistent", { email: "new@test.com" })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catchTag("EntityNotFoundError", () =>
              Effect.succeed("EntityNotFoundError" as const),
            ),
          );
      }),
    );

    expect(tag).toBe("EntityNotFoundError");
  });
});

// ─── Delete ─────────────────────────────────────────────────────────────────

describe("Store: deleteEntity", () => {
  test("deleteEntity removes entity", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        yield* store.deleteEntity(saved.id);
        return yield* store.loadEntity(PersonV1, saved.id).pipe(
          Effect.map(() => "found" as const),
          Effect.catchTag("EntityNotFoundError", () =>
            Effect.succeed("EntityNotFoundError" as const),
          ),
        );
      }),
    );

    expect(tag).toBe("EntityNotFoundError");
  });
});

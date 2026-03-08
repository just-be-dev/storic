import { test, expect, describe } from "bun:test";
import { Effect } from "effect";
import { Store, hashDef } from "../src/index.ts";
import { runStore } from "./test-helper.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const userV1Def = `S.Struct({ firstName: S.String, lastName: S.String, email: S.String })`;
const userV2Def = `S.Struct({ fullName: S.String, email: S.String })`;

const v1ToV2Forward = `(data) => ({
  fullName: data.firstName + ' ' + data.lastName,
  email: data.email
})`;
const v1ToV2Backward = `(data) => ({
  firstName: data.fullName.split(' ')[0],
  lastName: data.fullName.split(' ').slice(1).join(' '),
  email: data.email
})`;

// ─── Schema Operations ──────────────────────────────────────────────────────

describe("Store: schema operations", () => {
  test("registerSchema returns schema with deterministic id", async () => {
    const schema = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.registerSchema("User", userV1Def);
      }),
    );

    expect(schema.name).toBe("User");
    expect(schema.def).toBe(userV1Def);
    expect(schema.id).toBe(hashDef(userV1Def));
  });

  test("registerSchema is idempotent (same def = same schema)", async () => {
    const [s1, s2] = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const a = yield* store.registerSchema("User", userV1Def);
        const b = yield* store.registerSchema("User", userV1Def);
        return [a, b] as const;
      }),
    );

    expect(s1.id).toBe(s2.id);
  });

  test("getSchema retrieves a registered schema", async () => {
    const schema = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const registered = yield* store.registerSchema("User", userV1Def);
        return yield* store.getSchema(registered.id);
      }),
    );

    expect(schema.name).toBe("User");
    expect(schema.def).toBe(userV1Def);
  });

  test("getSchema fails with SchemaNotFoundError for unknown id", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.getSchema("nonexistent").pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("SchemaNotFoundError", () =>
            Effect.succeed("SchemaNotFoundError" as const),
          ),
        );
      }),
    );

    expect(tag).toBe("SchemaNotFoundError");
  });

  test("listSchemas returns all registered schemas", async () => {
    const schemas = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.registerSchema("User", userV1Def);
        yield* store.registerSchema("User", userV2Def);
        return yield* store.listSchemas();
      }),
    );

    expect(schemas).toHaveLength(2);
  });
});

// ─── Entity CRUD ────────────────────────────────────────────────────────────

describe("Store: entity CRUD", () => {
  test("createEntity stores and returns entity with data", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const schema = yield* store.registerSchema("User", userV1Def);
        return yield* store.createEntity(schema.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@test.com",
        });
      }),
    );

    expect(entity.data).toEqual({
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@test.com",
    });
    expect(entity.id).toBeDefined();
    expect(entity.created_at).toBeGreaterThan(0);
  });

  test("createEntity with custom id", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const schema = yield* store.registerSchema("User", userV1Def);
        return yield* store.createEntity(
          schema.id,
          { firstName: "Alice", lastName: "Smith", email: "a@b.com" },
          { id: "custom-id-123" },
        );
      }),
    );

    expect(entity.id).toBe("custom-id-123");
  });

  test("createEntity validates data by default", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const schema = yield* store.registerSchema("User", userV1Def);
        return yield* store.createEntity(schema.id, { bad: "data" }).pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("ValidationError", () =>
            Effect.succeed("ValidationError" as const),
          ),
        );
      }),
    );

    expect(tag).toBe("ValidationError");
  });

  test("createEntity skips validation when validate=false", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const schema = yield* store.registerSchema("User", userV1Def);
        return yield* store.createEntity(
          schema.id,
          { anything: "goes" },
          { validate: false },
        );
      }),
    );

    expect(entity.data).toEqual({ anything: "goes" });
  });

  test("createEntity fails with SchemaNotFoundError for unknown schema", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store
          .createEntity("nonexistent", { foo: "bar" })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catchTag("SchemaNotFoundError", () =>
              Effect.succeed("SchemaNotFoundError" as const),
            ),
          );
      }),
    );

    expect(tag).toBe("SchemaNotFoundError");
  });

  test("getEntity retrieves a stored entity", async () => {
    const [created, fetched] = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const schema = yield* store.registerSchema("User", userV1Def);
        const c = yield* store.createEntity(schema.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "a@b.com",
        });
        const f = yield* store.getEntity(c.id);
        return [c, f] as const;
      }),
    );

    expect(fetched.id).toBe(created.id);
    expect(fetched.data).toEqual(created.data);
  });

  test("getEntity fails with EntityNotFoundError for unknown id", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.getEntity("nonexistent").pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("EntityNotFoundError", () =>
            Effect.succeed("EntityNotFoundError" as const),
          ),
        );
      }),
    );

    expect(tag).toBe("EntityNotFoundError");
  });

  test("updateEntity with merge mode (default)", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const schema = yield* store.registerSchema("User", userV1Def);
        const created = yield* store.createEntity(schema.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "old@test.com",
        });
        return yield* store.updateEntity(created.id, {
          email: "new@test.com",
        });
      }),
    );

    expect(entity.data).toEqual({
      firstName: "Alice",
      lastName: "Smith",
      email: "new@test.com",
    });
  });

  test("updateEntity with replace mode", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const schema = yield* store.registerSchema("User", userV1Def);
        const created = yield* store.createEntity(schema.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "a@b.com",
        });
        return yield* store.updateEntity(
          created.id,
          { firstName: "Bob", lastName: "Jones", email: "bob@test.com" },
          { mode: "replace" },
        );
      }),
    );

    expect(entity.data).toEqual({
      firstName: "Bob",
      lastName: "Jones",
      email: "bob@test.com",
    });
  });

  test("updateEntity validates merged data by default", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const schema = yield* store.registerSchema("User", userV1Def);
        const created = yield* store.createEntity(schema.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "a@b.com",
        });
        // Merge in a field with wrong type
        return yield* store
          .updateEntity(created.id, { firstName: 42 as any })
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

  test("updateEntity fails with EntityNotFoundError for unknown id", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store
          .updateEntity("nonexistent", { foo: "bar" })
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

  test("deleteEntity removes the entity", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const schema = yield* store.registerSchema("User", userV1Def);
        const entity = yield* store.createEntity(schema.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "a@b.com",
        });
        yield* store.deleteEntity(entity.id);
        return yield* store.getEntity(entity.id).pipe(
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

// ─── Lens Registration & Projection ─────────────────────────────────────────

describe("Store: lens registration and projection", () => {
  test("registerLens creates a lens between two schemas", async () => {
    const lens = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        const v2 = yield* store.registerSchema("User", userV2Def);
        return yield* store.registerLens({
          from: v1.id,
          to: v2.id,
          forward: v1ToV2Forward,
          backward: v1ToV2Backward,
        });
      }),
    );

    expect(lens.id).toBeDefined();
    expect(lens.forward).toBe(v1ToV2Forward);
    expect(lens.backward).toBe(v1ToV2Backward);
  });

  test("registerLens is idempotent (same from/to returns existing)", async () => {
    const [l1, l2] = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        const v2 = yield* store.registerSchema("User", userV2Def);
        const opts = {
          from: v1.id,
          to: v2.id,
          forward: v1ToV2Forward,
          backward: v1ToV2Backward,
        };
        const a = yield* store.registerLens(opts);
        const b = yield* store.registerLens(opts);
        return [a, b] as const;
      }),
    );

    expect(l1.id).toBe(l2.id);
  });

  test("getLens retrieves a registered lens", async () => {
    const lens = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        const v2 = yield* store.registerSchema("User", userV2Def);
        const registered = yield* store.registerLens({
          from: v1.id,
          to: v2.id,
          forward: v1ToV2Forward,
          backward: v1ToV2Backward,
        });
        return yield* store.getLens(registered.id);
      }),
    );

    expect(lens).toBeDefined();
    expect(lens!.forward).toBe(v1ToV2Forward);
  });

  test("getLens returns undefined for unknown id", async () => {
    const lens = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.getLens("nonexistent");
      }),
    );

    expect(lens).toBeUndefined();
  });

  test("listLenses returns all registered lenses", async () => {
    const lenses = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        const v2 = yield* store.registerSchema("User", userV2Def);
        yield* store.registerLens({
          from: v1.id,
          to: v2.id,
          forward: v1ToV2Forward,
          backward: v1ToV2Backward,
        });
        return yield* store.listLenses();
      }),
    );

    expect(lenses).toHaveLength(1);
  });

  test("getEntity projects V1 entity as V2 via lens", async () => {
    const projected = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        const v2 = yield* store.registerSchema("User", userV2Def);
        yield* store.registerLens({
          from: v1.id,
          to: v2.id,
          forward: v1ToV2Forward,
          backward: v1ToV2Backward,
        });

        const alice = yield* store.createEntity(v1.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@test.com",
        });

        return yield* store.getEntity(alice.id, { as: v2.id });
      }),
    );

    expect(projected.data).toEqual({
      fullName: "Alice Smith",
      email: "alice@test.com",
    });
  });

  test("getEntity projects V2 entity as V1 via backward lens", async () => {
    const projected = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        const v2 = yield* store.registerSchema("User", userV2Def);
        yield* store.registerLens({
          from: v1.id,
          to: v2.id,
          forward: v1ToV2Forward,
          backward: v1ToV2Backward,
        });

        const bob = yield* store.createEntity(v2.id, {
          fullName: "Bob Jones",
          email: "bob@test.com",
        });

        return yield* store.getEntity(bob.id, { as: v1.id });
      }),
    );

    expect(projected.data).toEqual({
      firstName: "Bob",
      lastName: "Jones",
      email: "bob@test.com",
    });
  });

  test("getEntity with same schema as stored returns data unchanged", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        const created = yield* store.createEntity(v1.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "a@b.com",
        });
        return yield* store.getEntity(created.id, { as: v1.id });
      }),
    );

    expect(entity.data).toEqual({
      firstName: "Alice",
      lastName: "Smith",
      email: "a@b.com",
    });
  });

  test("getEntity fails with LensPathNotFoundError when no lens exists", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        const v2 = yield* store.registerSchema("User", userV2Def);
        // No lens registered between v1 and v2

        const entity = yield* store.createEntity(v1.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "a@b.com",
        });

        return yield* store.getEntity(entity.id, { as: v2.id }).pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("LensPathNotFoundError", () =>
            Effect.succeed("LensPathNotFoundError" as const),
          ),
        );
      }),
    );

    expect(tag).toBe("LensPathNotFoundError");
  });
});

// ─── Cross-schema Listing ───────────────────────────────────────────────────

describe("Store: cross-schema listing", () => {
  test("listEntities returns entities from same schema", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        yield* store.createEntity(v1.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "a@b.com",
        });
        yield* store.createEntity(v1.id, {
          firstName: "Bob",
          lastName: "Jones",
          email: "b@b.com",
        });
        return yield* store.listEntities(v1.id);
      }),
    );

    expect(entities).toHaveLength(2);
  });

  test("listEntities gathers entities from all reachable schemas and projects them", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        const v2 = yield* store.registerSchema("User", userV2Def);
        yield* store.registerLens({
          from: v1.id,
          to: v2.id,
          forward: v1ToV2Forward,
          backward: v1ToV2Backward,
        });

        // Create one entity in each schema version
        yield* store.createEntity(v1.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@test.com",
        });
        yield* store.createEntity(v2.id, {
          fullName: "Bob Jones",
          email: "bob@test.com",
        });

        // List all as V2 — both should appear projected into V2 shape
        return yield* store.listEntities(v2.id, { as: v2.id });
      }),
    );

    expect(entities).toHaveLength(2);
    // Both should have V2 shape
    for (const e of entities) {
      expect(e.data).toHaveProperty("fullName");
      expect(e.data).toHaveProperty("email");
    }
  });

  test("listEntities projects all entities into V1 when requested", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        const v2 = yield* store.registerSchema("User", userV2Def);
        yield* store.registerLens({
          from: v1.id,
          to: v2.id,
          forward: v1ToV2Forward,
          backward: v1ToV2Backward,
        });

        yield* store.createEntity(v1.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@test.com",
        });
        yield* store.createEntity(v2.id, {
          fullName: "Bob Jones",
          email: "bob@test.com",
        });

        // List all as V1
        return yield* store.listEntities(v1.id, { as: v1.id });
      }),
    );

    expect(entities).toHaveLength(2);
    for (const e of entities) {
      expect(e.data).toHaveProperty("firstName");
      expect(e.data).toHaveProperty("lastName");
      expect(e.data).toHaveProperty("email");
    }
  });

  test("listEntities with no opts.as defaults to schemaId for projection target", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        const v2 = yield* store.registerSchema("User", userV2Def);
        yield* store.registerLens({
          from: v1.id,
          to: v2.id,
          forward: v1ToV2Forward,
          backward: v1ToV2Backward,
        });

        yield* store.createEntity(v1.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@test.com",
        });
        yield* store.createEntity(v2.id, {
          fullName: "Bob Jones",
          email: "bob@test.com",
        });

        // No opts.as — should project to v2.id (the schemaId argument)
        return yield* store.listEntities(v2.id);
      }),
    );

    expect(entities).toHaveLength(2);
    for (const e of entities) {
      expect(e.data).toHaveProperty("fullName");
      expect(e.data).toHaveProperty("email");
    }
  });

  test("listEntities returns empty array when no entities exist", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        return yield* store.listEntities(v1.id);
      }),
    );

    expect(entities).toEqual([]);
  });
});

// ─── Multi-hop Lens Projection ──────────────────────────────────────────────

describe("Store: multi-hop lens projection", () => {
  const userV3Def = `S.Struct({ displayName: S.String, contactEmail: S.String })`;

  test("projects through a two-hop lens chain (V1 -> V2 -> V3)", async () => {
    const projected = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const v1 = yield* store.registerSchema("User", userV1Def);
        const v2 = yield* store.registerSchema("User", userV2Def);
        const v3 = yield* store.registerSchema("User", userV3Def);

        // V1 <-> V2
        yield* store.registerLens({
          from: v1.id,
          to: v2.id,
          forward: v1ToV2Forward,
          backward: v1ToV2Backward,
        });

        // V2 <-> V3
        yield* store.registerLens({
          from: v2.id,
          to: v3.id,
          forward: `(data) => ({ displayName: data.fullName, contactEmail: data.email })`,
          backward: `(data) => ({ fullName: data.displayName, email: data.contactEmail })`,
        });

        // Create entity as V1
        const alice = yield* store.createEntity(v1.id, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@test.com",
        });

        // Read as V3 (two hops: V1 -> V2 -> V3)
        return yield* store.getEntity(alice.id, { as: v3.id });
      }),
    );

    expect(projected.data).toEqual({
      displayName: "Alice Smith",
      contactEmail: "alice@test.com",
    });
  });
});

// ─── Index Operations ───────────────────────────────────────────────────────

describe("Store: index operations", () => {
  test("createIndex and listIndexes", async () => {
    const indexes = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.registerSchema("User", userV1Def);
        yield* store.createIndex("idx_email", "$.email");
        return yield* store.listIndexes();
      }),
    );

    expect(indexes).toContain("idx_email");
  });

  test("dropIndex removes the index", async () => {
    const indexes = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.registerSchema("User", userV1Def);
        yield* store.createIndex("idx_email", "$.email");
        yield* store.dropIndex("idx_email");
        return yield* store.listIndexes();
      }),
    );

    expect(indexes).not.toContain("idx_email");
  });

  test("createIndex is idempotent (IF NOT EXISTS)", async () => {
    await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.registerSchema("User", userV1Def);
        yield* store.createIndex("idx_email", "$.email");
        yield* store.createIndex("idx_email", "$.email");
        // No error = success
      }),
    );
  });
});

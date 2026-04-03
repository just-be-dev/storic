import { test, expect, describe } from "bun:test";
import { Effect, Schema } from "effect";
import { Store, defineLens } from "../src/index.ts";
import type { StoreConfig } from "../src/index.ts";
import { runStore, PersonV1, PersonV2 } from "./test-helper.ts";

// ─── Lens output validation ────────────────────────────────────────────────

describe("Store: lens output validation", () => {
  test("loadEntity validates lens output against target schema", async () => {
    // Create a broken lens that produces invalid output (missing required field)
    const BrokenV1 = Schema.TaggedStruct("Broken.v1", {
      name: Schema.String,
    });

    const BrokenV2 = Schema.TaggedStruct("Broken.v2", {
      name: Schema.String,
      required_field: Schema.String,
    });

    const brokenLens = defineLens(BrokenV1, BrokenV2, {
      decode: (v1) =>
        ({
          name: v1.name,
          // Deliberately missing required_field
        }) as any,
      encode: (v2) => ({
        name: v2.name,
      }),
    });

    const config: StoreConfig = {
      schemas: [BrokenV1, BrokenV2],
      lenses: [brokenLens],
    };

    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(BrokenV1, { name: "test" });
        return yield* store.loadEntity(BrokenV2, saved.id).pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("ValidationError", () => Effect.succeed("ValidationError" as const)),
        );
      }),
      config,
    );

    expect(tag).toBe("ValidationError");
  });

  test("loadEntities validates lens output against target schema", async () => {
    const BrokenV1 = Schema.TaggedStruct("BrokenMulti.v1", {
      name: Schema.String,
    });

    const BrokenV2 = Schema.TaggedStruct("BrokenMulti.v2", {
      name: Schema.String,
      required_field: Schema.String,
    });

    const brokenLens = defineLens(BrokenV1, BrokenV2, {
      decode: (v1) =>
        ({
          name: v1.name,
          // Missing required_field
        }) as any,
      encode: (v2) => ({
        name: v2.name,
      }),
    });

    const config: StoreConfig = {
      schemas: [BrokenV1, BrokenV2],
      lenses: [brokenLens],
    };

    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(BrokenV1, { name: "test" });
        return yield* store.loadEntities(BrokenV2).pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("ValidationError", () => Effect.succeed("ValidationError" as const)),
        );
      }),
      config,
    );

    expect(tag).toBe("ValidationError");
  });

  test("loadEntity skips validation when stored type matches target (no lens)", async () => {
    // Same-type load should not re-validate (data was validated on save)
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
  });

  test("loadEntity validates correctly with valid lens output", async () => {
    // Normal lens should pass validation
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

    expect(entity.data._tag).toBe("Person.v2");
    expect(entity.data.fullName).toBe("Alice Smith");
  });
});

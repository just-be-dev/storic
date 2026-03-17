import { test, expect, describe } from "bun:test";
import { Effect } from "effect";
import { Store } from "../src/index.ts";
import { runStore, PersonV1, PersonV2 } from "./test-helper.ts";

// ─── Cross-version update ───────────────────────────────────────────────────

describe("Store: cross-version updateEntity", () => {
  test("updating via a different schema version migrates the stored type", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        // Save as V1
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });

        // Update via V2 — should project V1→V2, apply update, store as V2
        const updated = yield* store.updateEntity(PersonV2, saved.id, {
          age: 30,
        });

        // Reload as V2 — should now be natively V2 (no lens needed)
        const reloaded = yield* store.loadEntity(PersonV2, saved.id);

        return { updated: updated.data, reloaded: reloaded.data };
      }),
    );

    // The update should have projected V1→V2, merged age, and stored as V2
    expect(result.updated._tag).toBe("Person.v2");
    expect(result.updated.fullName).toBe("Alice Smith");
    expect(result.updated.age).toBe(30);
    expect(result.reloaded).toEqual(result.updated);
  });

  test("updating V2 entity via V1 migrates to V1", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        const saved = yield* store.saveEntity(PersonV2, {
          fullName: "Bob Jones",
          email: "bob@example.com",
          age: 25,
        });

        // Update via V1 — projects V2→V1, applies update, stores as V1
        const updated = yield* store.updateEntity(PersonV1, saved.id, {
          email: "bob2@example.com",
        });

        return updated.data;
      }),
    );

    expect(result._tag).toBe("Person.v1");
    expect(result.firstName).toBe("Bob");
    expect(result.email).toBe("bob2@example.com");
  });

  test("updateEntity with replace mode validates all required fields", async () => {
    const tag = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        const saved = yield* store.saveEntity(PersonV2, {
          fullName: "Alice Smith",
          email: "alice@example.com",
          age: 25,
        });

        // Replace mode with incomplete data should fail validation
        return yield* store
          .updateEntity(PersonV2, saved.id, { fullName: "Alice Johnson" } as any, {
            mode: "replace",
          })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catchTag("ValidationError", () => Effect.succeed("ValidationError" as const)),
          );
      }),
    );

    expect(tag).toBe("ValidationError");
  });

  test("updateEntity with merge mode preserves unspecified fields", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        const saved = yield* store.saveEntity(PersonV2, {
          fullName: "Alice Smith",
          email: "alice@example.com",
          age: 25,
        });

        const updated = yield* store.updateEntity(PersonV2, saved.id, {
          age: 26,
        });

        return updated.data;
      }),
    );

    expect(result.fullName).toBe("Alice Smith");
    expect(result.email).toBe("alice@example.com");
    expect(result.age).toBe(26);
  });
});

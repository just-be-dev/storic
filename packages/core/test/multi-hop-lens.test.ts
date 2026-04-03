import { test, expect, describe } from "bun:test";
import { Effect, Schema } from "effect";
import { Store, defineLens } from "../src/index.ts";
import type { StoreConfig } from "../src/index.ts";
import { runStore } from "./test-helper.ts";

// ─── Three-version schema chain ────────────────────────────────────────────

const PersonV1 = Schema.TaggedStruct("MultiPerson.v1", {
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
});

const PersonV2 = Schema.TaggedStruct("MultiPerson.v2", {
  fullName: Schema.String,
  email: Schema.String,
});

const PersonV3 = Schema.TaggedStruct("MultiPerson.v3", {
  fullName: Schema.String,
  email: Schema.String,
  verified: Schema.Boolean,
});

const v1tov2 = defineLens(PersonV1, PersonV2, {
  decode: (v1) => ({
    fullName: `${v1.firstName} ${v1.lastName}`,
    email: v1.email,
  }),
  encode: (v2) => ({
    firstName: v2.fullName.split(" ")[0],
    lastName: v2.fullName.split(" ").slice(1).join(" "),
    email: v2.email,
  }),
});

const v2tov3 = defineLens(PersonV2, PersonV3, {
  decode: (v2) => ({
    fullName: v2.fullName,
    email: v2.email,
    verified: false,
  }),
  encode: (v3) => ({
    fullName: v3.fullName,
    email: v3.email,
  }),
});

const multiConfig: StoreConfig = {
  schemas: [PersonV1, PersonV2, PersonV3],
  lenses: [v1tov2, v2tov3],
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Store: multi-hop lens transformations", () => {
  test("loadEntity transforms V1 → V3 via two hops", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        return yield* store.loadEntity(PersonV3, saved.id);
      }),
      multiConfig,
    );

    expect(entity.data).toEqual({
      _tag: "MultiPerson.v3",
      fullName: "Alice Smith",
      email: "alice@example.com",
      verified: false,
    });
  });

  test("loadEntity transforms V3 → V1 via two hops backward", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV3, {
          fullName: "Bob Jones",
          email: "bob@example.com",
          verified: true,
        });
        return yield* store.loadEntity(PersonV1, saved.id);
      }),
      multiConfig,
    );

    expect(entity.data).toEqual({
      _tag: "MultiPerson.v1",
      firstName: "Bob",
      lastName: "Jones",
      email: "bob@example.com",
    });
  });

  test("loadEntities gathers all three versions projected to V3", async () => {
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
        });
        yield* store.saveEntity(PersonV3, {
          fullName: "Charlie Brown",
          email: "charlie@example.com",
          verified: true,
        });
        return yield* store.loadEntities(PersonV3);
      }),
      multiConfig,
    );

    expect(entities).toHaveLength(3);
    expect(entities.every((e) => e.data._tag === "MultiPerson.v3")).toBe(true);

    const names = entities.map((e) => e.data.fullName).sort();
    expect(names).toEqual(["Alice Smith", "Bob Jones", "Charlie Brown"]);
  });

  test("loadEntities projected to V1 gathers all three versions", async () => {
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
        });
        yield* store.saveEntity(PersonV3, {
          fullName: "Charlie Brown",
          email: "charlie@example.com",
          verified: true,
        });
        return yield* store.loadEntities(PersonV1);
      }),
      multiConfig,
    );

    expect(entities).toHaveLength(3);
    expect(entities.every((e) => e.data._tag === "MultiPerson.v1")).toBe(true);
  });

  test("patchEntities patches shared fields across all three versions", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const a = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        const b = yield* store.saveEntity(PersonV2, {
          fullName: "Bob Jones",
          email: "bob@example.com",
        });
        const c = yield* store.saveEntity(PersonV3, {
          fullName: "Charlie Brown",
          email: "charlie@example.com",
          verified: true,
        });

        // email exists in all three versions
        const affected = yield* store.patchEntities(PersonV3, {
          email: "redacted@example.com",
        });

        const ar = yield* store.loadEntity(PersonV1, a.id);
        const br = yield* store.loadEntity(PersonV2, b.id);
        const cr = yield* store.loadEntity(PersonV3, c.id);

        return {
          affected,
          aEmail: ar.data.email,
          bEmail: br.data.email,
          cEmail: cr.data.email,
        };
      }),
      multiConfig,
    );

    expect(result.affected).toBe(3);
    expect(result.aEmail).toBe("redacted@example.com");
    expect(result.bEmail).toBe("redacted@example.com");
    expect(result.cEmail).toBe("redacted@example.com");
  });
});

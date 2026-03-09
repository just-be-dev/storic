import { Console, Effect, Layer, Schema } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import { layer as sqliteLayer } from "@effect/sql-sqlite-bun/SqliteClient";
import { Store, defineLens } from "../packages/core/src/index.ts";

// ─── Schema definitions ───────────────────────────────────────────────────────

const PersonV1 = Schema.TaggedStruct("Person.v1", {
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String.annotate({ index: true }),
});

const PersonV2 = Schema.TaggedStruct("Person.v2", {
  fullName: Schema.String,
  email: Schema.String.annotate({ index: true }),
  age: Schema.optional(Schema.Number),
});

type PersonV1 = typeof PersonV1.Type;
type PersonV2 = typeof PersonV2.Type;

// ─── Lens definition ──────────────────────────────────────────────────────────

const PersonV1toV2 = defineLens(PersonV1, PersonV2, {
  decode: (v1) => ({
    _tag: "Person.v2" as const,
    fullName: `${v1.firstName} ${v1.lastName}`,
    email: v1.email,
  }),
  encode: (v2) => ({
    _tag: "Person.v1" as const,
    firstName: v2.fullName.split(" ")[0],
    lastName: v2.fullName.split(" ").slice(1).join(" "),
    email: v2.email,
  }),
});

// ─── Layer setup ──────────────────────────────────────────────────────────────

const SqlLive = sqliteLayer({ filename: ":memory:" });
const StoreLive = Store.layer({
  schemas: [PersonV1, PersonV2],
  lenses: [PersonV1toV2],
}).pipe(Layer.provide(SqlLive));

// ─── Main program ─────────────────────────────────────────────────────────────

const program = Effect.gen(function* () {
  const store = yield* Store;

  // ── 1. Save entities under different schema versions ─────────────────
  const alice = yield* store.saveEntity(PersonV1, {
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@example.com",
  });

  const bob = yield* store.saveEntity(PersonV2, {
    fullName: "Bob Jones",
    email: "bob@example.com",
    age: 30,
  });

  yield* Console.log("Saved Alice (V1):", alice.data);
  yield* Console.log("Saved Bob   (V2):", bob.data);

  // ── 2. Load individual entities with lens projection ─────────────────
  const aliceAsV2 = yield* store.loadEntity(PersonV2, alice.id);
  yield* Console.log("\nAlice loaded as V2:", aliceAsV2.data);

  const bobAsV1 = yield* store.loadEntity(PersonV1, bob.id);
  yield* Console.log("Bob   loaded as V1:", bobAsV1.data);

  // ── 3. Load ALL entities as V2 (V1 entries auto-converted) ───────────
  const allAsV2 = yield* store.loadEntities(PersonV2);
  yield* Console.log("\nAll persons as V2:");
  for (const e of allAsV2) {
    yield* Console.log(" ", e.data);
  }

  // ── 4. Load ALL entities as V1 (V2 entries auto-converted) ───────────
  const allAsV1 = yield* store.loadEntities(PersonV1);
  yield* Console.log("\nAll persons as V1:");
  for (const e of allAsV1) {
    yield* Console.log(" ", e.data);
  }

  // ── 5. Update with merge mode ────────────────────────────────────────
  yield* store.updateEntity(PersonV1, alice.id, {
    email: "alice2@example.com",
  });
  const aliceUpdated = yield* store.loadEntity(PersonV1, alice.id);
  yield* Console.log("\nAlice after merge update:", aliceUpdated.data);

  // ── 6. Delete ────────────────────────────────────────────────────────
  yield* store.deleteEntity(bob.id);
  const remaining = yield* store.loadEntities(PersonV2);
  yield* Console.log("\nRemaining after deleting Bob:", remaining.length, "entity");

  yield* Console.log("\nDone.");
});

// ─── Run ──────────────────────────────────────────────────────────────────────

const main = Effect.provide(program, StoreLive);
BunRuntime.runMain(main);

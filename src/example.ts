import { Console, Effect, Layer } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import { layer as sqliteLayer } from "@effect/sql-sqlite-bun/SqliteClient";
import { Store } from "./index.ts";

// ─── Layer setup ──────────────────────────────────────────────────────────────

const SqlLive = sqliteLayer({ filename: ":memory:" });
const StoreLive = Store.layer.pipe(Layer.provide(SqlLive));

// ─── Main program ─────────────────────────────────────────────────────────────

const program = Effect.gen(function* () {
  const store = yield* Store;

  // ── 1. Register schemas (id = SHA256 of def) ───────────────────────────
  const userV1 = yield* store.registerSchema(
    "User",
    `S.Struct({ firstName: S.String, lastName: S.String, email: S.String })`
  );

  const userV2 = yield* store.registerSchema(
    "User",
    `S.Struct({ fullName: S.String, email: S.String })`
  );

  yield* Console.log("V1:", userV1.id.slice(0, 12), "…");
  yield* Console.log("V2:", userV2.id.slice(0, 12), "…");

  // ── 2. Register lens V1 ↔ V2 ──────────────────────────────────────────
  yield* store.registerLens({
    from: userV1.id,
    to: userV2.id,
    forward: `(data) => ({
      fullName: data.firstName + ' ' + data.lastName,
      email: data.email
    })`,
    backward: `(data) => ({
      firstName: data.fullName.split(' ')[0],
      lastName: data.fullName.split(' ').slice(1).join(' '),
      email: data.email
    })`,
  });

  // ── 3. Create entities under different schema versions ─────────────────
  const alice = yield* store.createEntity(userV1.id, {
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@example.com",
  });

  const bob = yield* store.createEntity(userV2.id, {
    fullName: "Bob Jones",
    email: "bob@example.com",
  });

  // ── 4. Read with lens projection ──────────────────────────────────────
  const aliceAsV2 = yield* store.getEntity(alice.id, { as: userV2.id });
  yield* Console.log("\nAlice as V2:", aliceAsV2.data);

  const bobAsV1 = yield* store.getEntity(bob.id, { as: userV1.id });
  yield* Console.log("Bob   as V1:", bobAsV1.data);

  // ── 5. List all "User" entities regardless of storage schema ──────────
  const allAsV2 = yield* store.listEntities(userV2.id, { as: userV2.id });
  yield* Console.log("\nAll users as V2:");
  for (const e of allAsV2) {
    yield* Console.log(" ", e.data);
  }

  // ── 6. Merge update ───────────────────────────────────────────────────
  yield* store.updateEntity(
    alice.id,
    { email: "alice2@example.com" },
    { mode: "merge" }
  );
  const aliceUpdated = yield* store.getEntity(alice.id);
  yield* Console.log("\nAlice after merge update:", aliceUpdated.data);

  // ── 7. Add expression index ───────────────────────────────────────────
  yield* store.createIndex("idx_email", "$.email");
  const indexes = yield* store.listIndexes();
  yield* Console.log("\nIndexes on entities:", indexes);

  yield* Console.log("\nDone.");
});

// ─── Run ──────────────────────────────────────────────────────────────────────

const main = Effect.provide(program, StoreLive);
BunRuntime.runMain(main);

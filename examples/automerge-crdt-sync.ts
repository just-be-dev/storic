import * as A from "@automerge/automerge";
import { Console, Effect, Layer, Ref, Schema } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import { Store, defineLens } from "../packages/core/src/index.ts";
import {
  AutomergeDocs,
  AutomergePersistence,
  saveState,
  type EntityDoc,
} from "../packages/automerge/src/index.ts";

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
    fullName: `${v1.firstName} ${v1.lastName}`,
    email: v1.email,
  }),
  encode: (v2) => ({
    firstName: v2.fullName.split(" ")[0],
    lastName: v2.fullName.split(" ").slice(1).join(" "),
    email: v2.email,
  }),
});

// ─── Layer setup ──────────────────────────────────────────────────────────────

const PersistenceLive = AutomergePersistence.layer();
const StoreLive = Store.layer({
  schemas: [PersonV1, PersonV2],
  lenses: [PersonV1toV2],
}).pipe(Layer.provide(PersistenceLive));

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

  // ── 7. CRDT sync: save, fork, merge ──────────────────────────────────
  yield* Console.log("\n--- CRDT Sync Demo ---");

  // Save a snapshot of the current state
  const snapshot = yield* saveState;
  yield* Console.log("Saved snapshot:", snapshot.entities.length, "entity docs");

  // Simulate a second peer loading the snapshot and making changes
  const peerLayer = Layer.mergeAll(
    Store.layer({ schemas: [PersonV1, PersonV2], lenses: [PersonV1toV2] }).pipe(
      Layer.provide(AutomergePersistence.fromSaved(snapshot)),
    ),
    AutomergePersistence.fromSaved(snapshot),
  );

  const peerState = yield* Effect.gen(function* () {
    const peerStore = yield* Store;
    yield* peerStore.saveEntity(PersonV2, {
      fullName: "Carol White",
      email: "carol@example.com",
      age: 28,
    });
    return yield* saveState;
  }).pipe(Effect.provide(peerLayer));

  // Merge peer's entity docs into ours
  const { entities } = yield* AutomergeDocs;
  const entityMap = yield* Ref.get(entities);
  for (const [id, bytes] of peerState.entities) {
    const peerDoc = A.load<EntityDoc>(bytes);
    const localDoc = entityMap.get(id);
    entityMap.set(id, localDoc ? A.merge(localDoc, peerDoc) : peerDoc);
  }
  yield* Ref.set(entities, entityMap);

  const afterMerge = yield* store.loadEntities(PersonV2);
  yield* Console.log("After merging peer's changes:", afterMerge.length, "entities");
  for (const e of afterMerge) {
    yield* Console.log(" ", e.data);
  }

  yield* Console.log("\nDone.");
});

// ─── Run ──────────────────────────────────────────────────────────────────────

const main = Effect.provide(program, Layer.mergeAll(StoreLive, PersistenceLive));
BunRuntime.runMain(main);

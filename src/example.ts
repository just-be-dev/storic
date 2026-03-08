import { Store } from "./index.js";

const store = Store.open(":memory:");

// ── 1. Register schemas (id = SHA256 of def) ──────────────────────────────────

const userV1 = store.schemas.register(
  "User",
  `S.Struct({ firstName: S.String, lastName: S.String, email: S.String })`
);

const userV2 = store.schemas.register(
  "User",
  `S.Struct({ fullName: S.String, email: S.String })`
);

console.log("V1:", userV1.id.slice(0, 12), "…");
console.log("V2:", userV2.id.slice(0, 12), "…");

// ── 2. Register lens V1 ↔ V2 ─────────────────────────────────────────────────

store.lenses.register({
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

// ── 3. Create entities under different schema versions ────────────────────────

const alice = store.entities.create(userV1.id, {
  firstName: "Alice",
  lastName: "Smith",
  email: "alice@example.com",
});

const bob = store.entities.create(userV2.id, {
  fullName: "Bob Jones",
  email: "bob@example.com",
});

// ── 4. Read with lens projection ──────────────────────────────────────────────

const aliceAsV2 = store.entities.get(alice.id, { as: userV2.id });
console.log("\nAlice as V2:", aliceAsV2?.data);
// { fullName: 'Alice Smith', email: 'alice@example.com' }

const bobAsV1 = store.entities.get(bob.id, { as: userV1.id });
console.log("Bob   as V1:", bobAsV1?.data);
// { firstName: 'Bob', lastName: 'Jones', email: 'bob@example.com' }

// ── 5. List all "User" entities regardless of storage schema ──────────────────

const allAsV2 = store.entities.list(userV2.id, { as: userV2.id });
console.log("\nAll users as V2:");
allAsV2.forEach((e) => console.log(" ", e.data));

// ── 6. Merge update ───────────────────────────────────────────────────────────

store.entities.update(alice.id, { email: "alice2@example.com" }, { mode: "merge" });
const aliceUpdated = store.entities.get(alice.id);
console.log("\nAlice after merge update:", aliceUpdated?.data);

// ── 7. Add expression index ───────────────────────────────────────────────────

store.indexes.create("idx_email", "$.email");
console.log("\nIndexes on entities:", store.indexes.list());

store.close();
console.log("\nDone.");

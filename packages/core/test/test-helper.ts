import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { layer as sqliteLayer } from "@effect/sql-sqlite-bun/SqliteClient";
import { Store, defineLens, Persistence } from "../src/index.ts";
import type { StoreConfig } from "../src/index.ts";
import { sqlPersistenceLayer } from "@storic/sql";

// ─── Test Schemas ───────────────────────────────────────────────────────────

export const PersonV1 = Schema.TaggedStruct("Person.v1", {
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String.annotate({ index: true }),
});

export const PersonV2 = Schema.TaggedStruct("Person.v2", {
  fullName: Schema.String,
  email: Schema.String.annotate({ index: true }),
  age: Schema.Number,
});

export type PersonV1 = typeof PersonV1.Type;
export type PersonV2 = typeof PersonV2.Type;

// ─── Test Lenses ────────────────────────────────────────────────────────────

export const PersonV1toV2 = defineLens(PersonV1, PersonV2, {
  decode: (v1) => ({
    _tag: "Person.v2" as const,
    fullName: `${v1.firstName} ${v1.lastName}`,
    email: v1.email,
    age: 0,
  }),
  encode: (v2) => ({
    _tag: "Person.v1" as const,
    firstName: v2.fullName.split(" ")[0],
    lastName: v2.fullName.split(" ").slice(1).join(" "),
    email: v2.email,
  }),
});

// ─── Test Config ────────────────────────────────────────────────────────────

export const testConfig: StoreConfig = {
  schemas: [PersonV1, PersonV2],
  lenses: [PersonV1toV2],
};

// ─── Test Layer ─────────────────────────────────────────────────────────────

/**
 * Creates a fresh in-memory Store + SqlClient layer for each test.
 * Store → Persistence → SqlClient → SQLite in-memory
 */
export const makeTestLayer = (config: StoreConfig = testConfig) => {
  const SqlLive = sqliteLayer({ filename: ":memory:" });
  const PersistenceLive = sqlPersistenceLayer.pipe(Layer.provide(SqlLive));
  const StoreLive = Store.layer(config).pipe(Layer.provide(PersistenceLive));
  // Merge so Store, Persistence, and SqlClient are all available in tests
  return Layer.mergeAll(StoreLive, PersistenceLive, SqlLive);
};

/**
 * Run an Effect program that requires Store (and optionally SqlClient/Persistence)
 * against a fresh in-memory database.
 */
export const runStore = <A, E>(
  effect: Effect.Effect<A, E, Store | SqlClient | Persistence>,
  config?: StoreConfig,
): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, makeTestLayer(config)));

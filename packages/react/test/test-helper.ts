import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { layer as sqliteLayer } from "@effect/sql-sqlite-bun/SqliteClient";
import { Store, defineEntity, defineLens } from "@storic/core";
import { sqlPersistenceLayer } from "@storic/sql";
import type { StoreShape } from "@storic/core";

export const PersonV1 = Schema.TaggedStruct("Person.v1", {
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String.annotate({ index: true }),
});
export type PersonV1 = typeof PersonV1.Type;

export const PersonV2 = Schema.TaggedStruct("Person.v2", {
  fullName: Schema.String,
  email: Schema.String.annotate({ index: true }),
  age: Schema.Number,
});
export type PersonV2 = typeof PersonV2.Type;

export const PersonV1toV2 = defineLens(PersonV1, PersonV2, {
  decode: (v1) => ({
    fullName: `${v1.firstName} ${v1.lastName}`,
    email: v1.email,
    age: 0,
  }),
  encode: (v2) => ({
    firstName: v2.fullName.split(" ")[0]!,
    lastName: v2.fullName.split(" ").slice(1).join(" "),
    email: v2.email,
  }),
});

export const Person = defineEntity({ schema: PersonV2, lenses: [PersonV1toV2] });

/** Build an isolated runtime + resolved Store for a single test. */
export async function makeTestRuntime(): Promise<{
  runtime: ManagedRuntime.ManagedRuntime<Store, never>;
  store: StoreShape;
  dispose: () => Promise<void>;
}> {
  const SqlLive = sqliteLayer({ filename: ":memory:" });
  const PersistenceLive = sqlPersistenceLayer.pipe(Layer.provide(SqlLive));
  const StoreLive = Store.layer({ entities: [Person] }).pipe(
    Layer.provide(PersistenceLive),
    Layer.orDie,
  );
  const runtime = ManagedRuntime.make(StoreLive);
  const store = await runtime.runPromise(Effect.flatMap(Store.asEffect(), Effect.succeed));
  return {
    runtime,
    store,
    dispose: () => runtime.dispose(),
  };
}

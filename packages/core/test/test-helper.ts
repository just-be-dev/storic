import { Effect, Layer } from "effect";
import { layer as sqliteLayer } from "@effect/sql-sqlite-bun/SqliteClient";
import { Store, JsEvaluator } from "../src/index.ts";

/**
 * Creates a fresh in-memory Store layer for each test.
 * Each call produces an isolated SQLite database.
 */
export const makeTestLayer = () => {
  const SqlLive = sqliteLayer({ filename: ":memory:" });
  return Store.layer.pipe(
    Layer.provide(Layer.mergeAll(SqlLive, JsEvaluator.Eval)),
  );
};

/**
 * Run an Effect program that requires Store against
 * a fresh in-memory database.
 */
export const runStore = <A, E>(
  effect: Effect.Effect<A, E, Store>,
): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, makeTestLayer()));

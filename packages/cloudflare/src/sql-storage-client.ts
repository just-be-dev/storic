/**
 * Effect SqlClient adapter for Cloudflare Durable Object's sync SqlStorage API.
 *
 * Wraps `ctx.storage.sql` (which is synchronous) into Effect's `SqlClient`
 * interface so it can be used as the persistence layer for `Store.layer()`.
 */
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ServiceMap from "effect/ServiceMap";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

// ─── SqlStorage Connection ──────────────────────────────────────────────────

/**
 * Create a Connection that delegates to the Durable Object's sync SqlStorage.
 *
 * `SqlStorage.exec(query, ...bindings)` returns a `SqlStorageCursor<T>` which
 * is iterable and has `.toArray()`. The cursor returns rows as plain objects
 * with column names as keys — the same shape Effect's SqlClient expects.
 */
function makeSqlStorageConnection(sql: SqlStorage): Connection {
  const run = (
    query: string,
    params: ReadonlyArray<unknown> = [],
  ): Effect.Effect<Array<any>, SqlError> =>
    Effect.try({
      try: () => sql.exec(query, ...params).toArray(),
      catch: (cause) => new SqlError({ cause, message: "Failed to execute statement" }),
    });

  const runValues = (
    query: string,
    params: ReadonlyArray<unknown> = [],
  ): Effect.Effect<Array<Array<unknown>>, SqlError> =>
    Effect.try({
      try: () => {
        const cursor = sql.exec(query, ...params);
        const columns = cursor.columnNames;
        const rows: Array<Array<unknown>> = [];
        for (const row of cursor) {
          rows.push(columns.map((col) => (row as Record<string, unknown>)[col]));
        }
        return rows;
      },
      catch: (cause) => new SqlError({ cause, message: "Failed to execute statement" }),
    });

  return identity<Connection>({
    execute(query, params, transformRows) {
      return transformRows ? Effect.map(run(query, params), transformRows) : run(query, params);
    },
    executeRaw(query, params) {
      return run(query, params);
    },
    executeValues(query, params) {
      return runValues(query, params);
    },
    executeUnprepared(query, params, transformRows) {
      return this.execute(query, params, transformRows);
    },
    executeStream(_query, _params) {
      return Stream.die("executeStream not supported on Durable Object SqlStorage");
    },
  });
}

// ─── Layer ──────────────────────────────────────────────────────────────────

/**
 * Create a `SqlClient` layer backed by a Durable Object's `SqlStorage`.
 *
 * @example
 * ```ts
 * import { DurableObject } from "cloudflare:workers";
 * import { Store, sqlStorageLayer } from "@storic/cloudflare";
 *
 * export class MyDO extends DurableObject {
 *   private store: Store;
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     const layer = Store.layer(config).pipe(
 *       Layer.provide(sqlStorageLayer(ctx.storage.sql))
 *     );
 *     // ...
 *   }
 * }
 * ```
 */
export const sqlStorageLayer = (sql: SqlStorage): Layer.Layer<Client.SqlClient> => {
  const connection = makeSqlStorageConnection(sql);
  const compiler = Statement.makeCompilerSqlite();

  return Layer.effectServices(
    Effect.gen(function* () {
      const semaphore = yield* Semaphore.make(1);

      const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
      const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
        const fiber = Fiber.getCurrent()!;
        const scope = ServiceMap.getUnsafe(fiber.services, Scope.Scope);
        return Effect.as(
          Effect.tap(restore(semaphore.take(1)), () =>
            Scope.addFinalizer(scope, semaphore.release(1)),
          ),
          connection,
        );
      });

      const client = yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [[ATTR_DB_SYSTEM_NAME, "sqlite"]],
      });

      return ServiceMap.make(Client.SqlClient, client);
    }),
  ).pipe(Layer.provide(Reactivity.layer));
};

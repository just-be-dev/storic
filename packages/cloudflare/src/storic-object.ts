/**
 * Base class for Durable Objects that use Storic for entity persistence.
 *
 * Handles all the wiring:
 * - Creates a SqlClient layer from `ctx.storage.sql`
 * - Builds the Store layer (DDL, index sync) inside `blockConcurrencyWhile`
 * - Provides a `run()` helper to execute Effect programs with Store available
 *
 * @example
 * ```ts
 * import { DurableObject } from "cloudflare:workers";
 * import { Schema } from "effect";
 * import { StoricObject, Store } from "@storic/cloudflare";
 * import type { StoreConfig } from "@storic/cloudflare";
 *
 * const Person = Schema.TaggedStruct("Person.v1", {
 *   name: Schema.String,
 *   email: Schema.String,
 * });
 *
 * export class MyDO extends StoricObject<Env> {
 *   get config(): StoreConfig {
 *     return { schemas: [Person] };
 *   }
 *
 *   async fetch(request: Request) {
 *     const entity = await this.run(
 *       Store.use((store) =>
 *         store.saveEntity(Person, { name: "Alice", email: "alice@example.com" })
 *       )
 *     );
 *     return Response.json(entity);
 *   }
 * }
 * ```
 */
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Store } from "@storic/core";
import type { StoreConfig } from "@storic/core";
import { sqlStorageLayer } from "./sql-storage-client.ts";

/**
 * Abstract base class for Durable Objects backed by Storic.
 *
 * Subclasses must implement the `config` getter to provide schemas and lenses.
 * The base class handles:
 *
 * 1. Creating the SqlClient from `ctx.storage.sql`
 * 2. Running Store migrations (table creation, index sync) inside
 *    `blockConcurrencyWhile` so they complete before any requests are handled
 * 3. Providing a `run()` method to execute Effect programs with Store available
 */
export abstract class StoricObject<
  Env = unknown,
  Props = {},
> extends DurableObject<Env, Props> {
  /**
   * Override this getter to provide the Storic configuration.
   * Must return the schemas and optional lenses for the store.
   */
  abstract get config(): StoreConfig;

  /**
   * The ManagedRuntime with Store and its dependencies available.
   * Initialized in the constructor via `blockConcurrencyWhile`.
   */
  private _runtime!: ManagedRuntime.ManagedRuntime<Store, never>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      const sqlLayer = sqlStorageLayer(this.ctx.storage.sql);

      // Store.layer runs DDL (CREATE TABLE, CREATE INDEX) and index sync.
      // Errors during initialization are unrecoverable — if migrations fail,
      // the DO cannot operate, so we let them propagate as defects.
      const storeLayer = Store.layer(this.config).pipe(
        Layer.provide(sqlLayer),
        Layer.orDie,
      );

      // Build the runtime — this runs the Store initialization
      this._runtime = ManagedRuntime.make(storeLayer);

      // Force the layer to initialize now (inside blockConcurrencyWhile)
      // by running a no-op effect that depends on Store
      await this._runtime.runPromise(Effect.void);
    });
  }

  /**
   * Run an Effect program with `Store` available in the context.
   *
   * @example
   * ```ts
   * async fetch(request: Request) {
   *   const result = await this.run(
   *     Effect.gen(function* () {
   *       const store = yield* Store;
   *       return yield* store.loadEntities(MySchema);
   *     })
   *   );
   *   return Response.json(result);
   * }
   * ```
   */
  protected run<A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> {
    return this._runtime.runPromise(effect);
  }
}

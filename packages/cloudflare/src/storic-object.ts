import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Store, Persistence } from "@storic/core";
import type { StoreConfig } from "@storic/core";
import { doStoragePersistence } from "./persistence.ts";

/**
 * Generic Durable Object that provides a Persistence layer.
 *
 * This is the "dumb store" — it knows nothing about schemas or lenses.
 * All schema validation and lens transforms happen caller-side in the
 * Store layer, which is composed on top of the Persistence this DO provides.
 *
 * @example
 * ```ts
 * import { DurableObject } from "cloudflare:workers";
 * import { StoricDO, Store } from "@storic/cloudflare";
 * import type { StoreConfig } from "@storic/cloudflare";
 *
 * const config: StoreConfig = { schemas: [PersonV1, PersonV2], lenses: [PersonV1toV2] };
 *
 * export class MyDO extends StoricDO<Env> {
 *   get config(): StoreConfig {
 *     return config;
 *   }
 *
 *   async fetch(request: Request) {
 *     const entities = await this.run(
 *       Store.use((store) => store.loadEntities(PersonV2))
 *     );
 *     return Response.json(entities);
 *   }
 * }
 * ```
 */
export abstract class StoricDO<
  Env = unknown,
  Props = {},
> extends DurableObject<Env, Props> {
  /**
   * Override this getter to provide the Storic configuration.
   * Schemas and lenses are defined here, outside the DO's storage concerns.
   */
  abstract get config(): StoreConfig;

  private _runtime!: ManagedRuntime.ManagedRuntime<Store, never>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      const persistenceLayer = doStoragePersistence(this.ctx.storage.sql);

      // Store.layer handles schema registry, index computation, and
      // delegates storage to the Persistence backend.
      const storeLayer = Store.layer(this.config).pipe(
        Layer.provide(persistenceLayer),
        Layer.orDie,
      );

      this._runtime = ManagedRuntime.make(storeLayer);

      // Force initialization inside blockConcurrencyWhile
      await this._runtime.runPromise(Effect.void);
    });
  }

  /**
   * Run an Effect program with `Store` available in the context.
   */
  protected run<A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> {
    return this._runtime.runPromise(effect);
  }
}

/**
 * @deprecated Use `StoricDO` instead. This is an alias for backward compatibility.
 */
export const StoricObject = StoricDO;

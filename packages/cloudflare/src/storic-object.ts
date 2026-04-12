import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Persistence } from "@storic/core";
import type {
  InitSpec,
  PersistenceRecord,
  StoredRecord,
  QueryParams,
  PatchParams,
} from "@storic/core";
import { doStoragePersistence } from "./persistence.ts";

/**
 * Generic Durable Object that exposes the Persistence interface as RPC methods.
 *
 * This is a "dumb store" — it knows nothing about schemas or lenses.
 * All schema validation and lens transforms live caller-side in the
 * Store layer, which talks to this DO via `doStubPersistence(stub)`.
 *
 * Deploy once. Never redeploy for schema changes.
 *
 * @example
 * ```ts
 * // wrangler.jsonc
 * // { "durable_objects": { "bindings": [{ "name": "STORE", "class_name": "StoricDO" }] } }
 *
 * // worker.ts
 * import { StoricDO, createStore } from "@storic/cloudflare";
 * export { StoricDO };
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const store = createStore(env.STORE, "my-store", config);
 *     const entity = await store.loadEntity(PersonV2, id);
 *     return Response.json(entity);
 *   },
 * };
 * ```
 */
export class StoricDO<Env = unknown> extends DurableObject<Env> {
  private _runtime!: ManagedRuntime.ManagedRuntime<Persistence, never>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      const layer = doStoragePersistence(this.ctx.storage.sql).pipe(Layer.orDie);
      this._runtime = ManagedRuntime.make(layer);
      // Force initialization inside blockConcurrencyWhile
      await this._runtime.runPromise(Effect.void);
    });
  }

  // ── Persistence RPC methods ──────────────────────────────────────────────

  async initialize(spec: InitSpec): Promise<void> {
    return this._runtime.runPromise(Persistence.use((p) => p.initialize(spec)));
  }

  async put(record: PersistenceRecord): Promise<StoredRecord> {
    return this._runtime.runPromise(Persistence.use((p) => p.put(record)));
  }

  async get(id: string): Promise<StoredRecord | null> {
    return this._runtime.runPromise(Persistence.use((p) => p.get(id)));
  }

  async query(params: QueryParams): Promise<Array<StoredRecord>> {
    return this._runtime.runPromise(Persistence.use((p) => p.query(params)));
  }

  async update(
    id: string,
    record: { readonly type: string; readonly data: Record<string, unknown> },
  ): Promise<StoredRecord> {
    return this._runtime.runPromise(Persistence.use((p) => p.update(id, record)));
  }

  async patch(params: PatchParams): Promise<number> {
    return this._runtime.runPromise(Persistence.use((p) => p.patch(params)));
  }

  async remove(id: string): Promise<void> {
    return this._runtime.runPromise(Persistence.use((p) => p.remove(id)));
  }
}

/**
 * @deprecated Use `StoricDO` instead. This is an alias for backward compatibility.
 */
export const StoricObject = StoricDO;

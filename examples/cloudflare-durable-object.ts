/**
 * Cloudflare Durable Object example — StoricDO as a generic datastore.
 *
 * The DO is deployed once and never needs redeployment for schema changes.
 * All schema/lens knowledge lives in the Worker entrypoint (caller-side).
 * The DO just stores and retrieves records via RPC.
 *
 * wrangler.jsonc:
 * {
 *   "durable_objects": {
 *     "bindings": [{ "name": "STORE", "class_name": "StoricDO" }]
 *   },
 *   "migrations": [
 *     { "tag": "v1", "new_sqlite_classes": ["StoricDO"] }
 *   ]
 * }
 *
 * NOTE: In a real project you'd have @cloudflare/workers-types installed
 * and listed in your tsconfig "types". Here we declare just the bits we
 * need so the example typechecks without that dependency.
 */
import { Schema } from "effect";
import {
  StoricDO,
  defineEntity,
  defineLens,
  createStore,
} from "../packages/cloudflare/src/index.ts";
import type { StoreConfig } from "../packages/cloudflare/src/index.ts";

// Minimal Cloudflare type stubs for this example
declare class DurableObjectStub<_T = unknown> {
  fetch(request: Request): Promise<Response>;
}
declare interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub<T>;
}
declare interface DurableObjectId {}

// Re-export StoricDO for wrangler to bind
export { StoricDO };

// ─── Schema definitions (caller-side only) ────────────────────────────────────

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

const Person = defineEntity({
  schema: PersonV2,
  lenses: [PersonV1toV2],
});

const storeConfig: StoreConfig = {
  entities: [Person],
};

// ─── Env type ─────────────────────────────────────────────────────────────────

interface Env {
  STORE: DurableObjectNamespace<StoricDO>;
}

// ─── Worker entrypoint ────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const store = createStore(env.STORE as any, "contacts", storeConfig);
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /contacts — create a contact (accepts V1 or V2 body)
      if (request.method === "POST" && path === "/contacts") {
        const body = (await request.json()) as Record<string, unknown>;
        const entity =
          "fullName" in body
            ? await store.saveEntity(Person, body as any)
            : await store.saveEntity(Person, body as any, { as: PersonV1 });
        return Response.json(entity, { status: 201 });
      }

      // GET /contacts — list all contacts as V2 (default)
      if (request.method === "GET" && path === "/contacts") {
        const entities = await store.loadEntities(Person);
        return Response.json(entities);
      }

      // GET /contacts/:id — load a single contact as V2 (default)
      if (request.method === "GET" && path.startsWith("/contacts/")) {
        const id = path.slice("/contacts/".length);
        const entity = await store.loadEntity(Person, id);
        return Response.json(entity);
      }

      // PATCH /contacts/:id — update a contact (merge mode)
      if (request.method === "PATCH" && path.startsWith("/contacts/")) {
        const id = path.slice("/contacts/".length);
        const body = (await request.json()) as Record<string, unknown>;
        const entity = await store.updateEntity(Person, id, body);
        return Response.json(entity);
      }

      // DELETE /contacts/:id — delete a contact
      if (request.method === "DELETE" && path.startsWith("/contacts/")) {
        const id = path.slice("/contacts/".length);
        await store.deleteEntity(id);
        return Response.json({ deleted: true });
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};

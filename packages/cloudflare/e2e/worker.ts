/**
 * E2E test worker — uses StoricDO as a generic datastore via RPC.
 *
 * Schemas and lenses live entirely in this worker entrypoint.
 * The DO is deployed as-is, with no schema knowledge.
 */
import { Schema } from "effect";
import { defineEntity, defineLens } from "@storic/core";
import type { StoreConfig } from "@storic/core";
import { StoricDO, createStore } from "../src/index.ts";

// Re-export StoricDO so wrangler can bind it
export { StoricDO };

// ─── Schemas (caller-side only) ────────────────────────────────────────────

const PersonV1 = Schema.TaggedStruct("Person.v1", {
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
});

const PersonV2 = Schema.TaggedStruct("Person.v2", {
  fullName: Schema.String,
  email: Schema.String,
  age: Schema.Number,
});

const PersonV1toV2 = defineLens(PersonV1, PersonV2, {
  decode: (v1) => ({
    fullName: `${v1.firstName} ${v1.lastName}`,
    email: v1.email,
    age: 0,
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

// ─── Env type ──────────────────────────────────────────────────────────────

interface Env {
  TEST_DO: DurableObjectNamespace<StoricDO>;
}

// ─── Worker entrypoint ─────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const store = createStore(env.TEST_DO, "test", storeConfig);
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /save-v1
      if (request.method === "POST" && path === "/save-v1") {
        const body = (await request.json()) as any;
        const entity = await store.saveEntity(
          Person,
          {
            firstName: body.firstName,
            lastName: body.lastName,
            email: body.email,
          },
          { as: PersonV1 },
        );
        return Response.json(entity);
      }

      // POST /save-v2
      if (request.method === "POST" && path === "/save-v2") {
        const body = (await request.json()) as any;
        const entity = await store.saveEntity(Person, {
          fullName: body.fullName,
          email: body.email,
          age: body.age,
        });
        return Response.json(entity);
      }

      // GET /load/:id
      if (request.method === "GET" && path.startsWith("/load/")) {
        const id = path.slice("/load/".length);
        const entity = await store.loadEntity(Person, id);
        return Response.json(entity);
      }

      // GET /list
      if (request.method === "GET" && path === "/list") {
        const entities = await store.loadEntities(Person);
        return Response.json(entities);
      }

      // PATCH /update/:id
      if (request.method === "PATCH" && path.startsWith("/update/")) {
        const id = path.slice("/update/".length);
        const body = (await request.json()) as any;
        const entity = await store.updateEntity(Person, id, body);
        return Response.json(entity);
      }

      // DELETE /delete/:id
      if (request.method === "DELETE" && path.startsWith("/delete/")) {
        const id = path.slice("/delete/".length);
        await store.deleteEntity(id);
        return Response.json({ deleted: true });
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};

/**
 * E2E test worker — a Durable Object using StoricObject with a simple
 * HTTP interface that exercises all store operations.
 */
import { Schema } from "effect";
import { StoricDO, Store, defineLens } from "../src/index.ts";
import type { StoreConfig } from "../src/index.ts";

// ─── Schemas ────────────────────────────────────────────────────────────────

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

const storeConfig: StoreConfig = {
  schemas: [PersonV1, PersonV2],
  lenses: [PersonV1toV2],
};

// ─── Env type ───────────────────────────────────────────────────────────────

interface Env {
  TEST_DO: DurableObjectNamespace<TestDO>;
}

// ─── Durable Object ─────────────────────────────────────────────────────────

export class TestDO extends StoricDO<Env> {
  get config(): StoreConfig {
    return storeConfig;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /save-v1 — Save a PersonV1
      if (request.method === "POST" && path === "/save-v1") {
        const body = (await request.json()) as any;
        const entity = await this.run(
          Store.use((store) =>
            store.saveEntity(PersonV1, {
              firstName: body.firstName,
              lastName: body.lastName,
              email: body.email,
            }),
          ),
        );
        return Response.json(entity);
      }

      // POST /save-v2 — Save a PersonV2
      if (request.method === "POST" && path === "/save-v2") {
        const body = (await request.json()) as any;
        const entity = await this.run(
          Store.use((store) =>
            store.saveEntity(PersonV2, {
              fullName: body.fullName,
              email: body.email,
              age: body.age,
            }),
          ),
        );
        return Response.json(entity);
      }

      // GET /load/:id — Load by ID as V2
      if (request.method === "GET" && path.startsWith("/load/")) {
        const id = path.slice("/load/".length);
        const entity = await this.run(
          Store.use((store) => store.loadEntity(PersonV2, id)),
        );
        return Response.json(entity);
      }

      // GET /list — List all as V2
      if (request.method === "GET" && path === "/list") {
        const entities = await this.run(
          Store.use((store) => store.loadEntities(PersonV2)),
        );
        return Response.json(entities);
      }

      // PATCH /update/:id — Update entity (merge mode)
      if (request.method === "PATCH" && path.startsWith("/update/")) {
        const id = path.slice("/update/".length);
        const body = (await request.json()) as any;
        const entity = await this.run(
          Store.use((store) => store.updateEntity(PersonV2, id, body)),
        );
        return Response.json(entity);
      }

      // DELETE /delete/:id — Delete entity
      if (request.method === "DELETE" && path.startsWith("/delete/")) {
        const id = path.slice("/delete/".length);
        await this.run(Store.use((store) => store.deleteEntity(id)));
        return Response.json({ deleted: true });
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  }
}

// ─── Worker entrypoint ──────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route all requests to a single DO instance named "test"
    const id = env.TEST_DO.idFromName("test");
    const stub = env.TEST_DO.get(id);
    return stub.fetch(request);
  },
};

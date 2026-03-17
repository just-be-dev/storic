import { test, expect, describe } from "bun:test";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { Store, computeIndexSpecs, SchemaRegistry } from "../src/index.ts";
import type { StoreConfig } from "../src/index.ts";
import { runStore } from "./test-helper.ts";

describe("computeIndexSpecs", () => {
  test("extracts index specs from annotated fields", () => {
    const PersonV1 = Schema.TaggedStruct("Person.v1", {
      firstName: Schema.String,
      email: Schema.String.annotate({ index: true }),
    });

    const config: StoreConfig = { schemas: [PersonV1], lenses: [] };
    const registry = new SchemaRegistry(config);
    const specs = computeIndexSpecs(registry);

    expect(specs).toEqual([
      {
        name: "idx_Person_v1__email",
        fieldPath: "email",
        typeDiscriminator: "Person.v1",
      },
    ]);
  });

  test("returns empty array for non-annotated schemas", () => {
    const PersonV1 = Schema.TaggedStruct("Person.v1", {
      firstName: Schema.String,
      email: Schema.String,
    });

    const config: StoreConfig = { schemas: [PersonV1], lenses: [] };
    const registry = new SchemaRegistry(config);
    const specs = computeIndexSpecs(registry);

    expect(specs).toEqual([]);
  });
});

describe("Index sync (via Store initialization)", () => {
  test("creates indexes for annotated fields on startup", async () => {
    const PersonV1 = Schema.TaggedStruct("Person.v1", {
      firstName: Schema.String,
      email: Schema.String.annotate({ index: true }),
    });

    const config: StoreConfig = {
      schemas: [PersonV1],
      lenses: [],
    };

    const indexes = await runStore(
      Effect.gen(function* () {
        // Store initialization triggers persistence.initialize()
        yield* Store;
        // Query sqlite_master for indexes on entities table
        const sql = yield* SqlClient;
        const rows = yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entities' AND name LIKE 'idx_%'`;
        return rows.map((r) => r.name);
      }),
      config,
    );

    expect(indexes).toContain("idx_entities_type");
    expect(indexes).toContain("idx_Person_v1__email");
  });

  test("does not create index for non-annotated fields", async () => {
    const PersonV1 = Schema.TaggedStruct("Person.v1", {
      firstName: Schema.String,
      email: Schema.String,
    });

    const config: StoreConfig = {
      schemas: [PersonV1],
      lenses: [],
    };

    const indexes = await runStore(
      Effect.gen(function* () {
        yield* Store;
        const sql = yield* SqlClient;
        const rows = yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entities' AND name LIKE 'idx_%'`;
        return rows.map((r) => r.name);
      }),
      config,
    );

    // Only the built-in type index
    expect(indexes).toEqual(["idx_entities_type"]);
  });
});

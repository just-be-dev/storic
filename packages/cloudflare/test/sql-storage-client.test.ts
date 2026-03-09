import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { Store, defineLens } from "@storic/core";
import type { StoreConfig } from "@storic/core";
import { sqlStorageLayer } from "../src/sql-storage-client.ts";

// ─── Mock SqlStorage ────────────────────────────────────────────────────────

/**
 * Creates a mock SqlStorage that wraps Bun's in-memory SQLite.
 * This mimics the Durable Object's `ctx.storage.sql` interface.
 */
function makeMockSqlStorage(): SqlStorage {
  const db = new Database(":memory:");

  return {
    get databaseSize() {
      return 0;
    },
    exec(query: string, ...bindings: any[]) {
      const stmt = db.query(query);
      const rows = stmt.all(...bindings) as Record<string, any>[];
      const columnNames = stmt.columnNames;

      let index = 0;
      return {
        toArray() {
          return rows;
        },
        one() {
          return rows[0];
        },
        next() {
          if (index < rows.length) {
            return { value: rows[index++] };
          }
          return { done: true as const };
        },
        raw() {
          return rows.map((row) =>
            columnNames.map((col) => row[col]),
          )[Symbol.iterator]();
        },
        columnNames,
        get rowsRead() {
          return rows.length;
        },
        get rowsWritten() {
          return 0;
        },
        [Symbol.iterator]() {
          return rows[Symbol.iterator]();
        },
      } as unknown as SqlStorageCursor<any>;
    },
    Cursor: class {} as any,
    Statement: class {} as any,
  };
}

// ─── Test Schemas ───────────────────────────────────────────────────────────

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

const testConfig: StoreConfig = {
  schemas: [PersonV1, PersonV2],
  lenses: [PersonV1toV2],
};

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeTestLayer(config: StoreConfig = testConfig) {
  const sqlLayer = sqlStorageLayer(makeMockSqlStorage());
  const storeLayer = Store.layer(config).pipe(Layer.provide(sqlLayer));
  return Layer.mergeAll(storeLayer, sqlLayer);
}

function runStore<A, E>(
  effect: Effect.Effect<A, E, Store | SqlClient>,
  config?: StoreConfig,
): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, makeTestLayer(config)));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("sqlStorageLayer", () => {
  test("provides a working SqlClient", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql`SELECT 1 as value`;
        return rows;
      }),
    );
    expect(result).toEqual([{ value: 1 }]);
  });

  test("Store.layer initializes successfully", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        return store;
      }),
    );
    expect(result).toBeDefined();
  });

  test("saveEntity and loadEntity work", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        const loaded = yield* store.loadEntity(PersonV1, saved.id);
        return loaded;
      }),
    );

    expect(result.data).toEqual({
      _tag: "Person.v1",
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
    });
  });

  test("cross-version loading via lenses works", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        // Save as V1
        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Bob",
          lastName: "Jones",
          email: "bob@example.com",
        });

        // Load as V2 (should auto-transform via lens)
        const loaded = yield* store.loadEntity(PersonV2, saved.id);
        return loaded;
      }),
    );

    expect(result.data).toEqual({
      _tag: "Person.v2",
      fullName: "Bob Jones",
      email: "bob@example.com",
      age: 0,
    });
  });

  test("loadEntities returns all versions", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });
        yield* store.saveEntity(PersonV2, {
          fullName: "Bob Jones",
          email: "bob@example.com",
          age: 30,
        });

        // Load all as V2
        return yield* store.loadEntities(PersonV2);
      }),
    );

    expect(result).toHaveLength(2);
    for (const entity of result) {
      expect(entity.data._tag).toBe("Person.v2");
    }
  });

  test("updateEntity works", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });

        const updated = yield* store.updateEntity(PersonV1, saved.id, {
          firstName: "Alicia",
        });

        return updated;
      }),
    );

    expect(result.data.firstName).toBe("Alicia");
    expect(result.data.lastName).toBe("Smith");
  });

  test("deleteEntity works", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        const saved = yield* store.saveEntity(PersonV1, {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        });

        yield* store.deleteEntity(saved.id);

        return yield* store.loadEntity(PersonV1, saved.id).pipe(
          Effect.map(() => "found" as const),
          Effect.catchTag("EntityNotFoundError", () =>
            Effect.succeed("not-found" as const),
          ),
        );
      }),
    );

    expect(result).toBe("not-found");
  });
});

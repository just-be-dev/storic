import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { Persistence, PersistenceError } from "@storic/core";
import type { IndexSpec } from "@storic/core";
import { doStoragePersistence } from "../src/persistence.ts";

// ─── Mock SqlStorage ───────────────────────────────────────────────────────

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
          return rows.map((row) => columnNames.map((col) => row[col]))[Symbol.iterator]();
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

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeLayer() {
  return doStoragePersistence(makeMockSqlStorage()).pipe(Layer.orDie);
}

function runP<A, E>(effect: Effect.Effect<A, E, Persistence>): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, makeLayer()));
}

// ─── Tests: doStoragePersistence (Persistence interface) ───────────────────

describe("doStoragePersistence", () => {
  test("initialize creates tables without error", async () => {
    const result = await runP(Persistence.use((p) => p.initialize({ indexes: [] })));
    expect(result).toBeUndefined();
  });

  test("initialize is idempotent", async () => {
    await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        yield* p.initialize({ indexes: [] });
      }),
    );
  });

  test("initialize creates declared indexes", async () => {
    const indexes: IndexSpec[] = [
      { name: "Person_v1__email", fieldPath: "email", typeDiscriminator: "Person.v1" },
    ];

    await runP(Persistence.use((p) => p.initialize({ indexes })));
    // If this doesn't throw, indexes were created successfully
  });

  test("put inserts a record and returns it with timestamps", async () => {
    const stored = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        return yield* p.put({
          id: "rec-1",
          type: "Widget",
          data: { _tag: "Widget", color: "red" },
        });
      }),
    );

    expect(stored.id).toBe("rec-1");
    expect(stored.type).toBe("Widget");
    expect(stored.data).toEqual({ _tag: "Widget", color: "red" });
    expect(stored.created_at).toBeNumber();
    expect(stored.updated_at).toBeNumber();
    expect(stored.created_at).toBe(stored.updated_at);
  });

  test("get retrieves a stored record", async () => {
    const loaded = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        yield* p.put({ id: "r1", type: "A", data: { _tag: "A", x: 42 } });
        return yield* p.get("r1");
      }),
    );

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("r1");
    expect(loaded!.data).toEqual({ _tag: "A", x: 42 });
  });

  test("get returns null for nonexistent id", async () => {
    const result = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        return yield* p.get("missing");
      }),
    );

    expect(result).toBeNull();
  });

  test("query returns records matching requested types", async () => {
    const results = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        yield* p.put({ id: "a1", type: "Alpha", data: { _tag: "Alpha" } });
        yield* p.put({ id: "b1", type: "Beta", data: { _tag: "Beta" } });
        yield* p.put({ id: "a2", type: "Alpha", data: { _tag: "Alpha" } });
        return yield* p.query({ types: ["Alpha"] });
      }),
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.type === "Alpha")).toBe(true);
  });

  test("query with multiple types", async () => {
    const results = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        yield* p.put({ id: "a1", type: "Alpha", data: { _tag: "Alpha" } });
        yield* p.put({ id: "b1", type: "Beta", data: { _tag: "Beta" } });
        yield* p.put({ id: "g1", type: "Gamma", data: { _tag: "Gamma" } });
        return yield* p.query({ types: ["Alpha", "Gamma"] });
      }),
    );

    expect(results).toHaveLength(2);
    const types = results.map((r) => r.type).sort();
    expect(types).toEqual(["Alpha", "Gamma"]);
  });

  test("query with field filter", async () => {
    const results = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        yield* p.put({ id: "1", type: "T", data: { _tag: "T", score: 10 } });
        yield* p.put({ id: "2", type: "T", data: { _tag: "T", score: 50 } });
        yield* p.put({ id: "3", type: "T", data: { _tag: "T", score: 90 } });
        return yield* p.query({
          types: ["T"],
          filters: [{ field: "score", op: "gte", value: 50 }],
        });
      }),
    );

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.data.score as number).toBeGreaterThanOrEqual(50);
    }
  });

  test("query with limit and offset", async () => {
    const results = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        for (let i = 0; i < 10; i++) {
          yield* p.put({ id: `n${i}`, type: "N", data: { _tag: "N", i } });
        }
        return yield* p.query({ types: ["N"], limit: 3, offset: 2 });
      }),
    );

    expect(results).toHaveLength(3);
  });

  test("query returns empty array when no matches", async () => {
    const results = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        return yield* p.query({ types: ["Nonexistent"] });
      }),
    );

    expect(results).toEqual([]);
  });

  test("update changes data and type", async () => {
    const updated = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        yield* p.put({ id: "u1", type: "V1", data: { _tag: "V1", a: 1 } });
        return yield* p.update("u1", {
          type: "V2",
          data: { _tag: "V2", b: 2 },
        });
      }),
    );

    expect(updated.id).toBe("u1");
    expect(updated.type).toBe("V2");
    expect(updated.data).toEqual({ _tag: "V2", b: 2 });
  });

  test("update preserves created_at but changes updated_at", async () => {
    const { stored, updated } = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        const stored = yield* p.put({ id: "ts1", type: "T", data: { _tag: "T" } });
        const updated = yield* p.update("ts1", {
          type: "T",
          data: { _tag: "T", changed: true },
        });
        return { stored, updated };
      }),
    );

    expect(updated.created_at).toBe(stored.created_at);
    // updated_at may be the same if both ops happen within the same second
    expect(updated.updated_at).toBeGreaterThanOrEqual(stored.updated_at);
  });

  test("patch updates matching records in bulk", async () => {
    const { count, results } = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        yield* p.put({
          id: "p1",
          type: "Item",
          data: { _tag: "Item", status: "draft", priority: 1 },
        });
        yield* p.put({
          id: "p2",
          type: "Item",
          data: { _tag: "Item", status: "draft", priority: 2 },
        });
        yield* p.put({ id: "p3", type: "Other", data: { _tag: "Other", status: "draft" } });

        const count = yield* p.patch({
          patches: [{ type: "Item", patch: { status: "published" } }],
        });

        const results = yield* p.query({ types: ["Item"] });
        return { count, results };
      }),
    );

    expect(count).toBe(2);
    for (const r of results) {
      expect(r.data.status).toBe("published");
      // priority should be preserved
      expect(r.data.priority).toBeDefined();
    }
  });

  test("patch with filters narrows scope", async () => {
    const { count, results } = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        yield* p.put({ id: "f1", type: "T", data: { _tag: "T", v: 10 } });
        yield* p.put({ id: "f2", type: "T", data: { _tag: "T", v: 20 } });
        yield* p.put({ id: "f3", type: "T", data: { _tag: "T", v: 30 } });

        const count = yield* p.patch({
          patches: [
            {
              type: "T",
              patch: { v: 99 },
              filters: [{ field: "v", op: "gte", value: 20 }],
            },
          ],
        });

        const results = yield* p.query({ types: ["T"] });
        return { count, results };
      }),
    );

    expect(count).toBe(2);
    const values = results.map((r) => r.data.v as number).sort();
    expect(values).toEqual([10, 99, 99]);
  });

  test("remove deletes a record", async () => {
    const result = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        yield* p.put({ id: "del1", type: "X", data: { _tag: "X" } });
        yield* p.remove("del1");
        return yield* p.get("del1");
      }),
    );

    expect(result).toBeNull();
  });

  test("remove on nonexistent id does not throw", async () => {
    await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        yield* p.remove("never-existed");
      }),
    );
  });

  test("put with duplicate id fails with PersistenceError", async () => {
    const result = await runP(
      Effect.gen(function* () {
        const p = yield* Persistence;
        yield* p.initialize({ indexes: [] });
        yield* p.put({ id: "dup", type: "T", data: { _tag: "T", v: 1 } });
        return yield* p.put({ id: "dup", type: "T", data: { _tag: "T", v: 2 } }).pipe(
          Effect.map(() => "ok" as const),
          Effect.catchTag("PersistenceError", () => Effect.succeed("error" as const)),
        );
      }),
    );

    expect(result).toBe("error");
  });
});

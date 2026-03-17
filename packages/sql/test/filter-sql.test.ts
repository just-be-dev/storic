import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import { compileFilters, validateFieldName } from "../src/filter-sql.ts";

// ─── validateFieldName ──────────────────────────────────────────────────────

describe("validateFieldName", () => {
  test("accepts simple field names", () => {
    expect(validateFieldName("email")).toBe(true);
    expect(validateFieldName("firstName")).toBe(true);
    expect(validateFieldName("age")).toBe(true);
  });

  test("accepts dotted paths", () => {
    expect(validateFieldName("address.city")).toBe(true);
    expect(validateFieldName("a.b.c")).toBe(true);
  });

  test("accepts underscored names", () => {
    expect(validateFieldName("first_name")).toBe(true);
    expect(validateFieldName("_private")).toBe(true);
  });

  test("rejects names starting with a number", () => {
    expect(validateFieldName("1field")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(validateFieldName("")).toBe(false);
  });

  test("rejects SQL injection attempts", () => {
    expect(validateFieldName("email'); DROP TABLE entities; --")).toBe(false);
    expect(validateFieldName("field') OR 1=1 --")).toBe(false);
    expect(validateFieldName("a b")).toBe(false);
    expect(validateFieldName('field"')).toBe(false);
    expect(validateFieldName("field'")).toBe(false);
    expect(validateFieldName("field;")).toBe(false);
    expect(validateFieldName("field)")).toBe(false);
  });
});

// ─── compileFilters ─────────────────────────────────────────────────────────

describe("compileFilters", () => {
  test("returns null for undefined filters", async () => {
    const result = await Effect.runPromise(compileFilters(undefined));
    expect(result).toBeNull();
  });

  test("returns null for empty filters array", async () => {
    const result = await Effect.runPromise(compileFilters([]));
    expect(result).toBeNull();
  });

  test("compiles eq filter", async () => {
    const result = await Effect.runPromise(
      compileFilters([{ field: "email", op: "eq", value: "test@example.com" }]),
    );
    expect(result).toEqual({
      sql: "json_extract(data, '$.email') = ?",
      values: ["test@example.com"],
    });
  });

  test("compiles neq filter", async () => {
    const result = await Effect.runPromise(
      compileFilters([{ field: "status", op: "neq", value: "inactive" }]),
    );
    expect(result).toEqual({
      sql: "json_extract(data, '$.status') != ?",
      values: ["inactive"],
    });
  });

  test("compiles gt filter", async () => {
    const result = await Effect.runPromise(compileFilters([{ field: "age", op: "gt", value: 18 }]));
    expect(result).toEqual({
      sql: "json_extract(data, '$.age') > ?",
      values: [18],
    });
  });

  test("compiles gte filter", async () => {
    const result = await Effect.runPromise(
      compileFilters([{ field: "age", op: "gte", value: 21 }]),
    );
    expect(result).toEqual({
      sql: "json_extract(data, '$.age') >= ?",
      values: [21],
    });
  });

  test("compiles lt filter", async () => {
    const result = await Effect.runPromise(compileFilters([{ field: "age", op: "lt", value: 65 }]));
    expect(result).toEqual({
      sql: "json_extract(data, '$.age') < ?",
      values: [65],
    });
  });

  test("compiles lte filter", async () => {
    const result = await Effect.runPromise(
      compileFilters([{ field: "age", op: "lte", value: 30 }]),
    );
    expect(result).toEqual({
      sql: "json_extract(data, '$.age') <= ?",
      values: [30],
    });
  });

  test("compiles like filter", async () => {
    const result = await Effect.runPromise(
      compileFilters([{ field: "name", op: "like", value: "%alice%" }]),
    );
    expect(result).toEqual({
      sql: "json_extract(data, '$.name') LIKE ?",
      values: ["%alice%"],
    });
  });

  test("compiles in filter with values", async () => {
    const result = await Effect.runPromise(
      compileFilters([{ field: "status", op: "in", value: ["active", "pending"] }]),
    );
    expect(result).toEqual({
      sql: "json_extract(data, '$.status') IN (?, ?)",
      values: ["active", "pending"],
    });
  });

  test("compiles in filter with empty array as false condition", async () => {
    const result = await Effect.runPromise(
      compileFilters([{ field: "status", op: "in", value: [] }]),
    );
    expect(result).toEqual({
      sql: "0 = 1",
      values: [],
    });
  });

  test("compiles multiple filters with AND", async () => {
    const result = await Effect.runPromise(
      compileFilters([
        { field: "age", op: "gte", value: 18 },
        { field: "age", op: "lt", value: 65 },
      ]),
    );
    expect(result!.sql).toBe(
      "json_extract(data, '$.age') >= ? AND json_extract(data, '$.age') < ?",
    );
    expect(result!.values).toEqual([18, 65]);
  });

  test("supports dotted field paths", async () => {
    const result = await Effect.runPromise(
      compileFilters([{ field: "address.city", op: "eq", value: "NYC" }]),
    );
    expect(result).toEqual({
      sql: "json_extract(data, '$.address.city') = ?",
      values: ["NYC"],
    });
  });

  test("rejects invalid field names with PersistenceError", async () => {
    const result = await Effect.runPromise(
      compileFilters([{ field: "email'); DROP TABLE entities; --", op: "eq", value: "x" }]).pipe(
        Effect.map(() => "success" as const),
        Effect.catchTag("PersistenceError", (e) => Effect.succeed(e.message)),
      ),
    );
    expect(result).toContain("Invalid field name");
  });

  test("rejects unsupported operator with PersistenceError", async () => {
    const result = await Effect.runPromise(
      compileFilters([{ field: "email", op: "regex" as any, value: ".*" }]).pipe(
        Effect.map(() => "success" as const),
        Effect.catchTag("PersistenceError", (e) => Effect.succeed(e.message)),
      ),
    );
    expect(result).toContain("Unsupported filter operator");
  });
});

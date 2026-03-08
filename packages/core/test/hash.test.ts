import { test, expect, describe } from "bun:test";
import { hashDef, generateId } from "../src/hash.ts";

describe("hashDef", () => {
  test("returns consistent SHA256 hex for same input", () => {
    const hash1 = hashDef("S.Struct({ name: S.String })");
    const hash2 = hashDef("S.Struct({ name: S.String })");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA256 hex = 64 chars
  });

  test("trims whitespace before hashing", () => {
    const a = hashDef("  S.String  ");
    const b = hashDef("S.String");
    expect(a).toBe(b);
  });

  test("different defs produce different hashes", () => {
    const a = hashDef("S.String");
    const b = hashDef("S.Number");
    expect(a).not.toBe(b);
  });
});

describe("generateId", () => {
  test("returns a valid UUID", () => {
    const id = generateId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

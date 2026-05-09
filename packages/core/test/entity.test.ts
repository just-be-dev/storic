import { test, expect, describe } from "bun:test";
import { Schema } from "effect";
import { defineEntity, defineLens, entitySchemas } from "../src/index.ts";

// ─── Schemas for tests ─────────────────────────────────────────────────────

const V1 = Schema.TaggedStruct("Thing.v1", {
  name: Schema.String,
});
const V2 = Schema.TaggedStruct("Thing.v2", {
  name: Schema.String,
  count: Schema.Number,
});
const V3 = Schema.TaggedStruct("Thing.v3", {
  fullName: Schema.String,
  count: Schema.Number,
});
const Other = Schema.TaggedStruct("Other.v1", {
  value: Schema.String,
});

const V1toV2 = defineLens(V1, V2, {
  decode: (v1) => ({ name: v1.name, count: 0 }),
  encode: (v2) => ({ name: v2.name }),
});
const V2toV3 = defineLens(V2, V3, {
  decode: (v2) => ({ fullName: v2.name, count: v2.count }),
  encode: (v3) => ({ name: v3.fullName, count: v3.count }),
});
const StrayLens = defineLens(V2, Other, {
  decode: (v2) => ({ value: v2.name }),
  encode: (o) => ({ name: o.value, count: 0 }),
});

// ─── defineEntity ──────────────────────────────────────────────────────────

describe("defineEntity", () => {
  test("single-schema entity (no lenses) is valid", () => {
    const Thing = defineEntity({ schema: V1 });
    expect(Thing._tag).toBe("Entity");
    expect(Thing.schema).toBe(V1);
    expect(Thing.lenses).toEqual([]);
  });

  test("entity with lenses keeps them", () => {
    const Thing = defineEntity({ schema: V2, lenses: [V1toV2] });
    expect(Thing.schema).toBe(V2);
    expect(Thing.lenses).toEqual([V1toV2]);
  });

  test("multi-hop chain is connected", () => {
    expect(() => defineEntity({ schema: V3, lenses: [V1toV2, V2toV3] })).not.toThrow();
    expect(() => defineEntity({ schema: V1, lenses: [V1toV2, V2toV3] })).not.toThrow();
  });

  test("throws when a lens references a schema not reachable from `schema`", () => {
    // V3 reachable; but if we drop V1toV2, V1 in a third lens would be unreachable
    const Stranded = defineLens(V3, Other, {
      decode: (v3) => ({ value: v3.fullName }),
      encode: (o) => ({ fullName: o.value, count: 0 }),
    });
    // Schema is V1, lenses only mention V3↔Other — V3 is unreachable from V1
    expect(() => defineEntity({ schema: V1, lenses: [Stranded] })).toThrow(
      /not reachable from "Thing\.v1"/,
    );
  });

  test("throws on a missing intermediate hop (v1, v2→v3 lens, no v1→v2 lens)", () => {
    expect(() => defineEntity({ schema: V1, lenses: [V2toV3] })).toThrow(
      /not reachable from "Thing\.v1"/,
    );
  });

  test("throws when an unrelated lens is dropped into the list", () => {
    // V1 is the schema; V1toV2 connects V1 and V2; StrayLens connects V2 to Other.
    // Other IS reachable from V1 via the chain, so this should NOT throw.
    expect(() => defineEntity({ schema: V1, lenses: [V1toV2, StrayLens] })).not.toThrow();

    // But if we drop the V1↔V2 lens and only keep StrayLens, V2 and Other are
    // unreachable from V1.
    expect(() => defineEntity({ schema: V1, lenses: [StrayLens] })).toThrow(
      /not reachable from "Thing\.v1"/,
    );
  });
});

// ─── entitySchemas helper ──────────────────────────────────────────────────

describe("entitySchemas", () => {
  test("returns [schema] for a single-schema entity", () => {
    const Thing = defineEntity({ schema: V1 });
    expect(entitySchemas(Thing)).toEqual([V1]);
  });

  test("returns deduped union of root + lens-referenced schemas", () => {
    const Thing = defineEntity({ schema: V3, lenses: [V1toV2, V2toV3] });
    const schemas = entitySchemas(Thing);
    expect(new Set(schemas)).toEqual(new Set([V1, V2, V3]));
    expect(schemas.length).toBe(3);
  });
});

import { test, expect, describe } from "bun:test";
import { Effect, Schema } from "effect";
import { Store, defineLens } from "../src/index.ts";
import { runStore } from "./test-helper.ts";

// ─── Schemas ───────────────────────────────────────────────────────────────

const ItemV1 = Schema.TaggedStruct("Item.v1", {
  name: Schema.String,
  price: Schema.Number,
});

const ItemV2 = Schema.TaggedStruct("Item.v2", {
  name: Schema.String,
  price: Schema.Number,
  currency: Schema.String,
});

const ItemV1toV2 = defineLens(ItemV1, ItemV2, {
  decode: (v1) => ({
    name: v1.name,
    price: v1.price,
    currency: "USD",
  }),
  encode: (v2) => ({
    name: v2.name,
    price: v2.price,
  }),
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Store: auto-registration of schemas from lenses", () => {
  test("schemas referenced only by lenses are auto-registered", async () => {
    // Only pass lenses, no schemas — both should be auto-registered
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(ItemV1, {
          name: "Widget",
          price: 9.99,
        });
        return yield* store.loadEntity(ItemV2, saved.id);
      }),
      {
        schemas: [],
        lenses: [ItemV1toV2],
      },
    );

    expect(entity.data).toEqual({
      _tag: "Item.v2",
      name: "Widget",
      price: 9.99,
      currency: "USD",
    });
  });

  test("lens 'from' schema auto-registered when only 'to' is listed", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(ItemV1, {
          name: "Gadget",
          price: 19.99,
        });
        return yield* store.loadEntity(ItemV1, saved.id);
      }),
      {
        schemas: [ItemV2],
        lenses: [ItemV1toV2],
      },
    );

    expect(entity.data).toEqual({
      _tag: "Item.v1",
      name: "Gadget",
      price: 19.99,
    });
  });

  test("lens 'to' schema auto-registered when only 'from' is listed", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(ItemV1, {
          name: "Gadget",
          price: 19.99,
        });
        return yield* store.loadEntity(ItemV2, saved.id);
      }),
      {
        schemas: [ItemV1],
        lenses: [ItemV1toV2],
      },
    );

    expect(entity.data).toEqual({
      _tag: "Item.v2",
      name: "Gadget",
      price: 19.99,
      currency: "USD",
    });
  });

  test("explicitly listed schemas are not overwritten by lens schemas", async () => {
    // Both schemas explicitly listed + lens — should work identically
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(ItemV1, { name: "A", price: 1 });
        yield* store.saveEntity(ItemV2, { name: "B", price: 2, currency: "EUR" });
        return yield* store.loadEntities(ItemV2);
      }),
      {
        schemas: [ItemV1, ItemV2],
        lenses: [ItemV1toV2],
      },
    );

    expect(entities).toHaveLength(2);
    expect(entities.every((e) => e.data._tag === "Item.v2")).toBe(true);
  });

  test("multi-hop lenses auto-register all intermediate schemas", async () => {
    const ItemV3 = Schema.TaggedStruct("Item.v3", {
      name: Schema.String,
      price: Schema.Number,
      currency: Schema.String,
      inStock: Schema.Boolean,
    });

    const ItemV2toV3 = defineLens(ItemV2, ItemV3, {
      decode: (v2) => ({
        name: v2.name,
        price: v2.price,
        currency: v2.currency,
        inStock: true,
      }),
      encode: (v3) => ({
        name: v3.name,
        price: v3.price,
        currency: v3.currency,
      }),
    });

    // No schemas listed at all — all three should be auto-registered from lenses
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(ItemV1, {
          name: "Widget",
          price: 9.99,
        });
        // V1 → V2 → V3 (two hops, all schemas from lenses)
        return yield* store.loadEntity(ItemV3, saved.id);
      }),
      {
        schemas: [],
        lenses: [ItemV1toV2, ItemV2toV3],
      },
    );

    expect(entity.data).toEqual({
      _tag: "Item.v3",
      name: "Widget",
      price: 9.99,
      currency: "USD",
      inStock: true,
    });
  });
});

import { test, expect, describe } from "bun:test";
import { Effect, Schema } from "effect";
import { Store, defineEntity, defineLens } from "../src/index.ts";
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

const Item = defineEntity({
  schema: ItemV2,
  lenses: [ItemV1toV2],
});

// ─── Tests ─────────────────────────────────────────────────────────────────
//
// In the entity world, schemas reachable from a lens are inferred automatically.
// These tests verify that defining an entity with `lenses` is sufficient to
// register all the schemas the lenses connect — no need to enumerate them.

describe("Store: schemas inferred from entity lenses", () => {
  test("schemas referenced only by lenses are inferred from the entity", async () => {
    // Entity carries its lens; both V1 and V2 are reachable.
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(
          Item,
          {
            name: "Widget",
            price: 9.99,
          },
          { as: ItemV1 },
        );
        return yield* store.loadEntity(Item, saved.id);
      }),
      {
        entities: [Item],
      },
    );

    expect(entity.data).toEqual({
      _tag: "Item.v2",
      name: "Widget",
      price: 9.99,
      currency: "USD",
    });
  });

  test("lens 'from' schema reachable when entity targets 'to'", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(
          Item,
          {
            name: "Gadget",
            price: 19.99,
          },
          { as: ItemV1 },
        );
        return yield* store.loadEntity(Item, saved.id, { as: ItemV1 });
      }),
      {
        entities: [Item],
      },
    );

    expect(entity.data).toEqual({
      _tag: "Item.v1",
      name: "Gadget",
      price: 19.99,
    });
  });

  test("lens 'to' schema reachable when loading via the lens", async () => {
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(
          Item,
          {
            name: "Gadget",
            price: 19.99,
          },
          { as: ItemV1 },
        );
        return yield* store.loadEntity(Item, saved.id);
      }),
      {
        entities: [Item],
      },
    );

    expect(entity.data).toEqual({
      _tag: "Item.v2",
      name: "Gadget",
      price: 19.99,
      currency: "USD",
    });
  });

  test("entity with both versions plus lens behaves identically", async () => {
    const entities = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveEntity(Item, { name: "A", price: 1 }, { as: ItemV1 });
        yield* store.saveEntity(Item, { name: "B", price: 2, currency: "EUR" });
        return yield* store.loadEntities(Item);
      }),
      {
        entities: [Item],
      },
    );

    expect(entities).toHaveLength(2);
    expect(entities.every((e) => e.data._tag === "Item.v2")).toBe(true);
  });

  test("multi-hop lenses make all intermediate schemas reachable", async () => {
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

    const ItemMulti = defineEntity({
      schema: ItemV3,
      lenses: [ItemV1toV2, ItemV2toV3],
    });

    // Entity declares only the latest schema; V1 and V2 are inferred from lenses.
    const entity = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const saved = yield* store.saveEntity(
          ItemMulti,
          {
            name: "Widget",
            price: 9.99,
          },
          { as: ItemV1 },
        );
        // V1 → V2 → V3 (two hops, all schemas inferred from lenses)
        return yield* store.loadEntity(ItemMulti, saved.id);
      }),
      {
        entities: [ItemMulti],
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

import { test, expect, describe } from "bun:test";
import { Effect, Stream, Fiber } from "effect";
import { Store } from "../src/index.ts";
import { runStore, Person, PersonV1, PersonV2 } from "./test-helper.ts";

describe("Store: subscribeEntity", () => {
  test("emits the current value immediately, then on each update", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        const saved = yield* store.saveEntity(
          Person,
          { firstName: "Alice", lastName: "Smith", email: "alice@example.com" },
          { as: PersonV1 },
        );

        // Take 3 emissions: initial, after first update, after second update
        const collectFiber = yield* store
          .subscribeEntity(Person, saved.id, { as: PersonV1 })
          .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);

        // Give the subscriber a moment to register
        yield* Effect.sleep("10 millis");

        yield* store.updateEntity(
          Person,
          saved.id,
          { email: "alice2@example.com" },
          { as: PersonV1 },
        );

        yield* Effect.sleep("5 millis");

        yield* store.updateEntity(
          Person,
          saved.id,
          { email: "alice3@example.com" },
          { as: PersonV1 },
        );

        const items = yield* Fiber.join(collectFiber);
        return items;
      }),
    );

    expect(result).toHaveLength(3);
    expect(result[0]?.data.email).toBe("alice@example.com");
    expect(result[1]?.data.email).toBe("alice2@example.com");
    expect(result[2]?.data.email).toBe("alice3@example.com");
  });

  test("emits null when entity does not exist initially, then the value when created", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const id = "future-entity";

        const collectFiber = yield* store
          .subscribeEntity(Person, id, { as: PersonV1 })
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        yield* Effect.sleep("10 millis");

        yield* store.saveEntity(
          Person,
          { firstName: "Bob", lastName: "B", email: "b@b.com" },
          { id, as: PersonV1 },
        );

        const items = yield* Fiber.join(collectFiber);
        return items;
      }),
    );

    expect(result[0]).toBeNull();
    expect(result[1]?.data.email).toBe("b@b.com");
  });

  test("emits null after entity is deleted", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        const saved = yield* store.saveEntity(
          Person,
          { firstName: "C", lastName: "D", email: "c@d.com" },
          { as: PersonV1 },
        );

        const collectFiber = yield* store
          .subscribeEntity(Person, saved.id, { as: PersonV1 })
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        yield* Effect.sleep("10 millis");
        yield* store.deleteEntity(saved.id);

        const items = yield* Fiber.join(collectFiber);
        return items;
      }),
    );

    expect(result[0]?.data.email).toBe("c@d.com");
    expect(result[1]).toBeNull();
  });

  test("projects through lenses when target schema differs from stored", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        // Save as v1, subscribe as v2
        const saved = yield* store.saveEntity(
          Person,
          { firstName: "E", lastName: "F", email: "e@f.com" },
          { as: PersonV1 },
        );

        const collectFiber = yield* store
          .subscribeEntity(Person, saved.id, { as: PersonV2 })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        const items = yield* Fiber.join(collectFiber);
        return items;
      }),
    );

    expect(result[0]?.data._tag).toBe("Person.v2");
    expect((result[0]?.data as any).fullName).toBe("E F");
  });
});

describe("Store: subscribeEntities", () => {
  test("emits initial list, then re-emits on save and delete", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        const a = yield* store.saveEntity(
          Person,
          { firstName: "A", lastName: "A", email: "a@a.com" },
          { as: PersonV1 },
        );

        const collectFiber = yield* store
          .subscribeEntities(Person, { as: PersonV1 })
          .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);

        yield* Effect.sleep("10 millis");

        yield* store.saveEntity(
          Person,
          { firstName: "B", lastName: "B", email: "b@b.com" },
          { as: PersonV1 },
        );

        yield* Effect.sleep("5 millis");

        yield* store.deleteEntity(a.id);

        const items = yield* Fiber.join(collectFiber);
        return items;
      }),
    );

    expect(result[0]).toHaveLength(1);
    expect(result[1]).toHaveLength(2);
    expect(result[2]).toHaveLength(1);
  });

  test("re-emits after patchEntities", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* Store;

        yield* store.saveEntity(
          Person,
          { firstName: "X", lastName: "X", email: "x@x.com" },
          { as: PersonV1 },
        );

        const collectFiber = yield* store
          .subscribeEntities(Person, { as: PersonV1 })
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        yield* Effect.sleep("10 millis");

        yield* store.patchEntities(Person, { email: "patched@x.com" }, { as: PersonV1 });

        const items = yield* Fiber.join(collectFiber);
        return items;
      }),
    );

    expect(result[0][0]?.data.email).toBe("x@x.com");
    expect(result[1][0]?.data.email).toBe("patched@x.com");
  });
});

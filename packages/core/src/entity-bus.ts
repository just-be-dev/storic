import { Effect, PubSub, Stream } from "effect";
import type { ChangeEvent } from "./change-event.ts";

/**
 * An in-memory pub/sub for entity change events.
 *
 * Used by `Store` as the single point of fan-out to subscribers, regardless
 * of whether events originate from Store-internal mutations (self-publish
 * path) or from a backend's `Persistence.subscribe` stream (pass-through
 * path). Subscribers consume an Effect `Stream<ChangeEvent>` filtered to
 * the events they care about.
 */
export class EntityBus {
  private constructor(private readonly pubsub: PubSub.PubSub<ChangeEvent>) {}

  static readonly make: Effect.Effect<EntityBus> = Effect.map(
    PubSub.unbounded<ChangeEvent>(),
    (pubsub) => new EntityBus(pubsub),
  );

  publish(event: ChangeEvent): Effect.Effect<void> {
    return Effect.asVoid(PubSub.publish(this.pubsub, event));
  }

  /**
   * A Stream of every event published to the bus. Subscribers should filter
   * to the events they care about (by `type`, `id`, etc).
   */
  get stream(): Stream.Stream<ChangeEvent> {
    return Stream.fromPubSub(this.pubsub);
  }
}

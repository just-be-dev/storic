import { Effect, PubSub, Scope, Stream } from "effect";
import type { ChangeEvent } from "./change-event.ts";

/**
 * An in-memory pub/sub for entity change events.
 *
 * Used by `Store` as the single point of fan-out to subscribers, regardless
 * of whether events originate from Store-internal mutations (self-publish
 * path) or from a backend's `Persistence.subscribe` stream (pass-through
 * path). Subscribers consume an Effect `Stream<ChangeEvent>` filtered to
 * the events they care about.
 *
 * The underlying PubSub is unbounded: publishers never block, but a
 * permanently-stalled subscriber will retain memory for every published
 * event until it is interrupted. For typical workloads (UI subscribers
 * driven by React/atom that drain events on every render) this is fine;
 * for high-throughput backends consider switching to `PubSub.dropping` or
 * `PubSub.sliding` upstream.
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
   * Acquire a buffered subscription to the bus. The returned Stream begins
   * buffering events the moment this Effect is run — events published
   * between subscription and consumption are queued, not dropped.
   *
   * Prefer this over `stream` when you need to "subscribe first, then load
   * initial state" without a race window. The subscription is released when
   * the surrounding scope closes.
   */
  subscribe(): Effect.Effect<Stream.Stream<ChangeEvent>, never, Scope.Scope> {
    return Effect.map(PubSub.subscribe(this.pubsub), (s) => Stream.fromSubscription(s));
  }

  /**
   * A Stream of every event published to the bus. The subscription is
   * established lazily when the stream is first consumed — events published
   * before that point are not delivered. For "subscribe-before-load" flows,
   * use `subscribe()` instead.
   */
  get stream(): Stream.Stream<ChangeEvent> {
    return Stream.fromPubSub(this.pubsub);
  }
}

---
name: effect-best-practices
description: Enforces Effect v4 patterns for services, errors, layers, and schemas. Use when writing code with ServiceMap.Service, Schema.TaggedErrorClass, Layer composition, or Effect.gen programs.
version: 2.0.0
---

# Effect v4 Best Practices

This skill enforces opinionated, consistent patterns for Effect v4 (`effect-smol`) codebases. These patterns optimize for type safety, testability, observability, and maintainability.

> **Version note:** This covers Effect v4 (4.0.0-beta.29+). Key differences from v3: `ServiceMap.Service` replaces `Effect.Service`/`Context.Tag`, `Schema.TaggedErrorClass` replaces `Schema.TaggedError`, `Effect.catch` replaces `Effect.catchAll`, service proxy accessors are removed, and the `dependencies` option is removed from service definitions.

## Quick Reference: Critical Rules

| Category | DO | DON'T |
|----------|-----|-------|
| Services | `ServiceMap.Service<Self, Shape>()("id")` | `Effect.Service` (v3), `Context.Tag` |
| Layers | `static layer = Layer.effect(This, ...)` | `dependencies: [...]` in service (v3) |
| Layer Deps | `Layer.provide(depLayer)` on static layer | Manual `Effect.provide` at usage sites |
| Layer Composition | `Layer.mergeAll` for flat composition | Deeply nested `Layer.provide` chains |
| Errors | `Schema.TaggedErrorClass` with context fields | `Schema.TaggedError` (v3), plain classes |
| Error Specificity | `UserNotFoundError`, `SessionExpiredError` | Generic `NotFoundError`, `BadRequestError` |
| Error Handling | `catchTag`/`catchTags` for tagged errors | `Effect.catch` losing type info |
| Yielding Services | `const svc = yield* MyService` then `svc.method()` | `MyService.method()` (v3 accessors removed) |
| Functions | `Effect.fn("Service.method")` | Anonymous generators |
| Logging | `Effect.log` with structured data | `console.log` |
| Config | `Config.*` with validation | `process.env` directly |
| Options | `Option.match` with both cases | `Option.getOrThrow` |
| Nullability | `Option<T>` in domain types | `null`/`undefined` |

## Service Definition Pattern

**Always use `ServiceMap.Service`** for services. This is the v4 replacement for `Effect.Service` and `Context.Tag`.

```typescript
import { Effect, Layer, ServiceMap } from "effect"

// 1. Define the service shape interface
interface UserServiceShape {
  readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>
  readonly create: (data: CreateUserInput) => Effect.Effect<User, UserCreateError>
}

// 2. Extend ServiceMap.Service with Self type, Shape, and identifier
export class UserService extends ServiceMap.Service<UserService, UserServiceShape>()(
  "app/UserService"
) {
  // 3. Define the layer as a static property
  static readonly layer: Layer.Layer<UserService, never, UserRepo | CacheService> =
    Layer.effect(
      UserService,
      Effect.gen(function* () {
        const repo = yield* UserRepo
        const cache = yield* CacheService

        const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
          const cached = yield* cache.get(id)
          if (Option.isSome(cached)) return cached.value
          const user = yield* repo.findById(id)
          yield* cache.set(id, user)
          return user
        })

        const create = Effect.fn("UserService.create")(function* (data: CreateUserInput) {
          const user = yield* repo.create(data)
          yield* Effect.log("User created", { userId: user.id })
          return user
        })

        return UserService.of({ findById, create })
      })
    )
}

// 4. Usage — yield the service, then call methods
const program = Effect.gen(function* () {
  const userService = yield* UserService
  const user = yield* userService.findById(userId)
  return user
})

// 5. Wire layers — provide dependencies on the static layer
const UserServiceLive = UserService.layer.pipe(
  Layer.provide(UserRepo.layer),
  Layer.provide(CacheService.layer),
)

// 6. Or use Service.use for one-shot access
const program2 = UserService.use((svc) => svc.findById(userId))
```

**Important v4 changes from v3:**
- No `accessors: true` — proxy accessors are removed. You must `yield* Service` then call methods.
- No `dependencies: [...]` — use `Layer.provide(depLayer)` on the static layer.
- No `.Default` — convention is `.layer` (or `.live` for production-only).
- Service identifier format: `"namespace/ServiceName"` (e.g., `"app/UserService"`).

See `references/service-patterns.md` for detailed patterns.

## Error Definition Pattern

**Always use `Schema.TaggedErrorClass`** for errors. This is the v4 replacement for `Schema.TaggedError`.

```typescript
import { Schema } from "effect"

export class UserNotFoundError extends Schema.TaggedErrorClass<UserNotFoundError>()(
  "UserNotFoundError",
  {
    userId: Schema.String,
    message: Schema.String,
  }
) {}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()(
  "ValidationError",
  {
    message: Schema.String,
    field: Schema.optional(Schema.String),
  }
) {}
```

**Error handling — use `catchTag`/`catchTags`:**

```typescript
// Single tag
yield* repo.findById(id).pipe(
  Effect.catchTag("DatabaseError", (err) =>
    Effect.fail(new UserNotFoundError({ userId: id, message: "Lookup failed" }))
  ),
)

// Multiple tags
yield* effect.pipe(
  Effect.catchTags({
    DatabaseError: (err) => Effect.fail(new UserNotFoundError({ userId: id, message: err.message })),
    ValidationError: (err) => Effect.fail(new InvalidEmailError({ email: input.email, message: err.message })),
  }),
)
```

### Prefer Explicit Over Generic Errors

**Every distinct failure reason deserves its own error type.** Don't collapse multiple failure modes into generic HTTP errors.

```typescript
// WRONG - Generic errors lose information
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "NotFoundError",
  { message: Schema.String }
) {}

// CORRECT - Explicit domain errors with rich context
export class UserNotFoundError extends Schema.TaggedErrorClass<UserNotFoundError>()(
  "UserNotFoundError",
  { userId: Schema.String, message: Schema.String }
) {}

export class ChannelNotFoundError extends Schema.TaggedErrorClass<ChannelNotFoundError>()(
  "ChannelNotFoundError",
  { channelId: Schema.String, message: Schema.String }
) {}
```

See `references/error-patterns.md` for error remapping and retry patterns.

## Schema & Branded Types Pattern

**Brand all entity IDs** for type safety across service boundaries:

```typescript
import { Schema } from "effect"

// Entity IDs — always branded
export const UserId = Schema.UUID.pipe(Schema.brand("@App/UserId"))
export type UserId = Schema.Schema.Type<typeof UserId>

// Domain types — use Schema.Struct
export const User = Schema.Struct({
  id: UserId,
  email: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtc,
})
export type User = Schema.Schema.Type<typeof User>
```

See `references/schema-patterns.md` for transforms and advanced patterns.

## Function Pattern with Effect.fn

**Always use `Effect.fn`** for service methods. This provides automatic tracing with proper span names:

```typescript
const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
  yield* Effect.annotateCurrentSpan("userId", id)
  const user = yield* repo.findById(id)
  return user
})
```

## Layer Composition

**Provide dependencies on static layers**, not at usage sites:

```typescript
// Wire dependencies on the layer itself
const UserServiceLive = UserService.layer.pipe(
  Layer.provide(UserRepo.layer),
  Layer.provide(CacheService.layer),
)

// Compose layers at app root
const AppLive = Layer.mergeAll(
  UserServiceLive,
  OrderServiceLive,
  NotificationServiceLive,
).pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(RedisLive),
)
```

**Layer composition patterns:**

```typescript
// Layer.mergeAll for flat composition of same-level layers
const RepoLive = Layer.mergeAll(
  UserRepo.layer,
  OrderRepo.layer,
  ProductRepo.layer,
)

// Layer.provideMerge for incremental chaining (flatter types)
const MainLive = DatabaseLive.pipe(
  Layer.provideMerge(ConfigLive),
  Layer.provideMerge(LoggerLive),
)
```

See `references/layer-patterns.md` for testing layers and the `layerConfig` pattern.

## Option Handling

**Never use `Option.getOrThrow`**. Always handle both cases explicitly:

```typescript
yield* Option.match(maybeUser, {
  onNone: () => Effect.fail(new UserNotFoundError({ userId, message: "Not found" })),
  onSome: (user) => Effect.succeed(user),
})
```

## v3 → v4 Migration Quick Reference

| v3 | v4 |
|----|-----|
| `Effect.Service<S>()("id", {accessors, dependencies, effect})` | `ServiceMap.Service<S, Shape>()("id")` + `static layer = Layer.effect(...)` |
| `Schema.TaggedError<E>()("tag", {...})` | `Schema.TaggedErrorClass<E>()("tag", {...})` |
| `Effect.catchAll` | `Effect.catch` |
| `Effect.catchAllCause` | `Effect.catchCause` |
| `Effect.catchSome` | `Effect.catchFilter` |
| `Context.Tag` / `Context.GenericTag` | `ServiceMap.Service` |
| `Context.Reference` | `ServiceMap.Reference` |
| `Context.make/add` | `ServiceMap.make/add` |
| `Layer.scopedContext` | `Layer.effectServices` |
| `Service.method()` (proxy accessors) | `yield* Service` then `svc.method()`, or `Service.use(...)` |
| `dependencies: [Dep.Default]` | `Layer.provide(Dep.layer)` on static layer |
| `.Default` (layer naming) | `.layer` |
| `Schema.transform(from, to, {decode, encode})` | `from.pipe(Schema.decodeTo(to, {...}))` |
| `@effect/sql/SqlClient` | `effect/unstable/sql/SqlClient` |

## Anti-Patterns (Forbidden)

These patterns are **never acceptable**:

```typescript
// FORBIDDEN — runSync/runPromise inside services
const result = Effect.runSync(someEffect)

// FORBIDDEN — throw inside Effect.gen
yield* Effect.gen(function* () {
  if (bad) throw new Error("No!") // Use Effect.fail or yield* new MyError(...)
})

// FORBIDDEN — catch losing type info
yield* effect.pipe(Effect.catch(() => Effect.fail(new GenericError())))

// FORBIDDEN — console.log
console.log("debug") // Use Effect.log

// FORBIDDEN — process.env directly
const key = process.env.API_KEY // Use Config.string("API_KEY")
```

See `references/anti-patterns.md` for the complete list with rationale.

## Observability

```typescript
// Structured logging
yield* Effect.log("Processing order", { orderId, userId, amount })

// Metrics
const orderCounter = Metric.counter("orders_processed")
yield* Metric.increment(orderCounter)

// Config with validation
const config = Config.all({
  port: Config.integer("PORT").pipe(Config.withDefault(3000)),
  apiKey: Config.redacted("API_KEY"),
})
```

See `references/observability-patterns.md` for metrics and tracing patterns.

## Reference Files

For detailed patterns, consult these reference files in the `references/` directory:

- `service-patterns.md` — ServiceMap.Service definition, Effect.fn, layer wiring
- `error-patterns.md` — Schema.TaggedErrorClass, error remapping, retry patterns
- `schema-patterns.md` — Branded types, transforms, Schema.Class
- `layer-patterns.md` — Dependency composition, testing layers
- `rpc-cluster-patterns.md` — RpcGroup, Workflow, Activity patterns
- `anti-patterns.md` — Complete list of forbidden patterns
- `observability-patterns.md` — Logging, metrics, config patterns

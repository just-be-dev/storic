# Layer Patterns

## Layer.provide on Static Layers (Instead of Dependencies Array)

**Critical rule:** In Effect v4, there is no `dependencies` array on service definitions. Instead, define a `static layer` on the service class and compose dependencies with `Layer.provide` on that layer.

### Correct Pattern (v4)

```typescript
import { Effect, Layer, ServiceMap } from "effect"

interface OrderServiceShape {
  readonly create: (input: CreateOrderInput) => Effect.Effect<Order, OrderCreateError>
}

export class OrderService extends ServiceMap.Service<OrderService, OrderServiceShape>()(
  "app/OrderService"
) {
  static readonly layer = Layer.effect(
    OrderService,
    Effect.gen(function* () {
      const users = yield* UserService
      const products = yield* ProductService
      const inventory = yield* InventoryService
      const payments = yield* PaymentService

      const create = Effect.fn("OrderService.create")(function* (input: CreateOrderInput) {
        const user = yield* users.findById(input.userId)
        const product = yield* products.findById(input.productId)
        yield* inventory.reserve(input.productId, input.quantity)
        yield* payments.charge(user.id, product.price * input.quantity)
        return { id: OrderId.make(crypto.randomUUID()), ...input }
      })

      return OrderService.of({ create })
    })
  )
}

// Wire dependencies on the static layer
const OrderServiceLive = OrderService.layer.pipe(
  Layer.provide(UserService.layer),
  Layer.provide(ProductService.layer),
  Layer.provide(InventoryService.layer),
  Layer.provide(PaymentService.layer),
)

// At app root — simple, flat composition
const AppLive = Layer.mergeAll(
  OrderServiceLive,
  NotificationServiceLive,
  AnalyticsServiceLive,
)
```

### Wrong Pattern (v3 Style — Do Not Use)

```typescript
// WRONG — v3 dependencies array does not exist in v4
export class OrderService extends Effect.Service<OrderService>()("OrderService", {
  accessors: true,
  dependencies: [
    UserService.Default,
    ProductService.Default,
  ],
  effect: Effect.gen(function* () { /* ... */ }),
}) {}
```

### Wrong Pattern (Leaked Dependencies)

```typescript
// WRONG — No layer composition, dependencies leak to every usage site
const program = OrderService.use((svc) => svc.create(input)).pipe(
  Effect.provide(
    OrderService.layer.pipe(
      Layer.provide(UserService.layer),
      Layer.provide(ProductService.layer),
      // Easy to forget one — causes compile errors or runtime failures
    )
  ),
)
```

## Infrastructure Layers

Infrastructure layers (database, Redis, HTTP clients) are **acceptable** to leave out of per-service layer composition because:

1. They're provided once at the application root
2. They don't change between test/production (different implementations, same interface)
3. They're true infrastructure, not business logic

```typescript
import { PgClient } from "@effect/sql-pg"

const DatabaseLive = PgClient.layer({
  host: Config.string("DB_HOST"),
  port: Config.integer("DB_PORT"),
  database: Config.string("DB_NAME"),
  username: Config.string("DB_USER"),
  password: Config.redacted("DB_PASSWORD"),
})

// Service uses database but does not include it in its own layer composition
interface UserRepoShape {
  readonly findById: (id: UserId) => Effect.Effect<User | undefined, SqlError>
}

export class UserRepo extends ServiceMap.Service<UserRepo, UserRepoShape>()(
  "app/UserRepo"
) {
  static readonly layer = Layer.effect(
    UserRepo,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient

      const findById = Effect.fn("UserRepo.findById")(function* (id: UserId) {
        const rows = yield* sql`SELECT * FROM users WHERE id = ${id}`.pipe(Effect.orDie)
        return rows[0] as User | undefined
      })

      return UserRepo.of({ findById })
    })
  )
}

// App root provides infrastructure once to all layers that need it
const AppLive = Layer.mergeAll(
  OrderServiceLive,
  UserServiceLive,
).pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(RedisLive),
)
```

## Layer.mergeAll Over Nested Provides

**Use `Layer.mergeAll`** for composing layers at the same level:

```typescript
// CORRECT — Flat composition
const ServicesLive = Layer.mergeAll(
  UserServiceLive,
  OrderServiceLive,
  ProductServiceLive,
  NotificationServiceLive,
)

const InfrastructureLive = Layer.mergeAll(
  DatabaseLive,
  RedisLive,
  HttpClientLive,
)

const AppLive = ServicesLive.pipe(
  Layer.provide(InfrastructureLive),
)
```

```typescript
// WRONG — Deeply nested, hard to read
const AppLive = UserService.layer.pipe(
  Layer.provide(
    OrderService.layer.pipe(
      Layer.provide(
        ProductService.layer.pipe(
          Layer.provide(DatabaseLive),
        ),
      ),
    ),
  ),
)
```

## Layer.provideMerge for Sequential Composition

**Use `Layer.provideMerge`** when chaining layers that need incremental composition. Unlike `Layer.provide`, `provideMerge` merges the output into the current layer, producing flatter types.

```typescript
// CORRECT — Layer.provideMerge chains for incremental composition
const MainLive = DatabaseLive.pipe(
  Layer.provideMerge(ConfigServiceLive),
  Layer.provideMerge(LoggerLive),
  Layer.provideMerge(CacheLive),
  Layer.provideMerge(TracerLive),
)

// WRONG — Multiple Layer.provide calls create nested types
const MainLive = DatabaseLive.pipe(
  Layer.provide(ConfigServiceLive),
  Layer.provide(LoggerLive),  // Each provide creates deeper nesting
  Layer.provide(CacheLive),
)
```

**Key difference:** `Layer.provide(A, B)` provides B to A but outputs only A's services. `Layer.provideMerge(A, B)` provides B to A and outputs both A's and B's services merged together.

## Layer Deduplication Benefits

Layers automatically memoize construction — the same service is instantiated only once regardless of how many times it appears in the dependency graph.

```typescript
// Both UserRepo and OrderRepo depend on DatabaseLive
const RepoLive = Layer.mergeAll(
  UserRepo.layer,   // requires PgClient
  OrderRepo.layer,  // requires PgClient
)

// With Layer.mergeAll, DatabaseLive is constructed ONCE
const AppLive = RepoLive.pipe(
  Layer.provide(DatabaseLive), // Single instance shared
)
```

**`Effect.provide` does NOT deduplicate:**

```typescript
// WRONG — Each provide creates a new instance
const program = myEffect.pipe(
  Effect.provide(UserRepo.layer),
  Effect.provide(OrderRepo.layer),
  // If both repos need DatabaseLive, and you provide it separately,
  // you may get TWO database connections!
)

// CORRECT — Use layers for deduplication
const program = myEffect.pipe(
  Effect.provide(AppLive), // Single composed layer
)
```

## TypeScript LSP Performance

Deeply nested `Layer.provide` chains create complex recursive types that slow down the TypeScript Language Server.

```typescript
// PROBLEMATIC — Deep nesting causes slow LSP
const AppLive = Layer1.pipe(
  Layer.provide(Layer2.pipe(
    Layer.provide(Layer3.pipe(
      Layer.provide(Layer4.pipe(
        Layer.provide(Layer5),
      )),
    )),
  )),
)
// Type becomes: Layer<..., Layer<..., Layer<..., Layer<..., ...>>>>
```

```typescript
// BETTER — Flat composition with mergeAll produces simpler types
const InfraLive = Layer.mergeAll(Layer3, Layer4, Layer5)
const AppLive = Layer.mergeAll(Layer1, Layer2).pipe(
  Layer.provide(InfraLive),
)
// Type is flatter and LSP responds faster
```

**Recommendations:**
- Prefer `Layer.mergeAll` for layers at the same level
- Use `Layer.provideMerge` instead of chained `Layer.provide` calls
- Group related layers into intermediate compositions
- Keep nesting depth shallow (ideally 2-3 levels max)

## layerConfig Pattern

For services that need configuration at construction time, use the `layerConfig` static method pattern. Note: use `ServiceMap.Service`, not `Effect.Service`.

```typescript
import { Config, ConfigError, Effect, Layer, ServiceMap } from "effect"

interface EventQueueConfig {
  readonly maxRetries: number
  readonly batchSize: number
  readonly pollInterval: number
}

interface EventQueueShape {
  readonly enqueue: (event: DomainEvent) => Effect.Effect<void, EventQueueError>
  readonly poll: () => Effect.Effect<ReadonlyArray<DomainEvent>, EventQueueError>
}

export class ElectricEventQueue extends ServiceMap.Service<ElectricEventQueue, EventQueueShape>()(
  "app/ElectricEventQueue"
) {
  // Default layer with hardcoded config
  static readonly layer = Layer.effect(
    ElectricEventQueue,
    Effect.gen(function* () {
      return ElectricEventQueue.of({
        enqueue: Effect.fn("ElectricEventQueue.enqueue")(function* (event) {
          // Default implementation
        }),
        poll: Effect.fn("ElectricEventQueue.poll")(function* () {
          return []
        }),
      })
    })
  )

  // Static method for config-driven layer
  static readonly layerConfig = (
    config: Config.Config.Wrap<EventQueueConfig>,
  ): Layer.Layer<ElectricEventQueue, ConfigError.ConfigError> =>
    Layer.unwrapEffect(
      Config.unwrap(config).pipe(
        Effect.map((cfg) =>
          Layer.succeed(
            ElectricEventQueue,
            ElectricEventQueue.of(new ElectricEventQueueImpl(cfg))
          )
        )
      )
    )
}

// Usage
const EventQueueLive = ElectricEventQueue.layerConfig({
  maxRetries: Config.integer("EVENT_QUEUE_MAX_RETRIES").pipe(
    Config.withDefault(3)
  ),
  batchSize: Config.integer("EVENT_QUEUE_BATCH_SIZE").pipe(
    Config.withDefault(100)
  ),
  pollInterval: Config.integer("EVENT_QUEUE_POLL_INTERVAL").pipe(
    Config.withDefault(1000)
  ),
})
```

This pattern:
- Separates configuration from implementation
- Returns `ConfigError` for missing/invalid config
- Allows different configs per environment
- Integrates cleanly with `Layer.mergeAll` and `Layer.provideMerge`

## Layer Naming Conventions

In v4, use `.layer` instead of `.Default`:

```typescript
// v4 CORRECT — .layer convention
const UserServiceLive = UserService.layer.pipe(
  Layer.provide(UserRepo.layer),
)

// v3 WRONG — .Default is the old convention
const UserServiceLive = UserService.Default  // Does not exist in v4
```

Use suffixes on composed layer bindings to indicate environment:

- `ServiceLive` — Production implementation with deps wired
- `ServiceTest` — Test/mock implementation
- `ServiceLayer` — Generic layer (rare)

```typescript
// Production — wire dependencies on the static .layer
const UserServiceLive = UserService.layer.pipe(
  Layer.provide(UserRepo.layer),
  Layer.provide(CacheService.layer),
)

// Test with mocks — use Layer.succeed
const UserServiceTest = Layer.succeed(
  UserService,
  UserService.of({
    findById: (id) => Effect.succeed(mockUser),
    create: (input) => Effect.succeed({ id: UserId.make("test-id"), ...input }),
  })
)

// Test with in-memory state — use Layer.effect
const UserServiceInMemory = Layer.effect(
  UserService,
  Effect.gen(function* () {
    const store = new Map<string, User>()

    const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
      const user = store.get(id)
      if (!user) return yield* Effect.fail(new UserNotFoundError({ userId: id, message: "Not found" }))
      return user
    })

    const create = Effect.fn("UserService.create")(function* (input: CreateUserInput) {
      const user = { id: UserId.make(crypto.randomUUID()), ...input }
      store.set(user.id, user)
      return user
    })

    return UserService.of({ findById, create })
  })
)
```

## Layer.effectServices for Multi-Service Layers

**Use `Layer.effectServices`** when a single layer needs to provide multiple services at once. This replaces the v3 `Layer.scopedContext` pattern.

```typescript
import { Effect, Layer, ServiceMap } from "effect"

// A single initialization produces multiple services
const DatabaseServicesLive: Layer.Layer<UserRepo | OrderRepo | ProductRepo> =
  Layer.effectServices(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient

      const userRepo: UserRepo = UserRepo.of({
        findById: Effect.fn("UserRepo.findById")(function* (id: UserId) {
          const rows = yield* sql`SELECT * FROM users WHERE id = ${id}`.pipe(Effect.orDie)
          return rows[0] as User | undefined
        }),
      })

      const orderRepo: OrderRepo = OrderRepo.of({
        findById: Effect.fn("OrderRepo.findById")(function* (id: OrderId) {
          const rows = yield* sql`SELECT * FROM orders WHERE id = ${id}`.pipe(Effect.orDie)
          return rows[0] as Order | undefined
        }),
      })

      const productRepo: ProductRepo = ProductRepo.of({
        findById: Effect.fn("ProductRepo.findById")(function* (id: ProductId) {
          const rows = yield* sql`SELECT * FROM products WHERE id = ${id}`.pipe(Effect.orDie)
          return rows[0] as Product | undefined
        }),
      })

      // Use ServiceMap.make/add to construct the service map
      return ServiceMap.make(UserRepo, userRepo).pipe(
        ServiceMap.add(OrderRepo, orderRepo),
        ServiceMap.add(ProductRepo, productRepo),
      )
    })
  )

// Compose like any other layer
const AppLive = Layer.mergeAll(
  OrderServiceLive,
  UserServiceLive,
).pipe(
  Layer.provide(DatabaseServicesLive),
  Layer.provide(DatabaseLive),
)
```

**Key points:**
- `Layer.effectServices` accepts an `Effect` that returns a `ServiceMap` (built with `ServiceMap.make`/`ServiceMap.add`)
- Use this when multiple services share initialization (e.g., a single database connection producing multiple repos)
- Do NOT use the v3 `Layer.scopedContext` or `Context.make`/`Context.add` — these are replaced by `Layer.effectServices` and `ServiceMap.make`/`ServiceMap.add`

## Scoped Layers

For resources that need cleanup (connection pools, file handles, subscriptions):

```typescript
import { Effect, Layer } from "effect"

// Layer.scoped — acquires a resource and releases it when the scope closes
const DatabaseConnectionLive = Layer.scoped(
  DatabaseConnection,
  Effect.acquireRelease(
    Effect.gen(function* () {
      const pool = yield* createPool(config)
      yield* Effect.log("Database pool created")
      return pool
    }),
    (pool) =>
      Effect.gen(function* () {
        yield* pool.end()
        yield* Effect.log("Database pool closed")
      }).pipe(Effect.orDie)
  )
)

// Service using a scoped resource
interface UserRepoShape {
  readonly findById: (id: UserId) => Effect.Effect<User | undefined, SqlError>
}

export class UserRepo extends ServiceMap.Service<UserRepo, UserRepoShape>()(
  "app/UserRepo"
) {
  static readonly layer = Layer.effect(
    UserRepo,
    Effect.gen(function* () {
      const db = yield* DatabaseConnection

      const findById = Effect.fn("UserRepo.findById")(function* (id: UserId) {
        return yield* db.query("SELECT * FROM users WHERE id = $1", [id])
      })

      return UserRepo.of({ findById })
    })
  )
}

// Wire the scoped layer — cleanup happens automatically when the app shuts down
const UserRepoLive = UserRepo.layer.pipe(
  Layer.provide(DatabaseConnectionLive),
)
```

## Testing Layer Composition

```typescript
// test/setup.ts
import { Layer } from "effect"

export const TestLive = Layer.mergeAll(
  UserServiceTest,
  OrderServiceTest,
  ProductServiceTest,
).pipe(
  Layer.provide(InMemoryDatabaseLive),
)

// test/user.test.ts
import { Effect } from "effect"
import { expect, test } from "bun:test"
import { TestLive } from "./setup"

test("creates users", async () => {
  const program = Effect.gen(function* () {
    const userService = yield* UserService
    const user = yield* userService.create({
      email: "test@example.com",
      name: "Test User",
    })
    expect(user.email).toBe("test@example.com")
  })

  await Effect.runPromise(program.pipe(Effect.provide(TestLive)))
})
```

**Swap individual layers for testing:**

```typescript
// Replace only the payment service for testing
const TestWithMockPayment = Layer.mergeAll(
  UserServiceLive,
  OrderServiceLive,
  PaymentServiceTest, // Mock payments, real everything else
).pipe(
  Layer.provide(InMemoryDatabaseLive),
)
```

## Layer.effect vs Layer.succeed

```typescript
// Layer.succeed — for static values (no effects needed to construct)
const ConfigLive = Layer.succeed(AppConfig, AppConfig.of({
  port: 3000,
  env: "development",
}))

// Layer.effect — when construction needs effects (reading config, accessing other services)
const LoggerLive = Layer.effect(
  Logger,
  Effect.gen(function* () {
    const config = yield* AppConfig
    const transport = config.env === "production"
      ? createCloudTransport()
      : createConsoleTransport()
    return Logger.of(new LoggerImpl(transport))
  })
)
```

**When to use which:**

| Use | When |
|-----|------|
| `Layer.succeed` | Value is known at definition time, no deps needed |
| `Layer.effect` | Construction requires `yield*` (reading services, config, logging) |
| `Layer.scoped` | Construction acquires a resource that needs cleanup |
| `Layer.unwrapEffect` | Construction returns a `Layer` (e.g., config-driven layer selection) |
| `Layer.lazy` | Expensive initialization that should be deferred |

## Lazy Layers

For expensive initialization that should be deferred:

```typescript
const ExpensiveServiceLive = Layer.lazy(() => {
  // This code runs only when the layer is first used
  return Layer.effect(
    ExpensiveService,
    Effect.gen(function* () {
      yield* Effect.log("Initializing expensive service...")
      const client = yield* createExpensiveClient()
      return ExpensiveService.of(new ExpensiveServiceImpl(client))
    })
  )
})
```

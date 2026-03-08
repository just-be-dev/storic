# Service Patterns

## ServiceMap.Service Over Context.Tag

**Always use `ServiceMap.Service`** for defining business logic services. This is the v4 replacement for `Effect.Service` and `Context.Tag`, and provides:

1. **Type-safe service shape** — The shape interface is declared as a type parameter, enforcing the contract at compile time
2. **Explicit layer definition** — Layers are defined as static properties, making dependency wiring visible and composable
3. **`Service.of()` constructor** — Type-safe construction of the service value
4. **`Service.use()` accessor** — One-shot service access without manual `yield*`

### v3 vs v4 Comparison

```typescript
// ❌ v3 — FORBIDDEN (removed APIs)
import { Effect, Layer } from "effect"

class UserService extends Effect.Service<UserService>()("UserService", {
    accessors: true,                    // REMOVED in v4
    dependencies: [UserRepo.Default],   // REMOVED in v4
    effect: Effect.gen(function* () {
        const repo = yield* UserRepo
        return { findById: Effect.fn("UserService.findById")(function* (id: UserId) {
            return yield* repo.findById(id)
        }) }
    }),
}) {}

// v3 usage — proxy accessors
const program = UserService.findById(userId)  // REMOVED in v4
```

```typescript
// ✅ v4 — CORRECT
import { Effect, Layer, ServiceMap } from "effect"

// 1. Define the shape interface
interface UserServiceShape {
    readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>
}

// 2. Extend ServiceMap.Service with Self, Shape, and identifier
class UserService extends ServiceMap.Service<UserService, UserServiceShape>()(
    "app/UserService"
) {
    // 3. Layer as a static property
    static readonly layer: Layer.Layer<UserService, never, UserRepo> = Layer.effect(
        UserService,
        Effect.gen(function* () {
            const repo = yield* UserRepo

            const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
                return yield* repo.findById(id)
            })

            // 4. Construct with Service.of()
            return UserService.of({ findById })
        })
    )
}

// v4 usage — yield the service, then call methods
const program = Effect.gen(function* () {
    const userService = yield* UserService
    const user = yield* userService.findById(userId)
    return user
})

// Or use Service.use() for one-shot access
const program2 = UserService.use((svc) => svc.findById(userId))
```

**Key differences from v3:**

| v3 (removed) | v4 (current) |
|--------------|--------------|
| `Effect.Service<S>()("id", { effect, accessors, dependencies })` | `ServiceMap.Service<S, Shape>()("id")` + `static layer` |
| `accessors: true` → `Service.method()` | `yield* Service` then `svc.method()`, or `Service.use(...)` |
| `dependencies: [Dep.Default]` | `Layer.provide(Dep.layer)` on the static layer |
| `.Default` (layer convention) | `.layer` (layer convention) |
| `return { method1, method2 }` | `return Service.of({ method1, method2 })` |
| `import { Effect } from "effect"` | `import { Effect, ServiceMap } from "effect"` |

## Basic Service Definition

Every service follows the same three-part structure: **shape interface**, **class extending ServiceMap.Service**, and **static layer**.

```typescript
import { Effect, Layer, Option, ServiceMap } from "effect"

// ── 1. Shape interface ──────────────────────────────────────
// Declares the public contract. Every method returns an Effect.
interface UserServiceShape {
    readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>
    readonly findByEmail: (email: string) => Effect.Effect<Option.Option<User>>
    readonly create: (input: CreateUserInput) => Effect.Effect<User, UserCreateError>
}

// ── 2. Class extending ServiceMap.Service ───────────────────
// The identifier uses "namespace/ServiceName" format.
export class UserService extends ServiceMap.Service<UserService, UserServiceShape>()(
    "app/UserService"
) {
    // ── 3. Static layer ─────────────────────────────────────
    static readonly layer: Layer.Layer<UserService, never, UserRepo | CacheService> =
        Layer.effect(
            UserService,
            Effect.gen(function* () {
                const repo = yield* UserRepo
                const cache = yield* CacheService

                const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
                    const cached = yield* cache.get(`user:${id}`)
                    if (Option.isSome(cached)) return cached.value as User
                    const user = yield* repo.findById(id)
                    yield* cache.set(`user:${id}`, user)
                    return user
                })

                const findByEmail = Effect.fn("UserService.findByEmail")(function* (email: string) {
                    return yield* repo.findByEmail(email)
                })

                const create = Effect.fn("UserService.create")(function* (input: CreateUserInput) {
                    const user = yield* repo.create(input)
                    yield* Effect.log("User created", { userId: user.id })
                    return user
                })

                return UserService.of({ findById, findByEmail, create })
            })
        )
}
```

### Identifier Naming Convention

Use `"namespace/ServiceName"` for identifiers:

```typescript
// Application services
"app/UserService"
"app/OrderService"
"app/NotificationService"

// Infrastructure
"infra/CacheService"
"infra/EmailClient"

// Domain-specific
"billing/InvoiceService"
"auth/SessionService"
```

## Service with Dependencies

Dependencies are wired on the static layer using `Layer.provide`. Create a composed layer variable for use at the app root.

```typescript
import { Effect, Layer, ServiceMap } from "effect"

interface OrderServiceShape {
    readonly create: (input: CreateOrderInput) => Effect.Effect<Order, OrderCreateError | InsufficientInventoryError>
    readonly findById: (id: OrderId) => Effect.Effect<Order, OrderNotFoundError>
}

export class OrderService extends ServiceMap.Service<OrderService, OrderServiceShape>()(
    "app/OrderService"
) {
    // The raw layer declares its requirements in the type
    static readonly layer: Layer.Layer<
        OrderService,
        never,
        UserService | ProductService | InventoryService
    > = Layer.effect(
        OrderService,
        Effect.gen(function* () {
            const users = yield* UserService
            const products = yield* ProductService
            const inventory = yield* InventoryService

            const create = Effect.fn("OrderService.create")(function* (input: CreateOrderInput) {
                // Validate user exists
                const user = yield* users.findById(input.userId)

                // Check product availability
                const product = yield* products.findById(input.productId)
                const available = yield* inventory.checkAvailability(input.productId, input.quantity)

                if (!available) {
                    return yield* Effect.fail(new InsufficientInventoryError({
                        productId: input.productId,
                        message: "Not enough inventory",
                    }))
                }

                yield* Effect.log("Order created", { userId: user.id, productId: product.id })
                return yield* persistOrder({ user, product, quantity: input.quantity })
            })

            const findById = Effect.fn("OrderService.findById")(function* (id: OrderId) {
                // ...
            })

            return OrderService.of({ create, findById })
        })
    )
}

// ── Wire dependencies on the layer ─────────────────────────
// This is the live layer with all dependencies resolved.
const OrderServiceLive = OrderService.layer.pipe(
    Layer.provide(UserService.layer),
    Layer.provide(ProductService.layer),
    Layer.provide(InventoryService.layer),
)

// ── App root — flat composition ─────────────────────────────
const AppLive = Layer.mergeAll(
    OrderServiceLive,
    NotificationServiceLive,
    AnalyticsServiceLive,
).pipe(
    Layer.provide(DatabaseLive),
    Layer.provide(RedisLive),
)
```

## Wrong: Leaking Dependencies

"Leaking" means a service's layer requires dependencies that aren't provided on the layer itself, forcing every usage site to provide them manually.

```typescript
// ❌ WRONG — Dependencies not provided on the layer
export class OrderService extends ServiceMap.Service<OrderService, OrderServiceShape>()(
    "app/OrderService"
) {
    // Layer type leaks UserService as a requirement
    static readonly layer = Layer.effect(
        OrderService,
        Effect.gen(function* () {
            const users = yield* UserService  // Dependency not wired!
            // ...
            return OrderService.of({ /* ... */ })
        })
    )
}

// Now every usage site must manually provide UserService
const program = Effect.gen(function* () {
    const orders = yield* OrderService
    return yield* orders.create(input)
}).pipe(
    Effect.provide(OrderService.layer),
    Effect.provide(UserService.layer),  // Annoying and error-prone
)
```

```typescript
// ✅ CORRECT — Wire dependencies on the layer itself
export class OrderService extends ServiceMap.Service<OrderService, OrderServiceShape>()(
    "app/OrderService"
) {
    static readonly layer = Layer.effect(
        OrderService,
        Effect.gen(function* () {
            const users = yield* UserService
            // ...
            return OrderService.of({ /* ... */ })
        })
    )
}

// Dependencies wired once
const OrderServiceLive = OrderService.layer.pipe(
    Layer.provide(UserService.layer),
)

// Usage sites just provide the composed layer
const program = Effect.gen(function* () {
    const orders = yield* OrderService
    return yield* orders.create(input)
}).pipe(
    Effect.provide(OrderServiceLive),
)
```

**Exception:** Infrastructure layers (Database, Redis, HTTP clients) are acceptable to leave as "leaked" requirements because they are provided once at the app root and don't vary between business service consumers. See `layer-patterns.md` for details.

## Effect.fn for Tracing

**Always wrap service methods with `Effect.fn`**. This creates automatic tracing spans with the given name.

### Naming Convention

Use `"ServiceName.methodName"` format:

```typescript
const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
    yield* Effect.annotateCurrentSpan("userId", id)
    return yield* repo.findById(id)
})

const processPayment = Effect.fn("PaymentService.processPayment")(
    function* (orderId: OrderId, amount: number, currency: string) {
        yield* Effect.annotateCurrentSpan("orderId", orderId)
        yield* Effect.annotateCurrentSpan("amount", amount)
        yield* Effect.annotateCurrentSpan("currency", currency)
        // Implementation
    }
)
```

### Annotating Spans

Add important business identifiers to spans, but avoid noise:

```typescript
// ✅ CORRECT — Important business identifiers
yield* Effect.annotateCurrentSpan("userId", userId)
yield* Effect.annotateCurrentSpan("orderId", orderId)
yield* Effect.annotateCurrentSpan("amount", amount)

// ❌ WRONG — Too much detail, creates noise in traces
yield* Effect.annotateCurrentSpan("userEmail", user.email)
yield* Effect.annotateCurrentSpan("userName", user.name)
yield* Effect.annotateCurrentSpan("userCreatedAt", user.createdAt)
yield* Effect.annotateCurrentSpan("step", "validating")
yield* Effect.annotateCurrentSpan("step", "processing")
```

## When Context.Tag-Like Patterns Are Acceptable

For **infrastructure bindings provided by the runtime** (not created by your code), use `ServiceMap.Service` with a thin shape interface. In v4, `Context.Tag` is superseded by `ServiceMap.Service` even for infrastructure.

### Runtime-Provided Infrastructure

```typescript
import { Effect, Layer, ServiceMap } from "effect"

// ── Cloudflare Worker Bindings ──────────────────────────────
// These are provided by the runtime, not constructed by our code.
// Use ServiceMap.Service with an opaque shape type.

interface KVNamespaceShape {
    readonly get: (key: string) => Effect.Effect<string | null>
    readonly put: (key: string, value: string) => Effect.Effect<void>
}

export class KVNamespace extends ServiceMap.Service<KVNamespace, KVNamespaceShape>()(
    "infra/KVNamespace"
) {
    // Layer.succeed for runtime-provided values
    static layerFrom(kv: CloudflareKVNamespace): Layer.Layer<KVNamespace> {
        return Layer.succeed(
            KVNamespace,
            KVNamespace.of({
                get: (key) => Effect.tryPromise(() => kv.get(key)),
                put: (key, value) => Effect.tryPromise(() => kv.put(key, value)),
            })
        )
    }
}

// In the worker entry point
const handler = {
    fetch(request: Request, env: Env) {
        return program.pipe(
            Effect.provide(KVNamespace.layerFrom(env.MY_KV)),
            Effect.runPromise,
        )
    }
}
```

### Database/Redis Clients

```typescript
// Library-provided clients (e.g., @effect/sql) already define their
// own ServiceMap.Service or equivalent — just provide them at the root.
import { PgClient } from "effect/unstable/sql/PgClient"

const DatabaseLive = PgClient.layer({
    host: Config.string("DB_HOST"),
    port: Config.integer("DB_PORT"),
    database: Config.string("DB_NAME"),
    username: Config.string("DB_USER"),
    password: Config.redacted("DB_PASSWORD"),
})
```

## Single Responsibility

Each service should have a focused responsibility. Split large services into smaller, composable ones.

```typescript
// ✅ CORRECT — Focused services with clear boundaries
export class UserService extends ServiceMap.Service<UserService, UserServiceShape>()(
    "app/UserService"
) { /* user CRUD */ }

export class AuthService extends ServiceMap.Service<AuthService, AuthServiceShape>()(
    "app/AuthService"
) { /* authentication and authorization */ }

export class NotificationService extends ServiceMap.Service<NotificationService, NotificationServiceShape>()(
    "app/NotificationService"
) { /* sending notifications */ }
```

```typescript
// ❌ WRONG — God service doing everything
interface AppServiceShape {
    readonly createUser: (input: CreateUserInput) => Effect.Effect<User>
    readonly deleteUser: (id: UserId) => Effect.Effect<void>
    readonly login: (creds: Credentials) => Effect.Effect<Session>
    readonly logout: (sessionId: SessionId) => Effect.Effect<void>
    readonly sendEmail: (to: string, body: string) => Effect.Effect<void>
    readonly sendPush: (userId: UserId, msg: string) => Effect.Effect<void>
    readonly processPayment: (input: PaymentInput) => Effect.Effect<Receipt>
    // ... 50 more methods
}

export class AppService extends ServiceMap.Service<AppService, AppServiceShape>()(
    "app/AppService"
) { /* everything crammed together */ }
```

**Signs a service is too large:**
- More than 6–8 methods in the shape interface
- Methods that don't share dependencies or domain concepts
- Consumers only use a fraction of the service's methods

## Service Interface Patterns

### Return Types

Service methods should always return `Effect` types, never `Promise`:

```typescript
// ✅ CORRECT — Effect return types
interface UserServiceShape {
    readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>
    readonly create: (input: CreateUserInput) => Effect.Effect<User, UserCreateError>
}

// ❌ WRONG — Promise in service interface
interface UserServiceShape {
    readonly findById: (id: UserId) => Promise<User>
    readonly create: (input: CreateUserInput) => Promise<User>
}
```

### Use Option for "Maybe Found" Results

Provide two variants when a lookup may or may not find a result:

```typescript
interface UserServiceShape {
    // Fails with UserNotFoundError if not found
    readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>

    // Returns Option.None if not found — no error in the channel
    readonly findByIdOption: (id: UserId) => Effect.Effect<Option.Option<User>>
}

export class UserService extends ServiceMap.Service<UserService, UserServiceShape>()(
    "app/UserService"
) {
    static readonly layer = Layer.effect(
        UserService,
        Effect.gen(function* () {
            const repo = yield* UserRepo

            const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
                const maybeUser = yield* repo.findById(id)
                return yield* Option.match(maybeUser, {
                    onNone: () => Effect.fail(new UserNotFoundError({ userId: id, message: "Not found" })),
                    onSome: Effect.succeed,
                })
            })

            const findByIdOption = Effect.fn("UserService.findByIdOption")(function* (id: UserId) {
                return yield* repo.findById(id)
            })

            return UserService.of({ findById, findByIdOption })
        })
    )
}
```

### Avoid Leaking Implementation Details

Shape interfaces should express domain concepts, not implementation details:

```typescript
// ✅ CORRECT — Domain-focused interface
interface CacheServiceShape {
    readonly get: (key: string) => Effect.Effect<Option.Option<unknown>>
    readonly set: (key: string, value: unknown, ttl?: number) => Effect.Effect<void>
    readonly invalidate: (key: string) => Effect.Effect<void>
}

// ❌ WRONG — Redis-specific details in the interface
interface CacheServiceShape {
    readonly hget: (hash: string, field: string) => Effect.Effect<string | null>
    readonly pipeline: (commands: RedisCommand[]) => Effect.Effect<unknown[]>
    readonly subscribe: (channel: string) => Effect.Effect<RedisSubscription>
}
```

## Testing Services

### Simple Mocks with Layer.succeed + Service.of

For straightforward tests, create a layer with static return values:

```typescript
import { Effect, Layer, Option } from "effect"
import { expect, test } from "bun:test"

// Mock layer — returns canned data
const UserServiceTest = Layer.succeed(
    UserService,
    UserService.of({
        findById: (id) => Effect.succeed({
            id,
            email: "test@example.com",
            name: "Test User",
        } as User),
        findByIdOption: (id) => Effect.succeed(Option.some({
            id,
            email: "test@example.com",
            name: "Test User",
        } as User)),
        create: (input) => Effect.succeed({
            id: "test-user-id" as UserId,
            ...input,
        } as User),
    })
)

test("OrderService creates an order", async () => {
    const program = Effect.gen(function* () {
        const orders = yield* OrderService
        const order = yield* orders.create({
            userId: "test-user-id" as UserId,
            productId: "test-product-id" as ProductId,
            quantity: 1,
        })
        expect(order).toBeDefined()
    })

    await Effect.runPromise(
        program.pipe(
            Effect.provide(OrderService.layer),
            Effect.provide(UserServiceTest),
            Effect.provide(ProductServiceTest),
            Effect.provide(InventoryServiceTest),
        )
    )
})
```

### Stateful Mocks with ServiceMap.Service

For tests that need to verify state changes (e.g., "create then find"), use a stateful mock service:

```typescript
import { Effect, Layer, Option, Ref, ServiceMap } from "effect"

// Stateful in-memory implementation for testing
interface UserRepoTestShape {
    readonly findById: (id: UserId) => Effect.Effect<Option.Option<User>>
    readonly create: (input: CreateUserInput) => Effect.Effect<User>
}

class UserRepoTest extends ServiceMap.Service<UserRepoTest, UserRepoTestShape>()(
    "test/UserRepo"
) {
    static readonly layer = Layer.effect(
        // Provide as UserRepo — the production service tag
        UserRepo,
        Effect.gen(function* () {
            const store = yield* Ref.make(new Map<string, User>())

            const findById = Effect.fn("UserRepo.findById")(function* (id: UserId) {
                const users = yield* Ref.get(store)
                return Option.fromNullable(users.get(id))
            })

            const create = Effect.fn("UserRepo.create")(function* (input: CreateUserInput) {
                const user: User = {
                    id: crypto.randomUUID() as UserId,
                    ...input,
                }
                yield* Ref.update(store, (m) => new Map(m).set(user.id, user))
                return user
            })

            return UserRepo.of({ findById, create })
        })
    )
}

// Use in tests
test("create then find returns the user", async () => {
    const program = Effect.gen(function* () {
        const users = yield* UserService
        const created = yield* users.create({ email: "a@b.com", name: "Alice" })
        const found = yield* users.findById(created.id)
        expect(found.email).toBe("a@b.com")
    })

    await Effect.runPromise(
        program.pipe(
            Effect.provide(UserService.layer),
            Effect.provide(UserRepoTest.layer),
            Effect.provide(CacheServiceTest.layer),
        )
    )
})
```

### Testing Error Paths

```typescript
// Mock that always fails — for testing error handling
const UserServiceFailure = Layer.succeed(
    UserService,
    UserService.of({
        findById: (id) => Effect.fail(new UserNotFoundError({ userId: id, message: "Not found" })),
        findByIdOption: (_id) => Effect.succeed(Option.none()),
        create: (_input) => Effect.fail(new UserCreateError({ message: "DB down" })),
    })
)

test("handles user-not-found gracefully", async () => {
    const program = Effect.gen(function* () {
        const orders = yield* OrderService
        const result = yield* orders.create({
            userId: "missing" as UserId,
            productId: "p1" as ProductId,
            quantity: 1,
        }).pipe(Effect.flip)  // flip to get the error as success

        expect(result._tag).toBe("UserNotFoundError")
    })

    await Effect.runPromise(
        program.pipe(
            Effect.provide(OrderService.layer),
            Effect.provide(UserServiceFailure),
            Effect.provide(ProductServiceTest),
            Effect.provide(InventoryServiceTest),
        )
    )
})
```

### Composing Test Layers

Group test layers for reuse across test files:

```typescript
// test/layers.ts
import { Layer } from "effect"

export const TestRepos = Layer.mergeAll(
    UserRepoTest.layer,
    OrderRepoTest.layer,
    ProductRepoTest.layer,
)

export const TestServices = Layer.mergeAll(
    UserService.layer,
    OrderService.layer,
    ProductService.layer,
).pipe(
    Layer.provide(TestRepos),
    Layer.provide(CacheServiceTest.layer),
)

// test/order.test.ts
import { TestServices } from "./layers"

test("order flow", async () => {
    const program = Effect.gen(function* () {
        // ...
    })

    await Effect.runPromise(program.pipe(Effect.provide(TestServices)))
})
```

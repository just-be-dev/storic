# Anti-Patterns (Forbidden)

These patterns are **never acceptable** in Effect v4 code. Each is listed with rationale and the correct alternative.

> **Version note:** This covers Effect v4 (`effect-smol`). All code uses v4 APIs: `ServiceMap.Service`, `Schema.TaggedErrorClass`, `Effect.catch`, etc. See `SKILL.md` for the v3 → v4 migration table.

---

## FORBIDDEN: Effect.runSync/runPromise Inside Services

```typescript
// FORBIDDEN
export class UserService extends ServiceMap.Service<UserService, UserServiceShape>()(
  "app/UserService",
) {
  static readonly layer = Layer.effect(
    UserService,
    Effect.gen(function* () {
      const repo = yield* UserRepo;

      const findById = (id: UserId) => {
        // Running effects synchronously breaks composition
        const user = Effect.runSync(repo.findById(id));
        return user;
      };

      return UserService.of({ findById });
    }),
  );
}
```

**Why:** Breaks Effect's composition model, loses error handling, can't be tested, loses tracing. `runSync` will throw on async effects; `runPromise` escapes the Effect world entirely.

**Correct:**

```typescript
const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
  return yield* repo.findById(id);
});
```

---

## FORBIDDEN: throw Inside Effect.gen

```typescript
// FORBIDDEN
yield *
  Effect.gen(function* () {
    const user = yield* repo.findById(id);
    if (!user) {
      throw new Error("User not found"); // Bypasses Effect error channel
    }
    return user;
  });
```

**Why:** Throws bypass Effect's typed error channel, can't be caught with `catchTag`, breaks type safety. The error becomes a defect instead of a tracked failure.

**Correct:**

```typescript
yield *
  Effect.gen(function* () {
    const user = yield* repo.findById(id);
    if (!user) {
      // Option 1: yield* a tagged error directly
      return yield* new UserNotFoundError({ userId: id, message: "Not found" });
      // Option 2: Effect.fail
      return yield* Effect.fail(new UserNotFoundError({ userId: id, message: "Not found" }));
    }
    return user;
  });
```

---

## FORBIDDEN: Effect.catch Losing Type Information

```typescript
// FORBIDDEN (Effect.catch is the v4 rename of v3's Effect.catchAll)
yield *
  someEffect.pipe(
    Effect.catch((err) => Effect.fail(new GenericError({ message: "Something failed" }))),
  );
```

**Why:** Collapses all error types into one generic error. Loses specific error information, makes debugging harder, prevents specific error handling downstream, and the frontend can't show targeted messages.

**Correct:**

```typescript
yield *
  someEffect.pipe(
    Effect.catchTags({
      DatabaseError: (err) => Effect.fail(new ServiceUnavailableError({ message: err.message })),
      ValidationError: (err) => Effect.fail(new BadRequestError({ message: err.message })),
    }),
  );
```

---

## FORBIDDEN: any/unknown Casts

```typescript
// FORBIDDEN
const data = someValue as any;
const result = (await fetch(url)) as unknown as MyType;
```

**Why:** Completely bypasses type safety, can cause runtime errors, loses Effect's type guarantees.

**Correct:**

```typescript
// Use Schema for parsing unknown data
const result = yield * Schema.decodeUnknown(MyType)(someValue);

// Or explicit type guards
if (isMyType(someValue)) {
  // Now safely typed
}
```

---

## FORBIDDEN: Promise in Service Signatures

```typescript
// FORBIDDEN
export class UserService extends ServiceMap.Service<
  UserService,
  {
    readonly findById: (id: UserId) => Promise<User>; // Promise instead of Effect
  }
>()("app/UserService") {
  static readonly layer = Layer.effect(
    UserService,
    Effect.gen(function* () {
      return UserService.of({
        findById: async (id) => {
          /* ... */
        }, // async/Promise
      });
    }),
  );
}
```

**Why:** Loses Effect's typed error handling, can't compose with other Effects, loses tracing/metrics, breaks the Effect composition model.

**Correct:**

```typescript
interface UserServiceShape {
  readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>;
}

export class UserService extends ServiceMap.Service<UserService, UserServiceShape>()(
  "app/UserService",
) {
  static readonly layer = Layer.effect(
    UserService,
    Effect.gen(function* () {
      const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
        // ...
      });
      return UserService.of({ findById });
    }),
  );
}
```

---

## FORBIDDEN: console.log

```typescript
// FORBIDDEN
console.log("Processing order:", orderId);
console.error("Error:", error);
```

**Why:** Not structured, not captured by Effect's logging/telemetry system, lost in production observability pipelines.

**Correct:**

```typescript
yield * Effect.log("Processing order", { orderId });
yield * Effect.logError("Operation failed", { error: String(error) });
```

---

## FORBIDDEN: process.env Directly

```typescript
// FORBIDDEN
const apiKey = process.env.API_KEY;
const port = parseInt(process.env.PORT || "3000");
```

**Why:** No validation, no type safety, fails silently if missing, hard to test, not composable.

**Correct:**

```typescript
const config =
  yield *
  Config.all({
    apiKey: Config.redacted("API_KEY"),
    port: Config.integer("PORT").pipe(Config.withDefault(3000)),
  });
```

---

## FORBIDDEN: Config.secret (Deprecated)

```typescript
// FORBIDDEN (deprecated)
const secretConfig = Config.all({
  apiKey: Config.secret("API_KEY"),
  dbPassword: Config.secret("DB_PASSWORD"),
});
```

**Why:** `Config.secret` is deprecated. Use `Config.redacted` instead, which provides the same functionality with better naming.

**Correct:**

```typescript
import { Config, Redacted } from "effect";

const secretConfig = Config.all({
  apiKey: Config.redacted("API_KEY"), // Returns Redacted<string>
  dbPassword: Config.redacted("DB_PASSWORD"),
});

// Using redacted values
const program = Effect.gen(function* () {
  const { apiKey } = yield* secretConfig;
  const key = Redacted.value(apiKey); // Unwrap when needed
});
```

---

## FORBIDDEN: null/undefined in Domain Types

```typescript
// FORBIDDEN
type User = {
  name: string;
  bio: string | null;
  avatar: string | undefined;
};
```

**Why:** Null/undefined handling is error-prone, loses the explicit "absence" semantics, doesn't compose with Effect's Option-based patterns.

**Correct:**

```typescript
const User = Schema.Struct({
  name: Schema.String,
  bio: Schema.Option(Schema.String),
  avatar: Schema.Option(Schema.String),
});
```

---

## FORBIDDEN: Option.getOrThrow

```typescript
// FORBIDDEN
const user = Option.getOrThrow(maybeUser);
const name = pipe(maybeName, Option.getOrThrow);
```

**Why:** Throws exceptions, bypasses Effect's error handling, fails at runtime instead of compile time.

**Correct:**

```typescript
// Handle both cases explicitly
yield *
  Option.match(maybeUser, {
    onNone: () => Effect.fail(new UserNotFoundError({ userId, message: "Not found" })),
    onSome: Effect.succeed,
  });

// Or provide a default
const name = Option.getOrElse(maybeName, () => "Anonymous");

// Or use Option.map for transformations
const upperName = Option.map(maybeName, (n) => n.toUpperCase());
```

---

## FORBIDDEN: Using v3 Effect.Service or Context.Tag

These are v3 APIs. Neither exists in Effect v4.

```typescript
// FORBIDDEN — v3 Effect.Service
export class UserService extends Effect.Service<UserService>()("UserService", {
  accessors: true,
  dependencies: [UserRepo.Default],
  effect: Effect.gen(function* () {
    /* ... */
  }),
}) {}

// FORBIDDEN — v3 Context.Tag
export class UserService extends Context.Tag("UserService")<
  UserService,
  { findById: (id: UserId) => Effect.Effect<User, UserNotFoundError> }
>() {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      /* ... */
    }),
  );
}
```

**Why:** `Effect.Service` and `Context.Tag` do not exist in v4. `accessors`, `dependencies`, and `.Default` are all v3 concepts. Proxy accessors (`MyService.method()`) are removed in v4.

**Correct:**

```typescript
import { ServiceMap, Layer, Effect } from "effect";

interface UserServiceShape {
  readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>;
}

export class UserService extends ServiceMap.Service<UserService, UserServiceShape>()(
  "app/UserService",
) {
  // Layer as static property, provide deps with Layer.provide
  static readonly layer = Layer.effect(
    UserService,
    Effect.gen(function* () {
      const repo = yield* UserRepo;

      const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
        return yield* repo.findById(id);
      });

      return UserService.of({ findById });
    }),
  ).pipe(Layer.provide(UserRepo.layer));
}

// Usage — must yield* the service first, no proxy accessors
const program = Effect.gen(function* () {
  const svc = yield* UserService;
  const user = yield* svc.findById(userId);
  return user;
});
```

---

## FORBIDDEN: Using v3 Proxy Accessors (MyService.method)

```typescript
// FORBIDDEN — v3 proxy accessor pattern
const user = yield * UserService.findById(userId);

// Also FORBIDDEN — v3 accessor style
const result = UserService.create(input);
```

**Why:** Proxy accessors were removed in v4. `ServiceMap.Service` does not generate them. Attempting to call `MyService.method()` directly will fail at runtime.

**Correct:**

```typescript
// yield* the service, then call methods on the instance
const program = Effect.gen(function* () {
  const userService = yield* UserService;
  const user = yield* userService.findById(userId);
  return user;
});

// Or use Service.use for one-shot access
const program = UserService.use((svc) => svc.findById(userId));
```

---

## FORBIDDEN: Using v3 Schema.TaggedError

```typescript
// FORBIDDEN — v3 API
export class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()(
  "UserNotFoundError",
  { userId: Schema.String, message: Schema.String },
) {}
```

**Why:** `Schema.TaggedError` is the v3 API. In v4, use `Schema.TaggedErrorClass`.

**Correct:**

```typescript
export class UserNotFoundError extends Schema.TaggedErrorClass<UserNotFoundError>()(
  "UserNotFoundError",
  {
    userId: Schema.String,
    message: Schema.String,
  },
) {}
```

---

## FORBIDDEN: Ignoring Errors with orDie

```typescript
// FORBIDDEN (in most cases)
yield * someEffect.pipe(Effect.orDie);
```

**Why:** Converts recoverable errors to defects (unrecoverable), loses error information, makes failures impossible to handle downstream.

**Acceptable exceptions:**

- Truly unrecoverable situations (invalid program state)
- After exhausting all recovery options
- In test setup code

**Correct:**

```typescript
// Handle errors explicitly
yield *
  someEffect.pipe(
    Effect.catchTag("RecoverableError", (err) =>
      Effect.fail(new DomainError({ message: err.message })),
    ),
  );
```

---

## FORBIDDEN: mapError Instead of catchTag

```typescript
// FORBIDDEN
yield * effect.pipe(Effect.mapError((err) => new GenericError({ message: String(err) })));
```

**Why:** Collapses all error types into one, loses type discrimination, prevents `catchTag`-based handling downstream.

**Correct:**

```typescript
yield *
  effect.pipe(
    Effect.catchTag("SpecificError", (err) =>
      Effect.fail(new MappedError({ message: err.message })),
    ),
  );
```

---

## FORBIDDEN: Mixing Effect and Promise Chains

```typescript
// FORBIDDEN
const result = await someEffect.pipe(Effect.runPromise).then((data) => {
  // Mixing Promise chain with Effect
  return Effect.runPromise(anotherEffect(data));
});
```

**Why:** Loses Effect composition benefits, error handling becomes inconsistent, breaks tracing, creates multiple independent runtimes.

**Correct:**

```typescript
const program = Effect.gen(function* () {
  const data = yield* someEffect;
  return yield* anotherEffect(data);
});

// Single runPromise at the edge
const result = await Effect.runPromise(program);
```

---

## FORBIDDEN: Mutable State Without Ref

```typescript
// FORBIDDEN
let counter = 0;
const increment = Effect.sync(() => {
  counter++;
});
```

**Why:** Race conditions in concurrent code, not testable, not composable, breaks referential transparency.

**Correct:**

```typescript
const program = Effect.gen(function* () {
  const counter = yield* Ref.make(0);
  yield* Ref.update(counter, (n) => n + 1);
  return yield* Ref.get(counter);
});
```

---

## FORBIDDEN: Using Date.now() or new Date() Directly

```typescript
// FORBIDDEN
const now = new Date();
const timestamp = Date.now();
```

**Why:** Not testable, introduces non-determinism, hard to mock in tests. Effect provides `Clock` for testable time access.

**Correct:**

```typescript
import { Clock } from "effect";

const now = yield * Clock.currentTimeMillis;
```

---

## FORBIDDEN: Forgetting Layer.provide on Service Layers (Leaked Deps)

```typescript
// FORBIDDEN — layer uses UserRepo but doesn't provide it
export class OrderService extends ServiceMap.Service<OrderService, OrderServiceShape>()(
  "app/OrderService",
) {
  static readonly layer = Layer.effect(
    OrderService,
    Effect.gen(function* () {
      const users = yield* UserService; // Dependency used but not provided!
      const repo = yield* OrderRepo; // Another leaked dependency!

      const create = Effect.fn("OrderService.create")(function* (input: CreateOrderInput) {
        const user = yield* users.findById(input.userId);
        // ...
      });

      return OrderService.of({ create });
    }),
  );
  // Missing: .pipe(Layer.provide(UserService.layer), Layer.provide(OrderRepo.layer))
}
```

**Why:** Every consumer of `OrderService.layer` must manually provide the missing dependencies. This is error-prone, verbose, and easy to forget — causing runtime failures instead of compile-time errors at the layer definition.

**Correct:**

```typescript
export class OrderService extends ServiceMap.Service<OrderService, OrderServiceShape>()(
  "app/OrderService",
) {
  static readonly layer = Layer.effect(
    OrderService,
    Effect.gen(function* () {
      const users = yield* UserService;
      const repo = yield* OrderRepo;

      const create = Effect.fn("OrderService.create")(function* (input: CreateOrderInput) {
        const user = yield* users.findById(input.userId);
        // ...
      });

      return OrderService.of({ create });
    }),
  ).pipe(Layer.provide(UserService.layer), Layer.provide(OrderRepo.layer));
}
```

**Note:** Infrastructure dependencies (database, redis) are acceptable to leave unprovided — they are provided once at the application root. Only business-logic service dependencies should be wired on the static layer.

# Error Patterns

## Why Explicit Error Types?

Generic errors like `BadRequestError` or `NotFoundError` seem convenient but create problems:

| Generic Error | Problems |
|--------------|----------|
| `NotFoundError` | Which resource? How should frontend recover? |
| `BadRequestError` | What's invalid? Can user fix it? |
| `UnauthorizedError` | Session expired? Wrong credentials? Missing permission? |
| `InternalServerError` | Retryable? User action needed? |

**Explicit errors enable:**
1. **Specific UI messages** - "Your session expired" vs generic "Unauthorized"
2. **Targeted recovery** - Refresh token vs show login page
3. **Better observability** - Group errors by specific type in dashboards
4. **Type-safe handling** - `catchTag("SessionExpiredError")` vs generic catch

### Anti-Pattern: Generic Error Mapping

```typescript
// ❌ WRONG - Collapsing to generic HTTP errors
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
    "NotFoundError",
    { message: Schema.String },
    HttpApiSchema.annotations({ status: 404 }),
) {}

// At API boundaries:
Effect.catchTags({
    UserNotFoundError: (err) => new NotFoundError({ message: "Not found" }),
    ChannelNotFoundError: (err) => new NotFoundError({ message: "Not found" }),
    MessageNotFoundError: (err) => new NotFoundError({ message: "Not found" }),
})

// Frontend receives: { _tag: "NotFoundError", message: "Not found" }
// - Can't show specific message ("User doesn't exist" vs "Channel was deleted")
// - Can't take specific action (redirect to user search vs channel list)
// - Debugging is harder (which resource was missing?)
```

```typescript
// ✅ CORRECT - Keep explicit errors all the way to frontend
export class UserNotFoundError extends Schema.TaggedErrorClass<UserNotFoundError>()(
    "UserNotFoundError",
    { userId: UserId, message: Schema.String },
    HttpApiSchema.annotations({ status: 404 }),
) {}

export class ChannelNotFoundError extends Schema.TaggedErrorClass<ChannelNotFoundError>()(
    "ChannelNotFoundError",
    { channelId: ChannelId, message: Schema.String },
    HttpApiSchema.annotations({ status: 404 }),
) {}

// Frontend can handle each case:
Result.builder(result)
    .onErrorTag("UserNotFoundError", (err) => <UserNotFoundMessage userId={err.userId} />)
    .onErrorTag("ChannelNotFoundError", (err) => <ChannelDeletedMessage />)
    .onErrorTag("SessionExpiredError", () => <RedirectToLogin />)
    .render()
```

## Error Naming Conventions

| Pattern | Example | Use For |
|---------|---------|---------|
| `{Entity}NotFoundError` | `UserNotFoundError`, `ChannelNotFoundError` | Resource lookups |
| `{Entity}{Action}Error` | `UserCreateError`, `MessageUpdateError` | Mutations that fail |
| `{Feature}Error` | `SessionExpiredError`, `RateLimitExceededError` | Feature-specific failures |
| `{Integration}Error` | `WorkOSUserFetchError`, `StripePaymentError` | External service errors |
| `Invalid{Field}Error` | `InvalidEmailError`, `InvalidPasswordError` | Validation failures |

### Rich Error Context

Include context fields that help with debugging and UI handling:

```typescript
// Entity errors → include entity ID
export class UserNotFoundError extends Schema.TaggedErrorClass<UserNotFoundError>()(
    "UserNotFoundError",
    {
        userId: UserId,         // Which user?
        message: Schema.String,
    },
    HttpApiSchema.annotations({ status: 404 }),
) {}

// Action errors → include input that failed
export class UserCreateError extends Schema.TaggedErrorClass<UserCreateError>()(
    "UserCreateError",
    {
        email: Schema.String,   // What email failed?
        reason: Schema.String,  // Why? "duplicate", "invalid domain"
        message: Schema.String,
    },
    HttpApiSchema.annotations({ status: 400 }),
) {}

// Integration errors → include service name and retryable flag
export class StripePaymentError extends Schema.TaggedErrorClass<StripePaymentError>()(
    "StripePaymentError",
    {
        stripeErrorCode: Schema.String,
        retryable: Schema.Boolean,
        message: Schema.String,
    },
    HttpApiSchema.annotations({ status: 402 }),
) {}

// Auth errors → include expiry info
export class SessionExpiredError extends Schema.TaggedErrorClass<SessionExpiredError>()(
    "SessionExpiredError",
    {
        sessionId: SessionId,
        expiredAt: Schema.DateTimeUtc,
        message: Schema.String,
    },
    HttpApiSchema.annotations({ status: 401 }),
) {}
```

## Schema.TaggedErrorClass for All Errors

**Always use `Schema.TaggedErrorClass`** for defining errors. This provides:

1. **Serialization** - Errors can be sent over RPC/network
2. **Type safety** - `_tag` discriminator enables `catchTag`
3. **Consistent structure** - All errors have predictable shape
4. **HTTP status mapping** - Via `HttpApiSchema.annotations`
5. **Yieldable** - Instances can be yielded directly in `Effect.gen` to fail

> **v4 change:** `Schema.TaggedError` was renamed to `Schema.TaggedErrorClass`. Always use `Schema.TaggedErrorClass`.

### Basic Error Definition

```typescript
import { Schema } from "effect"
import { HttpApiSchema } from "@effect/platform"

export class UserNotFoundError extends Schema.TaggedErrorClass<UserNotFoundError>()(
    "UserNotFoundError",
    {
        userId: UserId,
        message: Schema.String,
    },
    HttpApiSchema.annotations({ status: 404 }),
) {}

export class UserCreateError extends Schema.TaggedErrorClass<UserCreateError>()(
    "UserCreateError",
    {
        message: Schema.String,
        cause: Schema.optional(Schema.String),
    },
    HttpApiSchema.annotations({ status: 400 }),
) {}

export class UnauthorizedError extends Schema.TaggedErrorClass<UnauthorizedError>()(
    "UnauthorizedError",
    {
        message: Schema.String,
    },
    HttpApiSchema.annotations({ status: 401 }),
) {}

export class ForbiddenError extends Schema.TaggedErrorClass<ForbiddenError>()(
    "ForbiddenError",
    {
        message: Schema.String,
        requiredPermission: Schema.optional(Schema.String),
    },
    HttpApiSchema.annotations({ status: 403 }),
) {}
```

### Required Fields

Every error should have:
- `message: Schema.String` - Human-readable description
- Relevant context fields (IDs, etc.)
- Optional `cause: Schema.optional(Schema.String)` for error chains

### Yielding Errors Directly (v4)

In Effect v4, `TaggedErrorClass` instances are yieldable. You can `yield*` an error instance inside `Effect.gen` to fail with that error — no need for `Effect.fail`:

```typescript
// ✅ v4 - yield error directly (preferred)
const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
    const maybeUser = yield* repo.findById(id)
    if (Option.isNone(maybeUser)) {
        return yield* new UserNotFoundError({ userId: id, message: "User not found" })
    }
    return maybeUser.value
})

// ✅ Also valid - Effect.fail still works
const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
    const maybeUser = yield* repo.findById(id)
    if (Option.isNone(maybeUser)) {
        return yield* Effect.fail(new UserNotFoundError({ userId: id, message: "User not found" }))
    }
    return maybeUser.value
})
```

Both forms are correct. Yielding the error directly is more concise; `Effect.fail` wrapping is still valid and sometimes clearer in complex expressions.

## Error Handling with catchTag/catchTags

**Never use `Effect.catch` (formerly `catchAll`) or `mapError`** when you can use `catchTag`/`catchTags`. These preserve type information and enable precise error handling.

### catchTag for Single Error Types

```typescript
const findUser = Effect.fn("UserService.findUser")(function* (id: UserId) {
    return yield* repo.findById(id).pipe(
        Effect.catchTag("DatabaseError", (err) =>
            new UserNotFoundError({
                userId: id,
                message: `Database lookup failed: ${err.message}`,
            })
        ),
    )
})
```

### catchTags for Multiple Error Types

```typescript
const processOrder = Effect.fn("OrderService.processOrder")(function* (input: OrderInput) {
    return yield* validateAndProcess(input).pipe(
        Effect.catchTags({
            ValidationError: (err) =>
                new OrderValidationError({
                    message: err.message,
                    field: err.field,
                }),
            PaymentError: (err) =>
                new OrderPaymentError({
                    message: `Payment failed: ${err.message}`,
                    code: err.code,
                }),
            InventoryError: (err) =>
                new OrderInventoryError({
                    productId: err.productId,
                    message: "Insufficient inventory",
                }),
        }),
    )
})
```

> **v4 note:** In `catchTag`/`catchTags` handlers, you can return a new error instance directly (it's yieldable) instead of wrapping with `Effect.fail(...)`. Both forms work.

## Why Not Effect.catch (formerly catchAll)?

> **v4 rename:** `Effect.catchAll` → `Effect.catch`. The function is the same but the name changed.

```typescript
// ❌ WRONG - Loses type information
yield* effect.pipe(
    Effect.catch((err) =>
        new InternalServerError({ message: "Something failed" })
    )
)

// Problems:
// 1. Can't distinguish error types downstream
// 2. Hides useful error context
// 3. Makes debugging harder
// 4. Frontend can't show specific messages
```

`Effect.catch` collapses the entire error union into a single type, erasing the discriminated union that makes `catchTag` work. Always prefer `catchTag`/`catchTags` for handling specific errors.

### Other v4 Error Handling Renames

| v3 | v4 | Notes |
|----|-----|-------|
| `Effect.catchAll` | `Effect.catch` | Catches all errors — avoid when possible |
| `Effect.catchAllCause` | `Effect.catchCause` | Catches full Cause including defects |
| `Effect.catchSome` | `Effect.catchFilter` | Catches errors matching a predicate |
| `Effect.catchTag` | `Effect.catchTag` | **Unchanged** — preferred approach |
| `Effect.catchTags` | `Effect.catchTags` | **Unchanged** — preferred approach |

## Error Remapping Pattern

Create reusable error remapping functions for common transformations:

```typescript
import { Effect } from "effect"

export const withRemapDbErrors = <A, E, R>(
    effect: Effect.Effect<A, E | DatabaseError | ConnectionError, R>,
    context: { entityType: string; entityId: string }
): Effect.Effect<A, E | EntityNotFoundError | ServiceUnavailableError, R> =>
    effect.pipe(
        Effect.catchTag("DatabaseError", (err) =>
            new EntityNotFoundError({
                entityType: context.entityType,
                entityId: context.entityId,
                message: `${context.entityType} not found`,
            })
        ),
        Effect.catchTag("ConnectionError", (err) =>
            new ServiceUnavailableError({
                message: "Database connection unavailable",
                cause: err.message,
            })
        ),
    )

// Usage
const findUser = Effect.fn("UserService.findUser")(function* (id: UserId) {
    return yield* repo.findById(id).pipe(
        withRemapDbErrors({ entityType: "User", entityId: id })
    )
})
```

## Retryable Errors Pattern

For errors that may be transient, add a `retryable` property:

```typescript
export class ServiceUnavailableError extends Schema.TaggedErrorClass<ServiceUnavailableError>()(
    "ServiceUnavailableError",
    {
        message: Schema.String,
        cause: Schema.optional(Schema.String),
        retryable: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    },
    HttpApiSchema.annotations({ status: 503 }),
) {}

export class RateLimitError extends Schema.TaggedErrorClass<RateLimitError>()(
    "RateLimitError",
    {
        message: Schema.String,
        retryAfter: Schema.optional(Schema.Number),
        retryable: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    },
    HttpApiSchema.annotations({ status: 429 }),
) {}

// Non-retryable error
export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()(
    "ValidationError",
    {
        message: Schema.String,
        field: Schema.String,
        retryable: Schema.optionalWith(Schema.Boolean, { default: () => false }),
    },
    HttpApiSchema.annotations({ status: 400 }),
) {}
```

### Retry Based on Error Property

```typescript
import { Effect, Schedule } from "effect"

const withRetry = <A, E extends { retryable?: boolean }, R>(
    effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
    effect.pipe(
        Effect.retry(
            Schedule.exponential("100 millis").pipe(
                Schedule.intersect(Schedule.recurs(3)),
                Schedule.whileInput((err: E) => err.retryable === true),
            )
        ),
    )

// Usage
yield* callExternalApi(request).pipe(withRetry)
```

## Error Unions for Activities

When defining workflow activities, use explicit error unions:

```typescript
// Activity error type - union of possible errors
export type GetChannelMembersError =
    | DatabaseError
    | ChannelNotFoundError

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()(
    "DatabaseError",
    {
        message: Schema.String,
        cause: Schema.optional(Schema.String),
        retryable: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    },
) {}

export class ChannelNotFoundError extends Schema.TaggedErrorClass<ChannelNotFoundError>()(
    "ChannelNotFoundError",
    {
        channelId: ChannelId,
        message: Schema.String,
        retryable: Schema.optionalWith(Schema.Boolean, { default: () => false }),
    },
) {}

// In activity definition
yield* Activity.make({
    name: "GetChannelMembers",
    success: ChannelMembersResult,
    error: Schema.Union(DatabaseError, ChannelNotFoundError),
    execute: Effect.gen(function* () {
        // ...
    }),
})
```

## HTTP Status Codes (Without Generic Errors)

**Map HTTP status codes at the error level, not by creating generic error classes.** Each explicit error can have its own HTTP status.

```typescript
// ✅ CORRECT - Domain errors with HTTP status annotations
export class UserNotFoundError extends Schema.TaggedErrorClass<UserNotFoundError>()(
    "UserNotFoundError",
    { userId: UserId, message: Schema.String },
    HttpApiSchema.annotations({ status: 404 }),  // Status on specific error
) {}

export class ChannelNotFoundError extends Schema.TaggedErrorClass<ChannelNotFoundError>()(
    "ChannelNotFoundError",
    { channelId: ChannelId, message: Schema.String },
    HttpApiSchema.annotations({ status: 404 }),  // Same status, different error
) {}

export class SessionExpiredError extends Schema.TaggedErrorClass<SessionExpiredError>()(
    "SessionExpiredError",
    { sessionId: SessionId, expiredAt: Schema.DateTimeUtc, message: Schema.String },
    HttpApiSchema.annotations({ status: 401 }),
) {}

export class InvalidCredentialsError extends Schema.TaggedErrorClass<InvalidCredentialsError>()(
    "InvalidCredentialsError",
    { message: Schema.String },
    HttpApiSchema.annotations({ status: 401 }),  // Same status, different meaning
) {}
```

```typescript
// ❌ WRONG - Generic HTTP error classes
export class UnauthorizedError extends Schema.TaggedErrorClass<UnauthorizedError>()(
    "UnauthorizedError",
    { message: Schema.String },
    HttpApiSchema.annotations({ status: 401 }),
) {}

// Then mapping everything to it - loses critical information!
Effect.catchTags({
    SessionExpiredError: (err) => new UnauthorizedError({ message: "Unauthorized" }),
    InvalidCredentialsError: (err) => new UnauthorizedError({ message: "Unauthorized" }),
    MissingTokenError: (err) => new UnauthorizedError({ message: "Unauthorized" }),
})
// Frontend can't distinguish: expired session vs wrong password vs missing token
```

### When Generic Errors Are Acceptable

Generic errors are only acceptable for **truly unrecoverable internal errors** where:
- The frontend can only show "Something went wrong"
- No user action can fix it
- You're hiding internal details for security

```typescript
// Acceptable for unrecoverable errors
export class InternalServerError extends Schema.TaggedErrorClass<InternalServerError>()(
    "InternalServerError",
    { message: Schema.String, requestId: Schema.optional(Schema.String) },
    HttpApiSchema.annotations({ status: 500 }),
) {}

// Use sparingly - only for truly unexpected errors
Effect.catch((unexpectedError) =>
    new InternalServerError({
        message: "An unexpected error occurred",
        requestId: context.requestId,
    })
)
```

## Error Logging

Log errors with structured context:

```typescript
const processWithLogging = Effect.fn("OrderService.process")(function* (orderId: OrderId) {
    return yield* processOrder(orderId).pipe(
        Effect.tapError((err) =>
            Effect.log("Order processing failed", {
                orderId,
                errorTag: err._tag,
                errorMessage: err.message,
            })
        ),
    )
})
```

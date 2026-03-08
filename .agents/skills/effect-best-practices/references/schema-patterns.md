# Schema Patterns

## Branded Types for IDs

**Always brand entity IDs** to prevent accidentally passing the wrong ID type:

```typescript
import { Schema } from "effect"

// Entity IDs — always branded with namespace
// Note: Schema.UUID does not exist in v4. Use Schema.String with Schema.isUUID() check.
export const UserId = Schema.String.pipe(
    Schema.check(Schema.isUUID()),
    Schema.brand("@App/UserId"),
)
export type UserId = Schema.Schema.Type<typeof UserId>

export const OrganizationId = Schema.String.pipe(
    Schema.check(Schema.isUUID()),
    Schema.brand("@App/OrganizationId"),
)
export type OrganizationId = Schema.Schema.Type<typeof OrganizationId>

export const OrderId = Schema.String.pipe(
    Schema.check(Schema.isUUID()),
    Schema.brand("@App/OrderId"),
)
export type OrderId = Schema.Schema.Type<typeof OrderId>

export const ProductId = Schema.String.pipe(
    Schema.check(Schema.isUUID()),
    Schema.brand("@App/ProductId"),
)
export type ProductId = Schema.Schema.Type<typeof ProductId>
```

### Branding Convention

Use `@Namespace/EntityName` format:
- `@App/UserId` - Main application entities
- `@Billing/InvoiceId` - Billing domain entities
- `@External/StripeCustomerId` - External system IDs

### Creating Branded Values

```typescript
// From string (validates UUID format + applies brand)
const userId = Schema.decodeUnknownSync(UserId)("123e4567-e89b-12d3-a456-426614174000")

// Construct directly (validates at runtime)
const newUserId = UserId.makeUnsafe(crypto.randomUUID())

// Type error — can't mix ID types
const order = yield* orderService.findById(userId) // Error: UserId is not OrderId
```

### Schema.Opaque for Lightweight Distinct Types

Use `Schema.Opaque` when you need a distinct type without a full branded schema. This is useful for types that should be opaque to consumers but don't need runtime branding:

```typescript
// Opaque wraps a schema with a distinct type identity
type ApiToken = Schema.Schema.Type<typeof ApiToken>
const ApiToken = Schema.String.pipe(
    Schema.check(Schema.isMinLength(32)),
    Schema.Opaque<ApiToken>(),
)

// The underlying type is string, but TypeScript treats it as distinct
const token: ApiToken = ApiToken.makeUnsafe("abc123...") // validated
const str: string = token // Error: ApiToken is not assignable to string
```

### When NOT to Brand

Don't brand simple strings that don't need type safety:

```typescript
// NOT branded — acceptable for values that don't cross service boundaries ambiguously
export const EmailAddress = Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
)

// These don't need branding because:
// 1. They don't cross service boundaries in ways that could be confused
// 2. They're typically validated by format, not by type
```

## Schema.Struct for Domain Types

**Prefer Schema.Struct** over TypeScript interfaces for domain types:

```typescript
// CORRECT — Schema.Struct
export const User = Schema.Struct({
    id: UserId,
    email: Schema.String,
    name: Schema.String,
    organizationId: OrganizationId,
    role: Schema.Literal("admin", "member", "viewer"),
    createdAt: Schema.DateTimeUtc,
    updatedAt: Schema.DateTimeUtc,
})
export type User = Schema.Schema.Type<typeof User>

// Can derive encoded type for database/API
export type UserEncoded = Schema.Schema.Encoded<typeof User>
```

## Input Types for Mutations

```typescript
export const CreateUserInput = Schema.Struct({
    email: Schema.String.pipe(
        Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
        Schema.annotate({ description: "Valid email address" }),
    ),
    name: Schema.String.pipe(
        Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    ),
    organizationId: OrganizationId,
    // Optional key with a decoding default
    role: Schema.Literal("admin", "member", "viewer").pipe(
        Schema.withDecodingDefault(() => "member" as const),
    ),
})
export type CreateUserInput = Schema.Schema.Type<typeof CreateUserInput>

export const UpdateUserInput = Schema.Struct({
    name: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
    role: Schema.optional(Schema.Literal("admin", "member", "viewer")),
})
export type UpdateUserInput = Schema.Schema.Type<typeof UpdateUserInput>
```

## Schema.decodeTo (Transforms)

In v4, `Schema.transform` and `Schema.transformOrFail` are replaced by `Schema.decodeTo`. Use `SchemaGetter.transform` for pure transforms and `SchemaGetter.transformOrFail` for effectful/fallible transforms.

### Pure Transforms

```typescript
import { Schema, SchemaGetter } from "effect"

// Transform string to number
export const NumberFromString = Schema.String.pipe(
    Schema.decodeTo(Schema.Number, {
        decode: SchemaGetter.transform((s) => Number(s)),
        encode: SchemaGetter.transform((n) => String(n)),
    }),
)

// Comma-separated string to array
export const CommaSeparatedList = Schema.String.pipe(
    Schema.decodeTo(Schema.Array(Schema.String), {
        decode: SchemaGetter.transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
        encode: SchemaGetter.transform((arr) => arr.join(",")),
    }),
)

// Cents to dollars
export const DollarsFromCents = Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.decodeTo(Schema.Number, {
        decode: SchemaGetter.transform((cents) => cents / 100),
        encode: SchemaGetter.transform((dollars) => Math.round(dollars * 100)),
    }),
)
```

### Simple Composition (No Custom Logic)

When composing two schemas without custom transformation logic, use the single-argument form:

```typescript
// Compose — decodes from String through to DateTimeUtc automatically
const MyDate = Schema.String.pipe(Schema.decodeTo(Schema.DateTimeUtcFromString))
```

### Effectful / Fallible Transforms

```typescript
import { Schema, SchemaGetter, SchemaIssue } from "effect"

// Transform that can fail
export const PositiveFromNumber = Schema.Number.pipe(
    Schema.decodeTo(
        Schema.Number.pipe(Schema.brand("Positive")),
        {
            decode: SchemaGetter.transformOrFail((n) =>
                n > 0
                    ? Effect.succeed(n)
                    : Effect.fail(SchemaIssue.make("Must be positive")),
            ),
            encode: SchemaGetter.transform((n) => n),
        },
    ),
)

// JSON string to typed object
export const JsonFromString = <A, I>(schema: Schema.Schema<A, I>) =>
    Schema.String.pipe(
        Schema.decodeTo(schema, {
            decode: SchemaGetter.transformOrFail((s) => {
                try {
                    return Effect.succeed(JSON.parse(s))
                } catch (e) {
                    return Effect.fail(SchemaIssue.make("Invalid JSON"))
                }
            }),
            encode: SchemaGetter.transform((a) => JSON.stringify(a)),
        }),
    )
```

## Checks (Validation / Filtering)

In v4, `Schema.filter(...)` and pipe-based helpers like `Schema.minLength(n)` are replaced by `Schema.check(...)` with `Schema.is*` predicates.

### Using .pipe(Schema.check(...))

```typescript
// String checks
const Name = Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
)

const Email = Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
)

const ZipCode = Schema.String.pipe(
    Schema.check(Schema.isPattern(/^\d{5}(-\d{4})?$/)),
)

// Number checks
const Port = Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65535)),
)

const Quantity = Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
)

// Multiple checks in a single .check() call
const Percentage = Schema.Number.pipe(
    Schema.check(
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(100),
    ),
)
```

### Using Instance Method .check()

Schemas also expose `.check()` as an instance method:

```typescript
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))
```

### Custom Checks with Schema.makeFilter

```typescript
const isEven = Schema.makeFilter<number>((n) =>
    n % 2 === 0 ? undefined : "Must be even"
)

const EvenNumber = Schema.Number.pipe(Schema.check(isEven))
```

### Convenience Schemas

Some common check combinations are pre-built:

```typescript
Schema.Int         // Number that passes isInt()
Schema.Trimmed     // String that passes isTrimmed()
Schema.NonEmptyString // String with isMinLength(1) (non-empty)
```

### Available Check Predicates

| Category | Predicate | Description |
|----------|-----------|-------------|
| String | `isMinLength(n)` | Minimum string length |
| String | `isMaxLength(n)` | Maximum string length |
| String | `isLengthBetween(min, max)` | Length within range |
| String | `isPattern(regex)` | Matches regex pattern |
| String | `isTrimmed()` | No leading/trailing whitespace |
| String | `isUUID()` | Valid UUID (optionally specify version) |
| String | `isULID()` | Valid ULID |
| String | `isBase64()` | Valid Base64 |
| String | `isStartsWith(s)` | Starts with prefix |
| String | `isEndsWith(s)` | Ends with suffix |
| String | `isIncludes(s)` | Contains substring |
| String | `isUppercased()` | All uppercase |
| Number | `isInt()` | Integer value |
| Number | `isFinite()` | Finite number |
| Number | `isGreaterThan(n)` | Exclusive minimum |
| Number | `isGreaterThanOrEqualTo(n)` | Inclusive minimum |
| Number | `isLessThan(n)` | Exclusive maximum |
| Number | `isLessThanOrEqualTo(n)` | Inclusive maximum |
| Number | `isBetween({min, max})` | Within range |

## Schema.Class for Entities with Methods

Use `Schema.Class` when entities need methods. In v4, the API takes an identifier string as the first argument:

```typescript
export class User extends Schema.Class<User>("User")({
    id: UserId,
    email: Schema.String,
    name: Schema.String,
    role: Schema.Literal("admin", "member", "viewer"),
    createdAt: Schema.DateTimeUtc,
}) {
    get isAdmin(): boolean {
        return this.role === "admin"
    }

    get displayName(): string {
        return this.name || this.email.split("@")[0]
    }

    canAccessResource(resource: Resource): boolean {
        if (this.isAdmin) return true
        return resource.ownerId === this.id
    }
}

// Usage
const user = new User({
    id: UserId.makeUnsafe(crypto.randomUUID()),
    email: "alice@example.com",
    name: "Alice",
    role: "member",
    createdAt: DateTime.unsafeNow(),
})

console.log(user.displayName) // "Alice"
console.log(user.isAdmin)     // false
```

### Schema.TaggedClass for Tagged Data Classes

Use `Schema.TaggedClass` for data classes with a `_tag` discriminator:

```typescript
export class Created extends Schema.TaggedClass<Created>("Created")("Created", {
    id: Schema.String,
    createdAt: Schema.DateTimeUtc,
}) {}

export class Updated extends Schema.TaggedClass<Updated>("Updated")("Updated", {
    id: Schema.String,
    updatedAt: Schema.DateTimeUtc,
    fields: Schema.Array(Schema.String),
}) {}

// Use in unions
const DomainEvent = Schema.Union(Created, Updated)
type DomainEvent = Schema.Schema.Type<typeof DomainEvent>
```

## Schema.annotate

Add annotations for documentation, validation messages, and JSON Schema generation. In v4, use `Schema.annotate` (the pipe-based version of v3's `Schema.annotations`):

```typescript
export const CreateOrderInput = Schema.Struct({
    productId: ProductId.pipe(
        Schema.annotate({ description: "The product to order" }),
    ),
    quantity: Schema.Number.pipe(
        Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
        Schema.annotate({
            description: "Number of items to order",
            examples: [1, 5, 10],
        }),
    ),
    shippingAddress: Schema.Struct({
        line1: Schema.String.pipe(Schema.annotate({ description: "Street address" })),
        line2: Schema.optional(Schema.String),
        city: Schema.String,
        state: Schema.String.pipe(Schema.check(Schema.isLengthBetween(2, 2))),
        zip: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{5}(-\d{4})?$/))),
    }).pipe(Schema.annotate({ description: "Shipping destination" })),
}).pipe(
    Schema.annotate({
        title: "Create Order Input",
        description: "Input for creating a new order",
    }),
)
```

## Optional Fields

v4 provides `Schema.optional`, `Schema.optionalKey`, `Schema.withDecodingDefault`, and `Schema.withConstructorDefault`:

```typescript
export const UserPreferences = Schema.Struct({
    // Optional — allows undefined and absent key (type: T | undefined, key?: ...)
    theme: Schema.optional(Schema.Literal("light", "dark")),

    // Optional key — absent key only, no undefined (type: T, key?: ...)
    timezone: Schema.optionalKey(Schema.String),

    // Optional with decoding default — absent/undefined decoded as default value
    language: Schema.String.pipe(
        Schema.withDecodingDefault(() => "en"),
    ),

    // Constructor default — only affects `new Class(...)` / `makeUnsafe`, not decoding
    notificationsEnabled: Schema.Boolean.pipe(
        Schema.withConstructorDefault(() => Option.some(true)),
    ),

    // Nullable — for database compatibility (type: T | null)
    bio: Schema.NullOr(Schema.String),

    // Nullish — allows null, undefined, or absent (type: T | null | undefined)
    nickname: Schema.NullishOr(Schema.String),
})
```

### optional vs optionalKey

| API | Type-level | Missing key | Explicit `undefined` |
|-----|-----------|-------------|---------------------|
| `Schema.optional(S)` | `T \| undefined` | Allowed | Allowed |
| `Schema.optionalKey(S)` | `T` | Allowed | **Not** allowed |

## Union Types and Discriminated Unions

```typescript
// Simple union of literals
export const PaymentMethod = Schema.Union(
    Schema.Literal("card"),
    Schema.Literal("bank_transfer"),
    Schema.Literal("crypto"),
)

// Discriminated union (tagged)
export const PaymentDetails = Schema.Union(
    Schema.Struct({
        _tag: Schema.Literal("Card"),
        cardNumber: Schema.String,
        expiry: Schema.String,
        cvv: Schema.String,
    }),
    Schema.Struct({
        _tag: Schema.Literal("BankTransfer"),
        accountNumber: Schema.String,
        routingNumber: Schema.String,
    }),
    Schema.Struct({
        _tag: Schema.Literal("Crypto"),
        walletAddress: Schema.String,
        network: Schema.Literal("ethereum", "bitcoin", "solana"),
    }),
)
export type PaymentDetails = Schema.Schema.Type<typeof PaymentDetails>

// Usage with match
const processPayment = (details: PaymentDetails) => {
    switch (details._tag) {
        case "Card":
            return processCard(details.cardNumber, details.expiry, details.cvv)
        case "BankTransfer":
            return processBankTransfer(details.accountNumber, details.routingNumber)
        case "Crypto":
            return processCrypto(details.walletAddress, details.network)
    }
}
```

### Tagged Class Unions

When union members need methods, use `Schema.TaggedClass`:

```typescript
class Success extends Schema.TaggedClass<Success>("Success")("Success", {
    data: Schema.Unknown,
}) {
    get isOk() { return true }
}

class Failure extends Schema.TaggedClass<Failure>("Failure")("Failure", {
    error: Schema.String,
}) {
    get isOk() { return false }
}

const Result = Schema.Union(Success, Failure)
```

## Enums and Literals

```typescript
// Use Literal for small, fixed sets (preferred)
export const UserRole = Schema.Literal("admin", "member", "viewer")
export type UserRole = Schema.Schema.Type<typeof UserRole>

// Use Enum for mapping to runtime enum objects
// Note: v4 uses Schema.Enum (singular), not Schema.Enums
const OrderStatusEnum = {
    Pending: "pending",
    Processing: "processing",
    Shipped: "shipped",
    Delivered: "delivered",
    Cancelled: "cancelled",
} as const

export const OrderStatus = Schema.Enum(OrderStatusEnum)
export type OrderStatus = Schema.Schema.Type<typeof OrderStatus>
```

## Recursive Schemas

```typescript
interface Category {
    readonly id: string
    readonly name: string
    readonly children: readonly Category[]
}

export const Category: Schema.Schema<Category> = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    children: Schema.Array(Schema.suspend(() => Category)),
})
```

## Decoding and Encoding

v4 renames the effectful decode/encode functions:

```typescript
// Effectful decode (returns Effect) — use in services
const parseUser = Schema.decodeUnknownEffect(User)
const result = yield* parseUser(rawData) // Effect<User, SchemaError>

// Sync decode — only in controlled contexts where failure should throw
const user = Schema.decodeUnknownSync(User)(rawData) // throws on failure

// Effectful encode — for serialization
const encodeUser = Schema.encodeEffect(User)
const encoded = yield* encodeUser(user) // Effect<UserEncoded, SchemaError>

// Sync encode
const encodedSync = Schema.encodeSync(User)(user)
```

### v3 → v4 Decode/Encode API Mapping

| v3 | v4 |
|----|-----|
| `Schema.decodeUnknown(S)` (returns Effect) | `Schema.decodeUnknownEffect(S)` |
| `Schema.decodeUnknownSync(S)` | `Schema.decodeUnknownSync(S)` (unchanged) |
| `Schema.encode(S)` (returns Effect) | `Schema.encodeEffect(S)` |
| `Schema.encodeSync(S)` | `Schema.encodeSync(S)` (unchanged) |
| `Schema.decodeSync(S)` | `Schema.decodeSync(S)` (unchanged) |

### v3 → v4 Schema API Mapping (Full)

| v3 | v4 |
|----|-----|
| `Schema.UUID` | `Schema.String.pipe(Schema.check(Schema.isUUID()))` |
| `Schema.transform(from, to, {decode, encode})` | `from.pipe(Schema.decodeTo(to, {decode: SchemaGetter.transform(fn), encode: ...}))` |
| `Schema.transformOrFail(from, to, {decode, encode})` | `from.pipe(Schema.decodeTo(to, {decode: SchemaGetter.transformOrFail(fn), encode: ...}))` |
| `Schema.filter(predicate)` | `Schema.check(Schema.makeFilter(predicate))` |
| `Schema.minLength(n)` | `Schema.check(Schema.isMinLength(n))` |
| `Schema.maxLength(n)` | `Schema.check(Schema.isMaxLength(n))` |
| `Schema.pattern(regex)` | `Schema.check(Schema.isPattern(regex))` |
| `Schema.int()` | `Schema.check(Schema.isInt())` |
| `Schema.positive()` | `Schema.check(Schema.isGreaterThan(0))` |
| `Schema.length(n)` | `Schema.check(Schema.isLengthBetween(n, n))` |
| `Schema.annotations({...})` | `Schema.annotate({...})` |
| `Schema.optionalWith(S, {default})` | `S.pipe(Schema.withDecodingDefault(fn))` |
| `Schema.optional(S, {exact: true})` | `Schema.optionalKey(S)` |
| `Schema.Enums(obj)` | `Schema.Enum(obj)` |
| `Schema.TaggedError` | `Schema.TaggedErrorClass` |
| `brand.make(value)` | `schema.makeUnsafe(value)` |
| `ParseResult.succeed / ParseResult.fail` | `Effect.succeed / Effect.fail` with `SchemaIssue` |

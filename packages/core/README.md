# @storic/core

The core implementation of Storic - a schema-versioned datastore with automatic lens-based transformations.

## Overview

`@storic/core` provides a flexible datastore that allows you to:

- **Version schemas** using content-addressable hashing (SHA256)
- **Store entities** under specific schema versions
- **Define bidirectional lenses** to transform data between schema versions
- **Query entities** with automatic projection to any reachable schema version
- **Index data** using SQLite's JSON expression syntax

## Installation

```bash
bun add @storic/core
```

## Core Concepts

### Store

The `Store` service provides the main API for interacting with your data. It manages schemas, entities, and lenses.

### Schemas

Schemas are defined using Effect Schema syntax and are automatically versioned by hashing their definition. Each schema gets a unique ID that represents its exact structure.

### Lenses

Lenses define bidirectional transformations between schema versions. They consist of:

- `forward`: Transform from version A to version B
- `backward`: Transform from version B to version A

Lenses are composable - the store automatically finds transformation paths between any two connected schema versions.

### JsEvaluator

An abstraction over JavaScript expression evaluation. The default implementation uses `new Function()`, but can be swapped with alternative implementations (like `@storic/cloudflare` for sandboxed evaluation).

## Quick Start

```typescript
import { Console, Effect, Layer } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import { layer as sqliteLayer } from "@effect/sql-sqlite-bun/SqliteClient";
import { Store, JsEvaluator } from "@storic/core";

// Setup layers
const SqlLive = sqliteLayer({ filename: ":memory:" });
const StoreLive = Store.layer.pipe(Layer.provide(Layer.mergeAll(SqlLive, JsEvaluator.Eval)));

// Use the store
const program = Effect.gen(function* () {
  const store = yield* Store;

  // Register a schema
  const userV1 = yield* store.registerSchema(
    "User",
    `S.Struct({ firstName: S.String, lastName: S.String, email: S.String })`,
  );

  // Create an entity
  const alice = yield* store.createEntity(userV1.id, {
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@example.com",
  });

  // Read it back
  const entity = yield* store.getEntity(alice.id);
  yield* Console.log(entity.data);
});

BunRuntime.runMain(Effect.provide(program, StoreLive));
```

## API Reference

### Store Methods

#### Schema Management

- `registerSchema(name: string, def: string)` - Register a new schema version
- `getSchema(id: string)` - Retrieve a schema by ID
- `listSchemas(name?: string)` - List all schemas, optionally filtered by name

#### Entity Management

- `createEntity(schemaId: string, data: unknown, options?)` - Create a new entity
- `getEntity(id: string, options?)` - Get an entity, optionally projecting to a different schema
- `listEntities(schemaId: string, options?)` - List entities, optionally with projection
- `updateEntity(id: string, data: unknown, options?)` - Update an entity (merge or replace)
- `deleteEntity(id: string)` - Delete an entity

#### Lens Management

- `registerLens(options)` - Register a bidirectional lens between two schemas
- `getLens(from: string, to: string)` - Retrieve a specific lens
- `listLenses(schemaId?: string)` - List all lenses, optionally filtered by schema

#### Indexing

- `createIndex(name: string, expression: string)` - Create a SQLite JSON expression index
- `dropIndex(name: string)` - Drop an index
- `listIndexes()` - List all indexes

## Effect Integration

`@storic/core` is built on [Effect](https://effect.website), providing:

- Type-safe error handling with discriminated error types
- Composable service layers for dependency injection
- Structured concurrency and resource management
- First-class support for Effect's ecosystem

## Error Types

All operations return `Effect` types with specific error types:

- `SchemaNotFoundError` - Schema ID doesn't exist
- `EntityNotFoundError` - Entity ID doesn't exist
- `ValidationError` - Data doesn't match schema
- `LensPathNotFoundError` - No transformation path exists between schemas
- `SchemaDefEvalError` - Schema definition evaluation failed
- `TransformError` - Lens transformation failed

## License

MIT

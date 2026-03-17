# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Storic is a schema-versioned datastore with automatic lens-based transformations, built on Effect. It supports evolving data schemas over time via bidirectional lenses with automatic graph-based path discovery.

## Commands

All tasks are defined in `mise.toml` and run via `mise run <task>`:

```bash
mise run build            # Build all packages (uses tsgo)
mise run check            # Type-check all packages (tsgo -b)
mise run test             # Run all tests (bun test)
mise run test:core        # Test @storic/core only
mise run test:cloudflare  # Test @storic/cloudflare only
mise run lint             # Lint with oxlint
mise run fmt              # Format with oxfmt
mise run fmt:check        # Check formatting
mise run example          # Run the schema-versioning example
```

To run a single test file: `bun test packages/core/test/store.test.ts`

## Monorepo Structure

Three packages under `packages/`, all using Effect v4 beta:

- **@storic/core** — Store service, Persistence interface, schema registry, lens graph, error types. No runtime persistence implementation — just the contract.
- **@storic/sql** — SQL-backed Persistence implementation using Effect's `SqlClient`. Single `entities` table with JSON data column and JSON-extracted indexes.
- **@storic/cloudflare** — Cloudflare Durable Objects integration. Adapts DO's `SqlStorage` to Effect's `SqlClient`, provides `StoricObject` base class for DOs with automatic Store setup.

Dependency flow: `cloudflare → sql → core`

## Architecture

**Store** (`core/src/store.ts`) is the main API surface. It manages a **SchemaRegistry** that maps schema tags to schemas and maintains a **LensGraph** — a bidirectional graph of schema transformations. When loading data, the Store finds the shortest transformation path (BFS) between the stored schema version and the requested version, then applies lenses in sequence.

**Persistence** (`core/src/persistence.ts`) is a generic Effect service interface. Implementations (SQL, Cloudflare DO) are provided as Effect Layers.

**Schemas** use Effect's `Schema.TaggedStruct` with a `_tag` discriminator that includes a version identifier (e.g., `"Person.v1"`). Schema versions are content-addressable via SHA256 hashing.

**Lenses** are defined with `defineLens(SchemaA, SchemaB, { decode, encode })` providing bidirectional transformations. The lens graph composes multi-hop transformations automatically.

## Conventions

- **Runtime:** Bun, not Node.js. Use `bun` for running, testing, installing.
- **Build:** `tsgo` (TypeScript native compiler from `@typescript/native-preview`).
- **Linting/Formatting:** `oxlint` and `oxfmt`, not ESLint/Prettier.
- **Effect patterns:** Services use `Effect.Service`, errors use `Schema.TaggedError`, layers compose via `Layer.provide`. All Store operations return `Effect` values.
- **No dotenv** — Bun loads `.env` automatically.

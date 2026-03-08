# Storic

A schema-versioned datastore with automatic lens-based transformations. Built with [Effect](https://effect.website) and designed for evolving data schemas over time.

## Overview

Storic is a monorepo containing multiple packages:

- **[@storic/core](./packages/core)** - Core datastore implementation with schema versioning, lenses, and entity management
- **[@storic/cloudflare](./packages/cloudflare)** - Cloudflare Workers-based JavaScript evaluator for sandboxed execution

## Features

- 🔄 **Schema Versioning** - Content-addressable schema versioning using SHA256 hashing
- 🔍 **Bidirectional Lenses** - Transform data between schema versions automatically
- 🎯 **Projection Queries** - Read entities in any reachable schema version
- 📊 **SQLite Backend** - Fast, reliable storage with JSON expression indexes
- 🛡️ **Type Safety** - Built with Effect for type-safe error handling and dependency injection
- ☁️ **Cloudflare Workers** - Optional sandboxed JavaScript evaluation

## Quick Start

### Installation

```bash
bun install
```

### Build All Packages

```bash
bun run build
```

### Run Example

```bash
bun run example
```

## Package Documentation

- [**@storic/core**](./packages/core/README.md) - Core datastore functionality
- [**@storic/cloudflare**](./packages/cloudflare/README.md) - Cloudflare Workers evaluator

## Development

### Workspace Structure

```
storic/
├── packages/
│   ├── core/           # @storic/core - Core datastore
│   └── cloudflare/     # @storic/cloudflare - Cloudflare evaluator
├── examples/           # Integration examples
├── test/              # Integration tests
└── package.json       # Workspace root
```

### Commands

```bash
# Build
bun run build              # Build all packages
bun run build:core         # Build @storic/core
bun run build:cloudflare   # Build @storic/cloudflare

# Type Checking
bun run check              # Check all packages
bun run check:core         # Check @storic/core
bun run check:cloudflare   # Check @storic/cloudflare

# Testing
bun run test               # Test all packages
bun run test:core          # Test @storic/core
bun run test:cloudflare    # Test @storic/cloudflare

# Examples
bun run example            # Run example integration
```

### Adding a New Package

1. Create directory under `packages/`
2. Add `package.json` with `@storic/` scope
3. Create `tsconfig.json` extending root config
4. Add package reference to root `tsconfig.json`
5. Update workspace scripts in root `package.json`

## Publishing

Individual packages can be published to npm:

```bash
cd packages/core
bun publish

cd packages/cloudflare
bun publish
```

Both packages are configured with `publishConfig: { access: "public" }`.

## Architecture

Storic uses:

- **Effect** for composable, type-safe error handling
- **SQLite** for reliable data storage
- **SHA256** for content-addressable schema IDs
- **Bidirectional lenses** for schema transformations
- **TypeScript project references** for efficient builds

## License

MIT

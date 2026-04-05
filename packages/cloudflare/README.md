# @storic/cloudflare

`JsEvaluator` implementation for Storic using Cloudflare [Dynamic Worker Loaders](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/).

Each evaluation generates a worker module with the expression and bindings injected directly into the source. The module is loaded into an isolated worker with no network access (`globalOutbound: null`), providing true sandboxing.

## Installation

```bash
bun add @storic/cloudflare
```

## Setup

### 1. Add the worker loader binding to your wrangler config

```toml
# wrangler.toml
[[worker_loaders]]
binding = "EVALUATOR"
```

### 2. Wire the layer in your worker

```typescript
import { Effect, Layer } from "effect";
import { Store } from "@storic/core";
import { CloudflareJsEvaluator, WorkerLoaderBinding } from "@storic/cloudflare";

export default {
  async fetch(request: Request, env: Env) {
    const StoreLive = Store.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          SqlLive,
          CloudflareJsEvaluator.layer.pipe(Layer.provide(WorkerLoaderBinding.layer(env.EVALUATOR))),
        ),
      ),
    );

    // use StoreLive ...
  },
};
```

## How it works

When `evaluate(jsExpr, bindings)` is called:

1. Binding names are validated (must be valid JS identifiers)
2. Binding values are JSON-serialized (must be serializable)
3. The expression is wrapped in an IIFE with bindings as parameters/arguments
4. A fresh dynamic worker is spawned via the Worker Loader API
5. The expression evaluates at module initialization time
6. The result is returned via a minimal `fetch` handler

For example, evaluating `a + b` with `{ a: 10, b: 20 }` generates:

```javascript
let __result;
let __error;

try {
  __result = ((a, b) => a + b)(10, 20);
} catch (e) {
  __error = e instanceof Error && e.message ? e.message : String(e);
}

export default {
  fetch() {
    if (__error !== undefined) {
      return Response.json({ error: __error }, { status: 400 });
    }
    const t = typeof __result;
    if (t === "function" || t === "symbol" || t === "undefined") {
      return Response.json({ error: "Result is not JSON-serializable: got " + t }, { status: 400 });
    }
    try {
      return Response.json({ result: __result });
    } catch (e) {
      const msg = e instanceof Error && e.message ? e.message : String(e);
      return Response.json({ error: "Result is not JSON-serializable: " + msg }, { status: 400 });
    }
  },
};
```

This mirrors core's `new Function(...names, 'return (expr)')(...values)` pattern, but runs in an isolated worker with `globalOutbound: null` — no network access, no bindings, no access to the parent worker's environment.

## API

### `CloudflareJsEvaluator.layer`

`Layer.Layer<JsEvaluator, never, WorkerLoaderBinding>`

Provides the `JsEvaluator` service. Requires a `WorkerLoaderBinding`.

### `WorkerLoaderBinding.layer(loader)`

`(loader: WorkerLoader) => Layer.Layer<WorkerLoaderBinding>`

Creates a `WorkerLoaderBinding` layer from the `env.EVALUATOR` binding in your worker.

### `WorkerLoader`

Minimal type for the Cloudflare Worker Loader binding. Matches the `get()` method from the [Worker Loader API](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/).

### `EvaluatorModuleError`

Thrown synchronously by `generateEvaluatorModule` when bindings contain invalid identifier names or non-JSON-serializable values. Wrapped into a `TransformError` by the layer.

## Notes

- **Closed beta**: Dynamic Worker Loaders require [signing up for the closed beta](https://forms.gle/MoeDxE9wNiqdf8ri9). They work locally with `wrangler dev`.
- **Bindings are JSON-serialized**: Functions, classes, symbols, `undefined`, `BigInt`, and circular references cannot be passed as bindings. Binding names must be valid JavaScript identifiers.
- **Results must be JSON-serializable**: If the expression evaluates to a function, symbol, `undefined`, or other non-serializable value, the evaluator returns a `TransformError`.
- **Fresh isolate per evaluation**: Each call uses a random worker ID to avoid stale cached results.
- **Syntax errors**: If the expression has a syntax error, the dynamic worker module fails to parse and the error surfaces through the Worker Loader API (caught as a `TransformError`).

## Testing

```bash
# Unit tests
bun test test/

# E2E tests (requires wrangler)
bun run test:e2e
```

## License

MIT

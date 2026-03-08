import { Effect, Layer, ServiceMap } from "effect";
import { JsEvaluator, TransformError } from "@storic/core";
import {
  generateEvaluatorModule,
  EvaluatorModuleError,
} from "./evaluator-worker.ts";

// ── Worker Loader types ───────────────────────────────────────────────────────

/**
 * Minimal type for the Cloudflare Worker Loader binding's `get` method.
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/
 */
export interface WorkerLoader {
  get(
    id: string,
    getCode: () => Promise<{
      compatibilityDate: string;
      mainModule: string;
      modules: Record<string, string>;
      globalOutbound?: null;
    }>,
  ): WorkerStub;
}

interface WorkerStub {
  getEntrypoint(): { fetch(request: Request | string): Promise<Response> };
}

// ── WorkerLoaderBinding service ───────────────────────────────────────────────

interface WorkerLoaderBindingShape {
  readonly loader: WorkerLoader;
}

/**
 * Service that provides the Worker Loader binding from the consumer's `env`.
 *
 * ## Usage
 *
 * ```typescript
 * // In your worker's fetch handler
 * export default {
 *   fetch(request, env) {
 *     const WorkerLoaderLive = WorkerLoaderBinding.layer(env.EVALUATOR);
 *     // ...
 *   },
 * };
 * ```
 */
export class WorkerLoaderBinding extends ServiceMap.Service<
  WorkerLoaderBinding,
  WorkerLoaderBindingShape
>()("@storic/cloudflare/WorkerLoaderBinding") {
  /**
   * Create a layer from a concrete `WorkerLoader` binding.
   */
  static layer(loader: WorkerLoader): Layer.Layer<WorkerLoaderBinding> {
    return Layer.succeed(WorkerLoaderBinding, WorkerLoaderBinding.of({ loader }));
  }
}

// ── CloudflareJsEvaluator ─────────────────────────────────────────────────────

/**
 * JsEvaluator implementation backed by Cloudflare Dynamic Workers.
 *
 * Each evaluation generates a worker module with the expression and bindings
 * injected directly into the source. The module is loaded into an isolated
 * worker via the Worker Loader API with **no network access**
 * (`globalOutbound: null`).
 *
 * ## Wrangler config (consumer's worker)
 *
 * ```toml
 * [[worker_loaders]]
 * binding = "EVALUATOR"
 * ```
 *
 * ## Wiring
 *
 * ```typescript
 * import { Store, JsEvaluator } from "@storic/core";
 * import { CloudflareJsEvaluator, WorkerLoaderBinding } from "@storic/cloudflare";
 *
 * export default {
 *   async fetch(request, env) {
 *     const StoreLive = Store.layer.pipe(
 *       Layer.provide(Layer.mergeAll(
 *         SqlLive,
 *         CloudflareJsEvaluator.layer.pipe(
 *           Layer.provide(WorkerLoaderBinding.layer(env.EVALUATOR)),
 *         ),
 *       )),
 *     );
 *     // ...
 *   },
 * };
 * ```
 */
export class CloudflareJsEvaluator {
  static readonly layer: Layer.Layer<JsEvaluator, never, WorkerLoaderBinding> =
    Layer.effect(
      JsEvaluator,
      Effect.gen(function* () {
        const { loader } = yield* WorkerLoaderBinding;

        return JsEvaluator.of({
          evaluate: (jsExpr, bindings) =>
            Effect.gen(function* () {
              // Generate the worker module source. This validates binding
              // names (must be valid JS identifiers) and values (must be
              // JSON-serializable) eagerly.
              const moduleCode = yield* Effect.try({
                try: () => generateEvaluatorModule(jsExpr, bindings),
                catch: (cause) =>
                  new TransformError({
                    reason:
                      cause instanceof EvaluatorModuleError
                        ? cause.message
                        : `Failed to generate evaluator module: ${cause}`,
                  }),
              });

              // Use a random ID so each evaluation gets a fresh isolate.
              // The dynamic worker loader may cache by ID, and we do not
              // want stale results from a previous evaluation with
              // different bindings to leak through.
              const workerId = `eval-${crypto.randomUUID()}`;

              const stub = loader.get(workerId, async () => ({
                compatibilityDate: "2025-01-01",
                mainModule: "evaluator.js",
                modules: { "evaluator.js": moduleCode },
                globalOutbound: null,
              }));

              const response = yield* Effect.tryPromise({
                try: () => stub.getEntrypoint().fetch("http://eval"),
                catch: (cause) =>
                  new TransformError({
                    reason: `Dynamic worker fetch failed: ${cause}`,
                  }),
              });

              const body = yield* Effect.tryPromise({
                try: () =>
                  response.json() as Promise<{
                    result?: unknown;
                    error?: string;
                  }>,
                catch: (cause) =>
                  new TransformError({
                    reason: `Failed to parse dynamic worker response: ${cause}`,
                  }),
              });

              // Use `"error" in body` instead of `body.error` so that
              // empty-string errors (which are falsy) are still caught.
              if ("error" in body) {
                return yield* new TransformError({
                  reason: `JS evaluation failed: ${body.error || "(unknown error)"}`,
                });
              }

              return body.result;
            }),
        });
      }),
    );
}

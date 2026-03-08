/**
 * E2E test worker that exercises CloudflareJsEvaluator with the real
 * Worker Loader binding provided by wrangler.
 *
 * POST /eval  { jsExpr, bindings }  →  { result } | { error }
 * GET  /health                      →  { ok: true }
 */
import { Effect, Layer } from "effect";
import { JsEvaluator } from "@storic/core";
import {
  CloudflareJsEvaluator,
  WorkerLoaderBinding,
  type WorkerLoader,
} from "../src/index.ts";

interface Env {
  EVALUATOR: WorkerLoader;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/eval" && request.method === "POST") {
      const body = (await request.json()) as {
        jsExpr: string;
        bindings: Record<string, unknown>;
      };

      const EvaluatorLive = CloudflareJsEvaluator.layer.pipe(
        Layer.provide(WorkerLoaderBinding.layer(env.EVALUATOR)),
      );

      const program = Effect.gen(function* () {
        const evaluator = yield* JsEvaluator;
        return yield* evaluator.evaluate(body.jsExpr, body.bindings);
      });

      const runnable = Effect.provide(program, EvaluatorLive);

      try {
        const result = await Effect.runPromise(runnable);
        return Response.json({ result });
      } catch (error: unknown) {
        // Effect's TaggedErrorClass instances have an empty .message —
        // the actual info is in the tagged fields (e.g. .reason).
        // Fall back to String(error) which includes the JSON payload.
        const message =
          error instanceof Error && error.message
            ? error.message
            : String(error);
        return Response.json({ error: message }, { status: 400 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

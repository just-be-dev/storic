import { Effect, Layer, ServiceMap } from "effect";
import { TransformError } from "./errors.ts";

/**
 * Abstraction over dynamically evaluating a JS expression string.
 *
 * `evaluate` receives:
 *   - `jsExpr`   – a JS expression string (e.g. `(data) => ({ ... })` or
 *                  `S.Struct({ name: S.String })`)
 *   - `bindings` – a record of named values made available to the expression
 *                  (e.g. `{ data: someValue }` or `{ S: Schema }`)
 *
 * It must return the evaluation result or fail with a `TransformError`.
 *
 * Swap the layer to provide a different evaluation strategy
 * (e.g. a sandboxed VM, WASM interpreter, or remote execution service).
 */
interface JsEvaluatorShape {
  readonly evaluate: (
    jsExpr: string,
    bindings: Record<string, unknown>,
  ) => Effect.Effect<unknown, TransformError>;
}

export class JsEvaluator extends ServiceMap.Service<
  JsEvaluator,
  JsEvaluatorShape
>()("datastore/JsEvaluator") {
  /**
   * Default layer that uses `new Function` to evaluate JS expressions.
   * Suitable for Node.js, Bun, and other environments that support
   * dynamic code generation.
   */
  static readonly Eval: Layer.Layer<JsEvaluator> = Layer.succeed(
    JsEvaluator,
    JsEvaluator.of({
      evaluate: (jsExpr, bindings) =>
        Effect.try({
          try: () => {
            const names = Object.keys(bindings);
            const values = Object.values(bindings);
            // eslint-disable-next-line no-new-func
            const fn = new Function(...names, `return (${jsExpr})`);
            return fn(...values);
          },
          catch: (cause) =>
            new TransformError({ reason: `JS evaluation failed: ${cause}` }),
        }),
    }),
  );
}

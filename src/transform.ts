import { Effect } from "effect";
import type { PathStep } from "./types.ts";
import { TransformError } from "./errors.ts";
import { JsEvaluator } from "./evaluator.ts";

/**
 * Evaluate a JS transform string against `data` using the `JsEvaluator`
 * service from context.
 *
 * The transform string should be a function expression like
 * `(data) => ({ ... })`. It is wrapped as `(expr)(data)` so the evaluator
 * executes the call and catches any errors from both parse and runtime.
 */
export const applyTransform = (
  jsStr: string,
  data: unknown
): Effect.Effect<unknown, TransformError, JsEvaluator> =>
  Effect.gen(function* () {
    const evaluator = yield* JsEvaluator;
    return yield* evaluator.evaluate(`(${jsStr})(data)`, { data });
  });

/**
 * Walk a chain of lens steps, applying each transform in sequence.
 */
export const applyLensChain = (
  steps: PathStep[],
  lensMap: Map<string, { forward: string; backward: string }>,
  data: unknown
): Effect.Effect<unknown, TransformError, JsEvaluator> =>
  Effect.gen(function* () {
    let current = data;

    for (const step of steps) {
      const lens = lensMap.get(step.lens_id);
      if (!lens) {
        return yield* new TransformError({
          reason: `Lens ${step.lens_id} not found in map`,
        });
      }
      const src = step.direction === "forward" ? lens.forward : lens.backward;
      current = yield* applyTransform(src, current);
    }

    return current;
  });

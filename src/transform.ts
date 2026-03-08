import { Effect } from "effect";
import type { PathStep } from "./types.ts";
import { TransformError } from "./errors.ts";

/**
 * Evaluate a JS transform string against `data`.
 * The string should be a function expression like `(data) => ({ ... })`.
 */
export const applyTransform = (
  jsStr: string,
  data: unknown
): Effect.Effect<unknown, TransformError> =>
  Effect.try({
    try: () => {
      // eslint-disable-next-line no-new-func
      const fn = new Function("data", `return (${jsStr})(data)`);
      return fn(data);
    },
    catch: (cause) =>
      new TransformError({ reason: `Transform failed: ${cause}` }),
  });

/**
 * Walk a chain of lens steps, applying each transform in sequence.
 */
export const applyLensChain = (
  steps: PathStep[],
  lensMap: Map<string, { forward: string; backward: string }>,
  data: unknown
): Effect.Effect<unknown, TransformError> =>
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

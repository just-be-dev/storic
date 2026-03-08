import type { PathStep } from "./types.js";

export function applyTransform(jsStr: string, data: unknown): unknown {
  // eslint-disable-next-line no-new-func
  const fn = new Function("data", `return (${jsStr})(data)`);
  return fn(data);
}

export function applyLensChain(
  steps: PathStep[],
  lensMap: Map<string, { forward: string; backward: string }>,
  data: unknown
): unknown {
  let current = data;

  for (const step of steps) {
    const lens = lensMap.get(step.lens_id);
    if (!lens) throw new Error(`Lens ${step.lens_id} not found in map`);
    const src = step.direction === "forward" ? lens.forward : lens.backward;
    current = applyTransform(src, current);
  }

  return current;
}

// Matches a valid JS identifier: starts with letter, $, or _, followed by
// alphanumerics, $, or _. Does not allow reserved words but that is a much
// larger list and a binding named "return" would simply cause a runtime error
// inside the IIFE, which the try/catch already handles.
const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * Thrown (synchronously) when `generateEvaluatorModule` receives input that
 * cannot be safely embedded in the generated worker source.
 */
export class EvaluatorModuleError extends Error {
  override readonly name = "EvaluatorModuleError";
}

/**
 * Generates a dynamic worker module that evaluates a JavaScript expression.
 *
 * The expression is wrapped in a function whose parameters are the binding
 * names, replicating how `new Function(...names, 'return (' + expr + ')')` works
 * in the core `JsEvaluator.Eval` implementation. Bindings are passed as arguments.
 *
 * The module is evaluated at initialization time in the isolated worker, and
 * the result is returned via a minimal `fetch` handler.
 *
 * @param jsExpr - The JavaScript expression to evaluate
 * @param bindings - Named values to make available to the expression
 * @returns Worker module source code string
 * @throws {EvaluatorModuleError} if a binding name is not a valid JS identifier
 *   or a binding value is not JSON-serializable
 */
export function generateEvaluatorModule(
  jsExpr: string,
  bindings: Record<string, unknown>,
): string {
  const names = Object.keys(bindings);
  const values = Object.values(bindings);

  // ── Validate binding names ────────────────────────────────────────────
  for (const name of names) {
    if (!VALID_IDENTIFIER.test(name)) {
      throw new EvaluatorModuleError(
        `Binding name ${JSON.stringify(name)} is not a valid JavaScript identifier`,
      );
    }
  }

  // ── Serialize binding values ──────────────────────────────────────────
  const serializedValues: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const json = JSON.stringify(values[i]);
    if (json === undefined) {
      throw new EvaluatorModuleError(
        `Binding ${JSON.stringify(names[i])} has a non-JSON-serializable value (${typeof values[i]})`,
      );
    }
    serializedValues.push(json);
  }

  // Build an IIFE that mirrors `new Function(...names, 'return (expr)')(...values)`.
  // The binding names become parameters and the serialized values become arguments.
  const params = names.join(", ");
  const args = serializedValues.join(", ");

  // The fetch handler uses a try/catch around Response.json to handle the
  // case where __result is not JSON-serializable (e.g. a function or BigInt).
  return `let __result;
let __error;

try {
  __result = ((${params}) => (${jsExpr}))(${args});
} catch (e) {
  __error = (e instanceof Error && e.message) ? e.message : String(e);
}

export default {
  fetch() {
    if (__error !== undefined) {
      return Response.json({ error: __error }, { status: 400 });
    }
    // JSON.stringify silently drops functions, symbols, and undefined.
    // Detect these before calling Response.json so we return a clear error.
    const t = typeof __result;
    if (t === "function" || t === "symbol" || t === "undefined") {
      return Response.json(
        { error: "Result is not JSON-serializable: got " + t },
        { status: 400 },
      );
    }
    try {
      return Response.json({ result: __result });
    } catch (e) {
      const msg = (e instanceof Error && e.message) ? e.message : String(e);
      return Response.json(
        { error: "Result is not JSON-serializable: " + msg },
        { status: 400 },
      );
    }
  },
};
`;
}

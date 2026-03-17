import { Effect } from "effect";
import { PersistenceError } from "@storic/core";
import type { Filter } from "@storic/core";

/** Operator to SQL mapping */
const opToSql: Record<string, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
};

/**
 * Allowed characters for field names used in SQL interpolation.
 * Permits dotted paths like "address.city" and underscores.
 */
const SAFE_FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

/**
 * Validate that a field name is safe for SQL interpolation.
 */
export function validateFieldName(name: string): boolean {
  return SAFE_FIELD_RE.test(name);
}

/**
 * Compile an array of Filters into a SQL WHERE clause fragment.
 * Uses json_extract to access fields inside the data JSON column.
 *
 * Returns the SQL string (without leading AND/WHERE) and the bind values.
 * If filters is empty or undefined, returns null.
 *
 * @example
 * ```ts
 * compileFilters([{ field: "email", op: "eq", value: "alice@example.com" }])
 * // => Effect.succeed({ sql: "json_extract(data, '$.email') = ?", values: ["alice@example.com"] })
 * ```
 */
export function compileFilters(
  filters: ReadonlyArray<Filter> | undefined,
): Effect.Effect<{ sql: string; values: unknown[] } | null, PersistenceError> {
  if (!filters || filters.length === 0) return Effect.succeed(null);

  return Effect.gen(function* () {
    const clauses: string[] = [];
    const values: unknown[] = [];

    for (const filter of filters) {
      if (!validateFieldName(filter.field)) {
        return yield* new PersistenceError({
          message: `Invalid field name in filter: "${filter.field}"`,
        });
      }

      const jsonPath = `json_extract(data, '$.${filter.field}')`;

      if (filter.op === "in") {
        const arr = filter.value as unknown[];
        if (arr.length === 0) {
          // IN with empty array matches nothing
          clauses.push("0 = 1");
        } else {
          const placeholders = arr.map(() => "?").join(", ");
          clauses.push(`${jsonPath} IN (${placeholders})`);
          values.push(...arr);
        }
      } else {
        const sqlOp = opToSql[filter.op];
        if (!sqlOp) {
          return yield* new PersistenceError({
            message: `Unsupported filter operator: ${filter.op}`,
          });
        }
        clauses.push(`${jsonPath} ${sqlOp} ?`);
        values.push(filter.value);
      }
    }

    return { sql: clauses.join(" AND "), values };
  });
}

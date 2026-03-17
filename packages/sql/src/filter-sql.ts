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
 * Compile an array of Filters into a SQL WHERE clause fragment.
 * Uses json_extract to access fields inside the data JSON column.
 *
 * Returns the SQL string (without leading AND/WHERE) and the bind values.
 * If filters is empty or undefined, returns null.
 *
 * @example
 * ```ts
 * compileFilters([{ field: "email", op: "eq", value: "alice@example.com" }])
 * // => { sql: "json_extract(data, '$.email') = ?", values: ["alice@example.com"] }
 * ```
 */
export function compileFilters(
  filters: ReadonlyArray<Filter> | undefined,
): { sql: string; values: unknown[] } | null {
  if (!filters || filters.length === 0) return null;

  const clauses: string[] = [];
  const values: unknown[] = [];

  for (const filter of filters) {
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
        throw new Error(`Unsupported filter operator: ${filter.op}`);
      }
      clauses.push(`${jsonPath} ${sqlOp} ?`);
      values.push(filter.value);
    }
  }

  return { sql: clauses.join(" AND "), values };
}

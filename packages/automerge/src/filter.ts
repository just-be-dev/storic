import type { Filter } from "@storic/core";

/** Allowed characters for field names — permits dotted paths like "address.city". */
const SAFE_FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

/** Validate that a field name is safe for use in queries. */
export function validateFieldName(name: string): boolean {
  return SAFE_FIELD_RE.test(name);
}

/** Resolve a dotted path like "address.city" to the nested value. */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Cache for compiled like-filter regexes. */
const likeRegexCache = new Map<string, RegExp>();

function getLikeRegex(pattern: string): RegExp {
  let re = likeRegexCache.get(pattern);
  if (!re) {
    const rePattern = "^" + pattern.replace(/%/g, ".*").replace(/_/g, ".") + "$";
    re = new RegExp(rePattern);
    likeRegexCache.set(pattern, re);
  }
  return re;
}

function matchesFilter(data: Record<string, unknown>, filter: Filter): boolean {
  const value = getNestedValue(data, filter.field);
  switch (filter.op) {
    case "eq":
      return value === filter.value;
    case "neq":
      return value !== filter.value;
    case "gt":
      return (value as number) > (filter.value as number);
    case "gte":
      return (value as number) >= (filter.value as number);
    case "lt":
      return (value as number) < (filter.value as number);
    case "lte":
      return (value as number) <= (filter.value as number);
    case "in":
      return (filter.value as unknown[]).includes(value);
    case "like": {
      if (typeof value !== "string") return false;
      return getLikeRegex(filter.value as string).test(value);
    }
    default:
      return false;
  }
}

/**
 * Check if a data record matches all the given filters.
 * Returns true if filters is empty or undefined.
 */
export function matchesFilters(
  data: Record<string, unknown>,
  filters?: ReadonlyArray<Filter>,
): boolean {
  if (!filters || filters.length === 0) return true;
  return filters.every((f) => matchesFilter(data, f));
}

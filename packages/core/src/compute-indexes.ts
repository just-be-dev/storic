import type { SchemaRegistry } from "./schema-registry.ts";
import { getIndexedFields } from "./annotations.ts";
import type { IndexSpec } from "./persistence.ts";

/**
 * Compute the expected index name for a field on a tagged type.
 *
 * Format: `idx_{type_with_dots_replaced}__{field}`
 * Example: `idx_Person_v1__email`
 */
function indexName(type: string, field: string): string {
  return `idx_${type.replace(/\./g, "_")}__${field}`;
}

/**
 * Extract declarative IndexSpec objects from all schemas in a registry.
 *
 * Walks every registered schema, finds fields annotated with `{ index: true }`,
 * and returns backend-agnostic index specifications.
 */
export function computeIndexSpecs(registry: SchemaRegistry): IndexSpec[] {
  const specs: IndexSpec[] = [];

  for (const tag of registry.getAllTags()) {
    const schema = registry.getSchemaByTag(tag);
    if (!schema) continue;

    const indexedFields = getIndexedFields(schema);

    for (const field of indexedFields) {
      specs.push({
        name: indexName(tag, field),
        fieldPath: field,
        typeDiscriminator: tag,
      });
    }
  }

  return specs;
}

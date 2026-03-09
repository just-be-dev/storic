import { SchemaAST } from "effect";
import type { AnyTaggedStruct } from "./types.ts";

// ─── Module Augmentation ────────────────────────────────────────────────────

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /** Mark a field for automatic SQLite expression indexing. */
      readonly index?: boolean | undefined;
    }
  }
}

// ─── Field Metadata ─────────────────────────────────────────────────────────

export interface FieldMetadata {
  readonly name: string;
  readonly index: boolean;
}

/**
 * Extract field metadata (including index annotations) from a TaggedStruct schema.
 */
export function extractFieldMetadata(
  schema: AnyTaggedStruct,
): FieldMetadata[] {
  const ast = schema.ast;

  if (!SchemaAST.isObjects(ast)) {
    return [];
  }

  const fields: FieldMetadata[] = [];

  for (const prop of ast.propertySignatures) {
    // Skip the _tag discriminant field
    if (prop.name === "_tag") continue;

    const annotations = SchemaAST.resolve(prop.type);

    fields.push({
      name: String(prop.name),
      index: annotations?.index === true,
    });
  }

  return fields;
}

/**
 * Get the names of indexed fields from a schema.
 */
export function getIndexedFields(schema: AnyTaggedStruct): string[] {
  return extractFieldMetadata(schema)
    .filter((f) => f.index)
    .map((f) => f.name);
}

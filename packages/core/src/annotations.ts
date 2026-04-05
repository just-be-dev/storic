import * as SchemaAST from "effect/SchemaAST";
import type { AnyTaggedStruct } from "./types.ts";
import type { Annotations } from "effect/Schema";

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

export interface FieldMetadata extends Annotations.Augment {
  readonly name: string;
  readonly index: boolean;
}

/**
 * Extract field metadata (including all annotations) from a TaggedStruct schema.
 */
export function extractFieldMetadata(schema: AnyTaggedStruct): FieldMetadata[] {
  const ast = schema.ast;

  if (!SchemaAST.isObjects(ast)) {
    return [];
  }

  const fields: FieldMetadata[] = [];

  for (const prop of ast.propertySignatures) {
    // Skip the _tag discriminant field
    if (prop.name === "_tag") continue;

    // In Effect v4, annotations are stored directly on the AST node
    const annotations = prop.type.annotations as Annotations.Augment | undefined;

    fields.push({
      name: String(prop.name),
      index: annotations?.index === true,
      ...annotations,
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

import { Schema } from "effect";

export type ValidationResult =
  | { success: true }
  | { success: false; message: string };

function parseSchema(def: string): Schema.Any {
  // eslint-disable-next-line no-new-func
  const fn = new Function("S", `return (${def})`);
  return fn(Schema);
}

export function validate(def: string, data: unknown): ValidationResult {
  try {
    const schema = parseSchema(def);
    Schema.decodeUnknownSync(schema)(data);
    return { success: true };
  } catch (e) {
    if (e instanceof Schema.SchemaError) {
      return { success: false, message: e.message };
    }
    throw new Error(`Failed to evaluate schema def: ${e}`);
  }
}

export function assertValid(def: string, data: unknown): void {
  try {
    const schema = parseSchema(def);
    Schema.decodeUnknownSync(schema)(data);
  } catch (e) {
    if (e instanceof Schema.SchemaError) {
      throw new Error(`Validation failed: ${e.message}`);
    }
    throw new Error(`Failed to evaluate schema def: ${e}`);
  }
}

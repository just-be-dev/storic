import { createHash } from "crypto";

export function hashDef(def: string): string {
  return createHash("sha256").update(def.trim()).digest("hex");
}

export function generateId(): string {
  return crypto.randomUUID();
}

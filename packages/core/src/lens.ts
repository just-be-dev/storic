import type { Schema } from "effect";
import type { AnyTaggedStruct, Lens } from "./types.ts";

/**
 * Define a bidirectional lens between two TaggedStruct schemas.
 *
 * The `decode` function converts from `From` → `To` (forward).
 * The `encode` function converts from `To` → `From` (backward).
 *
 * @example
 * ```ts
 * const PersonV1toV2 = defineLens(PersonV1, PersonV2, {
 *   decode: (v1) => ({
 *     _tag: "Person.v2" as const,
 *     fullName: `${v1.firstName} ${v1.lastName}`,
 *     email: v1.email,
 *     age: 0,
 *   }),
 *   encode: (v2) => ({
 *     _tag: "Person.v1" as const,
 *     firstName: v2.fullName.split(" ")[0],
 *     lastName: v2.fullName.split(" ").slice(1).join(" "),
 *     email: v2.email,
 *   }),
 * });
 * ```
 */
export function defineLens<
  From extends AnyTaggedStruct,
  To extends AnyTaggedStruct,
>(
  from: From,
  to: To,
  transformation: {
    readonly decode: (
      input: Schema.Schema.Type<From>,
    ) => Schema.Schema.Type<To>;
    readonly encode: (
      input: Schema.Schema.Type<To>,
    ) => Schema.Schema.Type<From>;
  },
): Lens<From, To> {
  return {
    from,
    to,
    forward: transformation.decode,
    backward: transformation.encode,
  };
}

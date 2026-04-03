import type { Schema } from "effect";
import type { AnyTaggedStruct, Lens } from "./types.ts";
import { getTag } from "./schema-registry.ts";

/**
 * Define a bidirectional lens between two TaggedStruct schemas.
 *
 * The `decode` function converts from `From` → `To` (forward).
 * The `encode` function converts from `To` → `From` (backward).
 *
 * The `_tag` field is injected automatically — you only need to return
 * the data fields.
 *
 * @example
 * ```ts
 * const PersonV1toV2 = defineLens(PersonV1, PersonV2, {
 *   decode: (v1) => ({
 *     fullName: `${v1.firstName} ${v1.lastName}`,
 *     email: v1.email,
 *     age: 0,
 *   }),
 *   encode: (v2) => ({
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
    ) => Omit<Schema.Schema.Type<To>, "_tag">;
    readonly encode: (
      input: Schema.Schema.Type<To>,
    ) => Omit<Schema.Schema.Type<From>, "_tag">;
  },
): Lens<From, To> {
  const toTag = getTag(to);
  const fromTag = getTag(from);
  return {
    from,
    to,
    forward: (input: Schema.Schema.Type<From>) =>
      ({ _tag: toTag, ...transformation.decode(input) }) as Schema.Schema.Type<To>,
    backward: (input: Schema.Schema.Type<To>) =>
      ({ _tag: fromTag, ...transformation.encode(input) }) as Schema.Schema.Type<From>,
  };
}

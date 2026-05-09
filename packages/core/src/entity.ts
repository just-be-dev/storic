import { getTag } from "./schema-registry.ts";
import type { AnyTaggedStruct, Entity, Lens } from "./types.ts";

/**
 * Define an entity — a named bundle of one or more schema versions linked by
 * lenses. The `schema` field is the current/latest version that all Store
 * operations target by default; older versions are inferred from `lenses`.
 *
 * @example
 * ```ts
 * const Person = defineEntity({
 *   schema: PersonV2,            // current
 *   lenses: [PersonV1toV2],      // older versions inferred
 * });
 *
 * // Use it with the Store:
 * yield* store.saveEntity(Person, { fullName, email, age });
 *
 * // Target a specific version explicitly:
 * yield* store.saveEntity(Person, v1Data, { as: PersonV1 });
 * ```
 *
 * Throws if any schema referenced by a lens is not reachable from `schema`
 * through the supplied lenses (catches stray or disconnected lenses).
 */
export function defineEntity<T extends AnyTaggedStruct>(config: {
  readonly schema: T;
  readonly lenses?: ReadonlyArray<Lens>;
}): Entity<T> {
  const lenses = config.lenses ?? [];
  validateConnectivity(config.schema, lenses);
  return {
    _tag: "Entity",
    schema: config.schema,
    lenses,
  };
}

/**
 * Return all schemas belonging to this entity (the root schema plus every
 * schema reachable through the entity's lenses), deduped by tag.
 */
export function entitySchemas(entity: Entity<AnyTaggedStruct>): ReadonlyArray<AnyTaggedStruct> {
  const seen = new Map<string, AnyTaggedStruct>();
  seen.set(getTag(entity.schema), entity.schema);
  for (const lens of entity.lenses) {
    const fromTag = getTag(lens.from);
    const toTag = getTag(lens.to);
    if (!seen.has(fromTag)) seen.set(fromTag, lens.from);
    if (!seen.has(toTag)) seen.set(toTag, lens.to);
  }
  return Array.from(seen.values());
}

function validateConnectivity(schema: AnyTaggedStruct, lenses: ReadonlyArray<Lens>): void {
  const rootTag = getTag(schema);
  const adjacency = new Map<string, Set<string>>();
  const allTags = new Set<string>([rootTag]);

  for (const lens of lenses) {
    const fromTag = getTag(lens.from);
    const toTag = getTag(lens.to);
    allTags.add(fromTag);
    allTags.add(toTag);
    if (!adjacency.has(fromTag)) adjacency.set(fromTag, new Set());
    if (!adjacency.has(toTag)) adjacency.set(toTag, new Set());
    adjacency.get(fromTag)!.add(toTag);
    adjacency.get(toTag)!.add(fromTag);
  }

  const visited = new Set<string>([rootTag]);
  const queue: string[] = [rootTag];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adjacency.get(current);
    if (!neighbors) continue;
    for (const next of neighbors) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  const unreachable: string[] = [];
  for (const tag of allTags) {
    if (!visited.has(tag)) unreachable.push(tag);
  }
  if (unreachable.length > 0) {
    throw new Error(
      `defineEntity: schemas [${unreachable.join(", ")}] are not reachable from "${rootTag}" via the provided lenses`,
    );
  }
}

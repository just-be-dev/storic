/**
 * Atom-shaped bindings for Storic, built on `effect/unstable/reactivity/Atom`
 * and consumable via `@effect/atom-react` hooks.
 *
 * Use this entry when your app already uses effect-atom and you want
 * Storic queries / mutations to participate in the same atom registry,
 * dependency tracking, and runtime.
 *
 * @example
 * ```ts
 * import * as Atom from "effect/unstable/reactivity/Atom";
 * import { useAtomSuspense, useAtomSet } from "@effect/atom-react";
 * import { entityAtom, saveEntityAtom } from "@storic/react/atom";
 *
 * const runtime = Atom.runtime(StoreLive);
 * const personById = entityAtom(runtime, Person);
 * const savePerson = saveEntityAtom(runtime, Person);
 *
 * function PersonView({ id }: { id: string }) {
 *   const result = useAtomSuspense(personById(id));
 *   const save = useAtomSet(savePerson, { mode: "promise" });
 *   // result.value is EntityRecord | null
 * }
 * ```
 */

export {
  entityAtom,
  entitiesAtom,
  saveEntityAtom,
  updateEntityAtom,
  patchEntitiesAtom,
  deleteEntityAtom,
} from "./factories.ts";

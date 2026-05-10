// ─── Provider + context ─────────────────────────────────────────────────────
export { StoricProvider, useStoricStore, useStoricRuntime } from "./provider.tsx";
export type { StoricContextValue, StoricProviderProps } from "./provider.tsx";
export type { StoricRuntime } from "./runtime.ts";

// ─── Read hooks ─────────────────────────────────────────────────────────────
export { useEntity } from "./use-entity.ts";
export { useEntities } from "./use-entities.ts";
export type { UseEntityOptions } from "./use-entity.ts";
export type { UseEntitiesOptions } from "./use-entities.ts";

// ─── Mutation hooks ─────────────────────────────────────────────────────────
export {
  useSaveEntity,
  useUpdateEntity,
  usePatchEntities,
  useDeleteEntity,
} from "./use-mutations.ts";
export type { MutationState } from "./use-mutations.ts";

// ─── Listener hooks ─────────────────────────────────────────────────────────
export { useEntityListener, useEntitiesListener } from "./use-listener.ts";

// ─── Effect-native escape hatches ───────────────────────────────────────────
export { useEffectQuery, useEffectCallback } from "./use-effect-query.ts";

// ─── Stream/state types ─────────────────────────────────────────────────────
export type { StreamState } from "./sync-external-store.ts";

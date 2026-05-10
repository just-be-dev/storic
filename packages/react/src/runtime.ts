import type { ManagedRuntime } from "effect";
import type { Store } from "@storic/core";

/** A runtime that has resolved (or can resolve) the Storic `Store` service. */
export type StoricRuntime = ManagedRuntime.ManagedRuntime<Store, never>;

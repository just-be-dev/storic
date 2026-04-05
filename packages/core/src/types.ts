import type { Schema } from "effect";

// ─── Tagged Struct Constraint ───────────────────────────────────────────────

/**
 * A Schema.Struct that has a `_tag` field (i.e., produced by Schema.TaggedStruct).
 * Used as the base constraint for all store operations.
 *
 * We use a structural constraint that checks for `fields._tag.schema.literal`
 * rather than constraining the full Struct generic, to avoid variance issues
 * with Effect's internal type parameters.
 */
export interface AnyTaggedStruct extends Schema.Top {
  readonly fields: {
    readonly _tag: {
      readonly schema: { readonly literal: string };
    };
  } & Schema.Struct.Fields;
}

// ─── Entity Record ──────────────────────────────────────────────────────────

/** An entity record returned from store queries. */
export interface EntityRecord<T extends AnyTaggedStruct> {
  readonly id: string;
  readonly data: Schema.Schema.Type<T>;
  readonly created_at: number;
  readonly updated_at: number;
}

// ─── Update Mode ────────────────────────────────────────────────────────────

export type UpdateMode = "merge" | "replace";

// ─── Lens ───────────────────────────────────────────────────────────────────

/** A bidirectional lens between two TaggedStruct schemas. */
export interface Lens<
  From extends AnyTaggedStruct = AnyTaggedStruct,
  To extends AnyTaggedStruct = AnyTaggedStruct,
> {
  readonly from: From;
  readonly to: To;
  readonly forward: (data: Schema.Schema.Type<From>) => Schema.Schema.Type<To>;
  readonly backward: (data: Schema.Schema.Type<To>) => Schema.Schema.Type<From>;
}

// ─── Lens Graph Internals ───────────────────────────────────────────────────

export interface LensPathStep {
  readonly fromType: string;
  readonly toType: string;
  readonly transform: (data: unknown) => unknown;
}

export interface LensPath {
  readonly steps: ReadonlyArray<LensPathStep>;
}

// ─── Store Configuration ────────────────────────────────────────────────────

export interface StoreConfig {
  readonly schemas: ReadonlyArray<AnyTaggedStruct>;
  readonly lenses?: ReadonlyArray<Lens>;
}

// ─── Utility ────────────────────────────────────────────────────────────────

/** Extract the tag literal from a TaggedStruct schema. */
export type TagOf<T extends AnyTaggedStruct> = T["fields"]["_tag"]["schema"]["literal"];

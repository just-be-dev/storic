import { LensGraph } from "./lens-graph.ts";
import type {
  AnyTaggedStruct,
  Lens,
  LensPath,
  StoreConfig,
} from "./types.ts";

// ─── Tag Extraction ─────────────────────────────────────────────────────────

/**
 * Extract the `_tag` literal from a TaggedStruct schema.
 */
export function getTag(schema: AnyTaggedStruct): string {
  return schema.fields._tag.schema.literal as string;
}

// ─── Schema Registry ────────────────────────────────────────────────────────

/**
 * An in-memory registry of all schemas and their lens relationships.
 *
 * Created from a `StoreConfig` and used by the Store to:
 * - Look up schemas by tag
 * - Find all connected tags for multi-version queries
 * - Find transformation paths between schema versions
 */
export class SchemaRegistry {
  private readonly schemas: ReadonlyMap<string, AnyTaggedStruct>;
  private readonly lensGraph: LensGraph;

  constructor(config: StoreConfig) {
    // Index schemas by tag
    const schemaMap = new Map<string, AnyTaggedStruct>();
    for (const schema of config.schemas) {
      const tag = getTag(schema);
      schemaMap.set(tag, schema);
    }
    this.schemas = schemaMap;

    // Build lens graph
    this.lensGraph = new LensGraph();
    for (const lens of config.lenses ?? []) {
      const fromTag = getTag(lens.from);
      const toTag = getTag(lens.to);

      this.lensGraph.register({
        fromTag,
        toTag,
        forward: lens.forward as (data: unknown) => unknown,
        backward: lens.backward as (data: unknown) => unknown,
      });
    }
  }

  /** Look up a schema by its `_tag` value. */
  getSchemaByTag(tag: string): AnyTaggedStruct | undefined {
    return this.schemas.get(tag);
  }

  /** Get all registered tags. */
  getAllTags(): string[] {
    return Array.from(this.schemas.keys());
  }

  /**
   * Get all tags connected to the given tag via the lens graph
   * (including the tag itself).
   */
  getConnectedTags(tag: string): string[] {
    return this.lensGraph.getConnectedTags(tag);
  }

  /**
   * Get the shortest transformation path between two tags.
   * Returns `null` if no path exists.
   */
  getPath(fromTag: string, toTag: string): LensPath | null {
    return this.lensGraph.getPath(fromTag, toTag);
  }
}

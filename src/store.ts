import { DatabaseSync } from "node:sqlite";
import { hashDef, generateId } from "./hash.js";
import { computeTransitiveClosure } from "./closure.js";
import { applyLensChain } from "./transform.js";
import { assertValid } from "./validate.js";
import type {
  Schema,
  Lens,
  Entity,
  UpdateMode,
  CreateEntityOptions,
  GetEntityOptions,
  ListEntitiesOptions,
  RegisterLensOptions,
} from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function deserializeEntity(row: Record<string, unknown>): Entity {
  return {
    id: row.id as string,
    schema_id: row.schema_id as string,
    data: JSON.parse(row.data as string),
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ─── Schema manager ───────────────────────────────────────────────────────────

class SchemaManager {
  constructor(private db: DatabaseSync) {}

  register(name: string, def: string): Schema {
    const id = hashDef(def);
    this.db
      .prepare(`INSERT OR IGNORE INTO schemas (id, name, def) VALUES (?, ?, ?)`)
      .run(id, name, def.trim());
    return { id, name, def: def.trim() };
  }

  get(id: string): Schema | undefined {
    return (this.db
      .prepare(`SELECT * FROM schemas WHERE id = ?`)
      .get(id) as Schema | undefined);
  }

  list(): Schema[] {
    return this.db.prepare(`SELECT * FROM schemas`).all() as unknown as Schema[];
  }
}

// ─── Lens manager ─────────────────────────────────────────────────────────────

class LensManager {
  constructor(private db: DatabaseSync) {}

  register(opts: RegisterLensOptions): Lens {
    const existing = this.db
      .prepare(`SELECT * FROM lenses WHERE from_schema = ? AND to_schema = ?`)
      .get(opts.from, opts.to) as Lens | undefined;

    if (existing) return existing;

    const id = generateId();

    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO lenses (id, from_schema, to_schema, forward, backward)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(id, opts.from, opts.to, opts.forward, opts.backward);

      this.rebuildReachability();
    });

    return {
      id,
      from_schema: opts.from,
      to_schema: opts.to,
      forward: opts.forward,
      backward: opts.backward,
    };
  }

  get(id: string): Lens | undefined {
    return this.db
      .prepare(`SELECT * FROM lenses WHERE id = ?`)
      .get(id) as Lens | undefined;
  }

  list(): Lens[] {
    return this.db.prepare(`SELECT * FROM lenses`).all() as unknown as Lens[];
  }

  rebuildReachability(): void {
    const lenses = this.list();
    const rows = computeTransitiveClosure(lenses);

    this.db.prepare(`DELETE FROM schema_reachability`).run();

    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO schema_reachability (from_schema, to_schema, path)
       VALUES (?, ?, ?)`
    );

    for (const row of rows) {
      insert.run(row.from_schema, row.to_schema, JSON.stringify(row.path));
    }
  }

  getLensMap(): Map<string, { forward: string; backward: string }> {
    const lenses = this.list();
    return new Map(
      lenses.map((l) => [l.id, { forward: l.forward, backward: l.backward }])
    );
  }

  getPath(fromSchema: string, toSchema: string) {
    if (fromSchema === toSchema) return [];

    const row = this.db
      .prepare(
        `SELECT path FROM schema_reachability WHERE from_schema = ? AND to_schema = ?`
      )
      .get(fromSchema, toSchema) as { path: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.path);
  }

  /** All schemas that can reach targetSchema (including itself). */
  getAllSourceSchemas(targetSchema: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT from_schema FROM schema_reachability WHERE to_schema = ?`
      )
      .all(targetSchema) as { from_schema: string }[];

    return [targetSchema, ...rows.map((r) => r.from_schema)];
  }
}

// ─── Entity manager ───────────────────────────────────────────────────────────

class EntityManager {
  constructor(
    private db: DatabaseSync,
    private lenses: LensManager,
    private schemas: SchemaManager
  ) {}

  create(
    schemaId: string,
    data: Record<string, unknown>,
    opts: CreateEntityOptions = {}
  ): Entity {
    const schema = this.schemas.get(schemaId);
    if (!schema) throw new Error(`Schema ${schemaId} not found`);

    if (opts.validate !== false) {
      assertValid(schema.def, data);
    }

    const id = opts.id ?? generateId();
    const ts = now();

    this.db
      .prepare(
        `INSERT INTO entities (id, schema_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, schemaId, JSON.stringify(data), ts, ts);

    return { id, schema_id: schemaId, data, created_at: ts, updated_at: ts };
  }

  get(id: string, opts: GetEntityOptions = {}): Entity | undefined {
    const row = this.db
      .prepare(`SELECT * FROM entities WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return undefined;

    const entity = deserializeEntity(row);

    if (opts.as && opts.as !== entity.schema_id) {
      entity.data = this.project(entity, opts.as);
    }

    return entity;
  }

  update(
    id: string,
    data: Record<string, unknown>,
    opts: { mode?: UpdateMode; validate?: boolean } = {}
  ): Entity {
    const row = this.db
      .prepare(`SELECT * FROM entities WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;

    if (!row) throw new Error(`Entity ${id} not found`);

    const existing = deserializeEntity(row);
    const mode = opts.mode ?? "merge";
    const newData = mode === "merge" ? { ...existing.data, ...data } : data;

    if (opts.validate !== false) {
      const schema = this.schemas.get(existing.schema_id);
      if (schema) assertValid(schema.def, newData);
    }

    const ts = now();
    this.db
      .prepare(`UPDATE entities SET data = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(newData), ts, id);

    return { ...existing, data: newData, updated_at: ts };
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM entities WHERE id = ?`).run(id);
  }

  /**
   * List entities matching a schema — includes entities stored under any
   * schema reachable via the lens graph.
   */
  list(schemaId: string, opts: ListEntitiesOptions = {}): Entity[] {
    const sourceSchemas = this.lenses.getAllSourceSchemas(schemaId);
    const placeholders = sourceSchemas.map(() => "?").join(", ");

    const rows = this.db
      .prepare(
        `SELECT * FROM entities WHERE schema_id IN (${placeholders})`
      )
      .all(...sourceSchemas) as Record<string, unknown>[];

    const targetSchema = opts.as ?? schemaId;

    return rows.map((row) => {
      const entity = deserializeEntity(row);
      if (entity.schema_id !== targetSchema) {
        return { ...entity, data: this.project(entity, targetSchema) };
      }
      return entity;
    });
  }

  private project(
    entity: Entity,
    targetSchemaId: string
  ): Record<string, unknown> {
    const path = this.lenses.getPath(entity.schema_id, targetSchemaId);

    if (path === null) {
      throw new Error(
        `No lens path from schema ${entity.schema_id} to ${targetSchemaId}`
      );
    }

    if (path.length === 0) return entity.data;

    const lensMap = this.lenses.getLensMap();
    return applyLensChain(path, lensMap, entity.data) as Record<
      string,
      unknown
    >;
  }
}

// ─── Index manager ────────────────────────────────────────────────────────────

class IndexManager {
  constructor(private db: DatabaseSync) {}

  /**
   * Create an expression index over a JSON path on entities.data.
   * e.g. store.indexes.create("idx_email", "$.email")
   *
   * Queries must use the same expression to hit the index:
   *   WHERE json_extract(data, '$.email') = ?
   */
  create(indexName: string, jsonPath: string, tableName = "entities"): void {
    this.db
      .prepare(
        `CREATE INDEX IF NOT EXISTS "${indexName}"
         ON ${tableName}(json_extract(data, '${jsonPath}'))`
      )
      .run();
  }

  drop(indexName: string): void {
    this.db.prepare(`DROP INDEX IF EXISTS "${indexName}"`).run();
  }

  list(): string[] {
    const rows = this.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'entities'`
      )
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class Store {
  readonly schemas: SchemaManager;
  readonly lenses: LensManager;
  readonly entities: EntityManager;
  readonly indexes: IndexManager;

  private constructor(private db: DatabaseSync) {
    this.schemas = new SchemaManager(db);
    this.lenses = new LensManager(db);
    this.entities = new EntityManager(db, this.lenses, this.schemas);
    this.indexes = new IndexManager(db);
  }

  static open(path: string): Store {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    Store.migrate(db);
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  private static migrate(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schemas (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        def  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lenses (
        id          TEXT PRIMARY KEY,
        from_schema TEXT NOT NULL REFERENCES schemas(id),
        to_schema   TEXT NOT NULL REFERENCES schemas(id),
        forward     TEXT NOT NULL,
        backward    TEXT NOT NULL,
        UNIQUE (from_schema, to_schema)
      );

      CREATE TABLE IF NOT EXISTS schema_reachability (
        from_schema TEXT NOT NULL REFERENCES schemas(id),
        to_schema   TEXT NOT NULL REFERENCES schemas(id),
        path        TEXT NOT NULL,
        PRIMARY KEY (from_schema, to_schema)
      );

      CREATE TABLE IF NOT EXISTS entities (
        id         TEXT PRIMARY KEY,
        schema_id  TEXT NOT NULL REFERENCES schemas(id),
        data       JSON NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entities_schema
        ON entities(schema_id);
    `);
  }
}

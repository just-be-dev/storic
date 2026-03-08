export interface Schema {
  id: string;   // SHA256(def)
  name: string; // human label only
  def: string;  // Effect Schema source string (S = Schema)
}

export interface Lens {
  id: string;
  from_schema: string;
  to_schema: string;
  forward: string;  // JS: (data: unknown) => unknown
  backward: string; // JS: (data: unknown) => unknown
}

export interface Entity {
  id: string;
  schema_id: string;
  data: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export type PathStep = {
  lens_id: string;
  direction: "forward" | "backward";
};

export interface ReachabilityRow {
  from_schema: string;
  to_schema: string;
  path: PathStep[];
}

export type UpdateMode = "merge" | "replace";

export interface CreateEntityOptions {
  id?: string;
  validate?: boolean;
}

export interface GetEntityOptions {
  as?: string; // target schema_id to project into
}

export interface ListEntitiesOptions {
  as?: string; // target schema_id to project into
}

export interface RegisterLensOptions {
  from: string;
  to: string;
  forward: string;
  backward: string;
}

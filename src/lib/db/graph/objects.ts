/**
 * The graph object surface (spec 4.1, 4.3, SR5, SR19).
 *
 * Pure, and shipped to the browser. One container level, the database, holds four kinds: node
 * labels and relationship types, which have rows and columns, and indexes and constraints, which
 * are listed and have no click action in v1. Nothing here reads the server: the catalog
 * (`graph-base-provider.ts` and the engine's own catalog reads) hands rows in, and these functions
 * map them onto the shared object, column and index shapes.
 *
 * A path segment is kind-qualified, so a label and a relationship type of one name never share an
 * address; `DatabaseObject.name` stays the plain name a person reads.
 */
import type { ContainerLevels, DatabaseObject, ObjectKindSpec } from "@/lib/db/types";
import type { ColumnSchema, IndexSchema } from "@/lib/types";

export type GraphKindId = "label" | "relationship_type" | "index" | "constraint";

/** No kind has a source, takes source edits or takes row writes in v1; each says so explicitly. */
const READ_ONLY = { hasSource: false, acceptsSourceEdits: false, acceptsRowWrites: false } as const;

export const GRAPH_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "label", role: "relation", label: "Node label", labelPlural: "Node labels", hasColumns: true, ...READ_ONLY },
  {
    id: "relationship_type",
    role: "relation",
    label: "Relationship type",
    labelPlural: "Relationship types",
    hasColumns: true,
    ...READ_ONLY,
  },
  { id: "index", role: "config", label: "Index", labelPlural: "Indexes", hasColumns: false, ...READ_ONLY },
  {
    id: "constraint",
    role: "config",
    label: "Constraint",
    labelPlural: "Constraints",
    hasColumns: false,
    ...READ_ONLY,
  },
] as const);

export const GRAPH_CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "catalog", label: "Database", labelPlural: "Databases" },
] as const);

/** Each kind's fixed prefix and suffix; the name is everything between them, so it is never escaped. */
const SEGMENT_FORMS: readonly (readonly [GraphKindId, string, string])[] = [
  ["label", "(:", ")"],
  ["relationship_type", "[:", "]"],
  ["index", "INDEX ", ""],
  ["constraint", "CONSTRAINT ", ""],
];

/**
 * The kind-qualified path segment: label `(:Name)`, relationship type `[:NAME]`, index
 * `INDEX name`, constraint `CONSTRAINT name`. Throws `RangeError` for an empty name, which no
 * engine object carries and which would make the segment ambiguous.
 */
export function graphObjectSegment(kind: GraphKindId, name: string): string {
  if (name.length === 0) throw new RangeError(`A graph ${kind} name cannot be empty`);
  const [, prefix, suffix] = SEGMENT_FORMS.find(([id]) => id === kind) as (typeof SEGMENT_FORMS)[number];
  return `${prefix}${name}${suffix}`;
}

/** Inverse of `graphObjectSegment`; undefined for a segment no kind produced. */
export function parseGraphObjectSegment(segment: string): { kind: GraphKindId; name: string } | undefined {
  for (const [kind, prefix, suffix] of SEGMENT_FORMS) {
    if (segment.length > prefix.length + suffix.length && segment.startsWith(prefix) && segment.endsWith(suffix)) {
      return { kind, name: segment.slice(prefix.length, segment.length - suffix.length) };
    }
  }
  return undefined;
}

/** One listed name from the catalog; `detail` is what the catalog read alongside it, if anything. */
export interface GraphCatalogEntry {
  readonly name: string;
  readonly detail?: Record<string, unknown>;
}

/** One property of one label or relationship type; the catalog splits a multi-label row into one row per label. */
export interface GraphPropertyRow {
  readonly owner: string;
  readonly property: string;
  readonly types: readonly string[];
  readonly mandatory: boolean;
}

/** One row of the engine's index listing, as the catalog read it. */
export interface GraphIndexRow {
  readonly name: string;
  readonly type: string;
  readonly entityType: "NODE" | "RELATIONSHIP";
  readonly labelsOrTypes: readonly string[];
  readonly properties: readonly string[];
  readonly state?: string;
  readonly unique?: boolean;
}

const byName = (a: string, b: string) => a.localeCompare(b, "en");

/** Path `[...container, graphObjectSegment(kind, name)]`, name the plain name; sorted by name, duplicates removed. */
export function toDatabaseObjects(
  container: readonly string[],
  kind: GraphKindId,
  entries: readonly GraphCatalogEntry[],
): DatabaseObject[] {
  return [...new Set(entries.map((entry) => entry.name))]
    .sort(byName)
    .map((name) => ({ path: [...container, graphObjectSegment(kind, name)], name, kind }));
}

/**
 * Columns of one label or relationship type from the property rows (others ignored), ordered by
 * property name. A property listed more than once (once per type, or once per label combination)
 * appears once: its types merge in first-seen order and are shown as returned, never parsed, and it
 * is non-nullable only when every row for it says mandatory (SR19).
 */
export function columnsOf(owner: string, rows: readonly GraphPropertyRow[]): ColumnSchema[] {
  const merged = new Map<string, { types: string[]; mandatory: boolean }>();
  for (const row of rows) {
    if (row.owner !== owner) continue;
    const seen = merged.get(row.property);
    if (seen === undefined) {
      merged.set(row.property, { types: [...new Set(row.types)], mandatory: row.mandatory });
      continue;
    }
    for (const type of row.types) if (!seen.types.includes(type)) seen.types.push(type);
    seen.mandatory &&= row.mandatory;
  }
  return [...merged.keys()].sort(byName).map((name) => {
    const { types, mandatory } = merged.get(name) as { types: string[]; mandatory: boolean };
    return { name, type: types.length === 0 ? "ANY" : types.join(" | "), nullable: !mandatory, isPrimary: false };
  });
}

/**
 * `IndexSchema` entries of one label or relationship type, sorted by name: rows of the matching entity
 * type that name the owner. A `LOOKUP` index serves every label or type rather than this one, so it
 * is left out.
 */
export function indexesOf(
  owner: string,
  entity: "NODE" | "RELATIONSHIP",
  rows: readonly GraphIndexRow[],
): IndexSchema[] {
  return rows
    .filter((row) => row.entityType === entity && row.type !== "LOOKUP" && row.labelsOrTypes.includes(owner))
    .map((row) => ({ name: row.name, columns: [...row.properties], unique: row.unique ?? false }))
    .sort((a, b) => byName(a.name, b.name));
}

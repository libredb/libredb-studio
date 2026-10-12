/**
 * Field inference for one collection (spec 5.2): the columns of the documents `describeObject` sampled, expanded into
 * dotted paths to depth 3 and at most 200 fields, each typed in Firestore's type names, `mixed(a|b)` where the
 * documents disagree, nullable where a document lacks the field or holds null, and marked `provenance: "sampled"` so
 * `machineColumns` keeps it from every model surface. `__name__`, the document path, leads and is never sampled.
 *
 * A column name is its segments joined by "."; a path with a segment that itself holds "." is named in the
 * `new FieldPath(...)` form instead, which `where()` reads back as the same path and which no dotted name can equal.
 * A map is a column of its own and is expanded below it until the depth bound, while a vector and an array are
 * leaves. Columns are ordered by the UTF-8 bytes of their names, so a sample whose maps list their keys in another
 * order names the same columns. Every document name an answer carries is checked against this database, and against
 * the collection read, before it is used. Browser-safe: no transport, no `node:` module.
 */
import { QueryError } from "@/lib/db/errors";
import type { ColumnSchema } from "@/lib/types";
import { jsString } from "./console/generators";
import { FIRESTORE_TYPE, LIMITS } from "./constants";
import { displayFieldPath } from "./field-path";
import { compareUtf8, type FirestoreTarget, relativeSegments } from "./names";
import { type FirestoreTypeName, type RestDocument, type RestValue, typeNameOf } from "./values";

/** A document name an answer carried that names no document of this connection's database. */
export const foreignDocumentSentence = (name: string): string =>
  `Firestore answered a document outside this connection's database (${name}), so Studio stopped reading the answer.`;

/** A document name an answer carried that is not a direct child of the collection Studio read. */
export const outsideCollectionSentence = (name: string): string =>
  `Firestore answered a document outside the collection Studio read (${name}), so Studio stopped reading the answer.`;

/** The leading column of every collection: the document path, never sampled. */
export function nameColumn(): ColumnSchema {
  return { name: "__name__", type: "reference", nullable: false, isPrimary: true };
}

/** A column's name: the dotted path, or the `new FieldPath(...)` form when a segment holds ".". */
export function columnName(segments: readonly string[]): string {
  return segments.some((segment) => segment.includes("."))
    ? `new FieldPath(${segments.map(jsString).join(", ")})`
    : displayFieldPath(segments);
}

/** The relative segments of a document name an answer carried; a name of another database, or of a collection, is refused. */
export function documentSegments(target: FirestoreTarget, name: string): string[] {
  const segments = relativeSegments(target, name);
  if (segments === null || segments.length === 0 || segments.length % 2 !== 0)
    throw new QueryError(foreignDocumentSentence(name), FIRESTORE_TYPE);
  return segments;
}

/** The id of a document an answer carried, after checking it is a direct child of `collection` in this database. */
export function collectionChildId(target: FirestoreTarget, collection: readonly string[], name: string): string {
  const segments = documentSegments(target, name);
  const inCollection =
    segments.length === collection.length + 1 && collection.every((segment, index) => segments[index] === segment);
  if (!inCollection) throw new QueryError(outsideCollectionSentence(name), FIRESTORE_TYPE);
  return segments[segments.length - 1];
}

interface FieldStats {
  readonly segments: readonly string[];
  readonly name: string;
  readonly types: Set<FirestoreTypeName>;
  present: number;
}

function mapFields(value: RestValue): Readonly<Record<string, RestValue>> {
  const map = (value as { readonly mapValue?: { readonly fields?: Readonly<Record<string, RestValue>> } }).mapValue;
  return map?.fields ?? {};
}

function visit(
  fields: Readonly<Record<string, RestValue>>,
  prefix: readonly string[],
  stats: Map<string, FieldStats>,
): void {
  for (const [key, value] of Object.entries(fields)) {
    const segments = [...prefix, key];
    // Keyed by the segments: only map keys spelt like `new FieldPath("a` could make two paths share a name.
    const id = JSON.stringify(segments);
    let entry = stats.get(id);
    if (entry === undefined) {
      entry = { segments, name: columnName(segments), types: new Set(), present: 0 };
      stats.set(id, entry);
    }
    entry.present += 1;
    const type = typeNameOf(value);
    entry.types.add(type);
    if (type === "map" && segments.length < LIMITS.sampleDepth) visit(mapFields(value), segments, stats);
  }
}

function typeText(types: ReadonlySet<FirestoreTypeName>): string {
  const named = [...types].filter((type) => type !== "null").sort(compareUtf8);
  if (named.length === 0) return "null";
  return named.length === 1 ? named[0] : `mixed(${named.join("|")})`;
}

/** The columns of a sample: `__name__`, then at most `LIMITS.sampleFields` sampled fields in UTF-8 order of their names. */
export function inferColumns(documents: readonly RestDocument[], target: FirestoreTarget): ColumnSchema[] {
  const stats = new Map<string, FieldStats>();
  for (const document of documents) {
    documentSegments(target, document.name);
    visit(document.fields ?? {}, [], stats);
  }
  const sampled = [...stats.values()]
    .sort((a, b) => compareUtf8(a.name, b.name) || compareUtf8(JSON.stringify(a.segments), JSON.stringify(b.segments)))
    .slice(0, LIMITS.sampleFields)
    .map(
      (entry): ColumnSchema => ({
        name: entry.name,
        type: typeText(entry.types),
        nullable: entry.present < documents.length || entry.types.has("null"),
        isPrimary: false,
        provenance: "sampled",
      }),
    );
  return [nameColumn(), ...sampled];
}

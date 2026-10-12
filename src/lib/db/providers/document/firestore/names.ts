/**
 * Firestore ids, paths and resource names: the id rules of spec 4.1, path split and join, the full resource name
 * and the check that a name belongs to this connection's database, per-segment percent-encoding, and UTF-8 byte
 * order.
 *
 * Every request path is built from segments encoded here one at a time, so an id holding `/`-free text of any kind
 * stays one segment: the shared `rfc3986Encode` spelling (A-Z a-z 0-9 - . _ ~ kept, every other UTF-8 byte as %XX
 * with upper-case hex), written again here because the shared module imports `node:net`. Browser-safe: no Node
 * built-in, no `Buffer`, no server module.
 */
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { DEFAULT_DATABASE_ID, FIRESTORE_TYPE, type FirestoreTarget, LIMITS } from "./constants";

export type { FirestoreTarget } from "./constants";

type IdKind = "collection" | "document";

/** 6 to 30 characters, letter first, no trailing hyphen, after an optional legacy `domain:` prefix. */
const PROJECT_ID = /^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** 4 to 63 characters, letter first, letter or digit last. */
const DATABASE_ID = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Firestore's reserved `__.*__`, matched against the whole id. */
const RESERVED_ID = /^__[\s\S]*__$/;
/** A numeric id from a Datastore import. */
const NUMERIC_ID = /^__id\d+__$/;
const UTF8 = new TextEncoder();

export const NAME_SENTENCES = Object.freeze({
  projectId:
    "Project ID must be 6 to 30 lowercase letters, digits or hyphens, starting with a letter and not ending with a hyphen, optionally after a legacy domain prefix such as example.com:",
  databaseId:
    "Database ID must be empty or (default) for the default database, or 4 to 63 lowercase letters, digits or hyphens, starting with a letter, ending with a letter or digit, and not shaped like a UUID",
  idEmpty: (kind: IdKind): string => `A ${kind} id cannot be empty`,
  idMalformed: (kind: IdKind): string => `A ${kind} id must be well-formed Unicode text`,
  idTooLong: (kind: IdKind): string => `A ${kind} id holds at most 1,500 bytes of UTF-8`,
  idSlash: (kind: IdKind): string => `A ${kind} id cannot contain "/"`,
  idDots: (kind: IdKind): string => `A ${kind} id cannot be "." or ".."`,
  idReserved: (kind: IdKind): string =>
    kind === "document"
      ? 'A document id cannot start and end with "__", except a numeric id from a Datastore import, such as __id42__'
      : 'A collection id cannot start and end with "__"',
  pathEmpty: "The Firestore path is empty; name a collection such as users, or a document such as users/alice",
  pathSegment: (position: number, kind: IdKind, refusal: string): string =>
    `Segment ${position} of the Firestore path is not a valid ${kind} id: ${refusal}`,
  invalidText: "Invalid text: expected well-formed Unicode, so it cannot be percent-encoded",
});

export function projectIdRefusal(id: string): string | null {
  return PROJECT_ID.test(id) ? null : NAME_SENTENCES.projectId;
}

/** "(default)" names the default database; any other id follows the named-database rule. */
export function databaseIdRefusal(id: string): string | null {
  if (id === DEFAULT_DATABASE_ID) return null;
  return DATABASE_ID.test(id) && !UUID_SHAPE.test(id) ? null : NAME_SENTENCES.databaseId;
}

/** Applied to user input and to every id a server answer carries before it is shown or reused. */
export function idRefusal(id: string, kind: IdKind): string | null {
  if (id === "") return NAME_SENTENCES.idEmpty(kind);
  if (!id.isWellFormed()) return NAME_SENTENCES.idMalformed(kind);
  if (UTF8.encode(id).length > LIMITS.maxIdBytes) return NAME_SENTENCES.idTooLong(kind);
  if (id.includes("/")) return NAME_SENTENCES.idSlash(kind);
  if (id === "." || id === "..") return NAME_SENTENCES.idDots(kind);
  if (RESERVED_ID.test(id) && !(kind === "document" && NUMERIC_ID.test(id))) return NAME_SENTENCES.idReserved(kind);
  return null;
}

/** Collection ids at odd positions (1st, 3rd, ...), document ids at even ones; the first failing segment's sentence. */
export function segmentsRefusal(segments: readonly string[]): string | null {
  for (const [index, segment] of segments.entries()) {
    const kind: IdKind = index % 2 === 0 ? "collection" : "document";
    const refusal = idRefusal(segment, kind);
    if (refusal !== null) return NAME_SENTENCES.pathSegment(index + 1, kind, refusal);
  }
  return null;
}

/** A path relative to `documents`, split on "/", each segment checked; throws QueryError naming the bad segment. */
export function splitPath(path: string): string[] {
  if (path === "") throw refuse(NAME_SENTENCES.pathEmpty);
  const segments = path.split("/");
  const refusal = segmentsRefusal(segments);
  if (refusal !== null) throw refuse(refusal);
  return segments;
}

export function isDocumentPath(segments: readonly string[]): boolean {
  return segments.length > 0 && segments.length % 2 === 0;
}

export function databaseName(target: FirestoreTarget): string {
  return `projects/${target.projectId}/databases/${target.databaseId}`;
}

export function documentsName(target: FirestoreTarget): string {
  return `${databaseName(target)}/documents`;
}

/** The unencoded resource name a JSON body carries; [] is the documents root. */
export function fullDocumentName(target: FirestoreTarget, segments: readonly string[]): string {
  const root = documentsName(target);
  return segments.length === 0 ? root : `${root}/${segments.join("/")}`;
}

/**
 * The segments under this database's documents root, [] for the root itself; null when the name belongs to another
 * project or database, or when any segment fails the id rules.
 */
export function relativeSegments(target: FirestoreTarget, name: string): string[] | null {
  const root = documentsName(target);
  if (name === root) return [];
  if (!name.startsWith(`${root}/`)) return null;
  const segments = name.slice(root.length + 1).split("/");
  return segmentsRefusal(segments) === null ? segments : null;
}

/** One path segment, every UTF-8 byte outside A-Z a-z 0-9 - . _ ~ as %XX with upper-case hex. */
export function encodeSegment(text: string): string {
  if (!text.isWellFormed()) throw new DatabaseConfigError(NAME_SENTENCES.invalidText, FIRESTORE_TYPE);
  return encodeURIComponent(text).replace(/[!'()*]/g, (mark) => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function encodeSegments(segments: readonly string[]): string {
  return segments.map(encodeSegment).join("/");
}

/**
 * UTF-8 byte order without encoding: for well-formed text it is code point order, so the comparison walks code
 * points. Answers -1, 0 or 1. Callers pass ids that already passed idRefusal; for a lone surrogate the order is not
 * Buffer.compare order.
 */
export function compareUtf8(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(j) ?? 0;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  return j < b.length ? -1 : 0;
}

/** True when the last segment of a verb request's parent holds ":", which Firestore reads as the verb's start. */
export function verbParentHasColon(segments: readonly string[]): boolean {
  return segments.at(-1)?.includes(":") === true;
}

function refuse(message: string): QueryError {
  return new QueryError(message, FIRESTORE_TYPE);
}

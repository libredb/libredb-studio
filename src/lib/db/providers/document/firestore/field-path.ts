/**
 * Field paths: the console's string form, the `new FieldPath(...)` form, the REST wire form and the grid's display
 * form (spec 5.4). A string path never reads backticks, as the SDK's string paths do not; the wire form adds them.
 * Browser-safe.
 */
import { QueryError } from "@/lib/db/errors";
import { FIRESTORE_TYPE } from "./constants";

export type FieldPathSegments = readonly string[];

/** `FieldPath.documentId()` and the string "__name__". */
export const DOCUMENT_ID: FieldPathSegments = Object.freeze(["__name__"]);

const STRING_PATH = /^[^*~/[\]]+$/;
const SIMPLE_SEGMENT = /^[_a-zA-Z][_a-zA-Z0-9]*$/;

export const FIELD_PATH_SENTENCES = Object.freeze({
  characters:
    'A field path string cannot be empty or contain *, ~, /, [ or ]; use new FieldPath("a", "b") for a field whose name holds one',
  emptySegment: 'A field path string cannot start or end with "." or hold "..", because a field name cannot be empty',
  malformed: "A field name must be well-formed Unicode text",
  noSegments: "new FieldPath() needs at least one field name",
  emptyName: "A field name in new FieldPath(...) cannot be empty",
});

export function parseFieldPathString(text: string): FieldPathSegments {
  if (!STRING_PATH.test(text)) throw refuse(FIELD_PATH_SENTENCES.characters);
  if (!text.isWellFormed()) throw refuse(FIELD_PATH_SENTENCES.malformed);
  const segments = text.split(".");
  if (segments.includes("")) throw refuse(FIELD_PATH_SENTENCES.emptySegment);
  return Object.freeze(segments);
}

export function fieldPathOf(segments: readonly string[]): FieldPathSegments {
  if (segments.length === 0) throw refuse(FIELD_PATH_SENTENCES.noSegments);
  if (segments.includes("")) throw refuse(FIELD_PATH_SENTENCES.emptyName);
  if (!segments.every((segment) => segment.isWellFormed())) throw refuse(FIELD_PATH_SENTENCES.malformed);
  return Object.freeze([...segments]);
}

export function wireFieldPath(path: FieldPathSegments): string {
  return path
    .map((segment) => (SIMPLE_SEGMENT.test(segment) ? segment : `\`${segment.replace(/[\\`]/g, "\\$&")}\``))
    .join(".");
}

export function displayFieldPath(path: FieldPathSegments): string {
  return path.join(".");
}

export function isDocumentId(path: FieldPathSegments): boolean {
  return path.length === 1 && path[0] === "__name__";
}

function refuse(message: string): QueryError {
  return new QueryError(message, FIRESTORE_TYPE);
}

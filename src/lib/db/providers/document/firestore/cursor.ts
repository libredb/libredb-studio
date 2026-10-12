/**
 * The Keys panel cursor (spec 5.3): `"0"` starts any level and ends it; every other cursor is `fsk1.` followed by
 * unpadded base64url of a JSON object `{v, p, a}` (the last entry an id level or a typed-id level returned) or
 * `{v, p, t?, o?}` (Google's page token and the folder still owed at the collection level, at least one of them).
 * `p` is the pattern the cursor was issued for and binds it to that level.
 *
 * A cursor carries a position, never an authority: it holds no credential and no key, and Google's page token goes
 * back to Google byte for byte. The text is held to 2,048 characters before any decoding, the decoded JSON to 1,536
 * bytes, and only the canonical base64url spelling is read. Browser-safe: no `Buffer`.
 */
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { FIRESTORE_TYPE, LIMITS } from "./constants";

export type LevelCursor =
  | { readonly v: 1; readonly p: string; readonly a: string }
  | { readonly v: 1; readonly p: string; readonly t: string; readonly o?: string }
  | { readonly v: 1; readonly p: string; readonly o: string };

export const FIRESTORE_CURSOR_SENTENCES = Object.freeze({
  notEnvelope: "This page's cursor is not one the Keys panel wrote for Firestore: list the level again.",
  version: "This page's cursor was written by another version of Studio: list the level again.",
  otherLevel: "This page's cursor belongs to another level: list the level again.",
  malformed: "This page's cursor holds fields Studio does not read: list the level again.",
  expired: "This listing expired; list the level again",
  tooLong: "This level's position is too long for a page cursor: list the level again with a larger count.",
});

const SPELLING = "fsk1.";
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const FIELDS: ReadonlySet<string> = new Set(["v", "p", "a", "t", "o"]);

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of a canonical unpadded base64url text, or null for any other text. */
function fromBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return toBase64Url(bytes) === text ? bytes : null;
}

function refuse(message: string): DatabaseConfigError {
  return new DatabaseConfigError(message, FIRESTORE_TYPE);
}

/** A non-empty string with no lone surrogate, which no request path can spell. */
function text(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.isWellFormed();
}

function cursorOf(record: Readonly<Record<string, unknown>>): LevelCursor | undefined {
  if (Object.keys(record).some((field) => !FIELDS.has(field))) return undefined;
  const { p, a, t, o } = record;
  if (typeof p !== "string" || !p.isWellFormed()) return undefined;
  if (a !== undefined) return t === undefined && o === undefined && text(a) ? { v: 1, p, a } : undefined;
  if (t !== undefined && !text(t)) return undefined;
  if (o !== undefined && !(text(o) && o.endsWith("/"))) return undefined;
  if (t !== undefined) return o === undefined ? { v: 1, p, t } : { v: 1, p, t, o };
  return o === undefined ? undefined : { v: 1, p, o };
}

/** The envelope of a cursor; a position longer than the envelope's bounds is a `QueryError`. */
export function encodeLevelCursor(cursor: LevelCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  const spelled = `${SPELLING}${toBase64Url(bytes)}`;
  if (bytes.length > LIMITS.cursorMaxDecodedBytes || spelled.length > LIMITS.cursorMaxChars)
    throw new QueryError(FIRESTORE_CURSOR_SENTENCES.tooLong, FIRESTORE_TYPE);
  return spelled;
}

/** The cursor a text names for `pattern`, null for "0"; every other text is refused before any request. */
export function decodeLevelCursor(spelled: string, pattern: string): LevelCursor | null {
  if (spelled === "0") return null;
  if (spelled.length > LIMITS.cursorMaxChars || !spelled.startsWith(SPELLING))
    throw refuse(FIRESTORE_CURSOR_SENTENCES.notEnvelope);
  const bytes = fromBase64Url(spelled.slice(SPELLING.length));
  if (bytes === null || bytes.length > LIMITS.cursorMaxDecodedBytes)
    throw refuse(FIRESTORE_CURSOR_SENTENCES.notEnvelope);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw refuse(FIRESTORE_CURSOR_SENTENCES.notEnvelope);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw refuse(FIRESTORE_CURSOR_SENTENCES.notEnvelope);
  const record = value as Readonly<Record<string, unknown>>;
  if (record.v !== 1) throw refuse(FIRESTORE_CURSOR_SENTENCES.version);
  const cursor = cursorOf(record);
  if (cursor === undefined) throw refuse(FIRESTORE_CURSOR_SENTENCES.malformed);
  if (cursor.p !== pattern) throw refuse(FIRESTORE_CURSOR_SENTENCES.otherLevel);
  return cursor;
}

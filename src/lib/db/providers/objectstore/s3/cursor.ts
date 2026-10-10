/**
 * The Keys panel cursor: `s3c:1:<payload>`, base64url without padding, the payload the UTF-8
 * JSON `{"b":bucket|null,"p":prefix,"l":0|1,"t"?:token,"a"?:after}`.
 *
 * A cursor carries a position, not an authority: every request names the bucket and prefix taken
 * from the pattern, which the scope check binds to the cursor, and is signed with the connection's own key, so a
 * hand-written cursor can only start a listing at another position inside what the key may list, as the console's
 * `--starting-token` can; the server answers a hand-written token with a start position or with 400 or 501, which
 * E23 words. It holds no key and no per-process state, so any instance of the connection, on any replica, before or
 * after a restart or an idle eviction, decodes a cursor another instance wrote.
 *
 * The decoder refuses a text longer than S3_CURSOR_TEXT_MAX_CHARS before any base64 work, because the route bounds no
 * cursor length, and that bound already holds the decoded payload to S3_CURSOR_PAYLOAD_MAX_BYTES; the encoder refuses a payload over S3_CURSOR_PAYLOAD_MAX_BYTES, so every cursor it writes decodes.
 * The token is passed back byte for byte, never parsed, never logged and never put in a sentence.
 */
import { QueryError } from "@/lib/db/errors";
import { S3_CURSOR_PAYLOAD_MAX_BYTES, S3_CURSOR_TEXT_MAX_CHARS, S3_CURSOR_TOKEN_MAX_CHARS, S3_TYPE } from "./constants";
import { S3_ERROR_SENTENCES } from "./errors";

export interface S3CursorScope {
  /** null at the root level. */
  readonly bucket: string | null;
  /** The S3 prefix sent (the key part of the pattern), or the bucket-name filter at the root level. */
  readonly prefix: string;
  readonly level: boolean;
}

export interface S3Cursor extends S3CursorScope {
  /** Exactly one of the two: the server's continuation token, or the last bucket name returned. */
  readonly token?: string;
  readonly after?: string;
}

export const S3_CURSOR_SENTENCES = Object.freeze({
  foreign: "This page's cursor is not one the Keys panel wrote: start the walk again.",
  scope: "This cursor belongs to another bucket, prefix or level: start the walk again.",
});

const SPELLING = "s3c:1:";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const FIELDS: ReadonlySet<string> = new Set(["b", "p", "l", "t", "a"]);

export function encodeS3Cursor(cursor: S3Cursor): string {
  if (cursor.token !== undefined && cursor.token.length > S3_CURSOR_TOKEN_MAX_CHARS)
    throw new QueryError(S3_ERROR_SENTENCES.tokenTooLong, S3_TYPE);
  const payload = Buffer.from(
    JSON.stringify({
      b: cursor.bucket,
      p: cursor.prefix,
      l: cursor.level ? 1 : 0,
      ...(cursor.token === undefined ? {} : { t: cursor.token }),
      ...(cursor.after === undefined ? {} : { a: cursor.after }),
    }),
    "utf8",
  );
  if (payload.length > S3_CURSOR_PAYLOAD_MAX_BYTES) throw new QueryError(S3_ERROR_SENTENCES.cursorTooLong, S3_TYPE);
  return `${SPELLING}${payload.toString("base64url")}`;
}

/** The cursor a text names, "start" for "0", or undefined for a text this module did not write. */
export function decodeS3Cursor(text: string): S3Cursor | "start" | undefined {
  if (text.length > S3_CURSOR_TEXT_MAX_CHARS) return undefined;
  if (text === "0") return "start";
  if (!text.startsWith(SPELLING)) return undefined;
  const body = text.slice(SPELLING.length);
  if (!BASE64URL.test(body)) return undefined;
  const bytes = Buffer.from(body, "base64url");
  if (bytes.toString("base64url") !== body) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return undefined;
  }
  return cursorOf(value);
}

function cursorOf(value: unknown): S3Cursor | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((field) => !FIELDS.has(field))) return undefined;
  const { b, p, l, t, a } = record;
  if ((b !== null && typeof b !== "string") || typeof p !== "string" || (l !== 0 && l !== 1)) return undefined;
  if ((t === undefined) === (a === undefined)) return undefined;
  if (t !== undefined) {
    if (typeof t !== "string" || t.length > S3_CURSOR_TOKEN_MAX_CHARS) return undefined;
    return { bucket: b, prefix: p, level: l === 1, token: t };
  }
  if (typeof a !== "string") return undefined;
  return { bucket: b, prefix: p, level: l === 1, after: a };
}

/** Whether a cursor belongs to the scope the pattern and `level` give; the root carries `after`, a bucket a token. */
export function cursorInScope(cursor: S3Cursor, scope: S3CursorScope): boolean {
  return (
    cursor.bucket === scope.bucket &&
    cursor.prefix === scope.prefix &&
    cursor.level === scope.level &&
    (scope.bucket === null) === (cursor.after !== undefined)
  );
}

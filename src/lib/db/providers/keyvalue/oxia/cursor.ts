/**
 * The Keys panel cursor (SB1-7.9): the last key a page emitted and the key order it was cut under, written
 * `k:<base64url of the key's UTF-8>:<h|n>`; "0" starts the walk.
 *
 * The walk resumes inclusive at `lastKey` and drops the equal key, never at `lastKey + "\u0000"`, which skips keys after
 * a key ending in "//" under hierarchical sorting (that string sits one level deeper). The cursor carries no shard-map
 * digest (SB1-13 D1): a resume is exact over any shard map. Browser-safe: base64url goes through `btoa` and `atob`.
 */
import { OXIA_CURSOR_KEY_MAX_BYTES } from "./constants";
import type { KeyOrder } from "./order";

export interface OxiaCursor {
  readonly lastKey: string;
  readonly order: KeyOrder;
}

export const OXIA_CURSOR_ORDER_REFUSAL =
  "This cursor was cut under the other key order than this namespace is now detected to have: start the walk again.";
export const OXIA_CURSOR_FOREIGN_REFUSAL = "This cursor was not written by the Oxia provider: start the walk again.";

const CURSOR_PATTERN = /^k:([A-Za-z0-9_-]*):([hn])$/;
const utf8 = new TextEncoder();

/** Base64url without padding, over bytes. */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of a base64url text, or `undefined` when `atob` refuses it. */
function fromBase64url(text: string): Uint8Array | undefined {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeOxiaCursor(cursor: OxiaCursor): string {
  return `k:${base64url(utf8.encode(cursor.lastKey))}:${cursor.order === "hierarchical" ? "h" : "n"}`;
}

/**
 * The cursor a text names, "start" for "0", or `undefined` for a text this module did not write: one spelling per key,
 * valid UTF-8, at most `OXIA_CURSOR_KEY_MAX_BYTES` bytes. Which refusal a caller raises is the caller's.
 */
export function decodeOxiaCursor(text: string): OxiaCursor | "start" | undefined {
  if (text === "0") return "start";
  const match = CURSOR_PATTERN.exec(text);
  if (match === null) return undefined;
  const bytes = fromBase64url(match[1]);
  if (bytes === undefined || base64url(bytes) !== match[1]) return undefined;
  if (bytes.length > OXIA_CURSOR_KEY_MAX_BYTES) return undefined;
  let lastKey: string;
  try {
    // ignoreBOM: a key that begins with U+FEFF keeps it; the default decoder would drop it and resume at another key.
    lastKey = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return { lastKey, order: match[2] === "h" ? "hierarchical" : "natural" };
}

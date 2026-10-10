/**
 * The AWS CLI's `NextToken` for ListObjectsV2, the `--starting-token` a console notice gives.
 *
 * Pure, and shipped to the browser, so the editor refuses a bad token before anything is sent. The CLI writes
 * `base64(json.dumps({"ContinuationToken": token}))`, with `boto_truncate_amount` when `--max-items` fell inside a
 * page. Studio writes the same object with `JSON.stringify`, compact and with JavaScript's escaping, which the CLI
 * reads because it decodes any valid JSON; Studio reads any valid JSON too, so a CLI-written token resumes here.
 * Tokens Studio never needs are refused: `boto_encoded_keys`, a list-object-versions marker token and the CLI's
 * legacy `___` form. A token is not authenticated: every request it starts still names the typed
 * or pinned bucket and is signed with the connection's own keys.
 */
import { S3_KEY_SCAN_MAX_COUNT, S3_MAX_TOKEN_CHARS } from "./constants";

/** A decoded token: the service's continuation token, and how many objects of its first page to skip. */
export interface S3ResumeToken {
  readonly continuationToken: string;
  readonly truncateAmount?: number;
}

/** Standard base64 with padding, at least one group. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TOKEN_KEY = "ContinuationToken";
const TRUNCATE_KEY = "boto_truncate_amount";

/** The CLI form of a service token: compact JSON, UTF-8, standard base64 with padding. */
export function encodeS3StartingToken(continuationToken: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ [TOKEN_KEY]: continuationToken }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The service token a CLI-form token carries, or undefined for any text that is not one. */
export function decodeS3StartingToken(text: string): S3ResumeToken | undefined {
  if (text === "" || text.length > S3_MAX_TOKEN_CHARS || !BASE64.test(text)) return undefined;
  const bytes = Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const fields = json as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (!keys.every((key) => key === TOKEN_KEY || key === TRUNCATE_KEY)) return undefined;
  const continuationToken = fields[TOKEN_KEY];
  if (typeof continuationToken !== "string" || continuationToken === "") return undefined;
  if (!keys.includes(TRUNCATE_KEY)) return { continuationToken };
  const amount = fields[TRUNCATE_KEY];
  // The truncate amount counts objects of one page, so it is at most the largest page.
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0 || amount > S3_KEY_SCAN_MAX_COUNT)
    return undefined;
  return { continuationToken, truncateAmount: amount };
}

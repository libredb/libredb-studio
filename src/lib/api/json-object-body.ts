/**
 * Reads a request body that must be a JSON object.
 *
 * The `/api/db/*` routes destructure their body straight away, so a JSON `null`, or a body that
 * is not JSON at all, used to reach that destructuring or `JSON.parse` and answer 500 with the
 * runtime's own text ("Cannot destructure property 'sql' ...", "JSON Parse error: ..."). Any body
 * that is not a JSON object (`null`, an array, a number, a string, a boolean, malformed text) is
 * the caller's malformed request: this answers `null` for it, and the route answers 400 with
 * `INVALID_REQUEST_BODY` before any connection resolves.
 */

/** The fixed sentence a route answers at 400 for a body that is not a JSON object. */
export const INVALID_REQUEST_BODY = "Invalid request body";

/** Whether a parsed JSON value is an object, and not `null` or an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The request's body when it is a JSON object, or `null` when it is anything else. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return isJsonObject(body) ? body : null;
}

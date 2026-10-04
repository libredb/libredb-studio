/**
 * A plain object, as opposed to null, an array or a primitive.
 * New modules import this one rather than add another private copy.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

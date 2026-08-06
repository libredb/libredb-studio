/**
 * The error a request gets when its `params` are not bindable. It names the whole
 * allowed set rather than the offending element, because the offending element is
 * a value the caller sent and the response is not the place to echo it back.
 */
export const BOUND_PARAMS_MESSAGE = "params must be an array of strings, numbers, booleans or null";

type BoundParamsResult = { valid: true; params: unknown[] | undefined } | { valid: false; message: string };

/**
 * Read a request's `params` field — the values a statement's positional
 * placeholders are bound to (#290).
 *
 * The check is a boundary, not a formality. The array reaches a driver's bind
 * path directly, and every driver reacts differently to a value it cannot bind:
 * an object may be coerced, expanded, or rejected deep inside the engine. Only the
 * scalars JSON can carry get through, so an inline row edit's value is bindable by
 * construction and anything else is refused with a 400 rather than a query error.
 */
export function readBoundParams(value: unknown): BoundParamsResult {
  if (value === undefined) return { valid: true, params: undefined };
  if (!Array.isArray(value)) return { valid: false, message: BOUND_PARAMS_MESSAGE };

  const bindable = value.every(
    (element) =>
      element === null || typeof element === "string" || typeof element === "number" || typeof element === "boolean",
  );

  return bindable ? { valid: true, params: value } : { valid: false, message: BOUND_PARAMS_MESSAGE };
}

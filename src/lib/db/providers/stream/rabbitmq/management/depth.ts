/**
 * Whether a parsed management answer nests objects and arrays deeper than Studio reads, checked with an explicit
 * stack, so no depth the broker sends can overflow the call stack. The outermost object or array is level 1; a
 * scalar adds no level. Real answers nest at most 4 levels.
 */
import { RABBITMQ_MGMT_DEPTH } from "../limits";

export function nestsTooDeep(value: unknown, maxDepth: number = RABBITMQ_MGMT_DEPTH): boolean {
  const pending: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 1 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next.value !== "object" || next.value === null) continue;
    if (next.depth > maxDepth) return true;
    for (const child of Object.values(next.value)) pending.push({ value: child, depth: next.depth + 1 });
  }
  return false;
}

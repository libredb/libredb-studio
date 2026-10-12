/**
 * Whether a parsed management answer nests objects and arrays deeper than Studio reads, checked with an explicit
 * stack, so no depth the broker sends can overflow the call stack. The outermost object or array is level 1; a
 * scalar adds no level. Real answers nest at most 4 levels.
 */
import { RABBITMQ_MGMT_DEPTH } from "../limits";

export function nestsTooDeep(value: unknown, maxDepth: number = RABBITMQ_MGMT_DEPTH): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (maxDepth < 1) return true;
  // Only objects and arrays take a stack entry, and children are read in place: an answer of millions of scalars,
  // which a bindings answer's declarer-written arguments can be, costs no record and no copy per scalar.
  const pending: { readonly value: object; readonly depth: number }[] = [{ value, depth: 1 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const node = next.value as Record<string, unknown>;
    const depth = next.depth + 1;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child: unknown = node[i];
        if (typeof child !== "object" || child === null) continue;
        if (depth > maxDepth) return true;
        pending.push({ value: child, depth });
      }
      continue;
    }
    for (const key in node) {
      const child = node[key];
      if (typeof child !== "object" || child === null) continue;
      if (depth > maxDepth) return true;
      pending.push({ value: child, depth });
    }
  }
  return false;
}

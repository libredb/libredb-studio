import type { DatabaseConnection } from "@/lib/types";

/**
 * Sorts `connections` by the persisted `connection_order` list (see the comment on
 * `StorageData["connection_order"]` for why it is one flat list). A connection this list has
 * no entry for (never dragged, or created after the user last reordered) sorts after every
 * connection the list does know about, in the relative order `connections` already returns
 * it — `Array.prototype.sort` is spec-guaranteed stable, so that fallback needs no code of
 * its own.
 */
export function applyConnectionOrder<T extends DatabaseConnection>(connections: T[], order: string[]): T[] {
  if (order.length === 0) return connections;
  const indexOf = new Map(order.map((id, i) => [id, i]));
  return [...connections].sort((a, b) => {
    const ai = indexOf.get(a.id);
    const bi = indexOf.get(b.id);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return 0;
  });
}

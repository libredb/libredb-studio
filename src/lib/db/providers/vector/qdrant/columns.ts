import type { QueryWarning } from "@/lib/types";

/**
 * The names of a Qdrant result's columns: a pure function of a key alone, the same for every route, page and
 * collection, so the grid, the tree and the Source name a payload key alike.
 *
 * Engine columns keep Qdrant's names and are never renamed; every column Studio adds starts with `$`. A payload
 * top-level key that could be read as one of those is shown under `payload.` and the key, the prefix applied
 * once: `id` becomes `payload.id` and `payload.id` becomes `payload.payload.id`. No two keys share a column, and
 * no key takes an engine or a Studio name.
 */

/** The columns Qdrant's own answer names. */
export const QDRANT_ENGINE_COLUMNS: readonly string[] = Object.freeze([
  "id",
  "score",
  "vector",
  "order_value",
  "shard_key",
]);

/** The columns Studio adds: the search a row came from, the group it belongs to, and the group's lookup record. */
export const QDRANT_STUDIO_COLUMNS = Object.freeze({ search: "$search", group: "$group", lookup: "$lookup" } as const);

const PAYLOAD_PREFIX = "payload.";
const RESERVED_PREFIXES: readonly string[] = ["vector.", "$", PAYLOAD_PREFIX];
const SHOWN_RENAMES = 5;

/** A vector's column: `vector` for the unnamed one, `vector.` and its name for a named one. */
export function vectorColumnName(name: string): string {
  return name === "" ? "vector" : `vector.${name}`;
}

/** Whether a payload key would read as a column Qdrant or Studio names, and so is shown under `payload.`. */
export function isReservedPayloadKey(key: string): boolean {
  return (
    key === "" ||
    key === "__proto__" ||
    QDRANT_ENGINE_COLUMNS.includes(key) ||
    RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/** A payload top-level key's column. */
export function payloadColumnName(key: string): string {
  return isReservedPayloadKey(key) ? `${PAYLOAD_PREFIX}${key}` : key;
}

/** The one warning naming the payload keys a result shows under another name, or undefined when none is. */
export function renameWarning(renames: ReadonlyMap<string, string>): QueryWarning | undefined {
  if (renames.size === 0) return undefined;
  const pairs = [...renames].map(([key, column]) => `${JSON.stringify(key)} -> ${column}`);
  const listed = pairs.slice(0, SHOWN_RENAMES).join(", ");
  const more = pairs.length > SHOWN_RENAMES ? `, and ${pairs.length - SHOWN_RENAMES} more` : "";
  return {
    message: `Payload keys that read as a column Qdrant or Studio names are shown under payload.: ${listed}${more}. A filter names the key itself.`,
  };
}

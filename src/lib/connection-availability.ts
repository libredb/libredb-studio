/**
 * Whether a connection or a saved query can be opened, as the Studio's lists and pickers answer it (FND-1).
 *
 * A record read from storage may carry a `type` or a `connectionType` that names no provider this Studio has: one saved
 * by a newer Studio that shares the same storage, a hand-edited record, one with no type, or one whose type is not
 * text. Availability is derived here from that field on every read and never written into the record, so a record is
 * kept as stored. The sentences that say why come from `typeIdRefusal` in `@/lib/db/type-id`; this module only names
 * the record they refuse.
 */
import { isDatabaseType, typeIdRefusal } from "@/lib/db/type-id";
import type { DatabaseConnection } from "@/lib/types";

/** A notice's title and the line under it, as `useToast` and sonner take them. */
export interface UnavailableNotice {
  readonly title: string;
  readonly description: string;
}

function noticeName(name: unknown, fallback: string): string {
  return typeof name === "string" && name !== "" ? name : fallback;
}

/**
 * The connection a picker shows by itself, before or without a pick: the one `savedId` names while it is listed and a
 * provider can open it, otherwise the first listed one a provider can open, otherwise null. A picker never opens on a
 * connection whose type names no provider; it lists that connection as unavailable.
 */
export function defaultConnection(
  list: readonly DatabaseConnection[],
  savedId: string | null,
): DatabaseConnection | null {
  const available = list.filter((connection) => isDatabaseType(connection.type));
  return available.find((connection) => connection.id === savedId) ?? available[0] ?? null;
}

/**
 * The connection a picker shows without a pick: the one it already shows, `shownId`, while it is listed, whatever its
 * type, otherwise `defaultConnection`. A picker records the id of what this returns, so a later list that names no
 * provider for that connection's type draws it as unavailable instead of moving the page to another database; only a
 * connection that leaves the list is replaced.
 */
export function shownConnection(
  list: readonly DatabaseConnection[],
  shownId: string | null,
  savedId: string | null,
): DatabaseConnection | null {
  return list.find((connection) => connection.id === shownId) ?? defaultConnection(list, savedId);
}

/**
 * The notice a picker raises when it opens on a list in which `savedId` names a connection whose type names no
 * provider, so the saved active connection is not replaced in silence; null when `savedId` names no listed connection
 * or one a provider can open.
 */
export function savedConnectionNotice(
  list: readonly DatabaseConnection[],
  savedId: string | null,
): UnavailableNotice | null {
  const saved = list.find((connection) => connection.id === savedId);
  const refusal = saved === undefined ? null : typeIdRefusal(saved.type);
  return saved === undefined || refusal === null ? null : unavailableConnectionNotice(saved, refusal.sentence);
}

/**
 * The notice that refuses a pick of a connection whose type names no provider: its name, or "This connection" for a
 * record whose name is missing, empty or not text, and the refusal's `sentence`. The editor's connection hook and the
 * pickers outside the editor raise the same notice.
 */
export function unavailableConnectionNotice(
  connection: { readonly name?: unknown },
  sentence: string,
): UnavailableNotice {
  return {
    title: "Connection unavailable",
    description: `${noticeName(connection.name, "This connection")}: ${sentence}`,
  };
}

/**
 * The notice that refuses a pick of a saved query whose `connectionType` names no provider: its name, or "This saved
 * query" for a record whose name is missing, empty or not text, and the refusal's `sentence`.
 */
export function unavailableSavedQueryNotice(query: { readonly name?: unknown }, sentence: string): UnavailableNotice {
  return {
    title: "Saved query unavailable",
    description: `${noticeName(query.name, "This saved query")}: ${sentence}`,
  };
}

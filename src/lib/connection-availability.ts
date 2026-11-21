/**
 * Whether a connection or a saved query can be opened, as the Studio's lists and pickers answer it (FND-1).
 *
 * A record read from storage may carry a `type` or a `connectionType` that names no provider this Studio has: one saved
 * by a newer Studio that shares the same storage, a hand-edited record, one with no type, or one whose type is not
 * text. Availability is derived here from that field on every read and never written into the record, so a record is
 * kept as stored. The sentences that say why come from `typeIdRefusal` in `@/lib/db/type-id`; this module only names
 * the record they refuse.
 */

/** A notice's title and the line under it, as `useToast` and sonner take them. */
interface UnavailableNotice {
  readonly title: string;
  readonly description: string;
}

function noticeName(name: unknown, fallback: string): string {
  return typeof name === "string" && name !== "" ? name : fallback;
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

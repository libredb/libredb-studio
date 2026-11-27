/**
 * The bounds of an object's source document and the SDK's bound helper (docs/providers/CONTRACT.md, clause C-115).
 *
 * A source document holds at most `SOURCE_PART_LIMIT` parts, and each part's text and each sentence in it at most
 * `SOURCE_CHARACTER_LIMIT` UTF-16 code units. `applySourceBound` cuts one text at a bound and marks only a text it cut,
 * so a provider bounding its own read cuts as the host does; `boundSourceAnswer` cuts each readable part of a whole
 * answer past the character bound, the cut the host applies to every answer it reads.
 */
import type { ObjectSourceDocument, ObjectSourcePart } from "./types";

/**
 * The most UTF-16 code units one part's text, or one sentence of a source document, holds: a text past it is cut by
 * `boundSourceAnswer`, and a sentence past it is refused, since no mark can state its cut.
 */
export const SOURCE_CHARACTER_LIMIT = 1_000_000;

/**
 * The most parts one source document holds. The largest document a shipped engine answers has four parts (an object
 * store's object), so the bound is twice it: no correct provider reaches it, and a document past it is refused, since
 * no mark can state a cut part.
 */
export const SOURCE_PART_LIMIT = 8;

/** The one sentence a source text cut at `limit` characters is marked with. */
export function sourceBoundTruncationReason(limit: number): string {
  return `the source read was bounded at ${limit.toLocaleString("en-US")} characters by its caller`;
}

/**
 * `text` under the bound `limit`: the text itself, never marked, where it fits or no bound is given, and otherwise its
 * first `limit` code units, marked with `limit` and `sourceBoundTruncationReason`. A cut that would end between the two
 * halves of a surrogate pair drops the pair whole, so the text never ends in half a character; the mark still names
 * `limit`, the bound that was asked for.
 */
export function applySourceBound(
  text: string,
  limit: number | undefined,
): {
  readonly text: string;
  readonly truncated?: { readonly limit: number; readonly reason: string };
} {
  if (limit === undefined || text.length <= limit) return { text };
  const cut = text.slice(0, limit);
  // The cut's last unit is a high surrogate only when its low half sits at `limit` in the text, since the text is
  // longer than the bound here.
  const last = cut.charCodeAt(cut.length - 1);
  const kept = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return {
    text: kept,
    truncated: { limit, reason: sourceBoundTruncationReason(limit) },
  };
}

/**
 * `part` with its text cut at `SOURCE_CHARACTER_LIMIT` (`applySourceBound`) and marked with that bound, where it is a
 * readable part whose text is past the bound: a mark the provider already set keeps its sentence, the bound's sentence
 * joined to it after "; ". Every other part is answered by reference.
 */
function boundPart(part: ObjectSourcePart): ObjectSourcePart {
  if ("unavailable" in part || part.text.length <= SOURCE_CHARACTER_LIMIT) return part;
  const reason = sourceBoundTruncationReason(SOURCE_CHARACTER_LIMIT);
  return {
    ...part,
    text: applySourceBound(part.text, SOURCE_CHARACTER_LIMIT).text,
    truncated: {
      limit: SOURCE_CHARACTER_LIMIT,
      reason: part.truncated === undefined ? reason : `${part.truncated.reason}; ${reason}`,
    },
  };
}

/**
 * `document`, an answer `checkSourceAnswer` read, cut where clause C-115 cuts it: a new document whose readable parts
 * past `SOURCE_CHARACTER_LIMIT` are cut and marked (`boundPart`), and whose other parts, its path and its kind are the
 * answer's own, by reference. Only a text is cut: a document of more parts than `SOURCE_PART_LIMIT`, or with a sentence
 * past the character bound, is refused by the answer check, since no mark can state those cuts. The answer is never
 * mutated.
 */
export function boundSourceAnswer(document: ObjectSourceDocument): ObjectSourceDocument {
  const [first, ...rest] = document.parts;
  return {
    path: document.path,
    kind: document.kind,
    parts: [boundPart(first), ...rest.map((part) => boundPart(part))],
  };
}

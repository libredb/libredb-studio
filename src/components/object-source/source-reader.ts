import { appFetch } from "@/lib/config/base-path";
import { buildConnectionPayload } from "@/hooks/use-connection-payload";
import { SOURCE_CHARACTER_LIMIT, SOURCE_PART_LIMIT } from "@/lib/db/object-kinds";
import type { ObjectSourceDocument, ObjectSourceForm, ObjectSourceOrigin } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Who answers a source read, and what a renderer is allowed to believe about the answer (#789).
 *
 * This is its OWN seam and not a fourth member of the tree's `ObjectReadRequest`, which is a
 * measured distinction rather than a preference. That type is paired with a `ReadSlot` whose
 * three kinds each land in a `TreeCache` map, and `isRenderableShape` dispatches on the slot
 * and not on the route; a source document is not an array, it caches nothing, and the surface
 * that wants it is a TAB holding no handle on the tree's private source at all. Adding a fourth
 * member would also oblige the embedded adapter's exhaustive switch to carry an arm for a state
 * the design says cannot occur, which is the deleted 501 in a new place under a coverage gate.
 *
 * The return is `unknown` on purpose, for both shells rather than for the embedded one alone: a
 * route's body and a host callback's return value are both ordinary values this component is
 * about to dereference, and only one of them has a type declaration.
 */
export type ObjectSourceReader = (
  connection: DatabaseConnection,
  path: readonly string[],
  kind: string,
) => Promise<unknown>;

/**
 * The default source: this application's own route.
 *
 * `buildConnectionPayload` sends a managed seed by id and anything else in full, which is how
 * every other db route is called and the only way a connection the server has never heard of
 * can be read at all.
 */
export const httpSourceReader: ObjectSourceReader = async (connection, path, kind) => {
  const response = await appFetch("/api/db/objects/source", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...buildConnectionPayload(connection), path, kind }),
  });
  // A route that answered with no body at all still answered something worth showing, so the
  // status stands in for the sentence rather than the read being reported as a parse error.
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `The source read failed with HTTP ${response.status}`);
  }
  return body;
};

const FORMS: readonly string[] = ["complete", "partial"] satisfies readonly ObjectSourceForm[];
const ORIGINS: readonly string[] = ["stored", "regenerated", "rendered"] satisfies readonly ObjectSourceOrigin[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string that carries a fact, rather than one that is present and says nothing. */
function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The truncation mark, checked because the banner DEREFERENCES `reason` and prints it.
 *
 * A mark whose reason is missing would draw an empty warning banner above a text, which is a
 * second spelling of the collapse this whole design exists to prevent: an attention state with
 * nothing in it reads as decoration.
 *
 * THE REASON IS BOUNDED BY THE SAME NUMBER AS A TEXT, and it is the one host-supplied rendered
 * string round 1's bound missed (#789 fix round 1). That round bounded the text and the refusal
 * sentence on the rule "it is a text this component renders", and `ObjectSourceView` renders
 * `part.truncated.reason` verbatim into the warning banner from the same unbounded host path.
 * MEASURED before this line: a part carrying a five-million-character reason passed this
 * predicate, so the whole of it reached a `<div>` on the one seam that has no route in front of
 * it. An overrun is a failed read here for the same reason it is for a text: this seam cannot
 * cut a sentence honestly, so it says the body is one it cannot render.
 */
function isTruncationShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.limit === "number" &&
    isFilledString(value.reason) &&
    value.reason.length <= SOURCE_CHARACTER_LIMIT
  );
}

/**
 * The affordance's own host-supplied string, and the ONE arm this predicate grows for `edit`
 * (#789 Phase 3, discussion #778).
 *
 * THE PREDICATE'S CONTRACT IS UNCHANGED for a malformed `edit`, and that asymmetry is the whole
 * of this arm. A part whose `edit` is not a well-formed `ObjectPartEdit` is still a RENDERABLE
 * part: refusing the document over it would regress an existing adopter's READ, which is a
 * feature they have today, over an affordance that is new. The affordance is decided by
 * `partEditability` in `source-editable.ts`, which reads a malformed `edit` as not offered,
 * because `edit?.offered === true` is false for every malformed value and the `offered: false`
 * arm additionally requires a filled `reason`. Absence and malformation both read as not
 * editable, so nothing downstream has to be told them apart.
 *
 * WHAT IS REFUSED IS AN OVER-LONG REFUSAL SENTENCE, on exactly one arm, and the rule is the one
 * the three strings above it already follow. `partEditability` in `source-editable.ts` answers
 * `provider-refused` carrying `edit.reason` VERBATIM and unprefixed when `offered` is `false` and
 * the reason is a filled string, and the pane renders that sentence, so that arm is the FOURTH
 * host-supplied rendered string on a seam with no route in front of it and the first one this
 * phase adds. Nothing downstream bounds it: measured at this commit, `partEditability` does not
 * look at the length.
 *
 * THE `offered: true` ARM IS NOT CHECKED, and fix round 1 narrowed the helper to say so. Round 1
 * checked the length wherever `reason` was a string, arguing that a host shipping megabytes under
 * an `offered: true` was handing this seam the same value with a different label on it. MEASURED
 * against the real `partEditability`: on that arm it answers `{ editable: true }` and never reads
 * `reason`, so no component renders the string and the bound protected nothing while costing the
 * READ of every part in the document. A guard wider than the population that renders is the
 * defect this phase keeps finding, so the guard now covers the arm that has a renderer and only
 * that arm. `tests/unit/components/object-source-reader.test.ts` pins both halves, the second one
 * by calling `partEditability` itself, so the day that arm gains a renderer the test says so.
 *
 * AN OVERRUN IS A FAILED READ and never a silent truncation, which is `isSourceDocumentShape`'s
 * own stated rule for `text`, `unavailable` and `truncated.reason`: this seam cannot cut a
 * sentence honestly, so it says the read answered a body it cannot render. It regresses no Phase
 * 2 adopter, because `edit` is a field this phase invents and no document written before it
 * carries one.
 *
 * THAT CONSEQUENCE IS A DECLARED DIVERGENCE FROM THIS TASK'S SPECIFICATION, recorded here because
 * a reader of this line deserves to know it is contested and not settled. The specification's
 * first half asks for the weaker consequence, the part alone losing its affordance, and its
 * second half asks for "the same rule that bounds the refusal sentence and the truncation
 * reason", which in this file IS `return false` over the document. Both cannot hold at once: this
 * predicate answers a boolean over a whole document and deletes nothing, so the weaker
 * consequence can only be written in `partEditability`, which is another task's file. The rule
 * was followed and the consequence was not, and the alternative is one length test there. The
 * cost of the choice, stated plainly: a host that answers `offered: false` with a reason over the
 * limit loses the READ of every part in that document.
 */
function editReasonOverruns(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.offered === false &&
    typeof value.reason === "string" &&
    value.reason.length > SOURCE_CHARACTER_LIMIT
  );
}

function isPartShape(part: unknown): boolean {
  if (!isRecord(part)) return false;
  if (!isFilledString(part.id)) return false;
  if (!isFilledString(part.label)) return false;
  // Both keys at once is the collapse, and it is checked BEFORE either arm is examined,
  // because each arm on its own would accept the part.
  if (Object.hasOwn(part, "unavailable") && Object.hasOwn(part, "text")) return false;
  if (Object.hasOwn(part, "unavailable")) {
    return isFilledString(part.unavailable) && part.unavailable.length <= SOURCE_CHARACTER_LIMIT;
  }
  if (!isFilledString(part.text)) return false;
  if (part.text.length > SOURCE_CHARACTER_LIMIT) return false;
  if (!isFilledString(part.language)) return false;
  if (!FORMS.includes(part.form as string)) return false;
  if (!ORIGINS.includes(part.origin as string)) return false;
  if (Object.hasOwn(part, "truncated") && !isTruncationShape(part.truncated)) return false;
  if (Object.hasOwn(part, "edit") && editReasonOverruns(part.edit)) return false;
  return true;
}

/**
 * The client's shape check, and the LIVE home of the invariants the compiler cannot hold.
 *
 * A predicate rather than a boolean, unlike `isRenderableShape`, so the caller narrows instead
 * of casting. Written here because the embedded shell's document comes from a HOST: ordinary
 * JavaScript whose declared return type is not a runtime guarantee. It is live for the
 * standalone route too, where the body is JSON nobody typed.
 *
 * Four of these checks are not about malformed data at all, they are about two facts
 * collapsing into one:
 *   - a part carrying BOTH keys narrows to the refusal and drops the text in silence, and
 *     MEASURED against tsc 6.0.3 our own compiler admits that literal, because TypeScript's
 *     excess-property check on a union accepts any property declared on any member of it;
 *   - a refusal with an empty sentence draws our headline over a blank line, which is the
 *     empty-versus-unreadable collapse this whole design exists to prevent, one level in;
 *   - an empty text is not a definition, and an editor holding one is the DBeaver shape,
 *     measured in its source: an unreadable definition in a WRITABLE editor holding one line;
 *   - a truncation mark with no reason is a warning banner with nothing in it.
 *
 * THE TWO BOUNDS ARE CHECKED HERE TOO, and that is the half the first round left open (#789).
 * The route applies `SOURCE_CHARACTER_LIMIT` and `SOURCE_PART_LIMIT` to every answer it
 * serialises, and the EMBEDDED shell has no route at all: its document comes from a host
 * function, so without these two lines a host could hand the shell tens of megabytes per part
 * and any number of parts, and the only thing between that and Monaco was this predicate. The
 * refusal SENTENCE is bounded by the same number as a text, because it is a text this component
 * renders and the route carries it through untouched, and so is a truncation mark's REASON, which
 * is the third such string and the one that rule missed the first time (see `isTruncationShape`).
 * The FOURTH is an `edit` refusal's `reason`, added with the affordance itself in #789 Phase 3
 * (see `editReasonOverruns`), where the same rule applies for the same reason and the MALFORMED
 * case deliberately does not: it degrades to "not editable" on its own.
 *
 * AN OVERRUN IS A FAILED READ, never a silent truncation, and that is a decision rather than a
 * shortcut: `truncated` is a claim about WHERE the cut was made and by whom, and this seam
 * cannot make it honestly. It does not know whether the host already cut the text, so a mark
 * composed here would either restate the host's bound as ours or hide that two cuts happened.
 * The viewer's failure grammar says what it can say, which is that the read answered a body it
 * cannot render.
 *
 * Two parts sharing one id is rejected for a different reason, and it is the switcher's:
 * `activePartId` addresses a part by id, so two parts under one id make the selection
 * unresolvable and a click on the second tab select the first.
 */
export function isSourceDocumentShape(value: unknown): value is ObjectSourceDocument {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.path) || !value.path.every((segment) => typeof segment === "string")) return false;
  if (typeof value.kind !== "string") return false;
  if (!Array.isArray(value.parts) || value.parts.length === 0) return false;
  if (value.parts.length > SOURCE_PART_LIMIT) return false;
  if (!value.parts.every(isPartShape)) return false;
  const ids = new Set((value.parts as Record<string, unknown>[]).map((part) => part.id as string));
  if (ids.size !== value.parts.length) return false;
  return true;
}

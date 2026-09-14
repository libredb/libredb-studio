import type { ObjectSourcePart } from "@/lib/db/types";

/**
 * Whether ONE part of an object's definition may be edited and submitted back (#789 Phase 3,
 * from discussion #778), and, when it may not, the one sentence that says why.
 *
 * A PURE exported function, not JSX and not a hook, for the reason `source-caption.ts` gives
 * above its own export: happy-dom returns ZEROS for layout, so a test that reaches this
 * decision through a rendered element asserts less than it appears to. Every arm is pinned by
 * its `refusal` id, without a DOM, in `tests/unit/components/object-source-editable.test.ts`.
 *
 * A DISCRIMINATED UNION and never a boolean, for the reason `KindCount` is one: "the control is
 * missing" is not a fact a reader can act on, and a disabled control carrying no sentence is
 * that same silence with a tooltip on it.
 *
 * THE ORDER IS THE CONTRACT, and it is why the core facts are tested before the provider's
 * affordance.
 * `truncated` first, then `form`, then `edit`.
 * Both of the core facts travel ON THE DOCUMENT, so both arms are reachable on BOTH shells: the
 * standalone app, which reads through `/api/db/objects/source`, and the embedded library
 * surface, where a HOST supplies the document and no route of ours runs at all. That second
 * half is the one the server-side stripping cannot cover: the route deletes `edit` from any
 * part whose kind the CONNECTED provider does not declare editable, but a host never reaches
 * `boundSourceDocument`, so on the embedded shell `edit` arrives exactly as the host wrote it.
 * Ordering the core facts first is what lets the embedded shell inherit the truncation and form
 * refusals with no route in the path, and it is what gives three of the four false arms a
 * producer on both shells rather than on one.
 * Ordering `edit` first would instead leave the `bounded` arm with no producer anywhere on the
 * standalone path, because a route that had already collapsed a truncated part into
 * `offered: false` would answer `provider-refused` there, and the only population left for
 * `bounded` would be a host handing a well-formed truncated part through the embedded seam,
 * which no harness in this repository builds.
 *
 * THE TWO CORE FACTS ARE INDEPENDENT AND ARE NOT CONJOINED. MEASURED on PostgreSQL 18.4:
 * `form` stays `complete` on a TRUNCATED part, which is shipped defect X17. Nothing here
 * consults `form` to decide whether the text is WHOLE, and nothing consults `truncated` to
 * decide whether it is a STATEMENT. A part that is both truncated AND `partial` answers
 * `bounded`, which is the arm its reader can act on.
 *
 * THE DECLARATION IS THE CONNECTED PROVIDER'S AND NEVER THE CLIENT'S COPY, which is why `edit`
 * is read off the part rather than off a capability the client already holds. MEASURED on
 * MariaDB 12.3.2: `provider-meta` never connects, so the client's own copy of a declaration can
 * describe a different server than the one serving this document.
 *
 * THE POPULATION FOR EACH ARM, on ONE PostgreSQL connection plus one extra login. Three of the
 * four are measured and the fourth is not yet, and this list says which is which.
 * - `bounded`: MEASURED. `app.over_limit_fn`, whose `pg_get_functiondef` text is 1,275,140
 *   characters, read against a bound of 1,000,000.
 * - `body-only`: MEASURED. `app.order_summary`, a view, whose `pg_get_viewdef` text is
 *   `partial`.
 * - `not-offered`: MEASURED. Any `trigger` row, a readable kind that declares no
 *   `acceptsSourceEdits`.
 * - `provider-refused`: the ENGINE FACT is measured and the ARM HAS NOT BEEN DRIVEN through the
 *   product at the time this file is written. MEASURED on PostgreSQL 18.4: `CREATE OR REPLACE`
 *   on somebody else's function is an OWNERSHIP check and not a privilege check, it answers
 *   `must be owner of function order_total` with SQLSTATE 42501, and the shipped error mapper
 *   turns that into HTTP 500 because the message matches none of its substrings. The producer
 *   this arm is built for is `app.order_total` read through the `src_probe` login in
 *   `docker/postgres-init/03-object-fixture.sql`, which owns nothing. Every test of this arm in
 *   the unit suite is a driver double, and no claim here says otherwise.
 */

/**
 * The text arm of a part. The refusal arm never reaches here: the refusal pane draws first, and
 * the hybrid that could defeat that ordering is refused at both seams, by `isSourceDocumentShape`
 * on the client and by `boundPart` on the route.
 */
export type SourceEditablePart = Extract<ObjectSourcePart, { readonly text: string }>;

/** Which false arm a part landed in. Tests assert this id and never the prose. */
export type SourceEditRefusal = "bounded" | "body-only" | "provider-refused" | "not-offered";

export type SourceEditability =
  | { readonly editable: true }
  | { readonly editable: false; readonly refusal: SourceEditRefusal; readonly sentence: string };

/**
 * OURS, not the engine's, and they join `UNRENDERABLE`, `MISMATCHED` and `DISCONNECTED` as facts
 * this product states in its own voice. A `provider-refused` sentence is the engine's and is
 * carried verbatim and unprefixed, the same grammar `unavailable` and `truncated.reason` use.
 */
export const BOUNDED_SENTENCE =
  "This text was shortened when it was read, so it is not the whole definition and cannot be replaced.";
export const BODY_ONLY_SENTENCE =
  "This is the body only and not a complete statement, so it cannot be replaced from here.";
export const NOT_OFFERED_SENTENCE = "This database offers no way to replace this definition in place.";

export function partEditability(part: SourceEditablePart): SourceEditability {
  if (part.truncated !== undefined) return { editable: false, refusal: "bounded", sentence: BOUNDED_SENTENCE };
  if (part.form === "partial") return { editable: false, refusal: "body-only", sentence: BODY_ONLY_SENTENCE };
  const edit = part.edit;
  if (edit?.offered === true) return { editable: true };
  if (edit?.offered === false && typeof edit.reason === "string" && edit.reason.trim() !== "") {
    return { editable: false, refusal: "provider-refused", sentence: edit.reason };
  }
  return { editable: false, refusal: "not-offered", sentence: NOT_OFFERED_SENTENCE };
}

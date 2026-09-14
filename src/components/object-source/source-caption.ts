import type { ObjectSourceForm, ObjectSourceOrigin } from "@/lib/db/types";

/**
 * The one sentence that says what a definition on screen IS (#789).
 *
 * NOT decoration. Two measured readings go wrong without it, and both are silent: a
 * PostgreSQL `pg_get_viewdef` answer is a bare SELECT with no `CREATE VIEW` in front of it and
 * reads as a complete statement a user could copy and run, and a DuckDB macro body is the
 * engine's regeneration from its catalog rather than the bytes anybody typed, which reads as
 * the user's own text. The caption is what separates those from an SQL Server module, which is
 * genuinely the author's stored bytes run as given.
 *
 * A PURE exported function, not JSX and not a hook, and that is standing ruling 5b's
 * prescription rather than a style choice: happy-dom returns ZEROS for layout and a test that
 * reaches this copy through a rendered element asserts less than it appears to. All six
 * compositions are pinned in `tests/unit/components/object-source-caption.test.ts` with no DOM
 * at all.
 *
 * TWO INDEPENDENT AXES and therefore two records rather than one six-cell table. `origin` says
 * where the bytes came from and `form` says whether they run as given, and no engine couples
 * the two: PostgreSQL produces `regenerated` in both forms (a view is `partial`, a function is
 * `complete`), and Couchbase produces `partial` from a `rendered` origin. A keyed table would
 * be six literals to keep in step for a fact that is three plus two.
 *
 * THE THIRD AXIS, added in Phase 3 to close shipped defect X17 (#789, from discussion #778).
 * `truncated` says whether ALL OF IT ARRIVED, which is a different question from where the bytes
 * came from and a different question from whether they run as given. MEASURED on PostgreSQL 18.4:
 * `form` stays `complete` on a TRUNCATED part, because the engine's rendering of that definition
 * IS a complete statement and the bound is the READ's and not the object's. So the caption read
 * `form` alone and answered "Complete as shown." for a text that had been cut, and MEASURED in a
 * browser on a real object over the bound the pane drew that sentence four lines above the
 * truncation banner saying the read was bounded at 1,000,000 characters. Reading `form` alone was
 * wrong for exactly one reason: it answers a question nobody asked it.
 *
 * A SECOND FROZEN RECORD rather than a suffix on the existing clause, and rather than a six-cell
 * table keyed on the pair. The truncated clause REPLACES the form clause instead of appending to
 * it, because "Complete as shown. Shortened when it was read." is two sentences that contradict
 * each other and a reader who stops at the first has been told the false one. The record stays
 * keyed on `form` because the two facts still compose: a truncated `partial` part is the body only
 * AND it was cut, and a reader owed only one of those is owed the wrong one.
 */

/** Where the bytes came from. One sentence per arm of `ObjectSourceOrigin`, all three used. */
const ORIGIN_SENTENCE: Readonly<Record<ObjectSourceOrigin, string>> = Object.freeze({
  stored: "Stored by the engine as it was submitted.",
  regenerated: "Rebuilt by the engine from its catalog.",
  rendered: "A structured definition, rendered here as JSON.",
});

/** Whether the bytes run as given. One clause per arm of `ObjectSourceForm`, both used. */
const FORM_CLAUSE: Readonly<Record<ObjectSourceForm, string>> = Object.freeze({
  complete: "Complete as shown.",
  partial: "This is the body only, not a complete statement.",
});

/**
 * What a TRUNCATED part is, one clause per arm of `ObjectSourceForm`, both used and neither
 * claiming completeness in any wording. Pinned by the negative assertion over all six
 * compositions in `tests/unit/components/object-source-caption.test.ts`.
 */
const TRUNCATED_CLAUSE: Readonly<Record<ObjectSourceForm, string>> = Object.freeze({
  complete: "Shortened when it was read, so this is not the whole definition.",
  partial: "The body only, and shortened when it was read.",
});

/** The caption for one part, composed origin first and the form-or-truncation clause second. */
export function sourceCaption(form: ObjectSourceForm, origin: ObjectSourceOrigin, truncated: boolean): string {
  return `${ORIGIN_SENTENCE[origin]} ${truncated ? TRUNCATED_CLAUSE[form] : FORM_CLAUSE[form]}`;
}

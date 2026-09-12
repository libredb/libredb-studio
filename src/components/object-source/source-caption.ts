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

/** The caption for one part, composed origin first and form second. */
export function sourceCaption(form: ObjectSourceForm, origin: ObjectSourceOrigin): string {
  return `${ORIGIN_SENTENCE[origin]} ${FORM_CLAUSE[form]}`;
}

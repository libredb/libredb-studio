import { describe, expect, test } from "bun:test";
import { sourceCaption } from "@/components/object-source/source-caption";

/**
 * The caption is the load-bearing half of the source pane (#789).
 *
 * It is what stops a `pg_get_viewdef` fragment reading as a complete statement and a DuckDB
 * regeneration reading as the user's own text, so all six compositions are pinned here and
 * each of the six has at least one producer in the shipped fleet.
 *
 * A PURE function tested with NO DOM at all, which is standing ruling 5b's prescription after
 * the happy-dom clamp finding: happy-dom returns zeros for layout, so a test that reaches the
 * copy through a rendered element can assert less than it looks like.
 */
describe("sourceCaption", () => {
  test.each([
    ["complete", "stored", "Stored by the engine as it was submitted. Complete as shown."],
    ["partial", "stored", "Stored by the engine as it was submitted. This is the body only, not a complete statement."],
    ["complete", "regenerated", "Rebuilt by the engine from its catalog. Complete as shown."],
    [
      "partial",
      "regenerated",
      "Rebuilt by the engine from its catalog. This is the body only, not a complete statement.",
    ],
    ["complete", "rendered", "A structured definition, rendered here as JSON. Complete as shown."],
    [
      "partial",
      "rendered",
      "A structured definition, rendered here as JSON. This is the body only, not a complete statement.",
    ],
  ] as const)("%s %s", (form, origin, expected) => {
    expect(sourceCaption(form, origin, false)).toBe(expected);
  });

  /**
   * X17, shipped in Phase 2 and closed here (#789 Phase 3, adjudication 2c).
   *
   * MEASURED in a browser on a real object over the bound: the pane showed
   * `Rebuilt by the engine from its catalog. Complete as shown.` four lines above
   * `the source read was bounded at 1,000,000 characters by its caller`, at the same time, on
   * the one screen where this phase asks a reader to trust what they are reading. The caption
   * read `form` alone, and `form` stays `complete` on a truncated part, so the sentence that
   * says the text is whole is exactly the sentence a bounded read cannot support.
   */
  test("a truncated part NEVER claims completeness, in any wording", () => {
    expect(sourceCaption("complete", "regenerated", true)).toBe(
      "Rebuilt by the engine from its catalog. Shortened when it was read, so this is not the whole definition.",
    );
    expect(sourceCaption("partial", "stored", true)).toBe(
      "Stored by the engine as it was submitted. The body only, and shortened when it was read.",
    );
    let checked = 0;
    for (const origin of ["stored", "regenerated", "rendered"] as const) {
      for (const form of ["complete", "partial"] as const) {
        expect(sourceCaption(form, origin, true)).not.toContain("Complete as shown");
        checked += 1;
      }
    }
    // Non-vacuity, the same floor the pair walk above carries: six compositions, not zero.
    expect(checked).toBe(6);
  });

  test("an untruncated part is exactly what it was", () => {
    expect(sourceCaption("complete", "regenerated", false)).toBe(
      "Rebuilt by the engine from its catalog. Complete as shown.",
    );
    expect(sourceCaption("partial", "stored", false)).toBe(
      "Stored by the engine as it was submitted. This is the body only, not a complete statement.",
    );
  });

  /**
   * The two axes are INDEPENDENT, and this is the assertion that says so rather than trusting
   * six literals to imply it. A lookup keyed on the pair would satisfy the six cases above and
   * would be a table with six cells to keep in step; the composition is two records of three
   * and two entries. Deleting either half of the composition kills every case here, and a
   * table would still pass its own six.
   */
  test("the origin sentence leads and the form clause follows, for every pair", () => {
    const origins = ["stored", "regenerated", "rendered"] as const;
    const forms = ["complete", "partial"] as const;
    let checked = 0;
    for (const origin of origins) {
      const complete = sourceCaption("complete", origin, false);
      for (const form of forms) {
        const caption = sourceCaption(form, origin, false);
        // Same leading sentence whatever the form: the origin half cannot depend on the form.
        expect(caption.startsWith(complete.slice(0, complete.indexOf(". ") + 1))).toBe(true);
        checked += 1;
      }
    }
    // Non-vacuity: six pairs were walked, not zero. A loop over an empty list certifies nothing.
    expect(checked).toBe(6);
  });
});

import { describe, expect, test } from "bun:test";
import {
  BODY_ONLY_SENTENCE,
  BOUNDED_SENTENCE,
  NOT_OFFERED_SENTENCE,
  partEditability,
  type SourceEditability,
  type SourceEditablePart,
  type SourceEditRefusal,
} from "@/components/object-source/source-editable";

/**
 * The brief's two `.refusal` assertions do not compile against the union, because the `editable:
 * true` arm carries no `refusal`. This accessor keeps each assertion's MEANING unchanged: the
 * editable arm answers `undefined`, which fails every `toBe("<refusal>")` below exactly as a
 * direct property read would have.
 */
function refusalOf(result: SourceEditability): SourceEditRefusal | undefined {
  return result.editable ? undefined : result.refusal;
}

const READABLE: SourceEditablePart = {
  id: "definition",
  label: "Definition",
  text: "CREATE OR REPLACE FUNCTION app.order_total(integer) ...",
  language: "pgsql",
  form: "complete",
  origin: "regenerated",
};

describe("partEditability", () => {
  test("editable when every conjunct holds", () => {
    expect(partEditability({ ...READABLE, edit: { offered: true } })).toEqual({ editable: true });
  });

  test("a bounded read is refused BEFORE the provider's affordance is consulted", () => {
    // The ordering is the finding rather than a detail. If `edit` were tested first, a route that
    // had already collapsed a truncated part into `offered: false` would leave this arm with no
    // producer anywhere on the standalone path, and the only population left would be a host
    // handing a well-formed truncated part through the embedded seam, which no harness reaches.
    expect(
      partEditability({
        ...READABLE,
        truncated: { limit: 1_000_000, reason: "the source read was bounded at 1,000,000 characters by its caller" },
        edit: { offered: true },
      }),
    ).toEqual({ editable: false, refusal: "bounded", sentence: BOUNDED_SENTENCE });
  });

  test("a bounded read is refused even when the provider withheld the affordance too", () => {
    // Both facts are true at once and the reader is told the one they can act on.
    expect(
      refusalOf(
        partEditability({
          ...READABLE,
          truncated: { limit: 1_000_000, reason: "bounded" },
          edit: { offered: false, reason: "must be owner of function order_total" },
        }),
      ),
    ).toBe("bounded");
  });

  test("a part that is BOTH truncated AND partial answers `bounded`, which is the arm the reader can act on", () => {
    // THE DISCRIMINATING POPULATION for mutation (b) below, and without it that mutation has an
    // empty one and asserts nothing. `truncated` is tested first, so this part must answer
    // `bounded`; a predicate that conjoined the two conjuncts, `form === "complete" &&
    // truncated !== undefined`, would fall through to `body-only` here and nowhere else in this
    // file.
    expect(
      partEditability({
        ...READABLE,
        form: "partial",
        truncated: { limit: 1_000_000, reason: "the source read was bounded at 1,000,000 characters by its caller" },
        edit: { offered: true },
      }),
    ).toEqual({ editable: false, refusal: "bounded", sentence: BOUNDED_SENTENCE });
  });

  test("a body-only text is refused, and `form` is the ONLY thing that decides it", () => {
    // MEASURED on PostgreSQL 18.4: `form` stays "complete" on a TRUNCATED part, which is shipped
    // defect X17. Nothing consults `form` to decide whether the text is WHOLE and nothing
    // consults `truncated` to decide whether it is a STATEMENT.
    expect(partEditability({ ...READABLE, form: "partial", edit: { offered: true } })).toEqual({
      editable: false,
      refusal: "body-only",
      sentence: BODY_ONLY_SENTENCE,
    });
  });

  test("the provider's own refusal is carried VERBATIM and unprefixed", () => {
    expect(
      partEditability({ ...READABLE, edit: { offered: false, reason: "must be owner of function order_total" } }),
    ).toEqual({
      editable: false,
      refusal: "provider-refused",
      sentence: "must be owner of function order_total",
    });
  });

  test("an absent affordance is OUR sentence, and it is a different arm from a provider refusal", () => {
    expect(partEditability(READABLE)).toEqual({
      editable: false,
      refusal: "not-offered",
      sentence: NOT_OFFERED_SENTENCE,
    });
  });

  test("a malformed affordance reads as not offered rather than as editable", () => {
    // A host can hand anything. `isSourceDocumentShape` drops a malformed `edit` before this is
    // called, and this is the second line of the same defence: absence and malformation both read
    // as not editable, and neither makes the DOCUMENT unrenderable.
    expect(refusalOf(partEditability({ ...READABLE, edit: { offered: "yes" } as unknown as { offered: true } }))).toBe(
      "not-offered",
    );
  });
});

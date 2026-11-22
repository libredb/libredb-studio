/**
 * Studio's review record of the claims a provider row makes that loosen the confirmation gate lists exactly the claims
 * the shipped rows make, each with its reason, and is read by the claim's key (E21-Q1, DESIGN 0.5).
 *
 * The censuses are what keep the record and the rows in one change: a row that adds a claim fails here until its
 * entry is written, and an entry whose claim no row makes fails too, because a stale entry would approve a future
 * claim no reviewer read.
 */
import { describe, expect, test } from "bun:test";
import {
  CONFIRMATION_CLAIM_REVIEW,
  type ConfirmationClaim,
  isReviewedConfirmationClaim,
} from "@/lib/db/confirmation-claim-review";
import { NON_SQL_DESTRUCTIVE_VOCABULARY } from "@/lib/db/destructive-commands";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import type { DatabaseType } from "@/lib/types";

/** The claims of one kind on the record, each as one comparable line. */
function recorded(kind: ConfirmationClaim["kind"]): string[] {
  return CONFIRMATION_CLAIM_REVIEW.filter(({ claim }) => claim.kind === kind)
    .map(({ claim }) => (claim.kind === "exempt-form" ? `${claim.type} ${claim.form.join(" ")}` : claim.type))
    .sort();
}

describe("the review record of the claims that loosen the confirmation gate", () => {
  test("lists every decides-alone claim a shipped vocabulary row makes, and no other", () => {
    const declared = Object.entries(NON_SQL_DESTRUCTIVE_VOCABULARY)
      .filter(([, row]) => row?.decidesAlone === true)
      .map(([type]) => type)
      .sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(recorded("decides-alone")).toEqual(declared);
  });

  test("lists every exempt form a shipped grammar row declares, and no other", () => {
    const declared = Object.entries(SQL_GRAMMAR)
      .flatMap(([type, spec]) => (spec.grammar.confirmExemptForms ?? []).map((form) => `${type} ${form.join(" ")}`))
      .sort();
    expect(declared).toEqual(["snowflake ALTER SESSION SET", "snowflake ALTER SESSION UNSET"]);
    expect(recorded("exempt-form")).toEqual(declared);
  });

  test("lists every text-not-sql claim a shipped grammar row makes, and no other", () => {
    const declared = Object.entries(SQL_GRAMMAR)
      .filter(([, spec]) => !spec.readsSqlText)
      .map(([type]) => type)
      .sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(recorded("text-not-sql")).toEqual(declared);
  });

  test("gives each entry its reason", () => {
    for (const { claim, reason } of CONFIRMATION_CLAIM_REVIEW) {
      // One sentence that says why the claim holds: it starts with a capital and ends with a full stop, once.
      expect({ claim, reason: /^[A-Z][^\n]*\.$/.test(reason) }).toEqual({ claim, reason: true });
      expect({ claim, sentences: reason.split(/\.\s/).length }).toEqual({ claim, sentences: 1 });
    }
  });

  test("is frozen, its entries, claims and forms included", () => {
    expect(Object.isFrozen(CONFIRMATION_CLAIM_REVIEW)).toBe(true);
    for (const entry of CONFIRMATION_CLAIM_REVIEW) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.claim)).toBe(true);
      if (entry.claim.kind === "exempt-form") expect(Object.isFrozen(entry.claim.form)).toBe(true);
    }
  });
});

describe("isReviewedConfirmationClaim", () => {
  test("matches a claim by its kind, its type and its form's words without case", () => {
    expect(
      isReviewedConfirmationClaim({ kind: "exempt-form", type: "snowflake", form: ["alter", "session", "set"] }),
    ).toBe(true);
    expect(
      isReviewedConfirmationClaim({ kind: "exempt-form", type: "snowflake", form: ["ALTER", "SESSION", "UNSET"] }),
    ).toBe(true);
    // A prefix of a listed form is another form.
    expect(isReviewedConfirmationClaim({ kind: "exempt-form", type: "snowflake", form: ["ALTER", "SESSION"] })).toBe(
      false,
    );
    // The same words in another order are another form.
    expect(
      isReviewedConfirmationClaim({ kind: "exempt-form", type: "snowflake", form: ["SESSION", "ALTER", "SET"] }),
    ).toBe(false);
    // A listed form is listed for the type that declares it, not for every type.
    expect(
      isReviewedConfirmationClaim({ kind: "exempt-form", type: "postgres", form: ["ALTER", "SESSION", "SET"] }),
    ).toBe(false);
    // An exempt-form claim with no form names no form the record could list.
    expect(isReviewedConfirmationClaim({ kind: "exempt-form", type: "snowflake" })).toBe(false);
    expect(isReviewedConfirmationClaim({ kind: "decides-alone", type: "prometheus" })).toBe(true);
    // MongoDB's row keeps the SQL reading in front of it, so it makes no decides-alone claim.
    expect(isReviewedConfirmationClaim({ kind: "decides-alone", type: "mongodb" })).toBe(false);
    // A decides-alone claim is not an exempt form of the same type.
    expect(isReviewedConfirmationClaim({ kind: "exempt-form", type: "prometheus", form: ["UPDATE"] })).toBe(false);
    // MongoDB's text is a JSON document, and Druid's is SQL.
    expect(isReviewedConfirmationClaim({ kind: "text-not-sql", type: "mongodb" })).toBe(true);
    expect(isReviewedConfirmationClaim({ kind: "text-not-sql", type: "druid" })).toBe(false);
  });

  test("lists no claim for no type", () => {
    for (const kind of ["decides-alone", "exempt-form", "text-not-sql"] as const) {
      expect(isReviewedConfirmationClaim({ kind, type: undefined, form: ["ALTER", "SESSION", "SET"] })).toBe(false);
    }
    const anyType: DatabaseType | undefined = undefined;
    expect(isReviewedConfirmationClaim({ kind: "decides-alone", type: anyType })).toBe(false);
  });
});

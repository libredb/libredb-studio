import { describe, expect, test } from "bun:test";
import {
  EDIT_BODY_BYTE_LIMIT,
  EDIT_CHARACTER_LIMIT,
  EDIT_PLAN_EXECUTABLE_LIMIT,
  OBJECT_EDIT_AUDIT,
  auditKeyFor,
  auditReadingFor,
  describeConsequence,
  describePinnedPathRefusal,
  pinnedSessionValue,
  planExecutableLength,
} from "@/lib/db/object-edit";
import { SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";
import type { ObjectEditConsequenceClass, ObjectEditOutcome, ObjectEditPlan, ObjectEditRefusal } from "@/lib/db/types";

const PLAN: ObjectEditPlan = {
  planVersion: 1,
  planId: "plan-1",
  issuedAt: "2026-09-13T00:00:00.000Z",
  connectionFingerprint: "fp",
  type: "postgres",
  path: ["app", "order_total(integer)"],
  kind: "function",
  partId: "definition",
  strategy: "guarded-atomic-batch",
  unit: {
    medium: "statement",
    steps: [{ text: "SELECT 1", language: "pgsql", segments: [{ from: "user", start: 0, end: 8 }] }],
  },
  session: [
    { mode: "pinned", setting: "search_path", value: '"app", pg_catalog' },
    { mode: "asserted", setting: "check_function_bodies", value: "on" },
  ],
  revision: { check: "guarded", token: "abc", basis: "md5(pg_get_functiondef(oid))", scope: "server" },
  consequences: [],
};

const CLASSES: readonly ObjectEditConsequenceClass[] = [
  "replaces-whole-container",
  "destroys-sibling-part",
  "destroys-overloads",
  "destroys-index",
  "destroys-comment",
  "forks-object",
  "transfers-security-principal",
  "changes-module-semantics",
];

describe("the three bounds", () => {
  test("the inbound text bound EQUALS the read bound, by construction", () => {
    expect(EDIT_CHARACTER_LIMIT).toBe(SOURCE_CHARACTER_LIMIT);
    expect(EDIT_CHARACTER_LIMIT).toBe(1_000_000);
  });

  test("the PLAN bound is a DIFFERENT number, above the text bound and below the byte wall", () => {
    // The one assertion that stops the two being collapsed back into one. A maximal part is
    // 1,000,000 characters and every day-one unit wraps it, so a plan bound equal to the text
    // bound refuses this route's OWN plan for a part near the read edge; the PostgreSQL fixture's
    // under-limit control sits at about 975,134 characters, inside that distance.
    expect(EDIT_PLAN_EXECUTABLE_LIMIT).toBe(1_200_000);
    expect(EDIT_PLAN_EXECUTABLE_LIMIT).toBeGreaterThan(EDIT_CHARACTER_LIMIT);
    // The byte wall's CHARACTER equivalent, at the worst-case six bytes per JSON-escaped code
    // unit: a plan above 8,388,608 / 6 characters cannot be posted back at all.
    expect(EDIT_PLAN_EXECUTABLE_LIMIT).toBeLessThan(Math.floor(EDIT_BODY_BYTE_LIMIT / 6));
  });

  test("the body byte bound sits above the worst case and below the framework wall", () => {
    // MEASURED: the framework truncates at exactly 10,485,760 bytes, and one maximal part is up
    // to 6 MB once JSON-escaped.
    expect(EDIT_BODY_BYTE_LIMIT).toBe(8_388_608);
    expect(EDIT_BODY_BYTE_LIMIT).toBeGreaterThan(6 * 1024 * 1024);
    expect(EDIT_BODY_BYTE_LIMIT).toBeLessThan(10_485_760);
  });
});

describe("planExecutableLength", () => {
  test("counts every step of a statement unit, not only the first", () => {
    expect(
      planExecutableLength({
        medium: "statement",
        steps: [
          { text: "aaa", language: "sql", segments: [{ from: "provider", text: "aaa" }] },
          { text: "bbbb", language: "sql", segments: [{ from: "provider", text: "bbbb" }] },
        ],
      }),
    ).toBe(7);
  });

  test("counts the verb, the argument tokens and the payload of a command unit", () => {
    expect(
      planExecutableLength({
        medium: "command",
        name: "FUNCTION",
        arguments: ["LOAD", "REPLACE"],
        payload: { text: "#!lua", language: "lua", segments: [{ from: "user", start: 0, end: 5 }] },
      }),
    ).toBe(8 + 4 + 7 + 5);
  });
});

describe("describeConsequence", () => {
  test("every class has a sentence, and every sentence carries the catalog fact", () => {
    // All eight, because seven have no day-one producer and would otherwise be dead arms that
    // the 100 percent line gate cannot see: an unexecuted arrow in a frozen record.
    for (const loses of CLASSES) {
      const sentence = describeConsequence({
        loses,
        fact: { source: "FUNCTION LIST LIBRARYNAME libredb_probe", observed: "libredb_echo_key, libredb_ping" },
      });
      expect(sentence).toContain("FUNCTION LIST LIBRARYNAME libredb_probe");
      expect(sentence).toContain("libredb_echo_key, libredb_ping");
    }
    expect(
      new Set(CLASSES.map((loses) => describeConsequence({ loses, fact: { source: "s", observed: "o" } }))).size,
    ).toBe(8);
  });
});

/**
 * One distinguishing substring per class, a TOTAL record so a ninth class fails to COMPILE here.
 *
 * Fix round 1, finding 1. The two assertions above are that every sentence interpolates the fact
 * and that the eight sentences are DISTINCT, and neither binds a consequence CLASS to its own
 * SENTENCE. MEASURED at this base: swapping the `destroys-index` and `destroys-comment` arrows
 * killed 0 of 32 tests, and replacing the `replaces-whole-container` sentence with "Applying this
 * is safe and nothing else in the container is affected." also killed 0 of 32, with format, lint,
 * typecheck, the whole of tests/unit and the 100 percent line gate all green, because every arrow
 * still executed and still interpolated the fact. That second mutation has a day-one producer:
 * `replace-in-place-command` on Redis 8.10.0 is the one live source of `replaces-whole-container`,
 * and FUNCTION LOAD REPLACE drops every other function in the library, so the mutated dialog would
 * tell the reader the apply is safe on the one path where it is not.
 *
 * This record is also what pins `CLASSES` to the type. MEASURED: adding a ninth class to
 * `ObjectEditConsequenceClass` with its arrow in `CONSEQUENCE_SENTENCE` makes THIS record fail to
 * compile (TS2741 at this line), and adding the ninth entry here while leaving `CLASSES` at eight
 * makes the first assertion below go red. The hand-written list can no longer fall behind the
 * union in silence.
 */
const DISTINGUISHING: Readonly<Record<ObjectEditConsequenceClass, string>> = {
  "replaces-whole-container": "whole container",
  "destroys-sibling-part": "other part",
  "destroys-overloads": "overload",
  "destroys-index": "index",
  "destroys-comment": "comment",
  "forks-object": "SECOND object",
  "transfers-security-principal": "principal",
  "changes-module-semantics": "evaluates this module",
};

describe("describeConsequence names the right consequence", () => {
  test("every class's sentence names ITS OWN loss, and no other class's sentence does", () => {
    expect(Object.keys(DISTINGUISHING).sort()).toEqual([...CLASSES].sort());
    const fact = { source: "s", observed: "o" };
    for (const loses of CLASSES) {
      expect(describeConsequence({ loses, fact })).toContain(DISTINGUISHING[loses]);
      for (const other of CLASSES) {
        if (other === loses) continue;
        expect(describeConsequence({ loses: other, fact })).not.toContain(DISTINGUISHING[loses]);
      }
    }
  });
});

describe("the pinned path sentence", () => {
  const refusal = (code?: string): ObjectEditRefusal => ({
    refusal: "definition",
    sentence: 'relation "orders" does not exist',
    ...(code === undefined ? {} : { code }),
    at: { within: "none" },
  });

  test("names the path that was used when the engine could not resolve a name", () => {
    const sentence = describePinnedPathRefusal(PLAN, refusal("42P01"));
    expect(sentence).toContain('"app", pg_catalog');
    expect(sentence).toContain("SET search_path");
  });

  test("says nothing about a complaint that is not a name", () => {
    // A syntax error under a pinned path has nothing to do with the path, and attaching this
    // sentence to it would send the reader after the wrong cause.
    expect(describePinnedPathRefusal(PLAN, refusal("42601"))).toBeUndefined();
    expect(describePinnedPathRefusal(PLAN, refusal())).toBeUndefined();
  });

  test("says nothing when the plan pinned no path", () => {
    expect(describePinnedPathRefusal({ ...PLAN, session: [] }, refusal("42P01"))).toBeUndefined();
  });

  test("pinnedSessionValue reads the PINNED arm only", () => {
    expect(pinnedSessionValue(PLAN, "search_path")).toBe('"app", pg_catalog');
    // The asserted arm is not a pin: nothing sets it, so the preview must not claim it does.
    expect(pinnedSessionValue(PLAN, "check_function_bodies")).toBeUndefined();
  });
});

describe("the outcome to audit map", () => {
  const revision = PLAN.revision;
  const outcomes: readonly ObjectEditOutcome[] = [
    { outcome: "applied", revision, duration: 1 },
    {
      outcome: "applied-with-collateral",
      lost: [{ loses: "replaces-whole-container", fact: { source: "s", observed: "o" } }],
      revision,
      duration: 1,
    },
    { outcome: "applied-elsewhere", undone: true, duration: 1 },
    { outcome: "conflict", conflict: "object-changed", current: { text: "x", language: "pgsql" }, duration: 1 },
    { outcome: "conflict", conflict: "engine-refused-concurrent", sentence: "tuple concurrently updated", duration: 1 },
    { outcome: "refused", refusal: { refusal: "definition", sentence: "no", at: { within: "none" } }, duration: 1 },
    { outcome: "interrupted", committed: "unknown", sentence: "gone", duration: 1 },
  ];

  test("every arm has a reading, and the two conflicts read DIFFERENTLY", () => {
    // The runtime walk beside the type-level totality: a Record keyed on `outcome` alone would
    // have one conflict entry and would still compile, which is the state the derived key exists
    // to prevent.
    for (const outcome of outcomes) expect(auditReadingFor(outcome)).toBeDefined();
    expect(auditReadingFor(outcomes[3]).reason).toBe("object_edit_conflict");
    expect(auditReadingFor(outcomes[4]).reason).toBe("object_edit_concurrent_update");
    expect(auditKeyFor(outcomes[3])).toBe("conflict:object-changed");
    expect(Object.keys(OBJECT_EDIT_AUDIT).sort()).toEqual(outcomes.map(auditKeyFor).sort());
  });

  test("a successful apply that destroyed something else is a SUCCESS with a reason", () => {
    // A log saying plain `success` for an apply that also destroyed something the reader was not
    // shown records the wrong fact, and a `failure` would record a different wrong one.
    expect(auditReadingFor(outcomes[1])).toEqual({ result: "success", reason: "object_edit_collateral_loss" });
    expect(auditReadingFor(outcomes[0])).toEqual({ result: "success" });
  });

  test("a GUARD refusal is filed apart from an engine refusal", () => {
    expect(auditReadingFor(outcomes[5]).reason).toBe("object_edit_refused");
    expect(
      auditReadingFor({
        outcome: "refused",
        refusal: { refusal: "guard", sentence: "this definition changed since it was read", at: { within: "none" } },
        duration: 1,
      }).reason,
    ).toBe("object_edit_guard_refused");
  });
});

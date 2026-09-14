import { describe, expect, test } from "bun:test";
import {
  isObjectEditBuildResponseShape,
  isObjectEditOutcomeShape,
  isObjectEditPlanShape,
  isObjectEditUnitShape,
} from "@/lib/api/object-edit-wire";

const STEP = { text: "SELECT 1", language: "pgsql", segments: [{ from: "user", start: 0, end: 8 }] };
const UNIT = { medium: "statement", steps: [STEP] };
const PLAN = {
  planVersion: 1,
  planId: "p1",
  issuedAt: "2026-09-13T00:00:00.000Z",
  connectionFingerprint: "fp",
  type: "postgres",
  path: ["app", "f(integer)"],
  kind: "function",
  partId: "definition",
  strategy: "guarded-atomic-batch",
  unit: UNIT,
  session: [{ mode: "asserted", setting: "check_function_bodies", value: "on" }],
  revision: { check: "guarded", token: "t", basis: "b", scope: "server" },
  consequences: [],
};

describe("isObjectEditUnitShape", () => {
  test("accepts the two arms the day-one set produces", () => {
    expect(isObjectEditUnitShape(UNIT)).toBe(true);
    expect(
      isObjectEditUnitShape({
        medium: "command",
        name: "FUNCTION",
        arguments: ["LOAD", "REPLACE"],
        payload: { text: "#!lua", language: "lua", segments: [{ from: "user", start: 0, end: 5 }] },
      }),
    ).toBe(true);
  });

  test("refuses a command unit that also carries steps", () => {
    // Representable, because the excess-property check on a union admits any property declared on
    // any member. This is the shape the type cannot stop.
    expect(isObjectEditUnitShape({ medium: "command", name: "F", arguments: [], payload: STEP, steps: [STEP] })).toBe(
      false,
    );
  });

  test("refuses a statement unit with no steps, and one with an empty segment list", () => {
    expect(isObjectEditUnitShape({ medium: "statement", steps: [] })).toBe(false);
    expect(isObjectEditUnitShape({ medium: "statement", steps: [{ ...STEP, segments: [] }] })).toBe(false);
  });

  test("refuses an unknown medium and a non-object", () => {
    expect(isObjectEditUnitShape({ medium: "script", steps: [STEP] })).toBe(false);
    expect(isObjectEditUnitShape(null)).toBe(false);
    expect(isObjectEditUnitShape("statement")).toBe(false);
  });

  test("refuses a segment that is neither arm, and a user segment with a reversed range", () => {
    expect(
      isObjectEditUnitShape({ medium: "statement", steps: [{ ...STEP, segments: [{ from: "host", text: "x" }] }] }),
    ).toBe(false);
    expect(
      isObjectEditUnitShape({
        medium: "statement",
        steps: [{ ...STEP, segments: [{ from: "user", start: 8, end: 0 }] }],
      }),
    ).toBe(false);
  });
});

describe("isObjectEditPlanShape", () => {
  test("accepts a well formed plan", () => {
    expect(isObjectEditPlanShape(PLAN)).toBe(true);
  });

  test("refuses an unavailable revision that also carries a token", () => {
    expect(isObjectEditPlanShape({ ...PLAN, revision: { check: "unavailable", reason: "no token", token: "t" } })).toBe(
      false,
    );
  });

  test("refuses a plan with no revision, which is the two-state collapse H3 forbids", () => {
    const { revision, ...withoutRevision } = PLAN;
    expect(isObjectEditPlanShape(withoutRevision)).toBe(false);
  });

  test("refuses a consequence built from an empty catalog read", () => {
    // `""` is the shape a provider reaches for when the read came back NULL and it wants to warn
    // anyway. A NULL comment means NO consequence, not an empty one.
    expect(
      isObjectEditPlanShape({
        ...PLAN,
        consequences: [{ loses: "destroys-comment", fact: { source: "s", observed: "" } }],
      }),
    ).toBe(false);
    expect(
      isObjectEditPlanShape({
        ...PLAN,
        consequences: [{ loses: "not-a-class", fact: { source: "s", observed: "o" } }],
      }),
    ).toBe(false);
  });

  test("refuses an unknown strategy, an unknown planVersion and a path that is not a path", () => {
    expect(isObjectEditPlanShape({ ...PLAN, strategy: "drop-then-create" })).toBe(false);
    expect(isObjectEditPlanShape({ ...PLAN, planVersion: 2 })).toBe(false);
    expect(isObjectEditPlanShape({ ...PLAN, path: ["app", null] })).toBe(false);
  });

  test("refuses a session pin that is neither mode", () => {
    expect(isObjectEditPlanShape({ ...PLAN, session: [{ mode: "restored", setting: "s", value: "v" }] })).toBe(false);
  });
});

describe("isObjectEditOutcomeShape", () => {
  test("accepts all seven arms", () => {
    const revision = PLAN.revision;
    const arms: unknown[] = [
      { outcome: "applied", revision, duration: 1 },
      {
        outcome: "applied-with-collateral",
        lost: [{ loses: "replaces-whole-container", fact: { source: "s", observed: "o" } }],
        revision,
        duration: 1,
      },
      { outcome: "applied-elsewhere", undone: false, wrote: "other", duration: 1 },
      { outcome: "conflict", conflict: "object-changed", current: { text: "x", language: "pgsql" }, duration: 1 },
      {
        outcome: "conflict",
        conflict: "engine-refused-concurrent",
        sentence: "tuple concurrently updated",
        duration: 1,
      },
      {
        outcome: "refused",
        refusal: { refusal: "privilege", sentence: "must be owner", code: "42501", at: { within: "none" } },
        duration: 1,
      },
      { outcome: "interrupted", committed: "unknown", sentence: "gone", duration: 1 },
    ];
    for (const arm of arms) expect(isObjectEditOutcomeShape(arm)).toBe(true);
  });

  test("refuses an outcome that succeeded AND conflicted", () => {
    // This is the one that matters most: a read that lies shows the wrong text, and an apply that
    // lies tells a reader their change landed when it did not.
    expect(
      isObjectEditOutcomeShape({
        outcome: "applied",
        revision: PLAN.revision,
        duration: 1,
        conflict: "object-changed",
      }),
    ).toBe(false);
  });

  test("refuses a collateral outcome that names nothing, and a conflict with no text to diff", () => {
    expect(
      isObjectEditOutcomeShape({ outcome: "applied-with-collateral", lost: [], revision: PLAN.revision, duration: 1 }),
    ).toBe(false);
    expect(isObjectEditOutcomeShape({ outcome: "conflict", conflict: "object-changed", duration: 1 })).toBe(false);
  });

  test("refuses a conflict with no second discriminant, and an unknown one", () => {
    expect(
      isObjectEditOutcomeShape({ outcome: "conflict", current: { text: "x", language: "pgsql" }, duration: 1 }),
    ).toBe(false);
    expect(isObjectEditOutcomeShape({ outcome: "conflict", conflict: "somebody-else", duration: 1 })).toBe(false);
  });

  test("refuses an interrupted outcome claiming a rollback it may not claim to know, spelled wrong", () => {
    expect(isObjectEditOutcomeShape({ outcome: "interrupted", committed: "maybe", sentence: "s", duration: 1 })).toBe(
      false,
    );
  });

  test("refuses a position the client would clamp", () => {
    // `at` is REQUIRED, and its third arm is the only way to say "no coordinate". An absent `at`
    // would leave the dialog with nothing to render and the marker code with nothing to refuse.
    expect(
      isObjectEditOutcomeShape({ outcome: "refused", refusal: { refusal: "definition", sentence: "s" }, duration: 1 }),
    ).toBe(false);
    expect(
      isObjectEditOutcomeShape({
        outcome: "refused",
        refusal: { refusal: "definition", sentence: "s", at: { within: "user" } },
        duration: 1,
      }),
    ).toBe(false);
  });
});

describe("isObjectEditBuildResponseShape", () => {
  test("accepts both arms and refuses a build that answers a plan AND a refusal", () => {
    expect(
      isObjectEditBuildResponseShape({
        built: true,
        plan: PLAN,
        preimage: { text: "x", language: "pgsql" },
        planToken: "t",
      }),
    ).toBe(true);
    expect(
      isObjectEditBuildResponseShape({
        built: false,
        refusal: { refusal: "identity", sentence: "s", at: { within: "none" } },
      }),
    ).toBe(true);
    expect(
      isObjectEditBuildResponseShape({
        built: false,
        refusal: { refusal: "identity", sentence: "s", at: { within: "none" } },
        plan: PLAN,
      }),
    ).toBe(false);
  });

  test("accepts a host's build with no planToken, because a host has no key", () => {
    expect(
      isObjectEditBuildResponseShape({ built: true, plan: PLAN, preimage: { text: "x", language: "pgsql" } }),
    ).toBe(true);
  });
});

// The cases below are not in the brief's block. They exist because this file is under a 100
// percent LINE gate and the brief's block leaves five arms unexecuted: the provider segment, an
// unknown revision check, a placeable user position, the truncation mark, and a `built` that is
// neither literal. Each one asserts a fact rather than touching a line.

describe("the arms the brief's block does not reach", () => {
  test("accepts a provider segment and refuses one whose text is not a string", () => {
    const spliced = {
      ...STEP,
      segments: [
        { from: "provider", text: "CREATE OR REPLACE " },
        { from: "user", start: 0, end: 8 },
      ],
    };
    expect(isObjectEditUnitShape({ medium: "statement", steps: [spliced] })).toBe(true);
    expect(
      isObjectEditUnitShape({
        medium: "statement",
        steps: [{ ...STEP, segments: [{ from: "provider", text: null }] }],
      }),
    ).toBe(false);
    expect(
      isObjectEditUnitShape({
        medium: "statement",
        steps: [{ ...STEP, segments: [{ from: "provider", text: "x", start: 0 }] }],
      }),
    ).toBe(false);
  });

  test("refuses a revision whose check is none of the three states H3 names", () => {
    expect(
      isObjectEditPlanShape({ ...PLAN, revision: { check: "moved", token: "t", basis: "b", scope: "server" } }),
    ).toBe(false);
    expect(
      isObjectEditPlanShape({ ...PLAN, revision: { check: "guarded", token: "t", basis: "b", scope: "session" } }),
    ).toBe(false);
    expect(isObjectEditPlanShape({ ...PLAN, revision: { check: "unavailable", reason: "" } })).toBe(false);
  });

  test("accepts a placeable 1-based position and refuses a 0-based one and an unknown `within`", () => {
    const refusalAt = (at: unknown) => ({
      outcome: "refused",
      refusal: { refusal: "definition", sentence: "s", at },
      duration: 1,
    });
    expect(isObjectEditOutcomeShape(refusalAt({ within: "user", line: 7, column: 3 }))).toBe(true);
    // Monaco's IMarkerData is 1-based on both axes, so 0 is not a coordinate it can place.
    expect(isObjectEditOutcomeShape(refusalAt({ within: "user", line: 0, column: 3 }))).toBe(false);
    expect(isObjectEditOutcomeShape(refusalAt({ within: "user", line: 7, column: 0 }))).toBe(false);
    expect(isObjectEditOutcomeShape(refusalAt({ within: "outside" }))).toBe(true);
    expect(isObjectEditOutcomeShape(refusalAt({ within: "somewhere" }))).toBe(false);
    expect(isObjectEditOutcomeShape(refusalAt({ within: "outside", line: 7 }))).toBe(false);
  });

  test("accepts a truncated pre-image and refuses a mark with nothing in it", () => {
    const built = (preimage: unknown) => ({ built: true, plan: PLAN, preimage });
    expect(
      isObjectEditBuildResponseShape(
        built({ text: "x", language: "pgsql", truncated: { limit: 10, reason: "over the part limit" } }),
      ),
    ).toBe(true);
    expect(isObjectEditBuildResponseShape(built({ text: "x", language: "pgsql", truncated: { limit: 10 } }))).toBe(
      false,
    );
    expect(
      isObjectEditBuildResponseShape(built({ text: "x", language: "pgsql", truncated: { limit: 10, reason: " " } })),
    ).toBe(false);
    expect(isObjectEditBuildResponseShape(built({ text: "x", language: "pgsql", truncated: null }))).toBe(false);
    expect(
      isObjectEditBuildResponseShape(
        built({ text: "x", language: "pgsql", truncated: { limit: Number.NaN, reason: "r" } }),
      ),
    ).toBe(false);
  });

  test("refuses a build whose `built` is a string, an absent one and a non-record", () => {
    expect(
      isObjectEditBuildResponseShape({ built: "true", plan: PLAN, preimage: { text: "x", language: "pgsql" } }),
    ).toBe(false);
    expect(isObjectEditBuildResponseShape({ plan: PLAN, preimage: { text: "x", language: "pgsql" } })).toBe(false);
    expect(isObjectEditBuildResponseShape([])).toBe(false);
    expect(isObjectEditBuildResponseShape(null)).toBe(false);
  });

  test("refuses a plan token, a preimage and an unknown outcome the seam would otherwise pass on", () => {
    expect(
      isObjectEditBuildResponseShape({
        built: true,
        plan: PLAN,
        preimage: { text: "x", language: "pgsql" },
        planToken: " ",
      }),
    ).toBe(false);
    expect(isObjectEditBuildResponseShape({ built: true, plan: PLAN, preimage: { text: "x" } })).toBe(false);
    expect(isObjectEditOutcomeShape({ outcome: "vanished", duration: 1 })).toBe(false);
    expect(isObjectEditOutcomeShape({ outcome: "applied", revision: PLAN.revision })).toBe(false);
    expect(isObjectEditOutcomeShape({ outcome: "applied", revision: PLAN.revision, duration: Number.NaN })).toBe(false);
    expect(isObjectEditOutcomeShape(null)).toBe(false);
    expect(isObjectEditPlanShape(null)).toBe(false);
  });

  test("refuses the optional fields when they are present and empty", () => {
    expect(isObjectEditOutcomeShape({ outcome: "applied-elsewhere", undone: false, wrote: "", duration: 1 })).toBe(
      false,
    );
    expect(isObjectEditOutcomeShape({ outcome: "applied-elsewhere", undone: "no", duration: 1 })).toBe(false);
    expect(
      isObjectEditOutcomeShape({
        outcome: "conflict",
        conflict: "engine-refused-concurrent",
        sentence: "s",
        code: "",
        duration: 1,
      }),
    ).toBe(false);
    expect(
      isObjectEditOutcomeShape({
        outcome: "refused",
        refusal: { refusal: "privilege", sentence: "s", at: { within: "none" }, hint: "" },
        duration: 1,
      }),
    ).toBe(false);
    expect(isObjectEditPlanShape({ ...PLAN, session: [{ mode: "pinned", setting: "search_path", value: "" }] })).toBe(
      true,
    );
    expect(isObjectEditPlanShape({ ...PLAN, session: [{ mode: "pinned", setting: "", value: "v" }] })).toBe(false);
    expect(isObjectEditPlanShape({ ...PLAN, path: [] })).toBe(false);
    expect(
      isObjectEditPlanShape({ ...PLAN, unit: { medium: "command", name: "F", arguments: [null], payload: STEP } }),
    ).toBe(false);
  });
});

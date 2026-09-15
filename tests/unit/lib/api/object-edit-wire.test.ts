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
    // `text` is the map laid end to end, because a step whose map does not span its own bytes is
    // now refused: see "the segment map must correspond to the bytes the engine receives" below.
    const spliced = {
      ...STEP,
      text: "CREATE OR REPLACE SELECT 1",
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

  test("refuses an unknown conflict discriminant that carries a well formed `current`", () => {
    // Found by mutation (c): with the second discriminant's VALUE check removed but its key still
    // required, every other case in this file still passed. This is the case that pins the value,
    // and nothing else in the file builds the population it lives in.
    expect(
      isObjectEditOutcomeShape({
        outcome: "conflict",
        conflict: "somebody-else",
        current: { text: "x", language: "pgsql" },
        duration: 1,
      }),
    ).toBe(false);
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

// Fix round 1 (#789). Every case below was added because a reviewer measured a refusal in this
// module that no test population reached, or a hybrid that reached the seam and was accepted.

describe("the segment map must correspond to the bytes the engine receives", () => {
  test("refuses a step whose provider segment is not the text at that offset", () => {
    // Ruling 1a at the only boundary the embedded seam has: `text` is authoritative and the map is
    // what the dialog renders, so a map that renders different bytes is a preview that lies. This
    // exact value was measured through the committed module and returned TRUE, while
    // `renderSegments("", segments)` from `src/lib/db/object-edit.ts` answered "SELECT 1" and the
    // engine would have received "DROP DATABASE prod".
    expect(
      isObjectEditUnitShape({
        medium: "statement",
        steps: [{ text: "DROP DATABASE prod", language: "pgsql", segments: [{ from: "provider", text: "SELECT 1" }] }],
      }),
    ).toBe(false);
  });

  test("refuses a provider segment of the right LENGTH and the wrong bytes", () => {
    // The length arithmetic alone cannot see this one: 15 characters claimed and 15 delivered, and
    // the preview would render "SELECT 1 FROM x" while the engine received "DROP DATABASE p".
    // Without this case the byte comparison in `spansTheText` refuses nothing any test builds.
    expect(
      isObjectEditUnitShape({
        medium: "statement",
        steps: [
          { text: "DROP DATABASE p", language: "pgsql", segments: [{ from: "provider", text: "SELECT 1 FROM x" }] },
        ],
      }),
    ).toBe(false);
  });

  test("refuses a user range that overruns the text it is a map of", () => {
    // Measured through the committed module: TRUE, and `userPositionOf(step, 5)` then answered a
    // line and column computed off a map overrunning its own text by 999,965 units.
    expect(
      isObjectEditUnitShape({
        medium: "statement",
        steps: [
          {
            text: "CREATE OR REPLACE FUNCTION f() ...",
            language: "pgsql",
            segments: [{ from: "user", start: 0, end: 999_999 }],
          },
        ],
      }),
    ).toBe(false);
  });

  test("refuses a map that is short of the text, and accepts the spliced map that does span it", () => {
    expect(
      isObjectEditUnitShape({
        medium: "statement",
        steps: [{ text: "SELECT 1 ", language: "pgsql", segments: [{ from: "user", start: 0, end: 8 }] }],
      }),
    ).toBe(false);
    expect(
      isObjectEditUnitShape({
        medium: "statement",
        steps: [
          {
            text: "CREATE OR REPLACE SELECT 1",
            language: "pgsql",
            segments: [
              { from: "provider", text: "CREATE OR REPLACE " },
              { from: "user", start: 0, end: 8 },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  test("refuses a command payload whose map does not span its text", () => {
    expect(
      isObjectEditUnitShape({
        medium: "command",
        name: "FUNCTION",
        arguments: [],
        payload: { text: "#!lua", language: "lua", segments: [{ from: "user", start: 0, end: 4 }] },
      }),
    ).toBe(false);
  });
});

describe("a non-enumerable own property is still an own property", () => {
  // `Object.keys` returns only ENUMERABLE own keys, so the exclusion arm of `hasExactKeys` was
  // blind to a property defined with `enumerable: false`. The live population is exactly the one
  // this module exists for: the embedded seam, where the host's value is a live JS object rather
  // than JSON (`JSON.parse` cannot produce a non-enumerable own property, so the route is unaffected).
  const hidden = <T extends object>(value: T, key: string, property: PropertyDescriptor): T => {
    Object.defineProperty(value, key, { enumerable: false, configurable: true, ...property });
    return value;
  };

  test("refuses a command unit hiding `steps`", () => {
    expect(
      isObjectEditUnitShape(
        hidden({ medium: "command", name: "F", arguments: [], payload: STEP }, "steps", { value: [STEP] }),
      ),
    ).toBe(false);
  });

  test("refuses an outcome hiding a `conflict` getter behind a success", () => {
    expect(
      isObjectEditOutcomeShape(
        hidden({ outcome: "applied", revision: PLAN.revision, duration: 1 }, "conflict", {
          get: () => "object-changed",
        }),
      ),
    ).toBe(false);
  });

  test("refuses a build response hiding a `refusal` behind a plan", () => {
    expect(
      isObjectEditBuildResponseShape(
        hidden({ built: true, plan: PLAN, preimage: { text: "x", language: "pgsql" } }, "refusal", {
          value: { refusal: "identity", sentence: "s", at: { within: "none" } },
        }),
      ),
    ).toBe(false);
  });

  test("refuses a plan hiding a fourteenth key", () => {
    expect(isObjectEditPlanShape(hidden({ ...PLAN }, "planToken", { value: "t" }))).toBe(false);
  });
});

describe("the refusals that had no population", () => {
  test("refuses a plan whose fourteenth key is an ordinary enumerable one", () => {
    // Pins `hasExactKeys(value, PLAN_KEYS)` in `isObjectEditPlanShape`: deleting that line killed
    // no test before this case existed, so the docblock's "no fourteenth is admitted" was unpinned.
    expect(isObjectEditPlanShape({ ...PLAN, planToken: "t" })).toBe(false);
  });

  test("refuses each required plan field emptied on its own", () => {
    // Six guards that could be deleted together with the file's own suite fully green.
    expect(isObjectEditPlanShape({ ...PLAN, planId: "" })).toBe(false);
    expect(isObjectEditPlanShape({ ...PLAN, issuedAt: " " })).toBe(false);
    expect(isObjectEditPlanShape({ ...PLAN, connectionFingerprint: "" })).toBe(false);
    expect(isObjectEditPlanShape({ ...PLAN, type: "" })).toBe(false);
    expect(isObjectEditPlanShape({ ...PLAN, kind: "" })).toBe(false);
    expect(isObjectEditPlanShape({ ...PLAN, partId: 7 })).toBe(false);
  });

  test("refuses a build response carrying a malformed plan", () => {
    // The seam's plan validation is what ruling 1a rests on at the embedded boundary, and before
    // this case nothing in the file ever sent a build response whose plan was not well formed:
    // deleting the `isObjectEditPlanShape(value.plan)` guard left the suite green.
    expect(
      isObjectEditBuildResponseShape({
        built: true,
        plan: { ...PLAN, strategy: "drop-then-create" },
        preimage: { text: "x", language: "pgsql" },
      }),
    ).toBe(false);
    expect(
      isObjectEditBuildResponseShape({ built: true, plan: null, preimage: { text: "x", language: "pgsql" } }),
    ).toBe(false);
  });

  test("refuses a collateral outcome whose `lost` names a malformed consequence", () => {
    // `lost.length === 0` was tested; a `lost` carrying a BAD consequence was not, so
    // `lost.every(isConsequence)` refused nothing this file built.
    expect(
      isObjectEditOutcomeShape({
        outcome: "applied-with-collateral",
        lost: [{ loses: "destroys-comment", fact: { source: "s", observed: "" } }],
        revision: PLAN.revision,
        duration: 1,
      }),
    ).toBe(false);
  });

  test("accepts a line number Monaco will clamp, which is the half of the hazard this boundary cannot close", () => {
    // Stated so the dialog task meets it as a fact and not a surprise: nothing here can know the
    // length of the model the marker lands in, so the only clamp this predicate catches is the
    // 0 that Monaco's 1-based `IMarkerData` cannot place at all.
    expect(
      isObjectEditOutcomeShape({
        outcome: "refused",
        refusal: { refusal: "definition", sentence: "s", at: { within: "user", line: 1_000_000_000, column: 1 } },
        duration: 1,
      }),
    ).toBe(true);
  });
});

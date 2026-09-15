import { describe, expect, test } from "bun:test";
import {
  isObjectEditBuildResponseShape,
  isObjectEditOutcomeShape,
  isObjectEditPlanShape,
  isObjectEditUnitShape,
} from "@/lib/api/object-edit-wire";
import { EDIT_BODY_BYTE_LIMIT, EDIT_PLAN_EXECUTABLE_LIMIT } from "@/lib/db/object-edit";
import { SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";

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

// D80. Every host-supplied string these four predicates accept is bounded, and each case below
// feeds ONE CHARACTER over the bound with a control sitting exactly on it. The strings are not
// this application's prose: a refusal sentence is the engine's own message and `libraryFact` in
// `src/lib/db/providers/keyvalue/redis.ts` builds a consequence's `observed` from `FUNCTION LIST`.

const PROSE_AT_LIMIT = "x".repeat(SOURCE_CHARACTER_LIMIT);
const PROSE_OVER_LIMIT = `${PROSE_AT_LIMIT}x`;

/** A statement step whose text is exactly `length` characters and whose map spans it. */
const stepOf = (length: number) => ({
  text: "x".repeat(length),
  language: "pgsql",
  segments: [{ from: "user", start: 0, end: length }],
});

describe("every host-supplied string is bounded", () => {
  test("isObjectEditUnitShape bounds the executable text by EDIT_BODY_BYTE_LIMIT", () => {
    // The whole unit and not one step, measured with `planExecutableLength`, which is the function
    // both routes measure with.
    expect(isObjectEditUnitShape({ medium: "statement", steps: [stepOf(EDIT_BODY_BYTE_LIMIT)] })).toBe(true);
    expect(isObjectEditUnitShape({ medium: "statement", steps: [stepOf(EDIT_BODY_BYTE_LIMIT + 1)] })).toBe(false);
    // Two steps that are each acceptable and together are not: a per-step bound would pass this.
    const half = stepOf(EDIT_BODY_BYTE_LIMIT / 2);
    expect(isObjectEditUnitShape({ medium: "statement", steps: [half, half] })).toBe(true);
    expect(isObjectEditUnitShape({ medium: "statement", steps: [half, half, stepOf(1)] })).toBe(false);
  });

  test("the wire's executable ceiling stays ABOVE the routes', so the route keeps the better sentence", () => {
    // Both edit routes call this predicate FIRST and measure the executable length SECOND, and it
    // is the second check that can name the number. MEASURED with this bound set to
    // `EDIT_PLAN_EXECUTABLE_LIMIT`: `tests/api/db/objects/edit-plan.test.ts` and its apply twin
    // both went red, answering "the build answered a plan this server cannot read as a plan" where
    // they assert "this apply would send". A unit one character over the routes' bound must
    // therefore still be a WELL FORMED unit here.
    expect(EDIT_BODY_BYTE_LIMIT).toBeGreaterThan(EDIT_PLAN_EXECUTABLE_LIMIT);
    expect(isObjectEditUnitShape({ medium: "statement", steps: [stepOf(EDIT_PLAN_EXECUTABLE_LIMIT + 1)] })).toBe(true);
  });

  test("isObjectEditUnitShape bounds a provider segment's text through the text it must span", () => {
    // A provider segment's bytes ARE the step's bytes at that offset, which `spansTheText` proves,
    // so the executable bound is the segment's bound and no second number is needed.
    const provider = (length: number) => ({
      text: "x".repeat(length),
      language: "pgsql",
      segments: [{ from: "provider", text: "x".repeat(length) }],
    });
    expect(isObjectEditUnitShape({ medium: "statement", steps: [provider(EDIT_BODY_BYTE_LIMIT)] })).toBe(true);
    expect(isObjectEditUnitShape({ medium: "statement", steps: [provider(EDIT_BODY_BYTE_LIMIT + 1)] })).toBe(false);
  });

  test("isObjectEditUnitShape bounds a step's language, a command's name and each argument token", () => {
    const statement = (language: string) => ({ medium: "statement", steps: [{ ...STEP, language }] });
    expect(isObjectEditUnitShape(statement(PROSE_AT_LIMIT))).toBe(true);
    expect(isObjectEditUnitShape(statement(PROSE_OVER_LIMIT))).toBe(false);
    const command = (name: string, argument: string) => ({
      medium: "command",
      name,
      arguments: [argument],
      payload: { text: "#!lua", language: "lua", segments: [{ from: "user", start: 0, end: 5 }] },
    });
    expect(isObjectEditUnitShape(command(PROSE_AT_LIMIT, "LOAD"))).toBe(true);
    expect(isObjectEditUnitShape(command(PROSE_OVER_LIMIT, "LOAD"))).toBe(false);
    expect(isObjectEditUnitShape(command("FUNCTION", PROSE_AT_LIMIT))).toBe(true);
    expect(isObjectEditUnitShape(command("FUNCTION", PROSE_OVER_LIMIT))).toBe(false);
  });

  test("isObjectEditPlanShape bounds every string it accepts", () => {
    const cases: readonly (readonly [string, (text: string) => unknown])[] = [
      ["planId", (text) => ({ ...PLAN, planId: text })],
      ["issuedAt", (text) => ({ ...PLAN, issuedAt: text })],
      ["connectionFingerprint", (text) => ({ ...PLAN, connectionFingerprint: text })],
      ["type", (text) => ({ ...PLAN, type: text })],
      ["path", (text) => ({ ...PLAN, path: ["app", text] })],
      ["kind", (text) => ({ ...PLAN, kind: text })],
      ["partId", (text) => ({ ...PLAN, partId: text })],
      ["session.setting", (text) => ({ ...PLAN, session: [{ mode: "asserted", setting: text, value: "on" }] })],
      ["session.value", (text) => ({ ...PLAN, session: [{ mode: "pinned", setting: "search_path", value: text }] })],
      [
        "revision.token",
        (text) => ({ ...PLAN, revision: { check: "guarded", token: text, basis: "b", scope: "server" } }),
      ],
      [
        "revision.basis",
        (text) => ({ ...PLAN, revision: { check: "compared", token: "t", basis: text, scope: "connection" } }),
      ],
      ["revision.reason", (text) => ({ ...PLAN, revision: { check: "unavailable", reason: text } })],
      [
        "consequences.fact.source",
        (text) => ({ ...PLAN, consequences: [{ loses: "destroys-overloads", fact: { source: text, observed: "o" } }] }),
      ],
      [
        "consequences.fact.observed",
        (text) => ({ ...PLAN, consequences: [{ loses: "destroys-overloads", fact: { source: "s", observed: text } }] }),
      ],
      [
        "unit.steps.language",
        (text) => ({ ...PLAN, unit: { medium: "statement", steps: [{ ...STEP, language: text }] } }),
      ],
    ];
    for (const [name, build] of cases) {
      expect(`${name} at the limit: ${isObjectEditPlanShape(build(PROSE_AT_LIMIT))}`).toBe(
        `${name} at the limit: true`,
      );
      expect(`${name} over the limit: ${isObjectEditPlanShape(build(PROSE_OVER_LIMIT))}`).toBe(
        `${name} over the limit: false`,
      );
    }
  });

  test("isObjectEditOutcomeShape bounds every string it accepts", () => {
    const refusalOf = (refusal: Record<string, unknown>) => ({
      outcome: "refused",
      refusal: { refusal: "privilege", sentence: "s", at: { within: "none" }, ...refusal },
      duration: 1,
    });
    const cases: readonly (readonly [string, (text: string) => unknown])[] = [
      [
        "revision.token",
        (text) => ({
          outcome: "applied",
          revision: { check: "guarded", token: text, basis: "b", scope: "server" },
          duration: 1,
        }),
      ],
      [
        "lost.fact.observed",
        (text) => ({
          outcome: "applied-with-collateral",
          lost: [{ loses: "replaces-whole-container", fact: { source: "s", observed: text } }],
          revision: PLAN.revision,
          duration: 1,
        }),
      ],
      ["wrote", (text) => ({ outcome: "applied-elsewhere", undone: false, wrote: text, duration: 1 })],
      [
        "current.text",
        (text) => ({
          outcome: "conflict",
          conflict: "object-changed",
          current: { text, language: "pgsql" },
          duration: 1,
        }),
      ],
      [
        "current.language",
        (text) => ({
          outcome: "conflict",
          conflict: "object-changed",
          current: { text: "x", language: text },
          duration: 1,
        }),
      ],
      [
        "current.truncated.reason",
        (text) => ({
          outcome: "conflict",
          conflict: "object-changed",
          current: { text: "x", language: "pgsql", truncated: { limit: 10, reason: text } },
          duration: 1,
        }),
      ],
      [
        "conflict.sentence",
        (text) => ({ outcome: "conflict", conflict: "engine-refused-concurrent", sentence: text, duration: 1 }),
      ],
      [
        "conflict.code",
        (text) => ({
          outcome: "conflict",
          conflict: "engine-refused-concurrent",
          sentence: "s",
          code: text,
          duration: 1,
        }),
      ],
      ["refusal.sentence", (text) => refusalOf({ sentence: text })],
      ["refusal.code", (text) => refusalOf({ code: text })],
      ["refusal.hint", (text) => refusalOf({ hint: text })],
      [
        "interrupted.sentence",
        (text) => ({ outcome: "interrupted", committed: "unknown", sentence: text, duration: 1 }),
      ],
    ];
    for (const [name, build] of cases) {
      expect(`${name} at the limit: ${isObjectEditOutcomeShape(build(PROSE_AT_LIMIT))}`).toBe(
        `${name} at the limit: true`,
      );
      expect(`${name} over the limit: ${isObjectEditOutcomeShape(build(PROSE_OVER_LIMIT))}`).toBe(
        `${name} over the limit: false`,
      );
    }
  });

  test("isObjectEditBuildResponseShape bounds every string it accepts", () => {
    const built = (preimage: unknown, planToken: string, plan: unknown = PLAN) => ({
      built: true,
      plan,
      preimage,
      planToken,
    });
    const cases: readonly (readonly [string, (text: string) => unknown])[] = [
      ["planToken", (text) => built({ text: "x", language: "pgsql" }, text)],
      ["preimage.text", (text) => built({ text, language: "pgsql" }, "t")],
      ["preimage.language", (text) => built({ text: "x", language: text }, "t")],
      [
        "preimage.truncated.reason",
        (text) => built({ text: "x", language: "pgsql", truncated: { limit: 10, reason: text } }, "t"),
      ],
      ["plan.planId", (text) => built({ text: "x", language: "pgsql" }, "t", { ...PLAN, planId: text })],
      [
        "refusal.sentence",
        (text) => ({ built: false, refusal: { refusal: "identity", sentence: text, at: { within: "none" } } }),
      ],
      [
        "refusal.hint",
        (text) => ({
          built: false,
          refusal: { refusal: "identity", sentence: "s", hint: text, at: { within: "none" } },
        }),
      ],
    ];
    for (const [name, build] of cases) {
      expect(`${name} at the limit: ${isObjectEditBuildResponseShape(build(PROSE_AT_LIMIT))}`).toBe(
        `${name} at the limit: true`,
      );
      expect(`${name} over the limit: ${isObjectEditBuildResponseShape(build(PROSE_OVER_LIMIT))}`).toBe(
        `${name} over the limit: false`,
      );
    }
  });
});

import { describe, expect, test } from "bun:test";
import { providerRanges, renderSegments, userPositionOf, userTextOf } from "@/lib/db/object-edit";
import type { ObjectEditStep } from "@/lib/db/types";

/**
 * The PostgreSQL guard prefix, at EXACTLY the measured length.
 *
 * MEASURED on PostgreSQL 18.4 in wave 1a: the same body error is reported at `position 23` when
 * the body is sent bare and at `position 63` when it is sent behind a 40-character prefix, so the
 * correction is a straight subtraction of 40. MEASURED again through `POST /api/db/query` at two
 * other prefixes, 8 answering position 17 and 108 answering position 117, which is the same
 * subtraction at a 100-character difference. This literal is 40 characters so the test asserts
 * the measured pair rather than an invented one.
 */
const PG_PREFIX = "DO $libredb$ BEGIN NULL; END $libredb$;\n";

const PG_USER_TEXT = "CREATE OR REPLACE FUNCTION app.f() RETURNS int LANGUAGE sql AS $$\n  SELECT 1\n$$;";

const PG_STEP: ObjectEditStep = {
  text: `${PG_PREFIX}${PG_USER_TEXT}`,
  language: "pgsql",
  segments: [
    { from: "provider", text: PG_PREFIX },
    { from: "user", start: 0, end: PG_USER_TEXT.length },
  ],
};

/** Trino 476: ` OR REPLACE` is spliced after the first token, which ends at offset 6. */
const TRINO_USER_TEXT = "CREATE FUNCTION memory.app.plus_one(x bigint)\n  RETURNS bigint\n  RETURN x + 1";

const TRINO_STEP: ObjectEditStep = {
  text: `${TRINO_USER_TEXT.slice(0, 6)} OR REPLACE${TRINO_USER_TEXT.slice(6)}`,
  language: "sql",
  segments: [
    { from: "user", start: 0, end: 6 },
    { from: "provider", text: " OR REPLACE" },
    { from: "user", start: 6, end: TRINO_USER_TEXT.length },
  ],
};

/**
 * Redis 8.10.0: no splice at all, so the payload is one user segment and the map is the identity.
 *
 * `end` is `REDIS_TEXT.length` and never a literal. RECOMPUTED in node while this plan was
 * repaired: the string below is 94 code units, and a hand-written 93 made `renderSegments` return
 * a 93-character prefix, so both the render invariant and `userTextOf` failed on a fixture rather
 * than on a defect. The only safe spelling of an offset into a literal is an expression over that
 * literal.
 */
const REDIS_TEXT = "#!lua name=libredb_probe\nredis.register_function('libredb_ping', function() return 'pong' end)";

const REDIS_STEP: ObjectEditStep = {
  text: REDIS_TEXT,
  language: "lua",
  segments: [{ from: "user", start: 0, end: REDIS_TEXT.length }],
};

describe("renderSegments", () => {
  test("reconstructs the sent text exactly, one case per day-one strategy", () => {
    expect(renderSegments(PG_USER_TEXT, PG_STEP.segments)).toBe(PG_STEP.text);
    expect(renderSegments(TRINO_USER_TEXT, TRINO_STEP.segments)).toBe(TRINO_STEP.text);
    expect(renderSegments(REDIS_STEP.text, REDIS_STEP.segments)).toBe(REDIS_STEP.text);
  });
});

describe("userTextOf", () => {
  test("recovers the reader's own text from the step alone, which is all an apply holds", () => {
    expect(userTextOf(PG_STEP)).toBe(PG_USER_TEXT);
    expect(userTextOf(TRINO_STEP)).toBe(TRINO_USER_TEXT);
    expect(userTextOf(REDIS_STEP)).toBe(REDIS_STEP.text);
  });

  test("a step that sends the reader's text TWICE still recovers it once", () => {
    // No day-one producer: `temp-name-test-create` is the first, and it sends the text under a
    // generated name and then for real. Constructed here so the arm is not dead code.
    const user = "SELECT 1";
    const step: ObjectEditStep = {
      text: `${user};${user}`,
      language: "sql",
      segments: [
        { from: "user", start: 0, end: 8 },
        { from: "provider", text: ";" },
        { from: "user", start: 0, end: 8 },
      ],
    };
    expect(userTextOf(step)).toBe(user);
  });

  test("a segment whose end precedes its start is a drift and answers undefined", () => {
    // Fix round 1, finding 2, MUTATION X1. Deleting `if (length < 0) return undefined;` killed 0
    // of 32 tests, and raw line coverage cannot see it because the `if` line itself executes on
    // every consistent fixture. This step is the population that guard rejects: an inverted
    // `user` range. Without the guard the walk answers "ab", a text assembled from a range no
    // provider ever sent, and every marker computed from it sits on the wrong character.
    const step: ObjectEditStep = {
      text: "ab",
      language: "sql",
      segments: [
        { from: "user", start: 0, end: 2 },
        { from: "user", start: 1, end: 0 },
      ],
    };
    expect(userTextOf(step)).toBeUndefined();
  });

  test("a GAP between two user segments cannot be reconstructed and answers undefined", () => {
    const step: ObjectEditStep = {
      text: "abXYef",
      language: "sql",
      segments: [
        { from: "user", start: 0, end: 2 },
        { from: "provider", text: "XY" },
        { from: "user", start: 4, end: 6 },
      ],
    };
    // Offsets 2 and 3 of the reader's text were never sent, so nothing here knows what they were.
    // Answering a text with a hole in it would put a marker on the wrong character.
    expect(userTextOf(step)).toBeUndefined();
  });
});

describe("userPositionOf", () => {
  test("PostgreSQL: the measured pair, position 63 assembled is position 23 bare", () => {
    // 1-based engine positions become 0-based offsets, which is the other half of the measured
    // conversion: `model.getPositionAt()` is 0-based and PostgreSQL's `position` is 1-based.
    expect(userPositionOf(PG_STEP, 63 - 1)).toEqual({ within: "user", line: 1, column: 23 });
  });

  test("PostgreSQL: an offset inside the guard block is OUTSIDE and never a number", () => {
    // MEASURED in a real browser: an uncorrected coordinate did not throw, did not warn and did
    // not look wrong, because Monaco CLAMPED it to the end of the model and the marker sat at
    // line 10 column 1 while the real error was at line 7 column 3. So a coordinate this map
    // cannot place inside the reader's own text is a sentence, never a number.
    expect(userPositionOf(PG_STEP, 10)).toEqual({ within: "outside" });
  });

  test("PostgreSQL: a body error on a later line lands on that line", () => {
    // Constructed rather than measured, and it is the control that makes the single-line case
    // above non-vacuous: a conversion that ignored newlines would answer line 1 here too.
    const offset = PG_PREFIX.length + PG_USER_TEXT.indexOf("SELECT 1");
    expect(userPositionOf(PG_STEP, offset)).toEqual({ within: "user", line: 2, column: 3 });
  });

  test("THE CONTROL: the uncorrected offset answers a DIFFERENT position", () => {
    // Without this the corrected assertion passes whether or not the correction exists. The
    // uncorrected reading is what a client that trusted the engine's own offset would compute.
    //
    // RECOMPUTED in node while this plan was repaired: offset 62 of `PG_USER_TEXT` is still on the
    // FIRST line, because the header runs to `AS $$` at offset 65 and the first newline is at 65.
    // The plan previously asserted `{ line: 2, column: 6 }`, which is a different string's answer,
    // and acceptance criterion 4's only control would have failed.
    const uncorrected = lineColumnOfForTest(PG_USER_TEXT, 63 - 1);
    expect(uncorrected).not.toEqual({ line: 1, column: 23 });
    expect(uncorrected).toEqual({ line: 1, column: 63 });
  });

  test("Trino: the eleven-character insertion at offset 6", () => {
    // A first-line error at engine column c is reader column c - 11, and the splice is INSIDE the
    // first line, which is why a scalar prefix length cannot describe this engine.
    const engineOffsetOfName = TRINO_STEP.text.indexOf("memory.app.plus_one");
    expect(userPositionOf(TRINO_STEP, engineOffsetOfName)).toEqual({
      within: "user",
      line: 1,
      column: TRINO_USER_TEXT.indexOf("memory.app.plus_one") + 1,
    });
    expect(userPositionOf(TRINO_STEP, 8)).toEqual({ within: "outside" });
  });

  test("Redis: the identity, because there is no splice", () => {
    expect(userPositionOf(REDIS_STEP, 6)).toEqual({ within: "user", line: 1, column: 7 });
  });

  test("an offset past the end of the sent text is outside, and so is a negative one", () => {
    expect(userPositionOf(PG_STEP, PG_STEP.text.length)).toEqual({ within: "outside" });
    expect(userPositionOf(PG_STEP, -1)).toEqual({ within: "outside" });
  });

  test("a NON-INTEGER offset is outside, and it is not the range check that says so", () => {
    // Fix round 1, finding 2, MUTATION X2. Deleting `!Number.isInteger(sentOffset) ||` from the
    // entry guard killed 0 of 32 tests. The live population is named by this module's own
    // docblock: PostgreSQL's `position` arrives as a STRING although `QueryError.position` is
    // typed `number`, so a provider doing a byte-to-character or a `parseFloat` conversion can
    // hand in a fraction. 62.5 is inside the user segment and inside the range, so only the
    // integer clause can reject it; without that clause the map answers a confident
    // `{ within: "user", line: 1, column: 63 }` and Monaco renders the marker silently.
    expect(userPositionOf(PG_STEP, 62.5)).toEqual({ within: "outside" });
  });

  test("an offset AT the end of an over-covering step is outside", () => {
    // Fix round 1, finding 2, MUTATION X3. Changing `sentOffset >= step.text.length` to `>`
    // killed 0 of 32 tests, and the suite's own
    // `userPositionOf(PG_STEP, PG_STEP.text.length)` does NOT pin it: on a consistent step the
    // walk runs off the end and the trailing `return { within: "outside" }` answers the same
    // thing. Here the segments OVER-COVER the text, so with `>` the walk finds offset 3 inside
    // the user segment and answers `{ within: "user", line: 1, column: 4 }`, a column past the
    // end of a 3-character text.
    const step: ObjectEditStep = {
      text: "abc",
      language: "sql",
      segments: [{ from: "user", start: 0, end: 5 }],
    };
    expect(userPositionOf(step, step.text.length)).toEqual({ within: "outside" });
  });

  test("a step whose segments do not cover its own text answers outside rather than a position", () => {
    // NOT in the brief, and added because the brief's own Step 9 coverage check found the walk's
    // trailing `return { within: "outside" }` at zero hits: every fixture above is CONSISTENT, so
    // the loop always returns from inside and the last line is unreachable through them. The live
    // population is a provider whose `segments` drift from its own `text`, which is the exact
    // drift `renderSegments` exists to pin, and the honest answer for an offset past the mapped
    // region is a sentence rather than a position the client would clamp.
    const step: ObjectEditStep = {
      text: "abcd",
      language: "sql",
      segments: [{ from: "user", start: 0, end: 2 }],
    };
    expect(userPositionOf(step, 3)).toEqual({ within: "outside" });
  });

  test("a step whose user text cannot be reconstructed answers outside rather than guessing", () => {
    const step: ObjectEditStep = {
      text: "abXYef",
      language: "sql",
      segments: [
        { from: "user", start: 0, end: 2 },
        { from: "provider", text: "XY" },
        { from: "user", start: 4, end: 6 },
      ],
    };
    expect(userPositionOf(step, 5)).toEqual({ within: "outside" });
  });
});

describe("providerRanges", () => {
  test("names the ranges of the SENT text the provider wrote, for the preview's decoration", () => {
    expect(providerRanges(PG_STEP)).toEqual([{ start: 0, end: PG_PREFIX.length }]);
    expect(providerRanges(TRINO_STEP)).toEqual([{ start: 6, end: 17 }]);
    expect(providerRanges(REDIS_STEP)).toEqual([]);
  });
});

/** The uncorrected reading, kept in the test file because it is the control and never shipped. */
function lineColumnOfForTest(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: offset - lastBreak };
}

/**
 * The document contract: what is accepted, what is refused, and what an operator may supply.
 *
 * Every rejection here is driven with a bad literal rather than by shipping a broken file, which
 * is why `parseTuning` takes a document instead of reading one. The seam is the point: it is
 * also how a document that arrives from somewhere else will be checked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { activeTuning, operatorTuningStatus, resetTuning, tuningProvenance } from "@/lib/agent/model-tuning";
import bundled from "@/lib/agent/model-tuning/measured-profiles.json";
import {
  ModelTuningError,
  TUNING_SCHEMA_VERSION,
  TUNING_SETTING_KEYS,
  parseOperatorTuning,
  parseTuning,
} from "@/lib/agent/model-tuning/schema";
import { ceilingFor, retriesEmptyTurn } from "@/lib/agent/models";
import { BASELINE_NOTICES } from "@/lib/agent/models/notices";
import {
  DEFAULT_PLAN_STATEMENT_RETRIES,
  DEFAULT_PRESENT_REMINDER_LIMIT,
  DEFAULT_VERDICT_HOLD_LIMIT,
  DEFAULT_REFUSAL_EXAMPLES,
  DEFAULT_REPORT_REMINDER_LIMIT,
  DEFAULT_RETRY_EMPTY_TURN,
  DEFAULT_RETRY_UNREAD_STOP,
  DEFAULT_SUPPRESS_PLAN_REASONING,
  DEFAULT_SAMPLING,
  DEFAULT_UNREPORTED_CALL_CEILING,
} from "@/lib/agent/models/profile";

const ENV = "AGENT_MODEL_TUNING_PATH";

/** Settings that state every defaulted knob, which is what the document requires of an entry. */
const COMPLETE = {
  sampling: { temperature: 0, topP: 1 },
  unreportedCallCeiling: 12,
  reportReminderLimit: 1,
  planStatementRetries: 0,
  presentReminderLimit: 1,
  retryEmptyTurn: false,
  retryUnreadStop: false,
  suppressPlanReasoning: false,
  refusalExamples: false,
};

/** One complete entry, so a case can vary a single part of it without retyping the rest. */
const ENTRY = {
  id: "some-model:9b",
  measured: "five surfaces, five runs each",
  settings: COMPLETE,
};

const document = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: TUNING_SCHEMA_VERSION,
  measuredAgainst: {
    turnTimeoutMs: 90_000,
    protocol: "six surfaces, five consecutive passing runs each",
    defaults: {
      sampling: { temperature: 0, topP: 1 },
      unreportedCallCeiling: 12,
      reportReminderLimit: 1,
      planStatementRetries: 0,
      presentReminderLimit: 1,
      verdictHoldLimit: 2,
      retryEmptyTurn: false,
      retryUnreadStop: false,
      suppressPlanReasoning: false,
      refusalExamples: false,
    },
  },
  models: [ENTRY],
  ...overrides,
});

/** Writes a document to a temp file and returns its path, for the operator-supplied layer. */
const writeDocument = (body: unknown): string => {
  const path = join(mkdtempSync(join(tmpdir(), "libredb-tuning-")), "models.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
};

afterEach(() => {
  delete process.env[ENV];
  resetTuning();
});

describe("the document Studio ships with", () => {
  test("passes its own contract", () => {
    const tuning = parseTuning(bundled, "test");
    expect(Object.keys(tuning.models)).toHaveLength(22);
  });

  test("argues for every value it changed", () => {
    // The rule the loader deliberately does NOT enforce, enforced here instead: a setting that
    // differs from the recorded defaults and explains itself nowhere is a guess wearing a
    // measurement's clothes, and this directory is where guesses would accumulate.
    expect(parseTuning(bundled, "test").undocumentedOverrides).toEqual([]);
  });

  test("was measured against the defaults this build still compiles", () => {
    /*
      The one assertion that catches a default moving out from under ten measurements.

      It is a test rather than a load-time check on purpose. If someone changes
      `DEFAULT_UNREPORTED_CALL_CEILING`, the honest outcome is a red test asking whether the ten
      models were re-measured — not an agent that refuses to start, and not ten entries silently
      reclassified as undocumented overrides.
    */
    // `?.` because an OPERATOR document may record no basis; Studio's own always does, and the
    // strict schema is what guarantees it — so an undefined here would fail this assertion loudly
    // rather than pass as "nothing to compare".
    expect(parseTuning(bundled, "test").measuredAgainst?.defaults).toEqual({
      sampling: DEFAULT_SAMPLING,
      unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
      reportReminderLimit: DEFAULT_REPORT_REMINDER_LIMIT,
      planStatementRetries: DEFAULT_PLAN_STATEMENT_RETRIES,
      presentReminderLimit: DEFAULT_PRESENT_REMINDER_LIMIT,
      verdictHoldLimit: DEFAULT_VERDICT_HOLD_LIMIT,
      retryEmptyTurn: DEFAULT_RETRY_EMPTY_TURN,
      retryUnreadStop: DEFAULT_RETRY_UNREAD_STOP,
      suppressPlanReasoning: DEFAULT_SUPPRESS_PLAN_REASONING,
      refusalExamples: DEFAULT_REFUSAL_EXAMPLES,
    });
  });

  test("carries no wording, so no prompt text can arrive as data", () => {
    /*
      Asserted on the raw document, not the parsed one: the point is that there is nowhere in the
      file for a sentence to sit, which is what makes an externally supplied document unable to
      change what Studio says to a model.

      The sentences themselves rather than the field names — `planStatementRetries` is a SETTING
      and its name contains one of them, so a name-shaped assertion here fails on the document it
      is meant to approve.
    */
    const raw = JSON.stringify(bundled);
    for (const sentence of Object.values(BASELINE_NOTICES)) expect(raw).not.toContain(sentence);
  });

  test("has nowhere for wording to sit even if somebody tried", () => {
    /*
      The structural half, and the one that matters for a document arriving from elsewhere: the
      absence above is a fact about today's file, this is a fact about every file that will ever
      be accepted.

      Note what is NOT asserted. `PLAN_NO_STATEMENT_MARKER` does appear in the shipped document —
      inside the prose two entries use to explain why they ask for an extra plan turn. That is a
      justification quoting the bar, not prompt text being shipped as data, and a test that
      confused the two would be a test nobody could satisfy while still explaining the setting.
    */
    const withWording = {
      models: [{ ...ENTRY, notices: { ...BASELINE_NOTICES } }],
    };
    expect(() => parseTuning(document(withWording), "test")).toThrow(ModelTuningError);
  });
});

describe("what the contract refuses", () => {
  test.each([
    ["a key nobody implements", { models: [{ ...ENTRY, retryEmtpyTurn: true }] }],
    ["a document written for a newer Studio", { schemaVersion: TUNING_SCHEMA_VERSION + 1 }],
    [
      "a temperature past the top of the range",
      { models: [{ ...ENTRY, settings: { ...COMPLETE, sampling: { temperature: 3, topP: 1 } } }] },
    ],
    [
      "a turn limit longer than the shortest run",
      { models: [{ ...ENTRY, settings: { ...COMPLETE, turnTimeoutMs: 400_000 } }] },
    ],
    ["an entry that states none of its settings", { models: [{ id: "x:1b", measured: "m", settings: {} }] }],
    ["an empty measurement", { models: [{ ...ENTRY, measured: "" }] }],
  ])("refuses %s", (_name, overrides) => {
    expect(() => parseTuning(document(overrides), "test")).toThrow(ModelTuningError);
  });

  test("refuses one id spelled two ways rather than letting the later win", () => {
    // Silently collapsing them would apply settings the other entry argues against, and no
    // reader of the file could say which had been used.
    const twice = { models: [ENTRY, { ...ENTRY, id: "SOME-MODEL:9B" }] };
    expect(() => parseTuning(document(twice), "test")).toThrow(/appears twice/);
  });

  test("names the document it refused, so an operator knows which file to fix", () => {
    expect(() => parseTuning({}, "/etc/libredb/models.json")).toThrow(/\/etc\/libredb\/models\.json/);
  });

  test("reports an override with no argument instead of refusing to load", () => {
    // Loads, and says so — the distinction this whole arrangement rests on. A missing paragraph
    // is a fault in the writing; the settings behind it were still measured.
    const unexplained = {
      models: [{ ...ENTRY, settings: { ...COMPLETE, retryEmptyTurn: true } }],
    };
    const tuning = parseTuning(document(unexplained), "test");
    expect(tuning.models["some-model:9b"]?.retryEmptyTurn).toBe(true);
    expect(tuning.undocumentedOverrides).toEqual(["some-model:9b: retryEmptyTurn"]);
  });
});

describe("what a document from outside Studio is held to instead", () => {
  /*
    The bundled document and an operator's are checked by DIFFERENT rules, and the reason is that
    they have different authors.

    Completeness — every defaulted setting restated on every entry — is a discipline for the
    document this repository writes: it is how a measurement survives a default moving. Applied to
    a document somebody else wrote it stops being discipline and becomes a trap, because the set of
    settings grows. The day Studio adds an eighth knob, every mounted document in the world states
    seven, fails the contract, and is refused WHOLE — so every model in it silently reverts to the
    defaults, on an upgrade that changed nothing about their measurements. "Studio can gain a
    setting without breaking documents in the field" is the same requirement as "a model can be
    added without a Studio release", seen from the other end.

    So an operator's entry states what it measured and nothing more, and an unknown key is reported
    rather than fatal. Reported matters: a misspelled `retryEmtpyTurn` must not quietly do nothing,
    which is the whole argument for the strict schema in the first place.
  */
  test("an entry may state one setting, and the rest resolve to the defaults", () => {
    const partial = {
      models: [{ id: "some-model:9b", measured: "one surface, five runs", settings: { turnTimeoutMs: 120_000 } }],
    };
    const tuning = parseOperatorTuning(document(partial), "test");
    expect(tuning.models["some-model:9b"]).toEqual({ measured: "one surface, five runs", turnTimeoutMs: 120_000 });
  });

  test("replacing a bundled entry with a partial one falls to the defaults, not to half the old one", () => {
    // The whole-entry promise, seen through the tolerant schema: `gemma4:26b` ships a ceiling of
    // 10, and an operator entry that does not mention the ceiling does not inherit it.
    process.env[ENV] = writeDocument(
      document({ models: [{ id: "gemma4:26b", measured: "re-measured here", settings: { retryEmptyTurn: true } }] }),
    );
    resetTuning();
    expect(ceilingFor("gemma4:26b")).toBe(DEFAULT_UNREPORTED_CALL_CEILING);
    expect(retriesEmptyTurn("gemma4:26b")).toBe(true);
  });

  test("a key this Studio does not implement is reported rather than refusing the document", () => {
    const misspelled = {
      models: [{ id: "some-model:9b", measured: "m", settings: { retryEmtpyTurn: true } }],
    };
    const tuning = parseOperatorTuning(document(misspelled), "test");
    expect(tuning.models["some-model:9b"]).toBeDefined();
    expect(tuning.ignoredKeys).toEqual(["some-model:9b: retryEmtpyTurn"]);
  });

  test("a key misspelled outside settings is reported too, not only one inside it", () => {
    // `sumary` beside `settings` is the same mistake one level up, and the level is not something
    // the person who made it was thinking about.
    const misplaced = {
      models: [{ id: "some-model:9b", measured: "m", settings: { retryEmptyTurn: true }, sumary: ["typo"] }],
    };
    expect(parseOperatorTuning(document(misplaced), "test").ignoredKeys).toEqual(["some-model:9b: sumary"]);
  });

  test("a recorded default this Studio does not implement does not refuse the document", () => {
    /*
      The half of forward-compatibility that loosening `settings` alone does not buy.

      A document written against a NEWER Studio records that Studio's defaults, so its
      `measuredAgainst.defaults` carries a key this one has never heard of. Refusing on that puts
      every model in the document back on the defaults for a reason that has nothing to do with any
      measurement — the same failure as refusing on an unknown setting, one block up.
    */
    const newer = {
      measuredAgainst: {
        turnTimeoutMs: 90_000,
        protocol: "six surfaces",
        defaults: { ...COMPLETE, someSettingFromTomorrow: 3 },
      },
      models: [{ id: "some-model:9b", measured: "m", settings: { retryEmptyTurn: true } }],
    };
    expect(parseOperatorTuning(document(newer), "test").models["some-model:9b"]?.retryEmptyTurn).toBe(true);
  });

  test("a recorded default the document omits is not read as an override", () => {
    /*
      The other direction, and it must not be answered by guessing. A default the document does not
      record is a default it says nothing about, so the setting beside it cannot be called a
      deviation from it — reporting one would invent an override the writer never made.
    */
    const sparse = {
      measuredAgainst: { turnTimeoutMs: 90_000, protocol: "six surfaces", defaults: { retryEmptyTurn: false } },
      models: [{ id: "some-model:9b", measured: "m", settings: { unreportedCallCeiling: 7 } }],
    };
    const tuning = parseOperatorTuning(document(sparse), "test");
    expect(tuning.models["some-model:9b"]?.unreportedCallCeiling).toBe(7);
    expect(tuning.undocumentedOverrides).toEqual([]);
  });

  test("a rationale for a setting this Studio does not implement travels with it", () => {
    /*
      The shape a forward document actually has: a new setting AND the paragraph arguing for it.
      Accepting the setting while refusing its rationale would be a tolerance that defeats itself —
      the document Studio is built to survive is exactly the one it would reject.
    */
    const argued = {
      models: [
        {
          id: "some-model:9b",
          measured: "m",
          settings: { retryEmptyTurn: true, someSettingFromTomorrow: 3 },
          rationale: { someSettingFromTomorrow: ["measured on the operator's own hardware"] },
        },
      ],
    };
    const tuning = parseOperatorTuning(document(argued), "test");
    expect(tuning.models["some-model:9b"]?.retryEmptyTurn).toBe(true);
    expect(tuning.ignoredKeys).toEqual(["some-model:9b: someSettingFromTomorrow"]);
  });

  test("Studio's own document is still refused on both, so neither relaxation leaked", () => {
    const strayDefault = { measuredAgainst: { turnTimeoutMs: 1, protocol: "p", defaults: { ...COMPLETE, extra: 1 } } };
    expect(() => parseTuning(document(strayDefault), "test")).toThrow(ModelTuningError);
    const strayRationale = { models: [{ ...ENTRY, rationale: { notASetting: ["because"] } }] };
    expect(() => parseTuning(document(strayRationale), "test")).toThrow(ModelTuningError);
  });

  test("need not record a basis at all, because Studio never reads the operator's", () => {
    /*
      `activeTuning` keeps the BUNDLED `measuredAgainst` and drops this one, so requiring it made
      an operator write a block nothing reads — and, worse, write it CORRECTLY: `turnTimeoutMs`
      had to be a positive integer and `protocol` a non-empty string, so a blank protocol refused
      the whole document and put every model in it back on the defaults. A refusal path with
      nothing behind it.

      Studio's own document still records its basis, and still must: that is what
      `undocumentedOverrides` is compared against and what keeps ten measurements meaningful after
      a compiled default moves. The asymmetry is the point — the discipline belongs to the document
      this repository writes.
    */
    const withoutBasis = {
      schemaVersion: TUNING_SCHEMA_VERSION,
      models: [{ id: "some-model:9b", measured: "m", settings: { retryEmptyTurn: true } }],
    };
    const tuning = parseOperatorTuning(withoutBasis, "test");
    expect(tuning.models["some-model:9b"]?.retryEmptyTurn).toBe(true);
    expect(tuning.measuredAgainst).toBeUndefined();
    expect(tuning.undocumentedOverrides).toEqual([]);
    // And Studio's own document is still held to it.
    expect(() => parseTuning(withoutBasis, "test")).toThrow(ModelTuningError);
  });

  test("the bounds still hold, so a tolerant schema is not an unchecked one", () => {
    // Held per ENTRY rather than per document (B55/B57): the out-of-range entry is not applied,
    // which is the rule, and it is named so the operator can find the number that broke it.
    const outOfRange = {
      models: [
        { id: "some-model:9b", measured: "m", settings: { turnTimeoutMs: 400_000 } },
        { id: "other-model:9b", measured: "m", settings: { retryEmptyTurn: true } },
      ],
    };
    const tuning = parseOperatorTuning(document(outOfRange), "test");
    expect(tuning.models["some-model:9b"]).toBeUndefined();
    expect(tuning.models["other-model:9b"]?.retryEmptyTurn).toBe(true);
    expect(tuning.skippedEntries).toEqual([
      "some-model:9b: settings.turnTimeoutMs: Too big: expected number to be <=179999",
    ]);
  });

  test("wording is still refused, which is the one rule that does not relax", () => {
    // Tolerance is about settings Studio may not know yet. Prompt text is not a setting Studio
    // might add later: it is the thing a mounted document must never be able to say. Per-entry
    // validation does not soften that — the entry carrying it is refused whole, so no wording it
    // named can reach a run — it only stops the entry beside it paying for the attempt.
    const withWording = {
      models: [
        // `settings` is stated, and that is deliberate: it is a REQUIRED key, so the entry this
        // test used to carry — wording and nothing else — was refused for the missing settings and
        // never reached the `notices` rule at all. The assertion below now names the fault.
        { id: "some-model:9b", measured: "m", settings: { retryEmptyTurn: true }, notices: { ...BASELINE_NOTICES } },
        { id: "other-model:9b", measured: "m", settings: { retryEmptyTurn: true } },
      ],
    };
    const tuning = parseOperatorTuning(document(withWording), "test");
    expect(tuning.models["some-model:9b"]).toBeUndefined();
    expect(tuning.models["other-model:9b"]).toBeDefined();
    expect(tuning.skippedEntries[0]).toContain("notices");
    // And Studio's own document refuses the same entry whole, as it always did.
    expect(() => parseTuning(document(withWording), "test")).toThrow(ModelTuningError);
  });

  /*
    Per-ENTRY validation, which is where the all-or-nothing rule actually belongs (B57).

    The argument for refusing whole was always about MERGING — half of one measurement beside half
    of another is a configuration nobody has run — and that argument protects whole-ENTRY
    replacement, not whole-document rejection. A document holding fifty models lost all fifty to a
    typo in the thirty-seventh, and the day these are published as a catalog that failure lands on
    everyone who mounted it for a fault in an entry nobody else is using.
  */
  test("one bad entry loses only that entry, and the rest apply", () => {
    const mixed = {
      models: [
        { id: "first:9b", measured: "m", settings: { retryEmptyTurn: true } },
        { id: "broken:9b", measured: "m", settings: { unreportedCallCeiling: "twelve" } },
        { id: "third:9b", measured: "m", settings: { retryUnreadStop: true } },
      ],
    };
    const tuning = parseOperatorTuning(document(mixed), "test");

    expect(Object.keys(tuning.models)).toEqual(["first:9b", "third:9b"]);
    expect(tuning.skippedEntries[0]).toContain("broken:9b: settings.unreportedCallCeiling");
  });

  test("an entry whose id is what is wrong is reported by its position, not by an invented name", () => {
    // Reported by `id` everywhere there is one, because that is what the operator wrote and what
    // they will search the file for. When the id is the fault there is nothing to search for, so
    // the position is the only honest handle — naming a model nobody configured would be worse.
    const noId = { models: [{ measured: "m", settings: { retryEmptyTurn: true } }, { ...ENTRY }] };
    const tuning = parseOperatorTuning(document(noId), "test");

    expect(tuning.models["some-model:9b"]).toBeDefined();
    expect(tuning.skippedEntries[0]).toContain("#0: id");
  });

  test("an entry that is not an object at all is skipped by position too", () => {
    // The array's element type is unread until the entry is validated, so a bare number reaches
    // the labeller. It has no `id` to read, and reading one off a non-object must not throw.
    const notAnObject = { models: [7, { ...ENTRY }] };
    const tuning = parseOperatorTuning(document(notAnObject), "test");

    expect(tuning.models["some-model:9b"]).toBeDefined();
    expect(tuning.skippedEntries[0]).toContain("#0");
  });

  test("a duplicate id skips the second entry rather than refusing the document", () => {
    // Still not last-wins: two spellings of one id is a document nobody can read, and collapsing
    // them would apply settings the other entry argues against. What changes is the blast radius.
    const twice = {
      models: [
        { id: "some-model:9b", measured: "first", settings: { retryEmptyTurn: true } },
        { id: "SOME-MODEL:9B", measured: "second", settings: { retryEmptyTurn: false } },
        { id: "other:9b", measured: "m", settings: { retryUnreadStop: true } },
      ],
    };
    const tuning = parseOperatorTuning(document(twice), "test");

    expect(tuning.models["some-model:9b"]?.measured).toBe("first");
    expect(tuning.models["other:9b"]).toBeDefined();
    expect(tuning.skippedEntries).toEqual(["SOME-MODEL:9B: appears twice"]);
  });

  test("a document whose ENVELOPE is wrong is still refused whole, because nothing in it survives", () => {
    // Per-entry tolerance is about entries. A wrong `schemaVersion` means Studio cannot say what
    // any entry in the file means, and `models` not being an array leaves no entries to walk.
    expect(() => parseOperatorTuning(document({ schemaVersion: 99 }), "test")).toThrow(ModelTuningError);
    expect(() => parseOperatorTuning(document({ models: "some-model:9b" }), "test")).toThrow(ModelTuningError);
  });

  test("Studio's own document is still refused whole on a bad entry and on a duplicate", () => {
    // The asymmetry, again: a fault in the document this repository ships is a repo fault, caught
    // by the test suite before anybody runs it, so there is nothing to keep working around.
    const oneBad = { models: [{ ...ENTRY }, { ...ENTRY, id: "x:1b", settings: { ...COMPLETE, retryEmptyTurn: 3 } }] };
    expect(() => parseTuning(document(oneBad), "test")).toThrow(ModelTuningError);
    expect(() => parseTuning(document({ models: [ENTRY, ENTRY] }), "test")).toThrow(/appears twice/);
  });

  test("a document with no readable entry at all applies nothing and names every one it dropped", () => {
    // The degenerate case stated rather than left to be discovered: the document parsed, so it is
    // not "ignored"; it simply contributed no entry, and the list says which faults cost it.
    const allBad = {
      models: [
        { id: "a:1b", measured: "m", settings: { retryEmptyTurn: 3 } },
        { id: "b:1b", measured: "", settings: { retryEmptyTurn: true } },
      ],
    };
    const tuning = parseOperatorTuning(document(allBad), "test");
    expect(tuning.models).toEqual({});
    expect(tuning.skippedEntries).toHaveLength(2);
  });

  test("the bundled document is still held to completeness, so the discipline is not lost", () => {
    // The other half of the split. If this ever passes, the rule that keeps ten measurements
    // meaningful after a default moves has been quietly dropped for Studio's own document too.
    const incomplete = { models: [{ id: "x:1b", measured: "m", settings: { retryEmptyTurn: true } }] };
    expect(() => parseTuning(document(incomplete), "test")).toThrow(ModelTuningError);
  });
});

describe("the example the documentation hands out", () => {
  test("is a document this Studio accepts, and needs no explaining away", () => {
    /*
      `docs/llms/model-tuning.md` tells somebody who measured a model to start from this file and
      change it. An example that has quietly stopped parsing is worse than no example: it is read
      as the contract, so every document copied from it is wrong in the same way, and the person
      who follows the page correctly is the one who gets the failure.

      Asserted through the same entry point an operator's file goes through, and asserted on
      `ignoredKeys` and `undocumentedOverrides` as well as on parsing — an example carrying a
      misspelling Studio silently drops, or an override with no paragraph behind it, would be
      teaching both by demonstration.
    */
    const path = join(import.meta.dir, "../../../../docs/llms/model-tuning.example.json");
    const tuning = parseOperatorTuning(JSON.parse(readFileSync(path, "utf8")), "docs example");
    expect(Object.keys(tuning.models)).toEqual(["mistral-small:24b"]);
    expect(tuning.models["mistral-small:24b"]?.turnTimeoutMs).toBe(140_000);
    expect(tuning.ignoredKeys).toEqual([]);
    expect(tuning.undocumentedOverrides).toEqual([]);
  });
});

describe("a document an operator supplies", () => {
  test("gives a model Studio never measured the settings somebody else measured", () => {
    /*
      Requirement (e), as a behaviour rather than an assertion: a model with no entry in Studio's
      own document is driven by settings that arrived on a mounted file. No release, no code
      change, no settings screen.
    */
    process.env[ENV] = writeDocument(
      document({
        models: [
          {
            id: "some-model-released-tomorrow:70b",
            measured: "six surfaces, five runs each, on the operator's own hardware",
            summary: [],
            settings: { ...COMPLETE, retryEmptyTurn: true },
            rationale: { retryEmptyTurn: ["it returns an empty turn with its readings already taken"] },
          },
        ],
      }),
    );
    resetTuning();
    expect(retriesEmptyTurn("some-model-released-tomorrow:70b")).toBe(true);
  });

  test("replaces a bundled entry whole, never field by field", () => {
    // Half of one measurement beside half of another is a configuration nobody has ever run.
    process.env[ENV] = writeDocument(
      document({
        models: [
          {
            id: "qwen3.5:9b",
            measured: "re-measured here",
            summary: [],
            settings: COMPLETE,
            rationale: {},
          },
        ],
      }),
    );
    resetTuning();
    // The bundled entry carries a turn limit of 150 000; the operator's entry states none, so
    // the run falls back to the product's limit rather than inheriting half the old entry.
    expect(activeTuning().models["qwen3.5:9b"]?.turnTimeoutMs).toBeUndefined();
    expect(retriesEmptyTurn("qwen3.5:9b")).toBe(false);
  });

  test("leaves every model it does not name alone", () => {
    process.env[ENV] = writeDocument(document());
    resetTuning();
    expect(ceilingFor("gemma4:26b")).toBe(10);
  });

  test("is ignored whole when it cannot be read, and the shipped measurements stand", () => {
    // The policy `config.ts` states for its own variable: a mistyped setting must not take the
    // runtime down. Half-applying a broken document would be worse — it would resolve to a
    // configuration nobody chose.
    process.env[ENV] = writeDocument("{ not json");
    resetTuning();
    expect(ceilingFor("gemma4:26b")).toBe(10);
    expect(Object.keys(activeTuning().models)).toHaveLength(22);
  });

  test("reports that it ignored a document, naming the file and the reason", () => {
    /*
      The other half of "ignored, loudly", and the half nothing checked.

      Fail-open is only safe when the operator can find out it happened: they set a path, the
      settings they mounted are not in force, and until this existed a log line was the only thing
      that said so — unasserted, so deleting it left the suite green.

      Asserted as a VALUE rather than by spying on the logger, and that was forced rather than
      preferred. `tests/api/db/disconnect.test.ts` calls `mock.module("@/lib/logger", ...)`, which
      bun applies process-wide and which swaps the module for whoever imports it next, so a test
      file and the module under test can end up holding two different logger objects: spying either
      one passes alone and fails in the full suite. A status the loader returns is the same fact
      without the ordering, and `/api/agent/config` needs it anyway — a warning in a container log
      is not a diagnosis an operator can reach.
    */
    const path = writeDocument("{ not json");
    process.env[ENV] = path;
    resetTuning();
    const status = operatorTuningStatus();
    expect(status.state).toBe("ignored");
    expect(status.state === "ignored" && status.path).toBe(path);
    expect(status.state === "ignored" && status.reason).toContain("JSON");
  });

  test("reports a digest of the document it applied, so a later edit is visible", () => {
    /*
      The status says WHICH file; the digest says WHICH VERSION of it. A run recorded against a
      path alone cannot be told apart from a run against the same path after somebody edited it,
      which is most of the value of recording the path at all.

      Of the bytes as read, not of the parsed result: a parsed object would have to be serialised
      to be hashed, and two serialisations of one document are the same file while two files with
      the same meaning are not the same evidence.
    */
    const body = JSON.stringify(document());
    process.env[ENV] = writeDocument(body);
    resetTuning();
    const status = operatorTuningStatus();

    expect(status.state).toBe("applied");
    expect(status.state === "applied" && status.digest).toBe(createHash("sha256").update(body).digest("hex"));
  });

  test("reports the document it applied, and how many models it carried", () => {
    process.env[ENV] = writeDocument(document());
    resetTuning();
    const status = operatorTuningStatus();
    expect(status.state).toBe("applied");
    expect(status.state === "applied" && status.models).toBe(1);
    expect(status.state === "applied" && status.skippedEntries).toEqual([]);
  });

  test("reports the entries it skipped by id, the way it reports ignored keys", () => {
    /*
      The reporting surface a per-entry refusal needs (B57), and it is the one `ignoredKeys`
      already had for the same reason: the document was applied AROUND the fault, so without this
      an operator's thirty-seventh entry would do nothing and say nothing — which is exactly the
      quietness the strict schema existed to prevent.
    */
    process.env[ENV] = writeDocument(
      document({
        models: [
          { id: "applied:9b", measured: "m", settings: { retryEmptyTurn: true } },
          { id: "dropped:9b", measured: "m", settings: { retryEmptyTurn: "yes" } },
        ],
      }),
    );
    resetTuning();
    const status = operatorTuningStatus();

    expect(status.state).toBe("applied");
    expect(status.state === "applied" && status.models).toBe(1);
    expect(status.state === "applied" && status.skippedEntries?.[0]).toContain("dropped:9b: settings.retryEmptyTurn");
    expect(activeTuning().models["applied:9b"]?.retryEmptyTurn).toBe(true);
  });

  test("reports a relative path as the absolute one it actually looked at", () => {
    /*
      The working directory is not the same thing in every place this ships — /app in the
      container, wherever the user stood under `npx`, the checkout in development — so a relative
      value is really a question about which directory, and the report is where that gets answered
      rather than guessed. Resolved rather than refused: refusing adds a failure mode, and naming
      the path it opened tells the operator everything refusing would have.
    */
    process.env[ENV] = "not-a-real-document.json";
    resetTuning();
    const status = operatorTuningStatus();
    expect(status.state).toBe("ignored");
    expect(status.state === "ignored" && status.path).toBe(resolve("not-a-real-document.json"));
  });

  test("says operator ONLY for a model the operator's document actually supplied", () => {
    /*
      The provenance answers "what drove THIS run", not "what was configured on this server", and
      the two come apart the moment a document names a model the run is not using.

      Demonstrated by accident before it was fixed: a live check mounted a document for
      `mistral-small:24b` — chosen precisely so it would not change the running model — drove
      `gemini-3.5-flash-lite`, and the ledger recorded `operator` with that document's digest while
      gemini's settings had come from the bundled one. The event named a file that had not touched
      the run.

      Lower-cased on the way in, because that is how the register is keyed and a provenance that
      disagreed with the resolver about which entry applies would be worse than no provenance.
    */
    const body = JSON.stringify(
      document({ models: [{ id: "Some-Model:9B", measured: "m", settings: { retryEmptyTurn: true } }] }),
    );
    process.env[ENV] = writeDocument(body);
    resetTuning();

    expect(tuningProvenance("some-model:9b")).toEqual({
      origin: "operator",
      digest: createHash("sha256").update(body).digest("hex"),
    });
    // Applied, but silent about this model — so this model was driven by the shipped settings.
    expect(tuningProvenance("gemini-3.5-flash-lite")).toEqual({ origin: "bundled" });
  });

  test("projects the other two states onto what a run records", () => {
    resetTuning();
    expect(tuningProvenance("qwen3:8b")).toEqual({ origin: "bundled" });

    process.env[ENV] = writeDocument("{ not json");
    resetTuning();
    // No path: the ledger is readable by any owner of the run, and a server filesystem path is
    // not theirs to read. Which file it was belongs to `GET /api/agent/config`, which is admin-only.
    expect(tuningProvenance("qwen3:8b")).toEqual({ origin: "operator-ignored" });
  });

  test("reports nothing configured when no path was set", () => {
    resetTuning();
    expect(operatorTuningStatus().state).toBe("unset");
  });

  test("is ignored when the file is empty, which a ConfigMap key with no value renders", () => {
    // Not a hypothetical shape: `agent.modelTuning.document` left at `{}` in a values file, or a
    // key an operator created and has not filled in yet, both arrive as zero bytes. `JSON.parse`
    // refuses it and the reason says so, rather than the empty document resolving to "no models"
    // and silently replacing nothing while reporting success.
    process.env[ENV] = writeDocument("");
    resetTuning();
    const status = operatorTuningStatus();
    expect(status.state).toBe("ignored");
    expect(ceilingFor("gemma4:26b")).toBe(10);
  });

  test("is ignored when it breaks the contract, not partially applied", () => {
    process.env[ENV] = writeDocument(document({ schemaVersion: 99 }));
    resetTuning();
    expect(Object.keys(activeTuning().models)).toHaveLength(22);
  });

  test("is ignored when the file is not there at all", () => {
    process.env[ENV] = "/nonexistent/models.json";
    resetTuning();
    expect(Object.keys(activeTuning().models)).toHaveLength(22);
  });

  test("an unset or blank variable is simply no operator document", () => {
    // Blank matters: it is what a Helm template renders when nobody filled the value in, and
    // reading it as a path would warn on every boot of an install that configured nothing.
    process.env[ENV] = "   ";
    resetTuning();
    expect(Object.keys(activeTuning().models)).toHaveLength(22);
  });

  test("is read once, so a run cannot see the table change under it", () => {
    process.env[ENV] = writeDocument(document());
    resetTuning();
    const first = activeTuning();
    expect(activeTuning()).toBe(first);
  });
});

describe("the settings table documents every key the schema accepts", () => {
  /*
    `docs/AGENT.md` calls the settings table in `docs/llms/model-tuning.md` "the document's own
    contract — every setting, its bounds", and nothing checked that sentence. Two keys had reached
    the schema without reaching the table — `verdictHoldLimit`, added with this branch's per-model
    reminder bound, and `suppressAgentReasoning` before it — so an operator had no way to learn
    either exists, and a misspelling of either lands silently in `ignoredKeys` rather than being
    refused.

    Asserted rather than argued, because the next key added will be added by somebody who did not
    read this comment.
  */
  const TABLE = readFileSync(resolve(import.meta.dir, "../../../../docs/llms/model-tuning.md"), "utf8");

  // Spread because `test.each` takes a mutable array and the export is readonly — the export is
  // read-only on purpose, since nothing may edit the schema's key list through it.
  test.each([...TUNING_SETTING_KEYS])("`%s` has a row", (key) => {
    // The leading pipe and backtick are what make this a TABLE ROW rather than a mention in the
    // prose around it: `turnTimeoutMs` is discussed in three paragraphs, and a test satisfied by
    // prose would not have caught either of the two keys that were missing.
    expect(TABLE).toContain(`| \`${key}\` |`);
  });

  test("and `perWorkflow`, which is a row without being a key of its own", () => {
    // The one row that is not in `settingsShape`: it is a field of `sampling`'s sibling object
    // rather than a setting, and it is in the table because an operator sets it by name.
    expect(TABLE).toContain("| `perWorkflow` |");
  });
});

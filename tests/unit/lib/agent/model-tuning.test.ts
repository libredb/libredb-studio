/**
 * The document contract: what is accepted, what is refused, and what an operator may supply.
 *
 * Every rejection here is driven with a bad literal rather than by shipping a broken file, which
 * is why `parseTuning` takes a document instead of reading one. The seam is the point: it is
 * also how a document that arrives from somewhere else will be checked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeTuning, providerTier, resetTuning } from "@/lib/agent/model-tuning";
import bundled from "@/lib/agent/model-tuning/measured-profiles.json";
import { ModelTuningError, TUNING_SCHEMA_VERSION, parseTuning } from "@/lib/agent/model-tuning/schema";
import { ceilingFor, retriesEmptyTurn, samplingFor } from "@/lib/agent/models";
import { BASELINE_NOTICES } from "@/lib/agent/models/notices";
import {
  DEFAULT_PLAN_STATEMENT_RETRIES,
  DEFAULT_PRESENT_REMINDER_LIMIT,
  DEFAULT_REFUSAL_EXAMPLES,
  DEFAULT_REPORT_REMINDER_LIMIT,
  DEFAULT_RETRY_EMPTY_TURN,
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
  refusalExamples: false,
};

/** One complete entry, so a case can vary a single part of it without retyping the rest. */
const ENTRY = {
  id: "some-model:9b",
  measured: "five surfaces, five runs each",
  summary: [] as string[],
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
      retryEmptyTurn: false,
      refusalExamples: false,
    },
  },
  providers: [],
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
    expect(Object.keys(tuning.models)).toHaveLength(10);
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
    expect(parseTuning(bundled, "test").measuredAgainst.defaults).toEqual({
      sampling: DEFAULT_SAMPLING,
      unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
      reportReminderLimit: DEFAULT_REPORT_REMINDER_LIMIT,
      planStatementRetries: DEFAULT_PLAN_STATEMENT_RETRIES,
      presentReminderLimit: DEFAULT_PRESENT_REMINDER_LIMIT,
      retryEmptyTurn: DEFAULT_RETRY_EMPTY_TURN,
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
    ["a provider tier for a provider that does not exist", { providers: [{ id: "olama", settings: {} }] }],
    [
      "an entry that states none of its settings",
      { models: [{ id: "x:1b", measured: "m", summary: [], settings: {} }] },
    ],
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

  test("refuses one provider tier stated twice", () => {
    const twice = {
      providers: [
        { id: "ollama", settings: {} },
        { id: "ollama", settings: {} },
      ],
    };
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

describe("the three layers", () => {
  test("a provider tier reaches a model nobody has measured", () => {
    // Requirement (c), and the only place it can be exercised: the ten measured models all have
    // entries of their own, and every shipped tier is empty.
    const withTier = {
      providers: [
        {
          id: "ollama",
          settings: { unreportedCallCeiling: 7 },
          rationale: { unreportedCallCeiling: ["measured across this provider"] },
        },
      ],
    };
    const tuning = parseTuning(document(withTier), "test");
    expect(tuning.providers.ollama?.unreportedCallCeiling).toBe(7);
  });

  test("a model's own measurement beats its provider's tier", () => {
    // The order is the contract. A tier that won would overwrite the thing it was meant to
    // stand in for.
    const both = {
      providers: [
        { id: "ollama", settings: { unreportedCallCeiling: 7 }, rationale: { unreportedCallCeiling: ["tier"] } },
      ],
      models: [
        {
          ...ENTRY,
          settings: { ...COMPLETE, unreportedCallCeiling: 9 },
          rationale: { unreportedCallCeiling: ["model"] },
        },
      ],
    };
    const tuning = parseTuning(document(both), "test");
    expect(tuning.models["some-model:9b"]?.unreportedCallCeiling).toBe(9);
    expect(tuning.providers.ollama?.unreportedCallCeiling).toBe(7);
  });

  test("a model's own sampling beats a tier's value for the same surface", () => {
    /*
      Asserted through the RESOLVER, not through the parsed document, because that is where this
      went wrong. The first version of `samplingFor` chose one surface value — the model's if it
      had one, otherwise the tier's — and spread it last, so a tier's per-surface value landed on
      top of a model's own general sampling. The document-level test above would not have caught
      it: both entries parse correctly, and it is the merge that inverts them.
    */
    process.env[ENV] = writeDocument(
      document({
        providers: [
          {
            id: "ollama",
            settings: { perWorkflow: { investigation: { temperature: 1.9, topP: 0.3 } } },
            rationale: { perWorkflow: ["a tier value, to be beaten by a model's own"] },
          },
        ],
        models: [],
      }),
    );
    resetTuning();
    // `qwen3:8b` states no per-surface value for investigation, so the tier is the only other
    // candidate — and its own measured sampling must still win.
    expect(samplingFor("qwen3:8b", "investigation", "ollama")).toEqual({ temperature: 0, topP: 1 });
    // Its own per-surface value stands where it has one.
    expect(samplingFor("qwen3:8b", "query-optimization", "ollama")).toEqual({ temperature: 0.8, topP: 0.9 });
  });

  test("a tier's sampling does reach a model that has no entry at all", () => {
    // The other half: the tier is not inert, it is outranked. A model nobody measured takes it.
    process.env[ENV] = writeDocument(
      document({
        providers: [
          {
            id: "ollama",
            settings: { sampling: { temperature: 0.4, topP: 0.7 } },
            rationale: { sampling: ["measured across this provider"] },
          },
        ],
        models: [],
      }),
    );
    resetTuning();
    expect(samplingFor("some-model-released-tomorrow:70b", "investigation", "ollama")).toEqual({
      temperature: 0.4,
      topP: 0.7,
    });
  });

  test("no tier is claimed for a run whose provider nobody passed", () => {
    expect(providerTier(undefined)).toEqual({});
  });

  test("the shipped tiers are empty, so no measured model resolves differently for it", () => {
    // Said out loud because it is the honest state: the mechanism ships, the values do not.
    // Across the ten, no setting is shared by all models of any provider.
    expect(activeTuning().providers).toEqual({});
    for (const provider of ["ollama", "openai", "gemini", "custom"] as const) {
      expect(ceilingFor("qwen3:8b", provider)).toBe(ceilingFor("qwen3:8b"));
      expect(samplingFor("qwen3:8b", "query-optimization", provider)).toEqual(
        samplingFor("qwen3:8b", "query-optimization"),
      );
    }
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
    expect(Object.keys(activeTuning().models)).toHaveLength(10);
  });

  test("is ignored when it breaks the contract, not partially applied", () => {
    process.env[ENV] = writeDocument(document({ schemaVersion: 99 }));
    resetTuning();
    expect(Object.keys(activeTuning().models)).toHaveLength(10);
  });

  test("is ignored when the file is not there at all", () => {
    process.env[ENV] = "/nonexistent/models.json";
    resetTuning();
    expect(Object.keys(activeTuning().models)).toHaveLength(10);
  });

  test("an unset or blank variable is simply no operator document", () => {
    // Blank matters: it is what a Helm template renders when nobody filled the value in, and
    // reading it as a path would warn on every boot of an install that configured nothing.
    process.env[ENV] = "   ";
    resetTuning();
    expect(Object.keys(activeTuning().models)).toHaveLength(10);
  });

  test("is read once, so a run cannot see the table change under it", () => {
    process.env[ENV] = writeDocument(document());
    resetTuning();
    const first = activeTuning();
    expect(activeTuning()).toBe(first);
  });
});

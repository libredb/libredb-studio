/**
 * The runtime settings store (spec 7.8, 9.5): every row of `settings_v1` is checked against the registry on each
 * load, a valid value is kept for `runtimeSetting()`, and an invalid one is ignored and reported as a SETTING_INVALID
 * skip by key and code, never by value.
 *
 * The state holder is the real one: each case records a snapshot the way the loader does, with the settings the store
 * made of its rows.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runtimeSetting, type SettingKey, settingSource, validateSettings } from "@/lib/governance/settings";
import { SETTINGS_REGISTRY } from "@/lib/governance/settings-registry";
import { type GovernanceSnapshot, recordGovernanceSnapshot, resetGovernanceState } from "@/lib/governance/state";

const UPDATED_AT = new Date("2026-10-15T08:00:00.000Z");

const row = (key: unknown, value: unknown) => ({ key, value, updated_at: UPDATED_AT });

/** Valid and invalid values of each key, at and just past its bounds. */
const CASES: Record<SettingKey, { readonly valid: readonly unknown[]; readonly invalid: readonly unknown[] }> = {
  "ai.enabled": { valid: [true, false], invalid: ["true", 1, null] },
  "agent.enabled": { valid: [true, false], invalid: ["false", 0, {}] },
  "mcp.enabled": { valid: [true, false], invalid: ["yes", [], null] },
  "query.timeoutMs": { valid: [1000, 60_000, 3_600_000], invalid: [999, 3_600_001, 1500.5, "60000", null] },
  "provider.poolMaxPerUser": { valid: [1, 3, 10], invalid: [0, 11, 2.5, "3", true] },
  "queryLog.statementCapture": { valid: ["none", "redacted", "full"], invalid: ["FULL", "", 1, null] },
  "queryLog.maxStatementBytes": { valid: [256, 4096, 65_536], invalid: [255, 65_537, 300.1, "4096"] },
  "queryLog.onSinkFailure": { valid: ["continue", "refuse"], invalid: ["stop", true, null] },
};

const KEYS = Object.keys(CASES) as SettingKey[];

function load(rows: readonly ReturnType<typeof row>[], contractVersion = 1): GovernanceSnapshot {
  const snapshot: GovernanceSnapshot = {
    loadedAt: Date.now(),
    contractVersion,
    publishedVersions: [contractVersion],
    connections: new Map(),
    skipped: [],
    grants: new Map(),
    revocations: new Map(),
    settings: validateSettings(rows, contractVersion),
    canary: {},
  };
  recordGovernanceSnapshot(snapshot);
  return snapshot;
}

let savedSource: string | undefined;

beforeEach(() => {
  savedSource = process.env.GOVERNANCE_SOURCE;
  process.env.GOVERNANCE_SOURCE = "postgres";
  resetGovernanceState();
});

afterEach(() => {
  resetGovernanceState();
  if (savedSource === undefined) delete process.env.GOVERNANCE_SOURCE;
  else process.env.GOVERNANCE_SOURCE = savedSource;
});

describe("validateSettings", () => {
  test("each of the eight keys accepts its valid values and ignores and reports an invalid one with SETTING_INVALID", () => {
    expect(SETTINGS_REGISTRY.map((definition) => definition.key)).toEqual(KEYS);

    for (const key of KEYS) {
      for (const value of CASES[key].valid) {
        const settings = load([row(key, value)]).settings;
        expect(settings).toEqual({ values: new Map([[key, value as never]]), ignored: [], malformed: 0 });
        expect(runtimeSetting(key)).toBe(value as never);
        expect(settingSource(SETTINGS_REGISTRY.find((definition) => definition.key === key)!)).toBe("runtime");
      }
      for (const value of CASES[key].invalid) {
        const settings = load([row(key, value)]).settings;
        expect(settings).toEqual({
          values: new Map(),
          ignored: [{ kind: "setting", id: key, code: "SETTING_INVALID" }],
          malformed: 0,
        });
        expect(runtimeSetting(key)).toBeUndefined();
      }
    }
  });

  test("an invalid row leaves the valid rows of other keys in force and the report carries no value", () => {
    const settings = validateSettings(
      [
        row("ai.enabled", false),
        row("query.timeoutMs", "SETTING-VALUE-CANARY"),
        row("queryLog.onSinkFailure", "refuse"),
      ],
      1,
    );

    expect([...settings.values]).toEqual([
      ["ai.enabled", false],
      ["queryLog.onSinkFailure", "refuse"],
    ]);
    expect(settings.ignored).toEqual([{ kind: "setting", id: "query.timeoutMs", code: "SETTING_INVALID" }]);
    expect(JSON.stringify(settings.ignored)).not.toContain("SETTING-VALUE-CANARY");
  });

  test("a key the registry does not publish, and two rows for one key, are reported once each and set nothing", () => {
    const settings = validateSettings(
      [
        row("statement.capture", "full"),
        row("query.timeoutMs", 30_000),
        row("query.timeoutMs", 40_000),
        row("query.timeoutMs", 50_000),
      ],
      1,
    );

    expect(settings).toEqual({
      values: new Map(),
      ignored: [
        { kind: "setting", id: "statement.capture", code: "SETTING_INVALID" },
        { kind: "setting", id: "query.timeoutMs", code: "SETTING_INVALID" },
      ],
      malformed: 0,
    });
  });

  test("a row whose key is not a well-formed setting key is counted, not reported, because it has no id to report", () => {
    const settings = validateSettings([row(7, true), row("", true), row("Ai.enabled", true), row(null, 1)], 1);

    expect(settings).toEqual({ values: new Map(), ignored: [], malformed: 4 });
  });

  test("a key is read only under a contract version that publishes it", () => {
    const settings = validateSettings([row("ai.enabled", false)], 0);

    expect(settings.ignored).toEqual([{ kind: "setting", id: "ai.enabled", code: "SETTING_INVALID" }]);
    expect(settings.values.size).toBe(0);
  });
});

describe("runtimeSetting", () => {
  test("an absent key leaves runtimeSetting undefined so the environment value or the default applies", () => {
    load([row("query.timeoutMs", 30_000)]);

    expect(runtimeSetting("query.timeoutMs")).toBe(30_000);
    for (const key of KEYS.filter((key) => key !== "query.timeoutMs")) {
      expect(runtimeSetting(key)).toBeUndefined();
    }
    const sources = Object.fromEntries(
      SETTINGS_REGISTRY.map((definition) => [definition.key, settingSource(definition)]),
    );
    expect(sources).toEqual({
      "ai.enabled": "default",
      "agent.enabled": "environment",
      "mcp.enabled": "environment",
      "query.timeoutMs": "runtime",
      "provider.poolMaxPerUser": "default",
      "queryLog.statementCapture": "default",
      "queryLog.maxStatementBytes": "default",
      "queryLog.onSinkFailure": "default",
    });
  });

  test("before the first load every key is undefined", () => {
    for (const key of KEYS) expect(runtimeSetting(key)).toBeUndefined();
  });

  test("with governance off runtimeSetting answers undefined for every key, even beside a recorded snapshot", () => {
    load(KEYS.map((key) => row(key, CASES[key].valid[0])));
    for (const key of KEYS) expect(runtimeSetting(key)).toBe(CASES[key].valid[0] as never);

    for (const off of [undefined, ""]) {
      if (off === undefined) delete process.env.GOVERNANCE_SOURCE;
      else process.env.GOVERNANCE_SOURCE = off;

      for (const key of KEYS) expect(runtimeSetting(key)).toBeUndefined();
      for (const definition of SETTINGS_REGISTRY) expect(settingSource(definition)).not.toBe("runtime");
    }
  });
});

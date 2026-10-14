/**
 * The runtime settings registry of governance contract v1 (spec 7.8, appendix A.2).
 *
 * The registry is the one place Studio names the keys a control plane may set at runtime. A control plane seeds
 * its allowlist from the published manifest, so a key, type, bound or description that drifts here reaches every
 * governed install. The expected values below are transcribed from spec 7.8 and appendix A.2 by hand, on purpose:
 * a test that derived them from the registry would certify whatever the registry says.
 */
import { describe, expect, test } from "bun:test";
import { SETTING_KEY_PATTERN, SETTINGS_REGISTRY, type SettingDefinition } from "@/lib/governance/settings-registry";

/** Spec 7.8: key, type, allowed values or bounds, and the Studio default or environment counterpart. */
const SPEC_7_8: Pick<
  SettingDefinition,
  "key" | "type" | "allowedValues" | "min" | "max" | "default" | "environment"
>[] = [
  {
    key: "ai.enabled",
    type: "boolean",
    allowedValues: null,
    min: null,
    max: null,
    default: true,
    environment: null,
  },
  {
    key: "agent.enabled",
    type: "boolean",
    allowedValues: null,
    min: null,
    max: null,
    default: null,
    environment: "LIBREDB_AGENT_ENABLED",
  },
  {
    key: "mcp.enabled",
    type: "boolean",
    allowedValues: null,
    min: null,
    max: null,
    default: null,
    environment: "LIBREDB_MCP_ENABLED",
  },
  {
    key: "query.timeoutMs",
    type: "integer",
    allowedValues: null,
    min: 1000,
    max: 3600000,
    default: 60000,
    environment: null,
  },
  {
    key: "provider.poolMaxPerUser",
    type: "integer",
    allowedValues: null,
    min: 1,
    max: 10,
    default: 3,
    environment: null,
  },
  {
    key: "queryLog.statementCapture",
    type: "string",
    allowedValues: ["none", "redacted", "full"],
    min: null,
    max: null,
    default: "none",
    environment: null,
  },
  {
    key: "queryLog.maxStatementBytes",
    type: "integer",
    allowedValues: null,
    min: 256,
    max: 65536,
    default: 4096,
    environment: null,
  },
  {
    key: "queryLog.onSinkFailure",
    type: "string",
    allowedValues: ["continue", "refuse"],
    min: null,
    max: null,
    default: "continue",
    environment: null,
  },
];

/** Appendix A.2: the description each allowlist row is seeded with. */
const A2_DESCRIPTIONS: Record<string, string> = {
  "ai.enabled": "AI assistance routes are available",
  "agent.enabled": "The query agent is available when its prerequisites are configured",
  "mcp.enabled": "The MCP endpoint is available when its prerequisites are configured",
  "query.timeoutMs": "Statement timeout applied to governed connections",
  "provider.poolMaxPerUser": "Maximum pooled database sessions per user and connection",
  "queryLog.statementCapture": "What Studio records of a statement in bridge.query_events_v1",
  "queryLog.maxStatementBytes": "UTF-8 byte cap applied to a captured statement before insert",
  "queryLog.onSinkFailure": "Whether Studio keeps executing while it cannot record query events",
};

describe("settings registry v1", () => {
  test("the registry holds exactly the eight v1 keys with the types, bounds and defaults of spec 7.8", () => {
    expect(
      SETTINGS_REGISTRY.map((setting) => ({
        key: setting.key,
        type: setting.type,
        allowedValues: setting.allowedValues,
        min: setting.min,
        max: setting.max,
        default: setting.default,
        environment: setting.environment,
      })),
    ).toEqual(SPEC_7_8);
  });

  test("every key is published under contract 1 with the description appendix A.2 seeds", () => {
    for (const setting of SETTINGS_REGISTRY) {
      expect(setting.sinceContract).toBe(1);
      expect(setting.description).toBe(A2_DESCRIPTIONS[setting.key]);
    }
  });

  test("every key matches the allowlist key format of appendix A.2 and appears once", () => {
    expect(SETTING_KEY_PATTERN).toBe("^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)+$");
    const format = new RegExp(SETTING_KEY_PATTERN);
    for (const setting of SETTINGS_REGISTRY) expect(setting.key).toMatch(format);
    expect(new Set(SETTINGS_REGISTRY.map((setting) => setting.key)).size).toBe(SETTINGS_REGISTRY.length);
    for (const refused of ["ai", "AI.enabled", "ai.", "ai..enabled", "ai.enabled-x", "1ai.enabled"]) {
      expect(refused).not.toMatch(format);
    }
  });

  test("a key has either a Studio default inside its domain or an environment counterpart, never both", () => {
    for (const setting of SETTINGS_REGISTRY) {
      expect((setting.default === null) !== (setting.environment === null)).toBe(true);
      if (setting.default === null) continue;
      if (setting.type === "boolean") expect(typeof setting.default).toBe("boolean");
      if (setting.type === "integer") {
        expect(Number.isInteger(setting.default)).toBe(true);
        expect(setting.default as number).toBeGreaterThanOrEqual(setting.min as number);
        expect(setting.default as number).toBeLessThanOrEqual(setting.max as number);
      }
      if (setting.type === "string") expect(setting.allowedValues).toContain(setting.default as string);
    }
  });

  test("only integers carry bounds, only strings carry allowed values, and every key names its consumer", () => {
    for (const setting of SETTINGS_REGISTRY) {
      expect(setting.min === null && setting.max === null).toBe(setting.type !== "integer");
      expect(setting.allowedValues === null).toBe(setting.type !== "string");
      expect(setting.consumer.trim().length).toBeGreaterThan(0);
    }
  });
});

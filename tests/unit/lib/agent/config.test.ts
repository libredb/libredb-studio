import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  AGENT_ENABLED_ENV,
  AGENT_WORLD_TARGET_ENV,
  AgentConfigError,
  getAgentRuntimeConfig,
  isAgentRuntimeEnabled,
  resolveAgentDurableBackend,
  SANCTIONED_WORLD_TARGETS,
} from "@/lib/agent/config";

const ENV_KEYS = [AGENT_ENABLED_ENV, AGENT_WORLD_TARGET_ENV, "VERCEL_DEPLOYMENT_ID"] as const;

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function captureRefusal(fn: () => unknown): AgentConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentConfigError);
    return error as AgentConfigError;
  }
  throw new Error("expected the configuration to be refused");
}

// ─── the enable flag ────────────────────────────────────────────────────────

describe("isAgentRuntimeEnabled", () => {
  test("is off when the variable is absent — the agent rail ships default off", () => {
    expect(isAgentRuntimeEnabled()).toBe(false);
  });

  test("is off when the variable is empty or whitespace only", () => {
    process.env[AGENT_ENABLED_ENV] = "";
    expect(isAgentRuntimeEnabled()).toBe(false);
    process.env[AGENT_ENABLED_ENV] = "   ";
    expect(isAgentRuntimeEnabled()).toBe(false);
  });

  test.each(["true", "TRUE", "True", " true ", "on", "ON", "1"])(
    "is on for the affirmative value %p, case-insensitively and trimmed",
    (value) => {
      process.env[AGENT_ENABLED_ENV] = value;
      expect(isAgentRuntimeEnabled()).toBe(true);
    },
  );

  test.each(["false", "FALSE", "off", "OFF", "0", " 0 "])("is off for the negative value %p", (value) => {
    process.env[AGENT_ENABLED_ENV] = value;
    expect(isAgentRuntimeEnabled()).toBe(false);
  });

  test("an unrecognised value stays off and warns, so a typo never silently enables the agent", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env[AGENT_ENABLED_ENV] = "yes-please";
      expect(isAgentRuntimeEnabled()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain(AGENT_ENABLED_ENV);
      expect(message).toContain("yes-please");
    } finally {
      warn.mockRestore();
    }
  });

  test("a recognised value does not warn", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env[AGENT_ENABLED_ENV] = "true";
      expect(isAgentRuntimeEnabled()).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── the durable backend ────────────────────────────────────────────────────

describe("resolveAgentDurableBackend", () => {
  test("defaults to the zero-config local backend when the variable is absent", () => {
    expect(resolveAgentDurableBackend()).toBe("local");
  });

  test("defaults to the local backend when the variable is empty", () => {
    process.env[AGENT_WORLD_TARGET_ENV] = "";
    expect(resolveAgentDurableBackend()).toBe("local");
  });

  test("maps every sanctioned target onto its backend", () => {
    for (const [target, backend] of Object.entries(SANCTIONED_WORLD_TARGETS)) {
      process.env[AGENT_WORLD_TARGET_ENV] = target;
      expect(resolveAgentDurableBackend()).toBe(backend);
    }
  });

  test("exposes exactly the two official modes and no third one", () => {
    expect(Object.keys(SANCTIONED_WORLD_TARGETS).sort()).toEqual(["@workflow/world-postgres", "local"]);
  });

  test("refuses an unrecognised value instead of falling back to the default", () => {
    process.env[AGENT_WORLD_TARGET_ENV] = "sqlite";
    const error = captureRefusal(() => resolveAgentDurableBackend());
    expect(error.reasonCode).toBe("UNSANCTIONED_WORLD_TARGET");
    expect(error.message).toContain(AGENT_WORLD_TARGET_ENV);
    expect(error.message).toContain("sqlite");
    expect(error.message).toContain("@workflow/world-postgres");
  });

  test("refuses a mixed-case spelling of a sanctioned target", () => {
    // The runtime compares this variable exactly (a non-'local' value is treated
    // as a module specifier), so accepting "LOCAL" here would let our validation
    // drift away from the world the runtime actually builds.
    process.env[AGENT_WORLD_TARGET_ENV] = "LOCAL";
    expect(captureRefusal(() => resolveAgentDurableBackend()).reasonCode).toBe("UNSANCTIONED_WORLD_TARGET");
  });

  test("refuses the hosted world the runtime would otherwise select", () => {
    process.env[AGENT_WORLD_TARGET_ENV] = "vercel";
    expect(captureRefusal(() => resolveAgentDurableBackend()).reasonCode).toBe("UNSANCTIONED_WORLD_TARGET");
  });

  test("refuses an arbitrary module specifier", () => {
    // Unvalidated, this variable is a module specifier the runtime require()s,
    // so the allowlist is what stops a stray value from loading arbitrary code.
    process.env[AGENT_WORLD_TARGET_ENV] = "../../evil-world.js";
    expect(captureRefusal(() => resolveAgentDurableBackend()).reasonCode).toBe("UNSANCTIONED_WORLD_TARGET");
  });

  test.each(["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"])(
    "refuses the inherited object-prototype member %p",
    (value) => {
      // An allowlist held in an object literal answers for every member of
      // Object.prototype too, so a lookup that trusts truthiness would accept
      // these and hand back a function typed as a backend.
      process.env[AGENT_WORLD_TARGET_ENV] = value;
      expect(captureRefusal(() => resolveAgentDurableBackend()).reasonCode).toBe("UNSANCTIONED_WORLD_TARGET");
    },
  );

  test("refuses the runtime's implicit hosted world instead of reporting local", () => {
    // With no explicit target on a hosted deployment the runtime picks its own
    // hosted world, which is neither of the two ratified backends. Reporting
    // "local" here would describe a backend that is not the one running.
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_example";
    const error = captureRefusal(() => resolveAgentDurableBackend());
    expect(error.reasonCode).toBe("IMPLICIT_HOSTED_WORLD");
    expect(error.message).toContain(AGENT_WORLD_TARGET_ENV);
  });

  test("accepts an explicit sanctioned target on a hosted deployment", () => {
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_example";
    process.env[AGENT_WORLD_TARGET_ENV] = "local";
    expect(resolveAgentDurableBackend()).toBe("local");
  });

  test("is an AgentConfigError with a stable name and prototype chain", () => {
    process.env[AGENT_WORLD_TARGET_ENV] = "nope";
    const error = captureRefusal(() => resolveAgentDurableBackend());
    expect(error.name).toBe("AgentConfigError");
    expect(error instanceof AgentConfigError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });
});

// ─── the composed configuration ─────────────────────────────────────────────

describe("getAgentRuntimeConfig", () => {
  test("reports disabled with no backend at all when the flag is off", () => {
    const config = getAgentRuntimeConfig();
    expect(config.enabled).toBe(false);
    expect(config).not.toHaveProperty("backend");
  });

  test("reports the local backend when enabled with no backend configured", () => {
    process.env[AGENT_ENABLED_ENV] = "true";
    expect(getAgentRuntimeConfig()).toEqual({ enabled: true, backend: "local" });
  });

  test("reports the postgres backend when the opt-in target is configured", () => {
    process.env[AGENT_ENABLED_ENV] = "on";
    process.env[AGENT_WORLD_TARGET_ENV] = "@workflow/world-postgres";
    expect(getAgentRuntimeConfig()).toEqual({ enabled: true, backend: "postgres" });
  });

  test("refuses to report a configuration when enabled with an unsanctioned target", () => {
    process.env[AGENT_ENABLED_ENV] = "true";
    process.env[AGENT_WORLD_TARGET_ENV] = "redis";
    expect(captureRefusal(() => getAgentRuntimeConfig()).reasonCode).toBe("UNSANCTIONED_WORLD_TARGET");
  });

  test("does not refuse over an unsanctioned target while the agent is off", () => {
    // Nothing builds a world while the flag is off, so refusing here would take
    // the whole server down over a variable no code path reads.
    process.env[AGENT_WORLD_TARGET_ENV] = "redis";
    expect(getAgentRuntimeConfig()).toEqual({ enabled: false });
  });
});

// ─── operator documentation ─────────────────────────────────────────────────

describe(".env.example", () => {
  const envExample = fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8");

  test.each([AGENT_ENABLED_ENV, AGENT_WORLD_TARGET_ENV])("documents %s", (key) => {
    expect(envExample).toContain(key);
  });

  test("documents both sanctioned world targets so the allowlist is copy-pasteable", () => {
    for (const target of Object.keys(SANCTIONED_WORLD_TARGETS)) {
      expect(envExample).toContain(target);
    }
  });
});

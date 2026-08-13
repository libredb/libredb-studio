import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  AGENT_ENABLED_ENV,
  AGENT_WORLD_TARGET_ENV,
  AgentConfigError,
  getAgentRuntimeConfig,
  isAgentRuntimeEnabled,
  LEDGER_PROBE_TTL_MS,
  resolveAgentAvailability,
  resolveAgentDurableBackend,
  resolveAgentLedgerDirectory,
  SANCTIONED_WORLD_TARGETS,
} from "@/lib/agent/config";

/**
 * The LLM keys are in this list because availability is DERIVED from them since
 * #331 T5, and because `bun` loads a checkout's `.env` into `process.env`: a
 * developer machine with a real `LLM_API_KEY` would otherwise answer differently
 * from CI, which has none. Deleting them makes both machines start from "no model
 * configured" and say so.
 */
const ENV_KEYS = [
  AGENT_ENABLED_ENV,
  AGENT_WORLD_TARGET_ENV,
  "VERCEL_DEPLOYMENT_ID",
  "WORKFLOW_LOCAL_DATA_DIR",
  "LLM_PROVIDER",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_API_URL",
] as const;

let originalEnv: Record<string, string | undefined>;
const scratchDirs: string[] = [];

/** A model configuration that validates without reaching anything. */
function configureModel(): void {
  process.env.LLM_PROVIDER = "gemini";
  process.env.LLM_API_KEY = "test-key";
}

/** A fresh, writable directory for the ledger probe to land in. */
function freshLedgerDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-agent-ledger-"));
  scratchDirs.push(dir);
  return dir;
}

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
  while (scratchDirs.length > 0) {
    fs.rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
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

// ─── the derived answer, without I/O ────────────────────────────────────────

describe("isAgentRuntimeEnabled", () => {
  test("is on with a model configured and no flag set — the deliberate act of configuring a model is the opt-in", () => {
    configureModel();
    expect(isAgentRuntimeEnabled()).toBe(true);
  });

  test("is off with no model configured at all, so no surface appears where the first Start must fail", () => {
    expect(isAgentRuntimeEnabled()).toBe(false);
  });

  test.each(["false", "FALSE", "off", "OFF", "0", " 0 "])(
    "is off for the negative value %p even with a model configured — the documented off-switch",
    (value) => {
      configureModel();
      process.env[AGENT_ENABLED_ENV] = value;
      expect(isAgentRuntimeEnabled()).toBe(false);
    },
  );

  test.each(["true", "TRUE", "True", " true ", "on", "ON", "1"])(
    "accepts the affirmative value %p unchanged, case-insensitively and trimmed",
    (value) => {
      configureModel();
      process.env[AGENT_ENABLED_ENV] = value;
      expect(isAgentRuntimeEnabled()).toBe(true);
    },
  );

  test("an affirmative value cannot conjure a model, so it does not turn on a rail that cannot work", () => {
    process.env[AGENT_ENABLED_ENV] = "true";
    expect(isAgentRuntimeEnabled()).toBe(false);
  });

  test.each(["", "   "])("treats the empty value %p as absent", (value) => {
    configureModel();
    process.env[AGENT_ENABLED_ENV] = value;
    expect(isAgentRuntimeEnabled()).toBe(true);
  });

  test("an unrecognised value is ignored and warns, so a typo neither enables nor silently removes the AI", () => {
    // The pre-T5 rule was "a typo never silently enables it". Now that the default
    // is derived, the same rule points the other way: a typo must not be the thing
    // that takes the product's only AI surface away either. Both are satisfied by
    // landing on the default, which is what an unset variable does.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      configureModel();
      process.env[AGENT_ENABLED_ENV] = "yes-please";
      expect(isAgentRuntimeEnabled()).toBe(true);
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
      configureModel();
      process.env[AGENT_ENABLED_ENV] = "true";
      expect(isAgentRuntimeEnabled()).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("an Ollama provider with no key counts as configured, which is a network-free check's blind spot", () => {
    // `validateConfig` requires no key for ollama and defaults the URL to
    // localhost, so this answers "available" for a server that may not be
    // running. Pinned rather than fixed: the alternative is a network call on a
    // visibility probe, and the model is reached where a run actually starts.
    process.env.LLM_PROVIDER = "ollama";
    expect(isAgentRuntimeEnabled()).toBe(true);
  });
});

// ─── the composed answer, including the ledger ──────────────────────────────

describe("resolveAgentAvailability", () => {
  test("is available when a model is configured and the ledger path can be written", async () => {
    configureModel();
    const dataDir = freshLedgerDir();
    process.env.WORKFLOW_LOCAL_DATA_DIR = dataDir;

    expect(await resolveAgentAvailability()).toEqual({ available: true, ledgerVerified: true });
  });

  test("creates the ledger directory the way the world would, so a green answer means its own check passes", async () => {
    configureModel();
    const dataDir = path.join(freshLedgerDir(), "nested", "workflow");
    process.env.WORKFLOW_LOCAL_DATA_DIR = dataDir;

    expect(await resolveAgentAvailability()).toEqual({ available: true, ledgerVerified: true });
    expect(fs.existsSync(dataDir)).toBe(true);
    // The write probe cleans up after itself: a leftover file would end up in the
    // ledger directory the runtime lists.
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });

  test("names the operator's off-switch when the flag is negative, rather than blaming the model or the disk", async () => {
    configureModel();
    process.env[AGENT_ENABLED_ENV] = "false";
    process.env.WORKFLOW_LOCAL_DATA_DIR = path.join(freshLedgerDir(), "unreachable");

    const availability = await resolveAgentAvailability();

    expect(availability.available).toBe(false);
    expect(availability).toMatchObject({ reason: "OPERATOR_DISABLED" });
    expect(String((availability as { detail: string }).detail)).toContain(AGENT_ENABLED_ENV);
    // The ledger was never probed: the operator said no, so nothing else is asked.
    expect(fs.existsSync(process.env.WORKFLOW_LOCAL_DATA_DIR)).toBe(false);
  });

  test("says the same true thing about the off-switch whether or not a model is configured", async () => {
    // The detail is the operator's whole diagnosis, and on a server with the flag
    // off and no key set it used to assert "even though a model is configured" —
    // a second fact this branch never checks, which sends the reader to look at an
    // LLM_API_KEY they never set. One message, true in both states.
    process.env[AGENT_ENABLED_ENV] = "false";
    const withoutModel = await resolveAgentAvailability();

    configureModel();
    const withModel = await resolveAgentAvailability();

    expect(withoutModel).toMatchObject({ available: false, reason: "OPERATOR_DISABLED" });
    const detail = String((withoutModel as { detail: string }).detail);
    expect(detail).toContain(AGENT_ENABLED_ENV);
    expect(detail).not.toMatch(/model is configured/i);
    expect(detail).toBe(String((withModel as { detail: string }).detail));
  });

  test("names the missing model, and creates no ledger directory for a deployment that has no AI at all", async () => {
    const dataDir = path.join(freshLedgerDir(), "workflow");
    process.env.WORKFLOW_LOCAL_DATA_DIR = dataDir;

    const availability = await resolveAgentAvailability();

    expect(availability).toMatchObject({ available: false, reason: "NO_MODEL_CONFIGURED" });
    expect(String((availability as { detail: string }).detail)).toContain("LLM_API_KEY");
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  test("names the ledger when its directory cannot be created, instead of offering a Start that must fail", async () => {
    configureModel();
    const blocker = path.join(freshLedgerDir(), "not-a-directory");
    fs.writeFileSync(blocker, "");
    process.env.WORKFLOW_LOCAL_DATA_DIR = path.join(blocker, "workflow");

    const availability = await resolveAgentAvailability();

    expect(availability).toMatchObject({ available: false, reason: "LEDGER_UNAVAILABLE" });
    expect(String((availability as { detail: string }).detail)).toContain("WORKFLOW_LOCAL_DATA_DIR");
  });

  test("reports an unsanctioned world target as itself rather than throwing out of the probe", async () => {
    // The route this feeds must not answer 500 on a misconfiguration: a 500 is
    // indistinguishable from "this server runs no agents", which is the state the
    // operator would be trying to diagnose.
    configureModel();
    process.env[AGENT_WORLD_TARGET_ENV] = "@workflow/world-turso";

    const availability = await resolveAgentAvailability();

    // The backend selector's own code, NOT LEDGER_UNAVAILABLE: the operator action
    // is fixing a variable, and a reason code that named the ledger would send them
    // to the disk instead.
    expect(availability).toMatchObject({ available: false, reason: "UNSANCTIONED_WORLD_TARGET" });
    expect(String((availability as { detail: string }).detail)).toContain(AGENT_WORLD_TARGET_ENV);
  });

  test("reports the implicit hosted world as a topology refusal, not as an unwritable ledger", async () => {
    // `VERCEL_DEPLOYMENT_ID` with no explicit target is a deployment-topology
    // refusal: nothing was asked of the filesystem, and nothing about the ledger is
    // known. Sharing LEDGER_UNAVAILABLE would make the one field an operator filters
    // on report a disk problem for a platform problem.
    configureModel();
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_example";
    const dataDir = path.join(freshLedgerDir(), "never-created");
    process.env.WORKFLOW_LOCAL_DATA_DIR = dataDir;

    const availability = await resolveAgentAvailability();

    expect(availability).toMatchObject({ available: false, reason: "IMPLICIT_HOSTED_WORLD" });
    expect(String((availability as { detail: string }).detail)).toContain(AGENT_WORLD_TARGET_ENV);
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  test("says the postgres ledger was NOT verified, rather than reporting it as a checked one (B31)", async () => {
    // The only way to test a database ledger is to open a connection, and this
    // answers on every page load of a logged-in user, so the connection is left to
    // where a world is actually built. What must not happen is this answer READING
    // like the local one: with an unreachable WORKFLOW_POSTGRES_URL the rail appears
    // and the first Start fails, which is the outcome deriving availability exists
    // to prevent. The carve-out is therefore stated in the answer itself, not only
    // in a comment.
    configureModel();
    process.env[AGENT_WORLD_TARGET_ENV] = "@workflow/world-postgres";
    const dataDir = path.join(freshLedgerDir(), "never-created");
    process.env.WORKFLOW_LOCAL_DATA_DIR = dataDir;

    expect(await resolveAgentAvailability()).toEqual({ available: true, ledgerVerified: false });
    expect(fs.existsSync(dataDir)).toBe(false);
  });
});

// ─── two probes at once ─────────────────────────────────────────────────────

describe("resolveAgentAvailability under concurrency", () => {
  test("two probes that reach the same directory at once both stay available, and neither removes the other's file", async () => {
    configureModel();
    const dataDir = freshLedgerDir();
    // The two probes reach ONE physical directory under two different names, which
    // is what keeps this a genuine filesystem race now that concurrent callers
    // naming the same directory share a single in-flight probe. The same collision
    // arrives from a second server process on a shared volume, and from an operator
    // re-pointing WORKFLOW_LOCAL_DATA_DIR while a probe is in flight — neither of
    // which the memo can de-duplicate.
    const alias = path.join(freshLedgerDir(), "alias");
    fs.symlinkSync(dataDir, alias);

    // Hold both probes at the point where each has written its file and neither has
    // removed it. A probe filename that is constant for the process lifetime cannot
    // survive that interleaving: both write the SAME path, the first cleanup removes
    // it, and the second meets ENOENT and reports LEDGER_UNAVAILABLE on a perfectly
    // writable ledger. `use-agent-capability` probes once on mount with no retry, so
    // that browser has no rail for the whole page session.
    let written = 0;
    let releaseBoth: () => void = () => {};
    const bothWrote = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementation(async (file) => {
      fs.writeFileSync(file as string, "");
      written += 1;
      if (written === 2) releaseBoth();
      await bothWrote;
    });

    try {
      // The variable is read synchronously when each call starts, so switching it
      // between the two starts is what puts both in flight against one directory.
      process.env.WORKFLOW_LOCAL_DATA_DIR = dataDir;
      const first = resolveAgentAvailability();
      process.env.WORKFLOW_LOCAL_DATA_DIR = alias;
      const second = resolveAgentAvailability();
      const answers = await Promise.all([first, second]);

      expect(answers).toEqual([
        { available: true, ledgerVerified: true },
        { available: true, ledgerVerified: true },
      ]);
      const probeFiles = writeSpy.mock.calls.map((call) => path.basename(String(call[0])));
      expect(new Set(probeFiles).size).toBe(2);
    } finally {
      writeSpy.mockRestore();
    }

    expect(fs.readdirSync(dataDir)).toEqual([]);
  });

  test("an ENOENT while removing the probe file is not a ledger fault", async () => {
    // Upstream's own `ensureDataDir` swallows exactly this, and names the reason: a
    // concurrent actor may already have removed the file. The write succeeded, which
    // is the question the probe asked.
    configureModel();
    process.env.WORKFLOW_LOCAL_DATA_DIR = freshLedgerDir();
    const unlinkSpy = spyOn(fsPromises, "unlink").mockImplementation(async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, unlink"), { code: "ENOENT" });
    });

    try {
      expect(await resolveAgentAvailability()).toEqual({ available: true, ledgerVerified: true });
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  test("a cleanup failure that is not ENOENT is still reported, so a read-only ledger is not hidden", async () => {
    configureModel();
    process.env.WORKFLOW_LOCAL_DATA_DIR = freshLedgerDir();
    const unlinkSpy = spyOn(fsPromises, "unlink").mockImplementation(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
    });

    try {
      const availability = await resolveAgentAvailability();
      expect(availability).toMatchObject({ available: false, reason: "LEDGER_UNAVAILABLE" });
      expect(String((availability as { detail: string }).detail)).toContain("EPERM");
    } finally {
      unlinkSpy.mockRestore();
    }
  });
});

// ─── what the probe costs a server ──────────────────────────────────────────

describe("the ledger probe's cost", () => {
  test("answers a repeat probe from memory, so a logged-in caller cannot drive a write per request", async () => {
    // The route this feeds sits outside the `ai` rate-limit bucket on purpose — a
    // metered visibility probe would spend a run's budget on rendering a panel, and
    // a throttled one would make the rail vanish for a user who reloads. The memo is
    // what bounds the filesystem work instead.
    configureModel();
    process.env.WORKFLOW_LOCAL_DATA_DIR = freshLedgerDir();
    const writeSpy = spyOn(fsPromises, "writeFile");

    try {
      expect(await resolveAgentAvailability()).toEqual({ available: true, ledgerVerified: true });
      expect(await resolveAgentAvailability()).toEqual({ available: true, ledgerVerified: true });
      expect(await resolveAgentAvailability()).toEqual({ available: true, ledgerVerified: true });
      expect(writeSpy).toHaveBeenCalledTimes(1);
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("a burst that arrives while the first probe is still in flight writes once, not once per request", async () => {
    // The bound the comment claimed and the code did not keep: the memo was written
    // only after the probe RESOLVED, so every request that arrived during that gap
    // performed its own mkdir + write + unlink. On a route deliberately outside the
    // `ai` rate-limit bucket, that is a filesystem write per authenticated request
    // for as long as a caller keeps them in flight.
    configureModel();
    process.env.WORKFLOW_LOCAL_DATA_DIR = freshLedgerDir();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementation(async (file) => {
      fs.writeFileSync(file as string, "");
      await held;
    });

    try {
      const burst = Promise.all(Array.from({ length: 8 }, () => resolveAgentAvailability()));
      release();
      const answers = await burst;

      expect(answers.every((answer) => answer.available)).toBe(true);
      expect(writeSpy).toHaveBeenCalledTimes(1);
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("re-probes once the interval has passed, so a permission an operator fixed is picked up", async () => {
    configureModel();
    process.env.WORKFLOW_LOCAL_DATA_DIR = freshLedgerDir();
    const start = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(start);
    const writeSpy = spyOn(fsPromises, "writeFile");

    try {
      await resolveAgentAvailability();
      clock.mockReturnValue(start + LEDGER_PROBE_TTL_MS + 1);
      await resolveAgentAvailability();
      expect(writeSpy).toHaveBeenCalledTimes(2);
    } finally {
      writeSpy.mockRestore();
      clock.mockRestore();
    }
  });

  test("never answers one directory from another directory's memo", async () => {
    configureModel();
    process.env.WORKFLOW_LOCAL_DATA_DIR = freshLedgerDir();
    expect(await resolveAgentAvailability()).toEqual({ available: true, ledgerVerified: true });

    const blocker = path.join(freshLedgerDir(), "not-a-directory");
    fs.writeFileSync(blocker, "");
    process.env.WORKFLOW_LOCAL_DATA_DIR = path.join(blocker, "workflow");

    expect(await resolveAgentAvailability()).toMatchObject({ available: false, reason: "LEDGER_UNAVAILABLE" });
  });
});

// ─── where the ledger lands ─────────────────────────────────────────────────

describe("resolveAgentLedgerDirectory", () => {
  test("resolves the configured directory to an absolute path", () => {
    const dataDir = freshLedgerDir();
    process.env.WORKFLOW_LOCAL_DATA_DIR = dataDir;
    expect(resolveAgentLedgerDirectory()).toBe(path.resolve(dataDir));
  });

  test.each([undefined, "", "   "])(
    "falls back to the SDK's own default for %p, so the probe tests the directory the world would build",
    (value) => {
      if (value !== undefined) process.env.WORKFLOW_LOCAL_DATA_DIR = value;
      expect(resolveAgentLedgerDirectory()).toBe(path.resolve(".workflow-data"));
    },
  );
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
  test("reports disabled with no backend at all when the operator switched it off", () => {
    configureModel();
    process.env[AGENT_ENABLED_ENV] = "false";
    const config = getAgentRuntimeConfig();
    expect(config.enabled).toBe(false);
    expect(config).not.toHaveProperty("backend");
  });

  test("reports disabled when no model is configured, so nothing builds a world for an AI-less server", () => {
    expect(getAgentRuntimeConfig()).toEqual({ enabled: false });
  });

  test("reports the local backend when a model is configured and no backend is", () => {
    configureModel();
    expect(getAgentRuntimeConfig()).toEqual({ enabled: true, backend: "local" });
  });

  test("reports the postgres backend when the opt-in target is configured", () => {
    configureModel();
    process.env[AGENT_WORLD_TARGET_ENV] = "@workflow/world-postgres";
    expect(getAgentRuntimeConfig()).toEqual({ enabled: true, backend: "postgres" });
  });

  test("refuses to report a configuration when enabled with an unsanctioned target", () => {
    configureModel();
    process.env[AGENT_WORLD_TARGET_ENV] = "redis";
    expect(captureRefusal(() => getAgentRuntimeConfig()).reasonCode).toBe("UNSANCTIONED_WORLD_TARGET");
  });

  test("does not refuse over an unsanctioned target while the agent is off", () => {
    // Nothing builds a world while the agent is off, so refusing here would take
    // the whole server down over a variable no code path reads.
    process.env[AGENT_ENABLED_ENV] = "false";
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

  test("documents the LLM_* keys as what decides whether the agent exists", () => {
    // The variable no longer carries that decision on its own, so the file that
    // an operator reads has to say where the decision moved to.
    const agentSection = envExample.split("Agent Runtime")[1] ?? "";
    expect(agentSection).toContain("LLM_API_KEY");
  });
});

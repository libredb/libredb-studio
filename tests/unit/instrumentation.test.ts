import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { register } from "@/instrumentation";
import { logger } from "@/lib/logger";
import { getPendingSeeds, getUnavailableSamples } from "@/lib/seed";
import { getSampleSeedState, resetSampleSeedStates, SAMPLES, unavailableSentence } from "@/lib/seed/samples";
import { installUncaughtExceptionExit, resetUncaughtExceptionExit } from "@/lib/uncaught-exception";
import { standInProcess } from "../helpers/uncaught-exception-stand-in";

const ENV_KEYS = [
  "NEXT_RUNTIME",
  "LIBREDB_EMBEDDED_SAMPLE",
  "LIBREDB_EMBEDDED_SAMPLE_PATH",
  "SQLITE_EMBEDDED_SAMPLE",
  "SQLITE_EMBEDDED_SAMPLE_PATH",
  "SEED_ASSETS_DIR",
  "LIBREDB_ENABLED_PROVIDERS",
  "STORAGE_SQLITE_PATH",
  "JWT_SECRET",
  "ADMIN_PASSWORD",
  "AUTH_BOOTSTRAP",
  "LIBREDB_NO_BANNER",
  "GOVERNANCE_SOURCE",
  "KUBERNETES_ACCESS_REVIEW",
  "NODE_EXTRA_CA_CERTS",
] as const;

/** Sets NODE_ENV, or removes it for `undefined`; the env typings declare it read-only. */
function setNodeEnv(value: string | undefined): void {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}

/** No sample has a seed state: register() never started seeding. */
function noSampleStarted(): boolean {
  return [...SAMPLES.values()].every((spec) => getSampleSeedState(spec.seedId) === undefined);
}

/** The samples seed fire-and-forget; poll for their observable effects. */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("instrumentation register()", () => {
  let orig: Record<string, string | undefined>;
  let tmpDir: string;

  beforeEach(() => {
    orig = {};
    for (const key of ENV_KEYS) {
      orig[key] = process.env[key];
      delete process.env[key];
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instrumentation-"));
    process.env.STORAGE_SQLITE_PATH = path.join(tmpDir, "libredb-storage.db");
    // Keep the boot banner out of the test output; the banner tests below opt
    // back in explicitly.
    process.env.LIBREDB_NO_BANNER = "1";
    resetSampleSeedStates();
    // register() installs the uncaught-exception exit once per process; installed on a stand-in here first, its own
    // install attaches nothing, so no test in this file binds the real process.exit. The tests about that install
    // reset this one first.
    installUncaughtExceptionExit(standInProcess());
  });

  afterEach(async () => {
    // Drain the fire-and-forget copies before anything they read is taken away.
    //
    // register() returns while the sample copies are still running, and not
    // every test above awaits them. A copy logs when it lands, so a later
    // test's logger spy would catch a line no call of its own produced:
    // measured on 2026-09-17 as a red Windows leg (CI run 35172616920) where a
    // copy's completion line reached the fast-path test, which asserts exactly
    // that no such info line appears.
    //
    // Draining on pendingSeeds is enough to contain the log: the sample
    // service sets each terminal state and logs in the same synchronous step,
    // so an empty list means every line has already been emitted into the
    // test that started it. The cleanup runs in `finally`, because a drain
    // that times out must not leave the next test to fail on this one's env
    // and state.
    try {
      await waitFor(() => getPendingSeeds().length === 0);
    } finally {
      for (const key of ENV_KEYS) {
        if (orig[key] === undefined) delete process.env[key];
        else process.env[key] = orig[key];
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resetSampleSeedStates();
      resetUncaughtExceptionExit();
    }
  });

  /**
   * Runs `body` with the uncaught-exception exit forgotten and process.exit replaced by a recorder, so register()
   * installs the exit on the real process without binding the real process.exit. `added()` lists the
   * uncaughtException listeners attached since the start; they are removed afterwards, and the exit forgotten again.
   */
  async function withRecordedExit(
    body: (added: () => NodeJS.UncaughtExceptionListener[]) => Promise<void>,
  ): Promise<{ exits: Array<number | undefined>; added: NodeJS.UncaughtExceptionListener[] }> {
    resetUncaughtExceptionExit();
    const before = process.listeners("uncaughtException");
    const added = () => process.listeners("uncaughtException").filter((listener) => !before.includes(listener));
    const originalExit = process.exit;
    const exits: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exits.push(code);
    }) as unknown as typeof process.exit;
    let attached: NodeJS.UncaughtExceptionListener[] = [];
    try {
      await body(added);
    } finally {
      attached = added();
      for (const listener of attached) process.removeListener("uncaughtException", listener);
      process.exit = originalExit;
      resetUncaughtExceptionExit();
    }
    return { exits, added: attached };
  }

  test("does nothing outside the nodejs runtime, and attaches no uncaught-exception exit", async () => {
    process.env.NEXT_RUNTIME = "edge";

    const { exits, added } = await withRecordedExit(() => register());

    expect(process.env.JWT_SECRET).toBeUndefined();
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    expect(added).toEqual([]);
    expect(exits).toEqual([]);
  });

  test.each(["production", "development"])(
    "installs the uncaught-exception exit on the process once, however often register() runs (NODE_ENV=%s)",
    async (nodeEnv) => {
      process.env.NEXT_RUNTIME = "nodejs";
      process.env.AUTH_BOOTSTRAP = "off";
      process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
      process.env.SQLITE_EMBEDDED_SAMPLE = "false";
      // A secret the auth preflight accepts, so a production boot runs to the end and only the exit is under test.
      process.env.JWT_SECRET = "x".repeat(32);
      const savedNodeEnv = process.env.NODE_ENV;
      const rejectionsBefore = process.listeners("unhandledRejection");
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      let rejectionsAfter: NodeJS.UnhandledRejectionListener[] = [];
      try {
        const { exits, added } = await withRecordedExit(async (addedSoFar) => {
          setNodeEnv(nodeEnv);
          await register();
          await register();
          rejectionsAfter = process.listeners("unhandledRejection");
          // What an uncaught exception does: Node.js calls the listener with the error.
          for (const listener of addedSoFar()) listener(new TypeError("boom"), "uncaughtException");
        });

        expect(added).toHaveLength(1);
        expect(exits).toEqual([70]);
        expect(rejectionsAfter).toEqual(rejectionsBefore);
      } finally {
        setNodeEnv(savedNodeEnv);
        errorSpy.mockRestore();
      }
    },
  );

  test("attaches the exit before the boot preflights, so a refused boot has it too", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.JWT_SECRET = "x".repeat(24); // Cosmos randomString(24), as in the #227 test above
    process.env.ADMIN_PASSWORD = "set-so-bootstrap-has-nothing-to-do";
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { exits, added } = await withRecordedExit(() => register());

      expect(exits).toEqual([1]);
      expect(added).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("runs auth bootstrap, then seeds nothing when both samples are disabled", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await register();
    } finally {
      log.mockRestore();
    }

    expect(process.env.JWT_SECRET).toBeDefined();
    expect(process.env.ADMIN_PASSWORD).toBeDefined();
    expect(fs.existsSync(path.join(tmpDir, "auth-bootstrap.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "sample.libredb"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "sample-employees.db"))).toBe(false);
    expect(noSampleStarted()).toBe(true);
  });

  test("hard-exits before seeding when JWT_SECRET is set but too short (#227)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.JWT_SECRET = "x".repeat(24); // Cosmos randomString(24)
    process.env.ADMIN_PASSWORD = "set-so-bootstrap-has-nothing-to-do";
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample.libredb");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample-employees.db");

    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let banner = "";
    try {
      await register();
      // Read the recorded calls before mockRestore(): bun clears them on restore.
      banner = errorSpy.mock.calls.flat().join("\n");
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
    }

    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("JWT_SECRET is too short");
    // register() must abandon the rest of boot: no sample seeding is started,
    // and the short secret is left exactly as the operator set it.
    expect(noSampleStarted()).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "sample.libredb"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "sample-employees.db"))).toBe(false);
    expect(process.env.JWT_SECRET).toBe("x".repeat(24));
  });

  test("hard-exits before seeding and the banner when NODE_EXTRA_CA_CERTS names a missing file", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.NODE_EXTRA_CA_CERTS = path.join(tmpDir, "absent-ca-bundle.crt");
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample.libredb");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample-employees.db");
    delete process.env.LIBREDB_NO_BANNER;

    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    let banner = "";
    let output = "";
    try {
      await register();
      // Read the recorded calls before mockRestore(): bun clears them on restore.
      banner = errorSpy.mock.calls.flat().join("\n");
      output = log.mock.calls.flat().join("\n");
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
      log.mockRestore();
    }

    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("NODE_EXTRA_CA_CERTS");
    // register() abandons the rest of boot: no sample is seeded and no welcome is printed.
    expect(noSampleStarted()).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "sample.libredb"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "sample-employees.db"))).toBe(false);
    expect(output).not.toContain("Star the project");
  });

  test("hard-exits before seeding and the banner when the governance preflight refuses the environment", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    // Governance on, with none of the settings it requires.
    process.env.GOVERNANCE_SOURCE = "postgres";
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample.libredb");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample-employees.db");
    delete process.env.LIBREDB_NO_BANNER;

    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    let banner = "";
    let output = "";
    try {
      await register();
      // Read the recorded calls before mockRestore(): bun clears them on restore.
      banner = errorSpy.mock.calls.flat().join("\n");
      output = log.mock.calls.flat().join("\n");
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
      log.mockRestore();
    }

    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("GOVERNANCE_POSTGRES_URL is not set");
    expect(banner).toContain("GOVERNANCE_INSTANCE_ID is not set");
    // register() abandons the rest of boot: no sample is seeded and no welcome is printed.
    expect(noSampleStarted()).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "sample.libredb"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "sample-employees.db"))).toBe(false);
    expect(output).not.toContain("Star the project");
  });

  test("hard-exits before seeding and the banner when the Kubernetes access review preflight refuses the environment", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    // The review on, with none of the settings it requires.
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample.libredb");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample-employees.db");
    delete process.env.LIBREDB_NO_BANNER;

    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    let banner = "";
    let output = "";
    try {
      await register();
      banner = errorSpy.mock.calls.flat().join("\n");
      output = log.mock.calls.flat().join("\n");
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
      log.mockRestore();
    }

    expect(exitCalls).toEqual([1]);
    expect(banner).toContain(
      "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT and KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO are both unset",
    );
    expect(noSampleStarted()).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "sample.libredb"))).toBe(false);
    expect(output).not.toContain("Star the project");
  });

  test("starts copying both samples without blocking boot", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    const sqliteFile = path.join(tmpDir, "sample-employees.db");
    const libredbFile = path.join(tmpDir, "sample.libredb");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = sqliteFile;
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = libredbFile;

    await register(); // must resolve without waiting for either copy

    // Non-blocking proof: a copy needs event-loop turns this synchronous check does not grant, so right after
    // register() resolves both copies MUST still be in flight. If boot ever waits for a copy, this fails.
    expect(getPendingSeeds()).toEqual(["sqlite-embedded-sample", "libredb-embedded-sample"]);
    expect(fs.existsSync(sqliteFile)).toBe(false);
    expect(fs.existsSync(libredbFile)).toBe(false);

    await waitFor(() => getPendingSeeds().length === 0);
    expect(getSampleSeedState("sqlite-embedded-sample")).toEqual({ phase: "done" });
    expect(getSampleSeedState("libredb-embedded-sample")).toEqual({ phase: "done" });
    expect(fs.statSync(sqliteFile).size).toBe(SAMPLES.get("sqlite")?.bytes ?? -1);
    expect(fs.statSync(libredbFile).size).toBe(SAMPLES.get("libredb")?.bytes ?? -1);
  });

  test("a fast-path boot stays quiet: one debug line per present sample, no info line", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    const sqliteFile = path.join(tmpDir, "sample-employees.db");
    const libredbFile = path.join(tmpDir, "sample.libredb");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = sqliteFile;
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = libredbFile;
    fs.writeFileSync(sqliteFile, "already seeded on a previous boot");
    fs.writeFileSync(libredbFile, "already seeded on a previous boot");

    const info = spyOn(logger, "info").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      await register();
      await waitFor(() => getPendingSeeds().length === 0);

      expect(info.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("Embedded sample"))).toEqual([]);
      expect(
        debug.mock.calls
          .filter((c) => c[0] === "Embedded sample already present")
          .map((c) => String(c[1]?.seedId))
          .sort(),
      ).toEqual(["libredb-embedded-sample", "sqlite-embedded-sample"]);
    } finally {
      info.mockRestore();
      debug.mockRestore();
    }
    expect(fs.readFileSync(sqliteFile, "utf8")).toBe("already seeded on a previous boot");
    expect(fs.readFileSync(libredbFile, "utf8")).toBe("already seeded on a previous boot");
  });

  test("a copy that fails is listed unavailable, logged once, and boot continues", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample-employees.db");
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample.libredb");
    const emptyAssets = path.join(tmpDir, "no-assets");
    fs.mkdirSync(emptyAssets);
    process.env.SEED_ASSETS_DIR = emptyAssets;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await register();
      await waitFor(() => getPendingSeeds().length === 0);
      const unavailable = (c: unknown[]) => c[0] === "Embedded sample unavailable";
      expect(
        warn.mock.calls
          .filter(unavailable)
          .map(
            (c) => `${String((c[1] as { seedId?: string })?.seedId)} ${String((c[1] as { reason?: string })?.reason)}`,
          )
          .sort(),
      ).toEqual(["libredb-embedded-sample asset-missing", "sqlite-embedded-sample asset-missing"]);
      const sentence = unavailableSentence("asset-missing");
      expect(getUnavailableSamples(["admin"])).toEqual([
        { seedId: "sqlite-embedded-sample", name: "Sample (Employees)", reason: "asset-missing", sentence },
        { seedId: "libredb-embedded-sample", name: "Sample (LibreDB)", reason: "asset-missing", sentence },
      ]);
      // Listing again logs nothing: each failure was logged once, when it happened.
      const logged = warn.mock.calls.length;
      getUnavailableSamples(["admin"]);
      expect(warn.mock.calls.length).toBe(logged);
    } finally {
      warn.mockRestore();
    }
    expect(fs.existsSync(path.join(tmpDir, "sample-employees.db"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "sample.libredb"))).toBe(false);
  });

  test("a sample whose path cannot be checked is listed unavailable, logged once, and boot continues with the other", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    const blocker = path.join(tmpDir, "a-regular-file");
    fs.writeFileSync(blocker, "");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(blocker, "sample-employees.db");
    const libredbFile = path.join(tmpDir, "sample.libredb");
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = libredbFile;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await register();
      await waitFor(() => getPendingSeeds().length === 0);
      expect(
        warn.mock.calls.filter((c) => c[0] === "Embedded sample unavailable").map((c) => [c[1]?.seedId, c[1]?.reason]),
      ).toEqual([["sqlite-embedded-sample", "target-unreadable"]]);
      expect(getUnavailableSamples(["admin"])).toEqual([
        {
          seedId: "sqlite-embedded-sample",
          name: "Sample (Employees)",
          reason: "target-unreadable",
          sentence: unavailableSentence("target-unreadable", "ENOTDIR"),
        },
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(fs.statSync(libredbFile).size).toBe(SAMPLES.get("libredb")?.bytes ?? -1);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a sample in a directory the server cannot search does not stop boot (POSIX, not root)",
    async () => {
      process.env.NEXT_RUNTIME = "nodejs";
      process.env.AUTH_BOOTSTRAP = "off";
      const locked = path.join(tmpDir, "locked");
      fs.mkdirSync(locked);
      process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(locked, "sample-employees.db");
      const libredbFile = path.join(tmpDir, "sample.libredb");
      process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = libredbFile;
      fs.chmodSync(locked, 0o000);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await register();
        await waitFor(() => getPendingSeeds().length === 0);
        expect(getUnavailableSamples(["admin"]).map(({ reason, sentence }) => ({ reason, sentence }))).toEqual([
          { reason: "target-unreadable", sentence: unavailableSentence("target-unreadable", "EACCES") },
        ]);
        expect(fs.existsSync(libredbFile)).toBe(true);
      } finally {
        warn.mockRestore();
        fs.chmodSync(locked, 0o700);
      }
    },
  );

  test("prints the boot banner even when both samples are disabled", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    delete process.env.LIBREDB_NO_BANNER;

    const log = spyOn(console, "log").mockImplementation(() => {});
    let output = "";
    try {
      await register();
      // Read the recorded calls before mockRestore(): bun clears them on restore.
      output = log.mock.calls.flat().join("\n");
    } finally {
      log.mockRestore();
    }

    expect(output).toContain("LibreDB Studio");
    expect(output).toContain("https://github.com/libredb/libredb-studio");
  });

  test("prints no banner when the server refuses to boot (#227)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.JWT_SECRET = "x".repeat(24);
    process.env.ADMIN_PASSWORD = "set-so-bootstrap-has-nothing-to-do";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    delete process.env.LIBREDB_NO_BANNER;

    const originalExit = process.exit;
    process.exit = (() => {}) as unknown as typeof process.exit;
    const log = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let output = "";
    try {
      await register();
      output = log.mock.calls.flat().join("\n");
    } finally {
      process.exit = originalExit;
      log.mockRestore();
      errorSpy.mockRestore();
    }

    expect(output).not.toContain("Star the project");
  });

  // The failure is produced by a directory whose mode forbids writing, which nothing can arrange
  // on Windows (chmod there only toggles the read-only bit) or as root (mode bits do not apply).
  // Named in the title rather than returned early from the body: a bare `return` reports a pass on
  // a machine that never ran the assertion, which is the same output a real pass gives.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "logs a warning and keeps boot alive when seeding fails (POSIX non-root only: needs an unwritable directory)",
    async () => {
      process.env.NEXT_RUNTIME = "nodejs";
      process.env.AUTH_BOOTSTRAP = "off";
      const lockedDir = path.join(tmpDir, "locked");
      fs.mkdirSync(lockedDir);
      fs.chmodSync(lockedDir, 0o500);
      process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(lockedDir, "sample.libredb");
      process.env.SQLITE_EMBEDDED_SAMPLE = "false";
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await register();
        await waitFor(() => getPendingSeeds().length === 0);
        expect(warn.mock.calls.map((c) => [c[0], c[1]?.seedId, c[1]?.reason])).toEqual([
          ["Embedded sample unavailable", "libredb-embedded-sample", "copy-failed"],
        ]);
        expect(getSampleSeedState("libredb-embedded-sample")).toEqual({
          phase: "failed",
          reason: "copy-failed",
          sentence: unavailableSentence("copy-failed", "EACCES"),
        });
      } finally {
        warn.mockRestore();
        fs.chmodSync(lockedDir, 0o700);
      }
    },
  );
});

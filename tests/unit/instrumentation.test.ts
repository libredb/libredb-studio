import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { register } from "@/instrumentation";
import { forgetEgressDecision } from "@/lib/db/egress-decision";
import { forgetTrustMaterial } from "@/lib/db/trust-material";
import * as dataDir from "@/lib/data-dir";
import { forgetStorageLocation } from "@/lib/data-dir";
import { logger } from "@/lib/logger";
import { closeStorageProvider } from "@/lib/storage/factory";
import { getPendingSeeds, getUnavailableSamples } from "@/lib/seed";
import { getSampleSeedState, resetSampleSeedStates, SAMPLES, unavailableSentence } from "@/lib/seed/samples";
import * as authBootstrap from "@/lib/auth-bootstrap";
import * as shutdownHandler from "@/lib/shutdown-handler";
import { installShutdownHandler, resetShutdownHandler } from "@/lib/shutdown-handler";
import * as uncaughtException from "@/lib/uncaught-exception";
import { installUncaughtExceptionExit, resetUncaughtExceptionExit } from "@/lib/uncaught-exception";
import { shutdownStandIn } from "../helpers/shutdown-stand-in";
import { standInProcess } from "../helpers/uncaught-exception-stand-in";

/*
  A sample path that runs through a regular file is a path the admission cannot check on POSIX, which reports it as
  ENOTDIR, so the sample is refused target-unreadable. Windows reports the same path as absent (ENOENT), so the
  admission lets it through and its copy fails at the mkdir instead, as copy-failed with EEXIST. Both are a failed
  sample listed unavailable with its reason and code while the rest goes on, which is what the test below holds.
*/
const UNCHECKABLE_PATH =
  process.platform === "win32"
    ? ({ reason: "copy-failed", code: "EEXIST" } as const)
    : ({ reason: "target-unreadable", code: "ENOTDIR" } as const);

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
  "DB_HTTP_BLOCK_PRIVATE_HOSTS",
  "NEXT_MANUAL_SIG_HANDLE",
  "STORAGE_ENCRYPTION_RESEAL",
  "STORAGE_ENCRYPTION_REQUIRE_V2",
  "STORAGE_PROVIDER",
] as const;

const ROOT = path.resolve(import.meta.dir, "../..");

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
    // Every launcher sets it; the server never takes the seed assets directory from its working directory.
    process.env.SEED_ASSETS_DIR = path.join(ROOT, "seed-assets");
    // Keep the boot banner out of the test output; the banner tests below opt
    // back in explicitly.
    process.env.LIBREDB_NO_BANNER = "1";
    resetSampleSeedStates();
    // register() takes the egress decision and Studio's storage location and reads the trust material once per
    // process; forgotten here, each boot below takes them as a new one.
    forgetEgressDecision();
    forgetTrustMaterial();
    forgetStorageLocation();
    // register() installs the uncaught-exception exit once per process; installed on a stand-in here first, its own
    // install attaches nothing, so no test in this file binds the real process.exit. The tests about that install
    // reset this one first.
    installUncaughtExceptionExit(standInProcess());
    // The same for the shutdown handler, so no test in this file attaches a real SIGTERM or SIGINT listener; the tests
    // about that install reset this one first.
    installShutdownHandler(shutdownStandIn(), "nextjs");
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
      forgetEgressDecision();
      forgetTrustMaterial();
      forgetStorageLocation();
      resetUncaughtExceptionExit();
      resetShutdownHandler();
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

  /**
   * Runs `body` with the shutdown handler forgotten and process.exit replaced by a recorder, so register() installs the
   * handler on the real process without binding the real process.exit. It answers the SIGTERM and SIGINT listeners
   * attached meanwhile, which are removed afterwards, and the handler forgotten again.
   */
  async function withSignalListeners(
    body: (added: () => number) => Promise<void>,
  ): Promise<{ exits: Array<number | undefined>; sigterm: number; sigint: number }> {
    resetShutdownHandler();
    const sigtermBefore = process.listeners("SIGTERM");
    const sigintBefore = process.listeners("SIGINT");
    const addedTerm = () => process.listeners("SIGTERM").filter((listener) => !sigtermBefore.includes(listener));
    const addedInt = () => process.listeners("SIGINT").filter((listener) => !sigintBefore.includes(listener));
    const originalExit = process.exit;
    const exits: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exits.push(code);
    }) as unknown as typeof process.exit;
    let sigterm = 0;
    let sigint = 0;
    try {
      await body(() => addedTerm().length + addedInt().length);
    } finally {
      const term = addedTerm();
      const int = addedInt();
      sigterm = term.length;
      sigint = int.length;
      for (const listener of term) process.removeListener("SIGTERM", listener);
      for (const listener of int) process.removeListener("SIGINT", listener);
      process.exit = originalExit;
      resetShutdownHandler();
    }
    return { exits, sigterm, sigint };
  }

  test("does nothing outside the nodejs runtime, and attaches no uncaught-exception exit", async () => {
    process.env.NEXT_RUNTIME = "edge";

    const { exits, added } = await withRecordedExit(() => register());

    expect(process.env.JWT_SECRET).toBeUndefined();
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    expect(added).toEqual([]);
    expect(exits).toEqual([]);
  });

  test("does nothing outside the nodejs runtime, and attaches no shutdown handler", async () => {
    process.env.NEXT_RUNTIME = "edge";

    const { exits, sigterm, sigint } = await withSignalListeners(() => register());

    expect([sigterm, sigint]).toEqual([0, 0]);
    expect(exits).toEqual([]);
  });

  test("register() installs the shutdown handler once, and before the auth bootstrap", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    process.env.JWT_SECRET = "x".repeat(32);
    const listenersAtBootstrap: number[] = [];
    let realBootstrap = true;
    const bootstrap = spyOn(authBootstrap, "bootstrapAuth");
    try {
      const { exits, sigterm, sigint } = await withSignalListeners(async (added) => {
        bootstrap.mockImplementation(() => {
          listenersAtBootstrap.push(added());
          realBootstrap = false;
        });
        await register();
        await register();
      });

      expect(realBootstrap).toBe(false);
      expect(listenersAtBootstrap).toEqual([2, 2]);
      expect([sigterm, sigint]).toEqual([1, 1]);
      expect(exits).toEqual([]);
    } finally {
      bootstrap.mockRestore();
    }
  });

  test.each([
    ["true", "studio"],
    ["", "nextjs"],
    [undefined, "nextjs"],
  ] as const)(
    "with NEXT_MANUAL_SIG_HANDLE=%p register() installs the uncaught-exception exit, then the shutdown handler for owner %s on the process, then bootstraps auth",
    async (value, owner) => {
      process.env.NEXT_RUNTIME = "nodejs";
      process.env.AUTH_BOOTSTRAP = "off";
      process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
      process.env.SQLITE_EMBEDDED_SAMPLE = "false";
      process.env.JWT_SECRET = "x".repeat(32);
      if (value !== undefined) process.env.NEXT_MANUAL_SIG_HANDLE = value;
      const order: string[] = [];
      const readOwner = shutdownHandler.exitOwnerAtBoot;
      const spies = [
        // This file runs under Bun, where `true` refuses the boot: read the variable as on Node.js, where it is served.
        spyOn(shutdownHandler, "exitOwnerAtBoot").mockImplementation(() => readOwner({ node: "24.22.1" })),
        spyOn(uncaughtException, "installUncaughtExceptionExit").mockImplementation(() => {
          order.push("uncaught-exception exit");
        }),
        spyOn(shutdownHandler, "installShutdownHandler").mockImplementation(() => {
          order.push("shutdown handler");
        }),
        spyOn(authBootstrap, "bootstrapAuth").mockImplementation(() => {
          order.push("auth bootstrap");
        }),
      ];
      try {
        await register();

        expect(order).toEqual(["uncaught-exception exit", "shutdown handler", "auth bootstrap"]);
        expect(shutdownHandler.installShutdownHandler).toHaveBeenCalledWith(process, owner);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    },
  );

  test("register() takes Studio's storage location after the shutdown handler and before the auth bootstrap", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    process.env.JWT_SECRET = "x".repeat(32);
    const order: string[] = [];
    const readOwner = shutdownHandler.exitOwnerAtBoot;
    const takeLocation = dataDir.storageLocation;
    const spies = [
      // This file runs under Bun, where `true` refuses the boot: read the variable as on Node.js, where it is served.
      spyOn(shutdownHandler, "exitOwnerAtBoot").mockImplementation(() => readOwner({ node: "24.22.1" })),
      spyOn(shutdownHandler, "installShutdownHandler").mockImplementation(() => {
        order.push("shutdown handler");
      }),
      spyOn(dataDir, "storageLocation").mockImplementation(() => {
        order.push("storage location");
        return takeLocation();
      }),
      spyOn(authBootstrap, "bootstrapAuth").mockImplementation(() => {
        order.push("auth bootstrap");
      }),
    ];
    try {
      await register();
      expect(order.slice(0, 3)).toEqual(["shutdown handler", "storage location", "auth bootstrap"]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("register() refuses a NEXT_MANUAL_SIG_HANDLE that is neither empty nor true, before installing the handler", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NEXT_MANUAL_SIG_HANDLE = "1";
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const bootstrap = spyOn(authBootstrap, "bootstrapAuth");
    let banner = "";
    try {
      const { exits, sigterm, sigint } = await withSignalListeners(() => register());
      banner = errorSpy.mock.calls.flat().join("\n");

      expect(exits).toEqual([1]);
      expect([sigterm, sigint]).toEqual([0, 0]);
      expect(bootstrap).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      bootstrap.mockRestore();
    }
    expect(banner).toContain('NEXT_MANUAL_SIG_HANDLE is set to "1"');
    expect(noSampleStarted()).toBe(true);
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

  test("hard-exits before seeding and the banner when DB_HTTP_BLOCK_PRIVATE_HOSTS is invalid", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "yes";
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
    const info = spyOn(logger, "info").mockImplementation(() => {});
    let banner = "";
    let output = "";
    try {
      await register();
      // Read the recorded calls before mockRestore(): bun clears them on restore.
      banner = errorSpy.mock.calls.flat().join("\n");
      output = log.mock.calls.flat().join("\n");
      expect(info.mock.calls.filter((call) => call[1]?.route === "egress-decision")).toEqual([]);
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
      log.mockRestore();
      info.mockRestore();
    }

    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("DB_HTTP_BLOCK_PRIVATE_HOSTS is invalid");
    expect(banner).toContain('Got "yes"');
    // register() abandons the rest of boot: no sample is seeded and no welcome is printed.
    expect(noSampleStarted()).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "sample.libredb"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "sample-employees.db"))).toBe(false);
    expect(output).not.toContain("Star the project");
  });

  test("a credential re-seal that fails stops register before the banner and the samples", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.STORAGE_ENCRYPTION_RESEAL = "true";
    process.env.STORAGE_PROVIDER = "sqlite";
    // An in-memory store cannot be backed up, so the re-seal refuses to run.
    process.env.STORAGE_SQLITE_PATH = ":memory:";
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
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
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
      warn.mockRestore();
      await closeStorageProvider();
    }

    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("the credential re-seal did not complete");
    expect(noSampleStarted()).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "sample.libredb"))).toBe(false);
    expect(output).not.toContain("Star the project");
  });

  test("the credential re-seal runs after the auth bootstrap and the preflights, so a refused boot never touched the store", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.STORAGE_ENCRYPTION_RESEAL = "true";
    process.env.STORAGE_PROVIDER = "sqlite";
    process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "yes";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";

    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const info = spyOn(logger, "info").mockImplementation(() => {});
    let banner = "";
    try {
      await register();
      banner = errorSpy.mock.calls.flat().join("\n");
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
      warn.mockRestore();
      info.mockRestore();
      await closeStorageProvider();
    }

    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("DB_HTTP_BLOCK_PRIVATE_HOSTS is invalid");
    expect(banner).not.toContain("credential re-seal");
    // Neither the store nor a backup of it was created: the re-seal never ran.
    expect(fs.readdirSync(tmpDir).filter((name) => name.startsWith("libredb-storage.db"))).toEqual([]);
  });

  /** Boots with both samples disabled and answers the egress decision lines logged, in order. */
  async function bootEgressLines(): Promise<unknown[][]> {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      await register();
      return info.mock.calls.filter((call) => call[1]?.route === "egress-decision");
    } finally {
      info.mockRestore();
    }
  }

  test("reports the egress decision once at boot, an unset variable as the documented default", async () => {
    expect(await bootEgressLines()).toEqual([
      [
        "Private database destinations are reachable",
        {
          route: "egress-decision",
          variable: "DB_HTTP_BLOCK_PRIVATE_HOSTS",
          blocksPrivateHosts: false,
          source: "default",
        },
      ],
    ]);
  });

  test("reports a set DB_HTTP_BLOCK_PRIVATE_HOSTS as set", async () => {
    process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "true";
    expect(await bootEgressLines()).toEqual([
      [
        "Private database destinations are blocked",
        { route: "egress-decision", variable: "DB_HTTP_BLOCK_PRIVATE_HOSTS", blocksPrivateHosts: true, source: "set" },
      ],
    ]);
  });

  test("reports the storage location once at boot", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      await register();
      expect(info.mock.calls.filter((call) => call[1]?.route === "storage-location")).toEqual([
        [
          "Studio's storage location is taken for this process",
          {
            route: "storage-location",
            storageFile: path.join(tmpDir, "libredb-storage.db"),
            dataDirectory: tmpDir,
          },
        ],
      ]);
    } finally {
      info.mockRestore();
    }
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
      ).toEqual([["sqlite-embedded-sample", UNCHECKABLE_PATH.reason]]);
      expect(getUnavailableSamples(["admin"])).toEqual([
        {
          seedId: "sqlite-embedded-sample",
          name: "Sample (Employees)",
          reason: UNCHECKABLE_PATH.reason,
          sentence: unavailableSentence(UNCHECKABLE_PATH.reason, UNCHECKABLE_PATH.code),
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

  test.each([
    ["unset", undefined],
    ["blank", "   "],
  ])(
    "register() with SEED_ASSETS_DIR %s continues boot and lists both samples unavailable as asset-directory-unset, each logged once",
    async (_label, value) => {
      process.env.NEXT_RUNTIME = "nodejs";
      process.env.AUTH_BOOTSTRAP = "off";
      if (value === undefined) delete process.env.SEED_ASSETS_DIR;
      else process.env.SEED_ASSETS_DIR = value;
      const sqliteFile = path.join(tmpDir, "sample-employees.db");
      const libredbFile = path.join(tmpDir, "sample.libredb");
      process.env.SQLITE_EMBEDDED_SAMPLE_PATH = sqliteFile;
      process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = libredbFile;
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await register();
        await waitFor(() => getPendingSeeds().length === 0);
        // The two copies settle in either order.
        expect(
          warn.mock.calls
            .filter((c) => c[0] === "Embedded sample unavailable")
            .map((c) => [String(c[1]?.seedId), c[1]?.reason, c[1]?.assets])
            .sort(([a], [b]) => String(a).localeCompare(String(b))),
        ).toEqual([
          ["libredb-embedded-sample", "asset-directory-unset", null],
          ["sqlite-embedded-sample", "asset-directory-unset", null],
        ]);
        const sentence = unavailableSentence("asset-directory-unset");
        expect(getUnavailableSamples(["admin"])).toEqual([
          { seedId: "sqlite-embedded-sample", name: "Sample (Employees)", reason: "asset-directory-unset", sentence },
          { seedId: "libredb-embedded-sample", name: "Sample (LibreDB)", reason: "asset-directory-unset", sentence },
        ]);
        // Listing again logs nothing: each failure was logged once, when it happened.
        const logged = warn.mock.calls.length;
        getUnavailableSamples(["admin"]);
        expect(warn.mock.calls.length).toBe(logged);
      } finally {
        warn.mockRestore();
      }
      expect(fs.existsSync(sqliteFile)).toBe(false);
      expect(fs.existsSync(libredbFile)).toBe(false);
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

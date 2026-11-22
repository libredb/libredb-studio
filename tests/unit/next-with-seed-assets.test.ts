/**
 * Tests for scripts/next-with-seed-assets.mjs, the launcher `bun dev` and `bun start` run the Next.js CLI through.
 *
 * The server never takes the seed assets directory from its working directory (src/lib/seed/samples.ts), so a
 * checkout's server gets it from this launcher: SEED_ASSETS_DIR set to the checkout's own seed-assets, unless the
 * shell or a .env file Next.js loads sets one (docs/DISTRIBUTION.md, "Built-in sample assets"). The launcher is outside
 * the line coverage gate, which counts src/ only, so these spawned tests are its proof. Every fixture case runs a copy
 * of the launcher in a checkout-shaped temp directory that holds a copy of this checkout's @next/env and a `next`
 * package whose CLI is a stub that reports what it was given, or obeys its arguments; the stub's every mode ends by
 * itself within seconds, so nothing outlives a failing case.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { spawnProbe, untilPrinted } from "../helpers/launcher-spawn-probe";
import { testIf } from "../helpers/posix-tools";

const ROOT = path.resolve(import.meta.dir, "../..");
const LAUNCHER = path.join("scripts", "next-with-seed-assets.mjs");
// At its real path, so the fixture paths, a child's working directory and the paths Node.js reports share one
// spelling: on Windows os.tmpdir() answers the 8.3 form of the user profile, and on macOS a path under /var.
const tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "next-with-seed-assets-")));
afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

/**
 * The stub Next.js CLI. With no mode it prints `{ seedAssets, manualSignalHandling, runtime, argv, cwd, keys }`, where
 * runtime is `bun` or `node` and keys are its environment's names. `exit <code>` exits with that code;
 * `die <signal>` ends itself with that signal; `wait` prints `ready` once its SIGINT and SIGTERM handlers are
 * installed and exits 130 or 143 on them; `sleep` installs no handler, so either signal ends it. Each mode that waits
 * exits 99 by itself after five seconds.
 */
const STUB = `
const [mode, value] = process.argv.slice(2);
if (mode === "exit") {
  process.exit(Number(value));
} else if (mode === "die") {
  setTimeout(() => process.exit(99), 5000);
  process.kill(process.pid, value);
} else if (mode === "wait") {
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
  setTimeout(() => process.exit(99), 5000);
  console.log("ready");
} else if (mode === "sleep") {
  setTimeout(() => process.exit(99), 5000);
} else {
  console.log(JSON.stringify({ seedAssets: process.env.SEED_ASSETS_DIR ?? null, manualSignalHandling: process.env.NEXT_MANUAL_SIG_HANDLE ?? null, runtime: typeof process.versions.bun === "string" ? "bun" : "node", argv: process.argv.slice(2), cwd: process.cwd(), keys: Object.keys(process.env) }));
}
`;

/**
 * This checkout's @next/env, the package Next.js loads .env files with, as next's own package finds it from its real
 * directory, which is not node_modules/next under an isolated install.
 */
const NEXT_ENV = path.dirname(
  path.dirname(
    createRequire(fs.realpathSync(path.join(ROOT, "node_modules", "next", "package.json"))).resolve("@next/env"),
  ),
);

/** Copies this checkout's @next/env, its manifest and its one bundled file, to `directory`. */
function copyNextEnv(directory: string): void {
  fs.mkdirSync(path.join(directory, "dist"), { recursive: true });
  for (const file of ["package.json", path.join("dist", "index.js")]) {
    fs.copyFileSync(path.join(NEXT_ENV, file), path.join(directory, file));
  }
}

/**
 * A checkout-shaped fixture: the launcher and its helper copied in at the same relative paths, an empty seed-assets,
 * a stub next package, and a copy of this checkout's @next/env at the top of node_modules.
 */
function checkout({
  withNext = true,
  withNextEnv = true,
  parent = tempDir,
}: {
  withNext?: boolean;
  withNextEnv?: boolean;
  parent?: string;
} = {}): string {
  const root = fs.mkdtempSync(path.join(parent, "checkout-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "bin", "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "seed-assets"));
  fs.copyFileSync(path.join(ROOT, LAUNCHER), path.join(root, LAUNCHER));
  fs.copyFileSync(
    path.join(ROOT, "bin", "lib", "launcher-utils.mjs"),
    path.join(root, "bin", "lib", "launcher-utils.mjs"),
  );
  if (withNext) {
    const next = path.join(root, "node_modules", "next");
    fs.mkdirSync(path.join(next, "dist", "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(next, "package.json"),
      JSON.stringify({ name: "next", bin: { next: "./dist/bin/next" } }),
    );
    fs.writeFileSync(path.join(next, "dist", "bin", "next"), STUB);
  }
  if (withNextEnv) copyNextEnv(path.join(root, "node_modules", "@next", "env"));
  return root;
}

/**
 * The test's environment, plus the case's own values. Four keys are left out: SEED_ASSETS_DIR and
 * NEXT_MANUAL_SIG_HANDLE, which the cases set themselves; NODE_PATH, a further place Node.js looks for packages; and
 * NODE_ENV, which bun test sets to test and which picks the .env files Next.js reads.
 */
const LEFT_OUT = new Set(["SEED_ASSETS_DIR", "NEXT_MANUAL_SIG_HANDLE", "NODE_PATH", "NODE_ENV"]);
function envWith(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !LEFT_OUT.has(key)) env[key] = value;
  }
  return { ...env, ...overrides };
}

/**
 * A next package at `directory`/next whose binary writes `ran` to `marker`: one the launcher must never run. Returns
 * its package.json path.
 */
function strayNext(directory: string, marker: string): string {
  const next = path.join(directory, "next");
  fs.mkdirSync(path.join(next, "bin"), { recursive: true });
  fs.writeFileSync(path.join(next, "package.json"), JSON.stringify({ name: "next", bin: { next: "./bin/next" } }));
  fs.writeFileSync(
    path.join(next, "bin", "next"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`,
  );
  return path.join(next, "package.json");
}

/**
 * An @next/env package at `directory`/@next/env whose loadEnvConfig writes `ran` to `marker`: one the launcher must
 * never load.
 */
function strayNextEnv(directory: string, marker: string): void {
  const env = path.join(directory, "@next", "env");
  fs.mkdirSync(env, { recursive: true });
  fs.writeFileSync(path.join(env, "package.json"), JSON.stringify({ name: "@next/env", main: "index.js" }));
  fs.writeFileSync(
    path.join(env, "index.js"),
    `exports.loadEnvConfig = () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); return { combinedEnv: {} }; };`,
  );
}

function node(): string {
  const found = Bun.which("node");
  if (found === null) throw new Error("node is not on PATH: bun dev and bun start run the launcher with node");
  return found;
}

function run(root: string, args: string[], overrides: Record<string, string> = {}, cwd = tempDir, runtime = node()) {
  const proc = Bun.spawnSync([runtime, path.join(root, LAUNCHER), ...args], {
    cwd,
    env: envWith(overrides),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    signalCode: proc.signalCode ?? null,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** What the stub reported, from a run that printed its report. */
function report(result: ReturnType<typeof run>): {
  seedAssets: string | null;
  manualSignalHandling: string | null;
  runtime: "bun" | "node";
  argv: string[];
  cwd: string;
  keys: string[];
} {
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.trim());
}

const real = (p: string) => fs.realpathSync.native(p);

describe("bun dev and bun start run Next.js through scripts/next-with-seed-assets.mjs", () => {
  test("package.json's dev and start scripts run the Next.js CLI only through the launcher", () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(scripts.dev).toBe("node scripts/copy-monaco.mjs && node scripts/next-with-seed-assets.mjs dev");
    expect(scripts.start).toBe("node scripts/next-with-seed-assets.mjs start");
    const direct = Object.entries(scripts).filter(([, command]) => /(^|&&|;|\s)next (dev|start)\b/.test(command));
    expect(direct).toEqual([]);
  });

  test("the launcher runs the Next.js CLI this checkout installs", () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "next", "package.json"), "utf8"));
    const proc = Bun.spawnSync([node(), path.join(ROOT, LAUNCHER), "--version"], {
      cwd: ROOT,
      env: envWith(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe(`Next.js v${version}`);
  });
});

describe("scripts/next-with-seed-assets.mjs on a checkout fixture with a stub Next.js CLI", () => {
  test("points SEED_ASSETS_DIR at the checkout's own seed-assets, computed from the script's location, whatever the working directory holds", () => {
    const root = checkout();
    const elsewhere = fs.mkdtempSync(path.join(tempDir, "cwd-"));
    fs.mkdirSync(path.join(elsewhere, "seed-assets"));
    const { seedAssets } = report(run(root, ["dev"], {}, elsewhere));
    expect(seedAssets).not.toBeNull();
    expect(path.isAbsolute(seedAssets as string)).toBe(true);
    expect(real(seedAssets as string)).toBe(real(path.join(root, "seed-assets")));
  });

  test.each(["", "   "])("treats a SEED_ASSETS_DIR of %p as unset", (value) => {
    const root = checkout();
    const { seedAssets } = report(run(root, ["start"], { SEED_ASSETS_DIR: value }));
    expect(real(seedAssets as string)).toBe(real(path.join(root, "seed-assets")));
  });

  test("keeps a SEED_ASSETS_DIR the caller set, as given, a relative one included", () => {
    const root = checkout();
    const own = path.join(tempDir, "own-assets");
    expect(report(run(root, ["start"], { SEED_ASSETS_DIR: own })).seedAssets).toBe(own);
    expect(report(run(root, ["start"], { SEED_ASSETS_DIR: "./rel" })).seedAssets).toBe("./rel");
  });

  test("passes every argument to the Next.js CLI unchanged, and runs it in the launcher's working directory", () => {
    const root = checkout();
    const cwd = fs.mkdtempSync(path.join(tempDir, "cwd-"));
    const args = ["dev", "--port", "3001", "-H", "127.0.0.1", "a b", "--", "--x"];
    const reported = report(run(root, args, {}, cwd));
    expect(reported.argv).toEqual(args);
    expect(real(reported.cwd)).toBe(real(cwd));
  });

  test.each([0, 3, 70])("exits with the Next.js CLI's exit code %d", (code) => {
    const result = run(checkout(), ["exit", String(code)]);
    expect(result.stderr).toBe("");
    expect([result.exitCode, result.signalCode]).toEqual([code, null]);
  });

  test("fails with exit code 1 and names the Next.js CLI when next is not installed", () => {
    const root = checkout({ withNext: false });
    const result = run(root, ["dev"], {}, root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot find this checkout's Next.js CLI (run bun install)");
  });

  test("fails with exit code 1 on a next installed only in a parent directory's node_modules, names the checkout's own, and never runs the other", () => {
    const outer = fs.mkdtempSync(path.join(tempDir, "outer-"));
    const marker = path.join(outer, "ran");
    strayNext(path.join(outer, "node_modules"), marker);
    const root = checkout({ withNext: false, parent: outer });
    const result = run(root, ["dev"], {}, root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot find this checkout's Next.js CLI (run bun install)");
    expect(result.stderr).toContain(path.join(root, "node_modules", "next", "package.json"));
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("runs the Next.js CLI of a checkout whose node_modules/next is a link to a build outside the checkout, as bun link makes", () => {
    const root = checkout();
    const moved = fs.mkdtempSync(path.join(tempDir, "next-build-"));
    fs.renameSync(path.join(root, "node_modules", "next"), path.join(moved, "next"));
    fs.symlinkSync(path.join(moved, "next"), path.join(root, "node_modules", "next"), "junction");
    expect(report(run(root, ["dev"])).argv).toEqual(["dev"]);
  });

  test("runs the Next.js CLI of a checkout whose node_modules is a link to another directory", () => {
    const root = checkout();
    const moved = fs.mkdtempSync(path.join(tempDir, "modules-"));
    fs.renameSync(path.join(root, "node_modules"), path.join(moved, "node_modules"));
    fs.symlinkSync(path.join(moved, "node_modules"), path.join(root, "node_modules"), "junction");
    expect(report(run(root, ["dev"])).argv).toEqual(["dev"]);
  });

  test("refuses, with exit code 1, a Next.js CLI that Node.js finds through NODE_PATH, and never runs it", () => {
    const elsewhere = fs.mkdtempSync(path.join(tempDir, "node-path-"));
    const marker = path.join(elsewhere, "ran");
    strayNext(elsewhere, marker);
    const root = checkout({ withNext: false });
    const result = run(root, ["dev"], { NODE_PATH: elsewhere }, root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot find this checkout's Next.js CLI (run bun install)");
    expect(fs.existsSync(marker)).toBe(false);
  });

  /** A working directory holding one .env file with `content`. */
  function withEnvFile(name: string, content: string): string {
    const cwd = fs.mkdtempSync(path.join(tempDir, "env-"));
    fs.writeFileSync(path.join(cwd, name), content);
    return cwd;
  }

  /** The names in the stub's environment that the launcher was not given; on Windows names ignore letter case. */
  function added(keys: string[], given: Record<string, string>): string[] {
    const fold = (key: string) => (process.platform === "win32" ? key.toUpperCase() : key);
    const known = new Set(Object.keys(given).map(fold));
    return keys.filter((key) => !known.has(fold(key)));
  }

  test.each([
    ["dev", ".env.development.local", {}],
    ["dev", ".env.local", {}],
    ["dev", ".env.development", {}],
    ["dev", ".env", {}],
    ["start", ".env.production.local", {}],
    ["start", ".env.local", {}],
    ["start", ".env.production", {}],
    ["start", ".env", {}],
    ["dev", ".env.test.local", { NODE_ENV: "test" }],
    ["dev", ".env.test", { NODE_ENV: "test" }],
    ["dev", ".env", { NODE_ENV: "test" }],
    ["start", ".env.test", { NODE_ENV: "test" }],
  ] as const)(
    "%s keeps a SEED_ASSETS_DIR in %s (%o) for Next.js to read, and passes nothing it loaded",
    (command, name, overrides) => {
      const cwd = withEnvFile(name, "OTHER_SETTING=1\nSEED_ASSETS_DIR=/from/the/file\n");
      const reported = report(run(checkout(), [command], overrides, cwd));
      expect(reported.seedAssets).toBeNull();
      // Under start on Node.js the launcher adds the one key of its own (docs/DISTRIBUTION.md, "Stopping the server").
      expect(added(reported.keys, envWith(overrides))).toEqual(command === "start" ? ["NEXT_MANUAL_SIG_HANDLE"] : []);
    },
  );

  test.each([
    ["dev", ".env.production", {}],
    ["start", ".env.development", {}],
    ["start", ".env.development.local", {}],
    ["dev", ".env.local", { NODE_ENV: "test" }],
    ["dev", ".env.development", { NODE_ENV: "test" }],
    ["start", ".env.production", { NODE_ENV: "test" }],
  ] as const)(
    "%s sets the checkout's seed-assets over a SEED_ASSETS_DIR in %s (%o), which Next.js does not load for it",
    (command, name, overrides) => {
      const root = checkout();
      const cwd = withEnvFile(name, "SEED_ASSETS_DIR=/from/the/file\n");
      const reported = report(run(root, [command], overrides, cwd));
      expect(real(reported.seedAssets as string)).toBe(real(path.join(root, "seed-assets")));
    },
  );

  test("loads the production .env files for a command other than dev", () => {
    const cwd = withEnvFile(".env.production", "SEED_ASSETS_DIR=/from/the/file\n");
    expect(report(run(checkout(), ["build"], {}, cwd)).seedAssets).toBeNull();
  });

  test("sets the checkout's seed-assets, and passes nothing else, when no .env file Next.js loads sets it", () => {
    const root = checkout();
    const cwd = withEnvFile(".env.local", "OTHER_SETTING=1\n");
    const reported = report(run(root, ["dev"], {}, cwd));
    expect(real(reported.seedAssets as string)).toBe(real(path.join(root, "seed-assets")));
    expect(added(reported.keys, envWith())).toEqual(["SEED_ASSETS_DIR"]);
  });

  test("treats a blank SEED_ASSETS_DIR in a .env file as unset, as it does a blank one from the shell", () => {
    const root = checkout();
    const reported = report(run(root, ["dev"], {}, withEnvFile(".env.local", "SEED_ASSETS_DIR=\n")));
    expect(real(reported.seedAssets as string)).toBe(real(path.join(root, "seed-assets")));
  });

  test("keeps a SEED_ASSETS_DIR the caller exported over one in a .env file, as Next.js does", () => {
    const own = path.join(tempDir, "own-assets");
    const cwd = withEnvFile(".env.local", "SEED_ASSETS_DIR=/from/the/file\n");
    expect(report(run(checkout(), ["dev"], { SEED_ASSETS_DIR: own }, cwd)).seedAssets).toBe(own);
  });

  test("skips a .env that is a directory, as Next.js does, such as the one python -m venv .env makes", () => {
    const root = checkout();
    const cwd = fs.mkdtempSync(path.join(tempDir, "env-"));
    fs.mkdirSync(path.join(cwd, ".env"));
    const { seedAssets } = report(run(root, ["dev"], {}, cwd));
    expect(real(seedAssets as string)).toBe(real(path.join(root, "seed-assets")));
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "leaves a .env file it cannot read to Next.js, which reports it, and sets the checkout's seed-assets",
    () => {
      const root = checkout();
      const cwd = withEnvFile(".env.local", "SEED_ASSETS_DIR=/from/the/file\n");
      const file = path.join(cwd, ".env.local");
      fs.chmodSync(file, 0o000);
      try {
        const { seedAssets } = report(run(root, ["dev"], {}, cwd));
        expect(real(seedAssets as string)).toBe(real(path.join(root, "seed-assets")));
      } finally {
        fs.chmodSync(file, 0o600);
      }
    },
  );

  test("fails with exit code 1 and names both places when this checkout has no @next/env", () => {
    const root = checkout({ withNextEnv: false });
    const result = run(root, ["dev"], {}, root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot find this checkout's @next/env (run bun install)");
    expect(result.stderr).toContain(path.join(root, "node_modules", "next", "node_modules", "@next", "env"));
    expect(result.stderr).toContain(path.join(root, "node_modules", "@next", "env"));
  });

  test("loads next's own nested @next/env before the one at the top of node_modules", () => {
    const root = checkout({ withNextEnv: false });
    const marker = path.join(root, "ran");
    copyNextEnv(path.join(root, "node_modules", "next", "node_modules", "@next", "env"));
    strayNextEnv(path.join(root, "node_modules"), marker);
    const cwd = withEnvFile(".env.local", "SEED_ASSETS_DIR=/from/the/file\n");
    expect(report(run(root, ["dev"], {}, cwd)).seedAssets).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
  });

  test.each([
    ["", false],
    [", node_modules itself being a link to another directory", true],
  ])(
    "loads the @next/env beside next's real directory in the checkout's node_modules, as bun's isolated install lays it out%s",
    (_, linkedModules) => {
      const root = checkout({ withNextEnv: false });
      let modules = path.join(root, "node_modules");
      if (linkedModules) {
        const moved = fs.mkdtempSync(path.join(tempDir, "modules-"));
        fs.renameSync(modules, path.join(moved, "node_modules"));
        fs.symlinkSync(path.join(moved, "node_modules"), modules, "junction");
        modules = path.join(moved, "node_modules");
      }
      const store = path.join(modules, ".bun", "next@0.0.0", "node_modules");
      fs.mkdirSync(store, { recursive: true });
      fs.renameSync(path.join(modules, "next"), path.join(store, "next"));
      fs.symlinkSync(path.join(store, "next"), path.join(modules, "next"), "junction");
      const envPackage = path.join(modules, ".bun", "@next+env@0.0.0", "node_modules", "@next", "env");
      copyNextEnv(envPackage);
      fs.mkdirSync(path.join(store, "@next"));
      fs.symlinkSync(envPackage, path.join(store, "@next", "env"), "junction");
      const cwd = withEnvFile(".env.local", "SEED_ASSETS_DIR=/from/the/file\n");
      expect(report(run(root, ["dev"], {}, cwd)).seedAssets).toBeNull();
    },
  );

  test("never loads the @next/env beside a linked next's real directory outside the checkout", () => {
    const root = checkout();
    const moved = fs.mkdtempSync(path.join(tempDir, "next-build-"));
    const marker = path.join(moved, "ran");
    fs.renameSync(path.join(root, "node_modules", "next"), path.join(moved, "next"));
    fs.symlinkSync(path.join(moved, "next"), path.join(root, "node_modules", "next"), "junction");
    strayNextEnv(moved, marker);
    const cwd = withEnvFile(".env.local", "SEED_ASSETS_DIR=/from/the/file\n");
    expect(report(run(root, ["dev"], {}, cwd)).seedAssets).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("never loads an @next/env from a parent directory's node_modules or from NODE_PATH", () => {
    const outer = fs.mkdtempSync(path.join(tempDir, "outer-"));
    const marker = path.join(outer, "ran");
    strayNextEnv(path.join(outer, "node_modules"), marker);
    const elsewhere = fs.mkdtempSync(path.join(tempDir, "node-path-"));
    strayNextEnv(elsewhere, marker);
    const root = checkout({ withNextEnv: false, parent: outer });
    const result = run(root, ["dev"], { NODE_PATH: elsewhere }, root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cannot find this checkout's @next/env (run bun install)");
    expect(fs.existsSync(marker)).toBe(false);
  });

  const NO_POSIX_SIGNALS =
    process.platform === "win32"
      ? "POSIX signals: Windows has no SIGINT or SIGTERM to forward, and kill() there ends a process at once"
      : null;

  /** Runs the launcher on Node.js with the spawn probe preloaded, `node --import`, from a new checkout fixture. */
  function probed(args: string[], { signal }: { signal?: "SIGINT" | "SIGTERM" } = {}) {
    const probe = spawnProbe(fs.mkdtempSync(path.join(tempDir, "probe-")), { signal });
    const command = [node(), "--import", probe.importUrl, path.join(checkout(), LAUNCHER), ...args];
    return { probe, command };
  }

  test("installs its SIGINT and SIGTERM forwarding before it spawns the Next.js CLI", () => {
    const { probe, command } = probed([]);
    const proc = Bun.spawnSync(command, { cwd: tempDir, env: envWith(), stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode, `launcher stderr: ${proc.stderr.toString()}`).toBe(0);
    expect(probe.listenersAtSpawn()).toEqual({ SIGINT: 1, SIGTERM: 1 });
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    testIf(
      NO_POSIX_SIGNALS,
      `forwards a ${signal} that reaches it as it spawns the Next.js CLI to the CLI once it exists, and ends itself with it`,
      () => {
        // The probe sends the signal before the real spawn runs; the stub's sleep mode has no handler, so the
        // forwarded signal ends it, and only a forwarded one does: it would otherwise exit 99 after five seconds.
        const { probe, command } = probed(["sleep"], { signal });
        const proc = Bun.spawnSync(command, { cwd: tempDir, env: envWith(), stdout: "pipe", stderr: "pipe" });
        expect(probe.childEnd()).toEqual([null, signal]);
        expect([proc.exitCode, proc.signalCode ?? null]).toEqual([null, signal]);
      },
    );
  }

  /**
   * Starts the launcher on the stub's `wait` mode and resolves once the stub has its handlers installed. The launcher
   * has its own by then because it installs them before it spawns the stub, which each case asserts from the probe:
   * `ready` only says the stub is waiting.
   */
  async function startWaiting() {
    const { probe, command } = probed(["wait"]);
    const proc = Bun.spawn(command, { cwd: tempDir, env: envWith(), stdout: "pipe", stderr: "pipe" });
    await untilPrinted(proc.stdout, "ready");
    return { proc, probe };
  }

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    testIf(
      NO_POSIX_SIGNALS,
      `forwards ${signal} to the Next.js CLI and exits with the code it then exits with`,
      async () => {
        const { proc, probe } = await startWaiting();
        expect(probe.listenersAtSpawn()).toEqual({ SIGINT: 1, SIGTERM: 1 });
        proc.kill(signal);
        await proc.exited;
        expect([proc.exitCode, proc.signalCode ?? null]).toEqual([code, null]);
      },
    );
  }

  testIf(NO_POSIX_SIGNALS, "ends itself with the signal that ended the Next.js CLI", () => {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      const result = run(checkout(), ["die", signal]);
      expect([signal, result.exitCode, result.signalCode]).toEqual([signal, null, signal]);
    }
  });
});

/**
 * The exit owner `bun start` hands the server (docs/DISTRIBUTION.md, "Stopping the server"): the launcher runs the
 * Next.js CLI with process.execPath, so the server runs on the launcher's own runtime, and `true` is added only on
 * Node.js, where Studio's shutdown handler accepts it.
 */
describe("bun start and NEXT_MANUAL_SIG_HANDLE", () => {
  /** A working directory holding one .env file with `content`. */
  function withEnvFile(name: string, content: string): string {
    const cwd = fs.mkdtempSync(path.join(tempDir, "env-"));
    fs.writeFileSync(path.join(cwd, name), content);
    return cwd;
  }

  test("start on Node.js hands the Next.js CLI NEXT_MANUAL_SIG_HANDLE=true when the caller set none", () => {
    const reported = report(run(checkout(), ["start"]));
    expect(reported.runtime).toBe("node");
    expect(reported.manualSignalHandling).toBe("true");
  });

  test.each(["", "true", "1"])(
    "start keeps the caller's NEXT_MANUAL_SIG_HANDLE %p, the empty one included",
    (value) => {
      expect(report(run(checkout(), ["start"], { NEXT_MANUAL_SIG_HANDLE: value })).manualSignalHandling).toBe(value);
    },
  );

  test.each(["dev", "build"])("%s hands the Next.js CLI no NEXT_MANUAL_SIG_HANDLE", (command) => {
    expect(report(run(checkout(), [command])).manualSignalHandling).toBeNull();
  });

  test("start on Bun runs the Next.js CLI on Bun without NEXT_MANUAL_SIG_HANDLE", () => {
    const reported = report(run(checkout(), ["start"], {}, tempDir, process.execPath));
    expect(reported.runtime).toBe("bun");
    expect(reported.manualSignalHandling).toBeNull();
  });

  const START_FILES = [".env.production.local", ".env.local", ".env.production", ".env"];
  test.each(START_FILES.flatMap((name) => ["true", ""].map((value) => [name, value] as const)))(
    "start stops with exit code 1 and runs nothing when only %s sets NEXT_MANUAL_SIG_HANDLE to %p",
    (name, value) => {
      const result = run(checkout(), ["start"], {}, withEnvFile(name, `NEXT_MANUAL_SIG_HANDLE=${value}\n`));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("NEXT_MANUAL_SIG_HANDLE");
      expect(result.stderr).toContain(`a .env file Next.js loads for start (${name})`);
      expect(result.stderr).toContain("docs/DISTRIBUTION.md#stopping-the-server");
    },
  );

  test("start names every .env file that sets NEXT_MANUAL_SIG_HANDLE in its refusal, and only those", () => {
    const cwd = withEnvFile(".env.local", "NEXT_MANUAL_SIG_HANDLE=true\n");
    fs.writeFileSync(path.join(cwd, ".env.production"), "OTHER_SETTING=1\n");
    fs.writeFileSync(path.join(cwd, ".env"), "NEXT_MANUAL_SIG_HANDLE=\n");
    const result = run(checkout(), ["start"], {}, cwd);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("a .env file Next.js loads for start (.env.local, .env),");
  });

  // Only Windows reads environment names without letter case: there the loader's process.env takes a lower-case key
  // as NEXT_MANUAL_SIG_HANDLE, so the refusal fires, and it has to find the file by the same rule to name it.
  testIf(
    process.platform === "win32" ? null : "letter case in environment names: only Windows ignores it",
    "start names a .env file that sets NEXT_MANUAL_SIG_HANDLE in another letter case in its refusal",
    () => {
      const result = run(checkout(), ["start"], {}, withEnvFile(".env.local", "next_manual_sig_handle=true\n"));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("a .env file Next.js loads for start (.env.local),");
    },
  );

  /**
   * `bun --bun run start` in the fixture `root`, which holds package.json's own start script and is the working
   * directory, as in a checkout: Bun runs the script's `node` as Bun, so the launcher and the Next.js CLI run on Bun.
   */
  function bunRunStart(root: string) {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { start: scripts.start } }));
    const proc = Bun.spawnSync([process.execPath, "--bun", "run", "start"], {
      cwd: root,
      env: envWith(),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  }

  test("bun --bun run start runs the launcher and the Next.js CLI on Bun without NEXT_MANUAL_SIG_HANDLE", () => {
    const result = bunRunStart(checkout());
    expect(result.exitCode).toBe(0);
    const reported = JSON.parse(result.stdout.trim()) as { runtime: string; manualSignalHandling: string | null };
    expect(reported.runtime).toBe("bun");
    expect(reported.manualSignalHandling).toBeNull();
  });

  // Bun loads no .env file into the environment of a package.json script it runs, so the launcher refuses a value
  // that only a .env file sets on Bun as on Node.js.
  test.each(["true", ""])(
    "bun --bun run start stops with exit code 1 and runs nothing when only .env.local sets NEXT_MANUAL_SIG_HANDLE to %p",
    (value) => {
      const root = checkout();
      fs.writeFileSync(path.join(root, ".env.local"), `NEXT_MANUAL_SIG_HANDLE=${value}\n`);
      const result = bunRunStart(root);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "NEXT_MANUAL_SIG_HANDLE is set in a .env file Next.js loads for start (.env.local)",
      );
      expect(result.stderr).toContain("docs/DISTRIBUTION.md#stopping-the-server");
    },
  );

  test("start keeps a NEXT_MANUAL_SIG_HANDLE the caller exported over one in a .env file, as Next.js does", () => {
    const cwd = withEnvFile(".env.local", "NEXT_MANUAL_SIG_HANDLE=true\n");
    expect(report(run(checkout(), ["start"], { NEXT_MANUAL_SIG_HANDLE: "" }, cwd)).manualSignalHandling).toBe("");
  });

  test("dev leaves a NEXT_MANUAL_SIG_HANDLE in a .env file to Next.js and adds none", () => {
    const cwd = withEnvFile(".env.local", "NEXT_MANUAL_SIG_HANDLE=true\n");
    expect(report(run(checkout(), ["dev"], {}, cwd)).manualSignalHandling).toBeNull();
  });
});

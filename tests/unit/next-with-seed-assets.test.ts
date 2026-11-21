/**
 * Tests for scripts/next-with-seed-assets.mjs, the launcher `bun dev` and `bun start` run the Next.js CLI through.
 *
 * The server never takes the seed assets directory from its working directory (src/lib/seed/samples.ts), so a
 * checkout's server gets it from this launcher: SEED_ASSETS_DIR set to the checkout's own seed-assets, unless the
 * caller set one (docs/DISTRIBUTION.md, "Built-in sample assets"). The launcher is outside the line coverage gate,
 * which counts src/ only, so these spawned tests are its proof. Every fixture case runs a copy of the launcher in a
 * checkout-shaped temp directory whose `next` package is a stub that reports what it was given, or obeys its
 * arguments; the stub's every mode ends by itself within seconds, so nothing outlives a failing case.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { testIf } from "../helpers/posix-tools";

const ROOT = path.resolve(import.meta.dir, "../..");
const LAUNCHER = path.join("scripts", "next-with-seed-assets.mjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "next-with-seed-assets-"));
afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

/**
 * The stub Next.js CLI. With no mode it prints `{ seedAssets, argv, cwd }`. `exit <code>` exits with that code;
 * `die <signal>` ends itself with that signal; `wait` prints `ready` once its SIGINT and SIGTERM handlers are
 * installed and exits 130 or 143 on them. Each mode that waits exits 99 by itself after five seconds.
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
} else {
  console.log(JSON.stringify({ seedAssets: process.env.SEED_ASSETS_DIR ?? null, argv: process.argv.slice(2), cwd: process.cwd() }));
}
`;

/** A checkout-shaped fixture: the launcher and its helper copied in at the same relative paths, an empty seed-assets, and a stub next package. */
function checkout({ withNext = true }: { withNext?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(tempDir, "checkout-"));
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
  return root;
}

/** The test's environment without SEED_ASSETS_DIR, plus the case's own values. */
function envWith(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "SEED_ASSETS_DIR") env[key] = value;
  }
  return { ...env, ...overrides };
}

function node(): string {
  const found = Bun.which("node");
  if (found === null) throw new Error("node is not on PATH: bun dev and bun start run the launcher with node");
  return found;
}

function run(root: string, args: string[], overrides: Record<string, string> = {}, cwd = tempDir) {
  const proc = Bun.spawnSync([node(), path.join(root, LAUNCHER), ...args], {
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
function report(result: ReturnType<typeof run>): { seedAssets: string | null; argv: string[]; cwd: string } {
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

  const NO_POSIX_SIGNALS =
    process.platform === "win32"
      ? "POSIX signals: Windows has no SIGINT or SIGTERM to forward, and kill() there ends a process at once"
      : null;

  /** Starts the launcher on the stub's `wait` mode and resolves once the stub has its handlers installed. */
  async function startWaiting() {
    const proc = Bun.spawn([node(), path.join(checkout(), LAUNCHER), "wait"], {
      cwd: tempDir,
      env: envWith(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("ready")) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk after the other.
      const { value, done } = await reader.read();
      if (done) throw new Error(`the stub ended before it was ready: ${seen}`);
      seen += decoder.decode(value);
    }
    reader.releaseLock();
    return proc;
  }

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    testIf(
      NO_POSIX_SIGNALS,
      `forwards ${signal} to the Next.js CLI and exits with the code it then exits with`,
      async () => {
        const proc = await startWaiting();
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

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
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { testIf } from "../helpers/posix-tools";

const ROOT = path.resolve(import.meta.dir, "../..");
const LAUNCHER = path.join("scripts", "next-with-seed-assets.mjs");
// At its real path, so the fixture paths, a child's working directory and the paths Node.js reports share one
// spelling: on Windows os.tmpdir() answers the 8.3 form of the user profile, and on macOS a path under /var.
const tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "next-with-seed-assets-")));
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
function checkout({ withNext = true, parent = tempDir }: { withNext?: boolean; parent?: string } = {}): string {
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
  return root;
}

/**
 * The test's environment, plus the case's own values. Three keys are left out: SEED_ASSETS_DIR, which the cases set
 * themselves; NODE_PATH, a further place Node.js looks for packages; and NODE_ENV, which bun test sets to test and
 * which picks the .env files Next.js reads.
 */
const LEFT_OUT = new Set(["SEED_ASSETS_DIR", "NODE_PATH", "NODE_ENV"]);
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

  test.each([
    ["dev", ".env.development.local"],
    ["dev", ".env.local"],
    ["dev", ".env.development"],
    ["dev", ".env"],
    ["start", ".env.production.local"],
    ["start", ".env.local"],
    ["start", ".env.production"],
    ["start", ".env"],
  ])(
    "%s refuses, with exit code 1, a SEED_ASSETS_DIR assigned in %s, whose value Next.js would drop, and names the file",
    (command, name) => {
      const cwd = withEnvFile(name, "OTHER_SETTING=1\nSEED_ASSETS_DIR=/from/the/file\n");
      const result = run(checkout(), [command], {}, cwd);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`SEED_ASSETS_DIR is assigned in ${path.join(real(cwd), name)}`);
      expect(result.stderr).toContain("export SEED_ASSETS_DIR in the shell");
    },
  );

  test.each(["export SEED_ASSETS_DIR=/x", "  SEED_ASSETS_DIR = /x", "SEED_ASSETS_DIR=", "SEED_ASSETS_DIR: /x"])(
    "refuses the assignment form %p, as Next.js's .env parser reads each",
    (line) => {
      const result = run(checkout(), ["dev"], {}, withEnvFile(".env.local", `${line}\n`));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("SEED_ASSETS_DIR is assigned in");
    },
  );

  test.each(["# SEED_ASSETS_DIR=/x", "MY_SEED_ASSETS_DIR=/x", "SEED_ASSETS_DIRECTORY=/x", "OTHER=SEED_ASSETS_DIR=/x"])(
    "runs on a .env file whose line %p assigns no SEED_ASSETS_DIR",
    (line) => {
      const root = checkout();
      const { seedAssets } = report(run(root, ["dev"], {}, withEnvFile(".env.local", `${line}\n`)));
      expect(real(seedAssets as string)).toBe(real(path.join(root, "seed-assets")));
    },
  );

  test.each([
    ["dev", ".env.production"],
    ["start", ".env.development"],
    ["start", ".env.development.local"],
  ])("%s runs on a SEED_ASSETS_DIR assigned in %s, which Next.js does not read for it", (command, name) => {
    const root = checkout();
    const { seedAssets } = report(run(root, [command], {}, withEnvFile(name, "SEED_ASSETS_DIR=/from/the/file\n")));
    expect(real(seedAssets as string)).toBe(real(path.join(root, "seed-assets")));
  });

  test("with NODE_ENV=test reads the test files Next.js reads, which leave out .env.local", () => {
    const root = checkout();
    const local = withEnvFile(".env.local", "SEED_ASSETS_DIR=/from/the/file\n");
    const { seedAssets } = report(run(root, ["dev"], { NODE_ENV: "test" }, local));
    expect(real(seedAssets as string)).toBe(real(path.join(root, "seed-assets")));
    const testLocal = withEnvFile(".env.test.local", "SEED_ASSETS_DIR=/from/the/file\n");
    const result = run(root, ["dev"], { NODE_ENV: "test" }, testLocal);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`SEED_ASSETS_DIR is assigned in ${path.join(real(testLocal), ".env.test.local")}`);
  });

  test.each([
    ["dev", "development", {}],
    ["start", "production", {}],
    ["dev", "test", { NODE_ENV: "test" }],
  ] as const)(
    "%s in %s mode refuses a SEED_ASSETS_DIR in exactly the .env files @next/env loads for it",
    (command, _mode, overrides) => {
      const names = [".env", ".env.local"];
      for (const mode of ["development", "production", "test"]) names.push(`.env.${mode}`, `.env.${mode}.local`);
      const all = withEnvFile(names[0], "SEED_ASSETS_DIR=/from/the/file\n");
      for (const name of names.slice(1)) fs.writeFileSync(path.join(all, name), "SEED_ASSETS_DIR=/from/the/file\n");
      // Next.js's own loader, asked in a child with the NODE_ENV the launcher's child gets, which files it loads.
      const nextEnv = createRequire(path.join(ROOT, "node_modules", "next", "package.json")).resolve("@next/env");
      const ask = Bun.spawnSync(
        [
          node(),
          "-e",
          `const { loadEnvConfig } = require(${JSON.stringify(nextEnv)});` +
            `const log = { info() {}, error(m) { throw new Error(m); } };` +
            `const { loadedEnvFiles } = loadEnvConfig(${JSON.stringify(all)}, ${command === "dev"}, log, true);` +
            "console.log(JSON.stringify(loadedEnvFiles.map((file) => file.path)));",
        ],
        { cwd: tempDir, env: envWith(overrides), stdout: "pipe", stderr: "pipe" },
      );
      expect(ask.stderr.toString()).toBe("");
      const loaded = JSON.parse(ask.stdout.toString()) as string[];
      expect(loaded.length).toBeGreaterThan(0);
      for (const name of names) {
        const cwd = withEnvFile(name, "SEED_ASSETS_DIR=/from/the/file\n");
        const result = run(checkout(), [command], overrides, cwd);
        expect([name, result.exitCode]).toEqual([name, loaded.includes(name) ? 1 : 0]);
      }
    },
  );

  test("skips a .env that is a directory, as Next.js does, such as the one python -m venv .env makes", () => {
    const root = checkout();
    const cwd = fs.mkdtempSync(path.join(tempDir, "env-"));
    fs.mkdirSync(path.join(cwd, ".env"));
    const { seedAssets } = report(run(root, ["dev"], {}, cwd));
    expect(real(seedAssets as string)).toBe(real(path.join(root, "seed-assets")));
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails with exit code 1 and one line naming a .env file it cannot read",
    () => {
      const cwd = withEnvFile(".env.local", "OTHER_SETTING=1\n");
      const file = path.join(cwd, ".env.local");
      fs.chmodSync(file, 0o000);
      try {
        const result = run(checkout(), ["dev"], {}, cwd);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr.trim().split("\n")).toEqual([
          expect.stringContaining(`Cannot read ${file} to check it for SEED_ASSETS_DIR:`),
        ]);
        expect(result.stderr).toContain("EACCES");
      } finally {
        fs.chmodSync(file, 0o600);
      }
    },
  );

  test("keeps a SEED_ASSETS_DIR the caller exported over one in a .env file, as Next.js does", () => {
    const own = path.join(tempDir, "own-assets");
    const cwd = withEnvFile(".env.local", "SEED_ASSETS_DIR=/from/the/file\n");
    expect(report(run(checkout(), ["dev"], { SEED_ASSETS_DIR: own }, cwd)).seedAssets).toBe(own);
  });

  test("reads no .env file for a command other than dev and start", () => {
    const cwd = withEnvFile(".env", "SEED_ASSETS_DIR=/from/the/file\n");
    const result = run(checkout(), ["exit", "0"], {}, cwd);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
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

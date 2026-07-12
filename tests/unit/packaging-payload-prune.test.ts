/**
 * Unit test for the standalone payload prune step (issue #124): Next.js
 * output file tracing sweeps the repo root, dragging non-runtime extras
 * (docs/, charts/, e2e/, tests/, CLAUDE.md, bun.lock, fly.toml, deploy
 * manifests) into .next/standalone - and from there into every
 * payload-derived artifact (release tarballs, .deb/.rpm, snap, npx cache).
 * Exercises the real `scripts/lib/prune-standalone-payload.sh` as a
 * subprocess against a fixture payload dir - no full `bun run build`
 * needed, since the helper only prunes an already-assembled payload.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../scripts/lib/prune-standalone-payload.sh");

/** Runtime files the prune must never remove (mirrors the build script's
 * payload assembly - including the hidden .next dir: see the snap 0.9.52
 * fileset incident for how easily dot-directories get dropped). LICENSE
 * and README.md are deliberately kept (release-artifact convention; the
 * MIT notice travels with the payload). */
const KEEP_FILES = [
  "server.js",
  "package.json",
  ".next/BUILD_ID",
  ".next/static/chunks/main.js",
  "public/logo.svg",
  "node_modules/better-sqlite3/package.json",
  "node_modules/@libredb/libredb/package.json",
  // Deny-list names nested inside kept directories are NOT payload-root
  // entries and must survive (the prune is root-only by design).
  "node_modules/@libredb/libredb/docs/README.md",
  "node_modules/some-pkg/src/index.js",
  "data/.gitkeep",
  "LICENSE",
  "README.md",
];

/** Directories on the deny-list (planted with one file each; the prune
 * must remove the whole directory, not just empty it). */
const EXTRA_DIRS = [
  "bin",
  "charts",
  "conductor",
  "coverage",
  "deploy",
  "dist",
  "docker",
  "docs",
  "e2e",
  "logs",
  "loop",
  "packaging",
  "scripts",
  "snap",
  "snap-payload",
  "src",
  "testdb",
  "tests",
];

/** Root files on the deny-list, including one instance per glob pattern
 * (docker-compose*, *.snap). */
const EXTRA_FILES = [
  ...EXTRA_DIRS.map((dir) => `${dir}/example-file`),
  "artifacthub-repo.yml",
  "biome.json",
  "bun.lock",
  "bunfig.toml",
  "CLAUDE.md",
  "CODE_OF_CONDUCT.md",
  "components.json",
  "CONTRIBUTING.md",
  "database-compose.yml",
  "Dockerfile",
  "docker-entrypoint.sh",
  "DOCKERHUB.md",
  "eslint.config.mjs",
  "fly.toml",
  "knip.json",
  "next.config.ts",
  "playwright.config.ts",
  "postcss.config.mjs",
  "render.yaml",
  "SECURITY.md",
  "sonar-project.properties",
  "tsconfig.json",
  "tsconfig.lib.json",
  "tsup.config.ts",
  "seed-connections.yaml",
  "tsconfig.tsbuildinfo",
  "npmjs-token",
  "testdb-shm",
  "testdb-wal",
  "docker-compose.yml",
  "docker-compose.example.yml",
  "libredb-studio_9.9.9_amd64.snap",
  "libredb-studio-0.1.12.tgz",
  "bun-debug.log",
  "local-cert.pem",
];

describe("scripts/lib/prune-standalone-payload.sh (#124)", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeFixturePayload(files: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "prune-standalone-payload-"));
    fixtureRoots.push(root);
    const payloadDir = join(root, "payload");
    for (const file of files) {
      mkdirSync(dirname(join(payloadDir, file)), { recursive: true });
      writeFileSync(join(payloadDir, file), "// fixture");
    }
    return payloadDir;
  }

  function runPrune(...args: string[]) {
    return Bun.spawnSync(["bash", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  }

  test("removes the repo-root extras from the payload root", () => {
    const payloadDir = makeFixturePayload([...KEEP_FILES, ...EXTRA_FILES]);

    const run = runPrune(payloadDir);
    expect(run.exitCode).toBe(0);

    for (const extra of EXTRA_FILES) {
      expect(existsSync(join(payloadDir, extra))).toBe(false);
    }
    // Pruned directories are gone entirely, not just emptied.
    for (const dir of EXTRA_DIRS) {
      expect(existsSync(join(payloadDir, dir))).toBe(false);
    }
  });

  test("keeps every runtime file, including dot-directories and nested deny-list names", () => {
    const payloadDir = makeFixturePayload([...KEEP_FILES, ...EXTRA_FILES]);

    const run = runPrune(payloadDir);
    expect(run.exitCode).toBe(0);

    for (const kept of KEEP_FILES) {
      expect(existsSync(join(payloadDir, kept))).toBe(true);
    }
  });

  test("succeeds on a payload that has no extras to prune", () => {
    const payloadDir = makeFixturePayload(KEEP_FILES);

    const run = runPrune(payloadDir);
    expect(run.exitCode).toBe(0);

    for (const kept of KEEP_FILES) {
      expect(existsSync(join(payloadDir, kept))).toBe(true);
    }
  });

  test("rejects a wrong number of arguments", () => {
    const run = runPrune();
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("Usage:");
  });

  test("fails on a missing payload dir", () => {
    const run = runPrune("/nonexistent/payload-dir");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("not found");
  });

  test("refuses a dir that does not look like a standalone payload and deletes nothing", () => {
    // Deny-list names present but NO payload markers (server.js, package.json,
    // .next) - e.g. a repo checkout or / passed by mistake. The prune must
    // refuse before removing anything.
    const notAPayload = ["docs/example-file", "CLAUDE.md", "bun.lock"];
    const payloadDir = makeFixturePayload(notAPayload);

    const run = runPrune(payloadDir);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("does not look like a standalone payload");

    for (const survivor of notAPayload) {
      expect(existsSync(join(payloadDir, survivor))).toBe(true);
    }
  });

  test("refuses when only some payload markers are present", () => {
    // package.json alone (any npm dir has one) must not qualify as a payload.
    const partial = ["package.json", "server.js", "docs/example-file"];
    const payloadDir = makeFixturePayload(partial);

    const run = runPrune(payloadDir);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain(".next");
    expect(existsSync(join(payloadDir, "docs/example-file"))).toBe(true);
  });
});

/**
 * Unit tests for the Monaco asset staging step (scripts/copy-monaco.mjs).
 * `stageMonacoAssets` is exercised against throwaway temp-dir fixtures; the CLI
 * describe block runs the real script as a subprocess so the exit codes the build
 * depends on are covered too.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageMonacoAssets } from "../../scripts/copy-monaco.mjs";

const tempDirs: string[] = [];

function makeFixture({ withMonaco = true }: { withMonaco?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "monaco-stage-"));
  tempDirs.push(root);
  if (withMonaco) {
    const vsDir = join(root, "node_modules", "monaco-editor", "min", "vs");
    mkdirSync(join(vsDir, "editor"), { recursive: true });
    writeFileSync(join(root, "node_modules", "monaco-editor", "package.json"), JSON.stringify({ version: "0.55.1" }));
    writeFileSync(join(vsDir, "loader.js"), "// amd loader");
    writeFileSync(join(vsDir, "editor", "editor.main.js"), "// editor");
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("stageMonacoAssets", () => {
  test("stages the AMD bundle into public/monaco/vs", () => {
    const root = makeFixture();

    const result = stageMonacoAssets(root);

    expect(readFileSync(join(root, "public", "monaco", "vs", "loader.js"), "utf8")).toBe("// amd loader");
    expect(existsSync(join(root, "public", "monaco", "vs", "editor", "editor.main.js"))).toBe(true);
    expect(result.target).toBe(join(root, "public", "monaco", "vs"));
    expect(result.version).toBe("0.55.1");
  });

  test("replaces a previously staged copy so an upgrade cannot serve stale assets", () => {
    const root = makeFixture();
    const staged = join(root, "public", "monaco", "vs");
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "loader.js"), "// stale loader from an older monaco");

    stageMonacoAssets(root);

    expect(readFileSync(join(staged, "loader.js"), "utf8")).toBe("// amd loader");
  });

  test("fails loudly when monaco-editor is not installed", () => {
    const root = makeFixture({ withMonaco: false });

    expect(() => stageMonacoAssets(root)).toThrow(/monaco-editor/);
  });
});

describe("copy-monaco CLI", () => {
  const script = join(import.meta.dir, "..", "..", "scripts", "copy-monaco.mjs");

  test("exits 0 and reports the staged path", () => {
    const root = makeFixture();

    const proc = Bun.spawnSync(["node", script], { cwd: root });

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("public/monaco/vs");
  });

  test("exits 1 with an actionable message when the dependency is missing", () => {
    const root = makeFixture({ withMonaco: false });

    const proc = Bun.spawnSync(["node", script], { cwd: root });

    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("monaco-editor");
  });
});

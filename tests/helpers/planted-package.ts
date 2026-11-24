/**
 * A throwaway root that mirrors the repository's gate configuration around one planted
 * workspace package, so a test can prove a gate sees `packages/` by watching it fail on a
 * violation planted there (packages/README.md, "Gates").
 *
 * The root holds copies of the named repository files (biome.json, eslint.config.mjs,
 * tsconfig.json, knip.json, bunfig.toml), a root package.json whose `workspaces` is the
 * repository's own value or absent, the planted files, a `.gitignore` of node_modules and a
 * git repository, because Biome reads the ignore file through git. With `linkNodeModules`,
 * its node_modules is a link to the repository's (a junction on Windows, which needs no
 * privilege), so each tool runs from the repository's install; without it the root has no
 * node_modules, for a test that runs `bun install` there and must not write into the
 * repository's. Tools run by their JavaScript entry under node, so no `.bin` shim and no
 * shell is involved.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");

/** The repository's own root package.json `workspaces` value. */
export function repositoryWorkspaces(): unknown {
  return JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8")).workspaces;
}

export interface PlantedRootOptions {
  /** Repository-root files copied in unchanged. */
  readonly copy: readonly string[];
  /** Whether the root package.json carries the repository's `workspaces`. */
  readonly workspaces: boolean;
  /** Files written relative to the root, the planted package among them. */
  readonly files: Readonly<Record<string, string>>;
  /** Whether node_modules links to the repository's install. */
  readonly linkNodeModules: boolean;
}

export interface ToolRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  /** stdout and stderr together, for a tool that reports on either. */
  readonly output: string;
}

/** Creates the root and returns its path; the caller removes it with removePlantedRoot. */
export function plantedRoot(options: PlantedRootOptions): string {
  const root = mkdtempSync(path.join(tmpdir(), "planted-package-"));
  for (const file of options.copy) copyFileSync(path.join(REPOSITORY_ROOT, file), path.join(root, file));
  const manifest: Record<string, unknown> = { name: "planted-root", private: true };
  if (options.workspaces) manifest.workspaces = repositoryWorkspaces();
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [file, content] of Object.entries(options.files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
  if (options.linkNodeModules) {
    symlinkSync(path.join(REPOSITORY_ROOT, "node_modules"), path.join(root, "node_modules"), "junction");
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

/** Removes a root plantedRoot made, without following its node_modules link. */
export function removePlantedRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export interface ToolRunOptions {
  /** How long the tool may run, in milliseconds, before the run fails naming it. */
  readonly timeoutMs: number;
}

/**
 * Runs a tool's JavaScript entry (a path under node_modules) under node in the root, and
 * returns its exit code, its stdout, and its stdout and stderr together.
 *
 * The run is bounded by `timeoutMs`: a blocking spawn cannot be pre-empted by bun's own
 * per-test timeout, so without a bound a tool that hangs would hang the test file. A run
 * that outlives the bound is killed and throws, naming the entry and the bound, with the
 * spawn error as its cause; any other spawn error is thrown as it is.
 */
export function runTool(root: string, entry: string, args: readonly string[], options: ToolRunOptions): ToolRun {
  const result = spawnSync("node", [path.join(root, "node_modules", entry), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: options.timeoutMs,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new Error(`${entry} did not finish within ${options.timeoutMs} ms`, { cause: result.error });
    }
    throw result.error;
  }
  return { exitCode: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}` };
}

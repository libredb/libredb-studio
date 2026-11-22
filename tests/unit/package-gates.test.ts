/**
 * Each tool gate sees a workspace package (packages/README.md, "Gates").
 *
 * Every case plants one violation in `packages/planted/` of a throwaway root that carries
 * the repository's own configuration file for that gate, and asserts the gate reports it.
 * Each pins a tool behaviour the repository relies on: bun's linker choice for a workspace
 * root, Biome's `files.includes`, the type-aware ESLint block's file scope, and knip's
 * reading of the root package.json `workspaces`. A tool upgrade that changes one of them
 * fails here by name, instead of letting a package fall silently out of the gate.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { plantedRoot, removePlantedRoot, runTool } from "../helpers/planted-package";

const PLANTED_MANIFEST = `${JSON.stringify(
  { name: "@libredb/planted", version: "0.0.0", private: true, type: "module", exports: { ".": "./src/index.ts" } },
  null,
  2,
)}\n`;

const roots: string[] = [];

function root(options: Parameters<typeof plantedRoot>[0]): string {
  const made = plantedRoot(options);
  roots.push(made);
  return made;
}

afterEach(() => {
  for (const made of roots.splice(0)) removePlantedRoot(made);
});

describe("the gates see a workspace package", () => {
  test("a workspace package installs hoisted under the repository's bunfig.toml", () => {
    // bun picks the isolated linker for a workspace root by default, which puts every
    // package under node_modules/.bun and changes the layout Studio builds and tests with.
    const made = root({
      copy: ["bunfig.toml"],
      workspaces: true,
      files: { "packages/planted/package.json": PLANTED_MANIFEST, "packages/planted/src/index.ts": "" },
      linkNodeModules: false,
    });

    const install = spawnSync(process.execPath, ["install"], { cwd: made, encoding: "utf8" });

    expect({ status: install.status, stderr: install.stderr }).toEqual({ status: 0, stderr: expect.any(String) });
    const link = path.join(made, "node_modules/@libredb/planted");
    expect({
      isolatedStore: existsSync(path.join(made, "node_modules/.bun")),
      hoistedLink: existsSync(link) && lstatSync(link).isSymbolicLink(),
    }).toEqual({ isolatedStore: false, hoistedLink: true });
    expect(realpathSync(link)).toBe(realpathSync(path.join(made, "packages/planted")));
  }, 30_000);

  test("Biome formats a workspace package's files", () => {
    const made = root({
      copy: ["biome.json"],
      workspaces: true,
      files: {
        "packages/planted/package.json": PLANTED_MANIFEST,
        "packages/planted/src/fmt.ts": "export   const x=1\n",
      },
      linkNodeModules: true,
    });

    const run = runTool(made, "@biomejs/biome/bin/biome", ["format", "."]);

    expect(run.exitCode).toBe(1);
    expect(run.output).toContain("packages/planted/src/fmt.ts");
  }, 30_000);

  test("the type-aware ESLint block reports a floating promise in a workspace package", () => {
    const made = root({
      copy: ["eslint.config.mjs", "tsconfig.json"],
      workspaces: true,
      files: {
        "packages/planted/package.json": PLANTED_MANIFEST,
        "packages/planted/src/float.ts":
          "export async function work(): Promise<number> {\n  return 1;\n}\nexport function caller(): void {\n  work();\n}\n",
      },
      linkNodeModules: true,
    });

    const run = runTool(made, "eslint/bin/eslint.js", ["packages", "--format", "json"]);

    expect(run.exitCode).toBe(1);
    const [report] = JSON.parse(run.stdout);
    expect(report.filePath).toEndWith(path.join("packages", "planted", "src", "float.ts"));
    expect(report.messages.map((message: { ruleId: string; line: number }) => [message.ruleId, message.line])).toEqual([
      ["@typescript-eslint/no-floating-promises", 5],
    ]);
  }, 60_000);

  test("knip reports an unused file in a workspace package", () => {
    const made = root({
      copy: ["knip.json"],
      workspaces: true,
      files: {
        "packages/planted/package.json": PLANTED_MANIFEST,
        "packages/planted/src/index.ts": "export const planted = 1;\n",
        "packages/planted/src/unused.ts": "export const unusedPlanted = 2;\n",
      },
      linkNodeModules: true,
    });

    const run = runTool(made, "knip/bin/knip.js", ["--include", "files", "--no-progress"]);

    expect(run.exitCode).toBe(1);
    expect(run.output).toContain("packages/planted/src/unused.ts");
    expect(run.output).not.toContain("packages/planted/src/index.ts");
  }, 60_000);
});

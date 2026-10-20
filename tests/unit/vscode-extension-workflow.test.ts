/**
 * The VS Code extension's workflow invariants (docs/TOOLCHAIN.md, "VS Code extension").
 *
 * Each failure here is silent. A cache of the whole `.vscode-test/` also saves the e2e leg's VS Code profile, its
 * `user-data/` and `extensions/`, and restores it into every later run, fork pull requests included. An upload that
 * finds no VSIX only warns. An npm install without its cache still passes, it just downloads the extension's
 * closure inside the required job on every run.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  "working-directory"?: string;
  with?: Record<string, string | number | boolean>;
}
interface Workflow {
  jobs: Record<string, { steps?: Step[] }>;
}

const WORKFLOWS = join(import.meta.dir, "../../.github/workflows");
const read = (file: string) => parseYaml(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
const steps = (workflow: Workflow, job: string) => workflow.jobs[job]?.steps ?? [];
const extension = read("vscode-extension.yml");

describe("vscode-extension.yml", () => {
  for (const job of ["vscode-extension", "vscode-extension-smoke"]) {
    test(`${job} caches the pinned VS Code builds and not the e2e leg's profile`, () => {
      const caches = steps(extension, job).filter((step) => step.uses?.startsWith("actions/cache@"));
      expect(caches.map((step) => step.with?.path)).toEqual(["vscode-extension/.vscode-test/vscode-*"]);
    });
  }

  test("the VSIX upload fails the job when packaging wrote no VSIX", () => {
    const uploads = steps(extension, "vscode-extension").filter((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(uploads.map((step) => step.with?.["if-no-files-found"])).toEqual(["error"]);
  });
});

describe("ci.yml lint-and-build", () => {
  test("installs the extension's packages for knip from the npm cache, on Node 24", () => {
    const job = steps(read("ci.yml"), "lint-and-build");
    const install = job.findIndex(
      (step) => step.run === "npm ci --ignore-scripts" && step["working-directory"] === "vscode-extension",
    );
    const setupNode = job.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(install).toBeGreaterThan(-1);
    expect(setupNode).toBeGreaterThan(-1);
    expect(setupNode).toBeLessThan(install);
    expect(job[setupNode]?.with).toEqual({
      "node-version": "24",
      cache: "npm",
      "cache-dependency-path": "vscode-extension/package-lock.json",
    });
  });
});

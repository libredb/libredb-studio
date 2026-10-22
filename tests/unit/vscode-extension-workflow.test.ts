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
  env?: Record<string, string>;
}
interface Job {
  steps?: Step[];
  needs?: string | string[];
  uses?: string;
  permissions?: unknown;
  environment?: unknown;
  "timeout-minutes"?: number;
}
interface Workflow {
  on?: Record<string, unknown>;
  permissions?: unknown;
  jobs: Record<string, Job>;
}

const WORKFLOWS = join(import.meta.dir, "../../.github/workflows");
const read = (file: string) => parseYaml(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
const steps = (workflow: Workflow, job: string) => workflow.jobs[job]?.steps ?? [];
const extension = read("vscode-extension.yml");
const daily = read("vscode-extension-insiders.yml");
const RELEASE_FILE = "vscode-extension-release.yml";

describe("vscode-extension.yml", () => {
  for (const job of ["vscode-extension", "vscode-extension-smoke"]) {
    test(`${job} caches the pinned VS Code builds and not the e2e leg's profile`, () => {
      const caches = steps(extension, job).filter((step) => step.uses?.startsWith("actions/cache@"));
      expect(caches.map((step) => step.with?.path)).toEqual(["vscode-extension/.vscode-test/vscode-*"]);
    });
  }

  test("the VSIX and source map uploads fail the job when packaging wrote no file", () => {
    const uploads = steps(extension, "vscode-extension").filter((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(uploads.map((step) => step.with?.["if-no-files-found"])).toEqual(["error", "error"]);
  });

  test("keeps the packaged build's source maps beside the VSIX, so a released build can be symbolicated", () => {
    const job = steps(extension, "vscode-extension");
    const pack = job.findIndex((step) => step.run === "npm run package");
    const maps = job.findIndex(
      (step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === "vscode-extension-sourcemaps",
    );
    expect(maps).toBeGreaterThan(pack);
    expect(job[maps]?.with?.path).toBe("vscode-extension/dist/*.js.map");
  });

  test("installs the packed VSIX into a real VS Code after packaging it and before the upload", () => {
    const job = steps(extension, "vscode-extension");
    const pack = job.findIndex((step) => step.run === "npm run package");
    const install = job.findIndex((step) => step.run === "npm run test:vsix");
    const upload = job.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(pack).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(pack);
    expect(upload).toBeGreaterThan(install);
  });
});

describe("the coexistence leg", () => {
  // It downloads ms-mssql.mssql from the Marketplace, so it stays out of the pull request job (PR 14 decision 3).
  const subsetOf = (step: Step) => step.env?.LIBREDB_E2E_SUBSET;

  test("never runs in the pull request job", () => {
    for (const job of Object.keys(extension.jobs)) {
      const subsets = steps(extension, job).map(subsetOf);
      expect(subsets).not.toContain("coexistence");
    }
  });

  test("runs daily and on manual dispatch, on the pinned builds, in a job of its own", () => {
    expect(Object.keys(daily.on ?? {}).sort()).toEqual(["schedule", "workflow_dispatch"]);
    const job = steps(daily, "coexistence");
    const leg = job.filter((step) => subsetOf(step) === "coexistence");
    expect(leg.map((step) => step.run)).toEqual(["xvfb-run -a npm run test:e2e"]);
    expect(leg[0]?.env?.LIBREDB_VSCODE_VERSION).toBeUndefined();
    const caches = job.filter((step) => step.uses?.startsWith("actions/cache@"));
    expect(caches.map((step) => step.with?.path)).toEqual(["vscode-extension/.vscode-test/vscode-*"]);
  });
});

describe("vscode-extension-release.yml", () => {
  const release = () => read(RELEASE_FILE);
  const allSteps = (workflow: Workflow) => Object.keys(workflow.jobs).flatMap((job) => steps(workflow, job));

  test("runs on a pushed vscode-extension-* tag only: no release event, no dispatch, no branch push", () => {
    expect(release().on).toEqual({ push: { tags: ["vscode-extension-*"] } });
  });

  test("reads the repository, and only publish widens that, by the OIDC token alone", () => {
    const workflow = release();
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job.permissions).toEqual(name === "publish" ? { contents: "read", "id-token": "write" } : undefined);
    }
  });

  test("verify refuses a tag that does not name the manifest's version or a commit off main", () => {
    const job = steps(release(), "verify");
    const checkout = job.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout).toBeGreaterThan(-1);
    expect(job[checkout]?.with?.["fetch-depth"]).toBe(0);
    const tag = job.findIndex((step) => step.run?.trim() === 'node scripts/release-tag.mjs "$GITHUB_REF_NAME"');
    expect(tag).toBeGreaterThan(checkout);
    expect(job[tag]?.["working-directory"]).toBe("vscode-extension");
    const onMain = job.findIndex((step) =>
      step.run?.includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main'),
    );
    expect(onMain).toBeGreaterThan(checkout);
    expect(job[onMain]?.run).toContain("git fetch origin main");
    expect(job[onMain]?.run).toContain("The tag's commit is not on main.");
  });

  test("gates run the same reusable workflow as every pull request, after verify", () => {
    const gates = release().jobs.gates;
    expect(gates?.needs).toBe("verify");
    expect(gates?.uses).toBe("./.github/workflows/vscode-extension.yml");
  });

  test("pins every action by its full commit SHA, one the other workflows already use", () => {
    for (const step of allSteps(release())) {
      if (step.uses) expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
    const pinned = (workflow: Workflow) =>
      new Set(allSteps(workflow).flatMap((step) => (step.uses ? [step.uses] : [])));
    const ours = new Set([...pinned(extension), ...pinned(read("ci.yml"))]);
    for (const uses of pinned(release())) expect(ours.has(uses)).toBe(true);
  });

  test("publish uploads the VSIX the gates tested, from an environment that requires a reviewer", () => {
    const publish = release().jobs.publish;
    expect(publish?.needs).toBe("gates");
    expect(publish?.environment).toBe("vscode-marketplace");
    const job = steps(release(), "publish");
    const download = job.findIndex((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(job[download]?.with).toEqual({ name: "vscode-extension-vsix", path: "vscode-extension/dist-vsix" });
    const install = job.findIndex(
      (step) => step.run === "npm ci --ignore-scripts" && step["working-directory"] === "vscode-extension",
    );
    const upload = job.findIndex((step) => step.run === "npm run publish:marketplace");
    expect(install).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(Math.max(download, install));
    expect(job[upload]?.["working-directory"]).toBe("vscode-extension");
    expect(job.some((step) => step.run?.includes("npm run package") || step.run?.includes("npm run build"))).toBe(
      false,
    );
  });

  test("publishes to the Marketplace only: no Open VSX, no GitHub Release, no stored Marketplace token", () => {
    const text = readFileSync(join(WORKFLOWS, RELEASE_FILE), "utf8");
    for (const step of allSteps(release())) {
      const command = `${step.run ?? ""} ${step.uses ?? ""}`;
      expect(command).not.toMatch(/vsce\s+publish|ovsx|gh\s+release/);
      expect(step.uses?.split("@")[0] ?? "").not.toContain("release");
    }
    expect(text).not.toMatch(/secrets\.|VSCE_PAT|VSCE_TOKEN|OVSX_PAT/);
    for (const [name, job] of Object.entries(release().jobs)) {
      if (name !== "publish") expect(job.environment).toBeUndefined();
    }
  });

  test("the product's tag patterns never match the extension's tags", () => {
    // GitHub's filter pattern syntax, as release-artifacts.yml uses it: a class, `+` after it, `*`, and literals.
    const fromGlob = (glob: string) =>
      new RegExp(
        `^${glob.replace(/\[[^\]]+\]\+?|\*|[.+?^${}()|\\]/g, (token) =>
          token.startsWith("[") ? token : token === "*" ? "[^/]*" : `\\${token}`,
        )}$`,
      );
    const product = read("release-artifacts.yml").on?.push as { tags: string[] };
    expect(product.tags.length).toBeGreaterThan(0);
    for (const pattern of product.tags) {
      expect(fromGlob(pattern).test("0.18.4")).toBe(!pattern.endsWith("-*"));
      expect(fromGlob(pattern).test("vscode-extension-0.1.0")).toBe(false);
    }
    const npm = readFileSync(join(WORKFLOWS, "npm-publish.yml"), "utf8");
    expect(npm).toContain("!startsWith(github.event.release.tag_name, 'libredb-studio-')");
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

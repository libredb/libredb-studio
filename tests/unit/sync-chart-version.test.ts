/**
 * Unit tests for the chart version sync guard
 * (scripts/sync-chart-version.mjs, issues #138/#151). The core functions
 * (parseChart, bumpPatch, checkSync, applyBump, tagQueryNeeded) are pure
 * string checks. The CLI describe blocks run the real script as a subprocess
 * against throwaway temp-dir fixtures; the #151 block additionally builds
 * hermetic local git fixtures for the base-comparison paths - no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyBump,
  bumpPatch,
  checkChangesAnnotation,
  checkSync,
  parseChart,
  parseImageTag,
  parseReadmeVersion,
  tagQueryNeeded,
} from "../../scripts/sync-chart-version.mjs";

function chartYaml({
  version = "0.1.3",
  appVersion = "0.9.44",
  imageTag = appVersion,
}: {
  version?: string;
  appVersion?: string;
  imageTag?: string;
} = {}): string {
  return `apiVersion: v2
name: libredb-studio
description: Web-based SQL IDE for cloud-native teams
type: application
version: ${version}
appVersion: "${appVersion}"
kubeVersion: ">=1.26.0-0"
annotations:
  artifacthub.io/images: |
    - name: libredb-studio
      image: ghcr.io/libredb/libredb-studio:${imageTag}
      platforms:
        - linux/amd64
  artifacthub.io/changes: |
    - "Track app release ${appVersion} (appVersion bump; default image tag follows)"
dependencies:
  - name: postgresql
    version: "16.x.x"
`;
}

function readme(version = "0.1.3"): string {
  return `# libredb-studio chart

\`\`\`bash
helm install libredb oci://ghcr.io/libredb/charts/libredb-studio \\
  --version ${version} \\
  --set secrets.jwtSecret=$(openssl rand -base64 32)
\`\`\`
`;
}

describe("parseChart", () => {
  test("parses version and quoted appVersion", () => {
    expect(parseChart(chartYaml())).toEqual({ version: "0.1.3", appVersion: "0.9.44" });
  });

  test("throws when version is missing", () => {
    expect(() => parseChart("apiVersion: v2\nname: x\n")).toThrow(/version/);
  });
});

describe("bumpPatch", () => {
  test("bumps the patch segment", () => {
    expect(bumpPatch("0.1.3")).toBe("0.1.4");
  });

  test("throws on a prerelease version", () => {
    expect(() => bumpPatch("0.1.3-rc.1")).toThrow(/patch-bump/);
  });
});

describe("parseImageTag", () => {
  test("returns the tag when duplicated image lines agree", () => {
    const dup = `${chartYaml()}      image: ghcr.io/libredb/libredb-studio:0.9.44\n`;
    expect(parseImageTag(dup)).toBe("0.9.44");
  });

  test("throws when duplicated image lines disagree instead of silently using the first (#151)", () => {
    const dup = `${chartYaml()}      image: ghcr.io/libredb/libredb-studio:0.9.43\n`;
    expect(() => parseImageTag(dup)).toThrow(/disagree/);
  });
});

describe("parseReadmeVersion", () => {
  test("returns the version when duplicated --version examples agree", () => {
    const dup = `${readme()}helm upgrade libredb libredb/libredb-studio --version 0.1.3\n`;
    expect(parseReadmeVersion(dup)).toBe("0.1.3");
  });

  test("throws when duplicated --version examples disagree instead of silently using the first (#151)", () => {
    const dup = `${readme()}helm upgrade libredb libredb/libredb-studio --version 0.1.2\n`;
    expect(() => parseReadmeVersion(dup)).toThrow(/disagree/);
  });
});

describe("checkChangesAnnotation", () => {
  // ArtifactHub refuses to index a chart version whose artifacthub.io/changes
  // entries contain any of {}:[],&*#?|-<>=!%@ unquoted - released 0.1.1 and
  // 0.1.9-0.1.11 are missing from the AH listing for exactly this reason.
  test("quoted entries are clean", () => {
    expect(checkChangesAnnotation(chartYaml())).toEqual([]);
  });

  test("an unquoted entry is a violation naming the offending line", () => {
    const unquoted = chartYaml().replace(
      /- "Track app release .*/,
      "- Default install is now zero-config: no values needed",
    );
    const violations = checkChangesAnnotation(unquoted);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("artifacthub.io/changes");
    expect(violations[0]).toContain("zero-config");
  });

  test("a half-quoted entry is a violation", () => {
    const half = chartYaml().replace(/- "Track app release .*/, '- "Unterminated quote entry');
    expect(checkChangesAnnotation(half).length).toBe(1);
  });

  test("a chart without a changes annotation is clean", () => {
    const noChanges = chartYaml().replace(/  artifacthub\.io\/changes: \|\n(?: {4}.*\n)*/, "");
    expect(noChanges).not.toContain("artifacthub.io/changes");
    expect(checkChangesAnnotation(noChanges)).toEqual([]);
  });

  test("CRLF line endings do not blind the check", () => {
    const crlfClean = chartYaml().replace(/\n/g, "\r\n");
    expect(checkChangesAnnotation(crlfClean)).toEqual([]);
    const crlfUnquoted = chartYaml()
      .replace(/- "Track app release .*/, "- Default install is now zero-config: no values needed")
      .replace(/\n/g, "\r\n");
    expect(checkChangesAnnotation(crlfUnquoted).length).toBe(1);
  });

  test("a reindented changes block is still checked", () => {
    const reindented = [
      "apiVersion: v2",
      "name: libredb-studio",
      "version: 0.1.3",
      'appVersion: "0.9.44"',
      "annotations:",
      "    artifacthub.io/changes: |",
      '        - "Quoted entry"',
      "        - Unquoted entry with a dash - flagged",
      "dependencies: []",
      "",
    ].join("\n");
    const violations = checkChangesAnnotation(reindented);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("Unquoted entry");
  });

  test("a changes key whose block cannot be parsed fails loudly instead of passing silently", () => {
    // The guard's failure mode must never be silence: an inline (non-block)
    // changes value means the extraction no longer understands the file.
    const inline = chartYaml().replace(
      /  artifacthub\.io\/changes: \|\n(?: {4}.*\n)*/,
      "  artifacthub.io/changes: '[\"entry\"]'\n",
    );
    const violations = checkChangesAnnotation(inline);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("could not be parsed");
  });

  test("a multi-line folded entry is flagged once (house style: single-line quoted entries)", () => {
    const continued = chartYaml().replace(
      /- "Track app release .*/,
      '- "A quoted entry\n      that folds onto a second line"',
    );
    const violations = checkChangesAnnotation(continued);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("A quoted entry");
  });

  test("checkSync surfaces changes-annotation violations", () => {
    const unquoted = chartYaml().replace(
      /- "Track app release .*/,
      "- Refuse zero-config installs with replicaCount > 1",
    );
    const violations = checkSync({ pkgVersion: "0.9.44", chartYaml: unquoted, readme: readme() });
    expect(violations.some((v) => v.includes("artifacthub.io/changes"))).toBe(true);
  });
});

describe("checkSync", () => {
  test("in-sync tree produces no violations", () => {
    expect(checkSync({ pkgVersion: "0.9.44", chartYaml: chartYaml(), readme: readme() })).toEqual([]);
  });

  test("appVersion behind package.json is a violation", () => {
    const violations = checkSync({ pkgVersion: "0.9.45", chartYaml: chartYaml(), readme: readme() });
    expect(violations.some((v) => v.includes("appVersion") && v.includes("0.9.45"))).toBe(true);
  });

  test("appVersion ahead of package.json is a violation", () => {
    const violations = checkSync({ pkgVersion: "0.9.43", chartYaml: chartYaml(), readme: readme() });
    expect(violations.length).toBeGreaterThan(0);
  });

  test("artifacthub image tag drift is a violation", () => {
    const violations = checkSync({
      pkgVersion: "0.9.44",
      chartYaml: chartYaml({ imageTag: "0.9.43" }),
      readme: readme(),
    });
    expect(violations.some((v) => v.includes("artifacthub.io/images"))).toBe(true);
  });

  test("README --version drift is a violation", () => {
    const violations = checkSync({ pkgVersion: "0.9.44", chartYaml: chartYaml(), readme: readme("0.1.2") });
    expect(violations.some((v) => v.includes("README"))).toBe(true);
  });

  test("appVersion changed without a chart version bump is a violation", () => {
    const violations = checkSync({
      pkgVersion: "0.9.45",
      chartYaml: chartYaml({ version: "0.1.3", appVersion: "0.9.45" }),
      readme: readme("0.1.3"),
      baseChart: { version: "0.1.3", appVersion: "0.9.44" },
    });
    expect(violations.some((v) => v.includes("chart-releaser"))).toBe(true);
  });

  test("reusing an already-released chart version is a violation", () => {
    const violations = checkSync({
      pkgVersion: "0.9.45",
      chartYaml: chartYaml({ version: "0.1.2", appVersion: "0.9.45" }),
      readme: readme("0.1.2"),
      baseChart: { version: "0.1.3", appVersion: "0.9.44" },
      chartTagExists: true,
    });
    expect(violations.some((v) => v.includes("already released"))).toBe(true);
  });

  test("unknown tag state (offline) skips the released-version check", () => {
    const violations = checkSync({
      pkgVersion: "0.9.45",
      chartYaml: chartYaml({ version: "0.1.4", appVersion: "0.9.45" }),
      readme: readme("0.1.4"),
      baseChart: { version: "0.1.3", appVersion: "0.9.44" },
      chartTagExists: null,
    });
    expect(violations).toEqual([]);
  });
});

describe("tagQueryNeeded", () => {
  test("false without a base chart", () => {
    expect(tagQueryNeeded({ baseChart: null, version: "0.1.4", appVersion: "0.9.45" })).toBe(false);
  });

  test("false when appVersion is unchanged from the base", () => {
    const baseChart = { version: "0.1.3", appVersion: "0.9.44" };
    expect(tagQueryNeeded({ baseChart, version: "0.1.4", appVersion: "0.9.44" })).toBe(false);
  });

  test("false when appVersion changed but the chart version still equals the base's", () => {
    const baseChart = { version: "0.1.3", appVersion: "0.9.44" };
    expect(tagQueryNeeded({ baseChart, version: "0.1.3", appVersion: "0.9.45" })).toBe(false);
  });

  test("true when appVersion changed and the chart version moved off the base's", () => {
    const baseChart = { version: "0.1.3", appVersion: "0.9.44" };
    expect(tagQueryNeeded({ baseChart, version: "0.1.4", appVersion: "0.9.45" })).toBe(true);
  });
});

describe("applyBump", () => {
  test("round-trip: a behind tree becomes check-clean", () => {
    const result = applyBump({ pkgVersion: "0.9.45", chartYaml: chartYaml(), readme: readme() });
    expect(result.changed).toBe(true);
    expect(result.version).toBe("0.1.4");
    expect(result.appVersion).toBe("0.9.45");
    expect(result.chartYaml).toContain('appVersion: "0.9.45"');
    expect(result.chartYaml).toContain("image: ghcr.io/libredb/libredb-studio:0.9.45");
    expect(result.chartYaml).toContain('- "Track app release 0.9.45 (appVersion bump; default image tag follows)"');
    expect(result.readme).toContain("--version 0.1.4");
    expect(checkSync({ pkgVersion: "0.9.45", chartYaml: result.chartYaml, readme: result.readme })).toEqual([]);
  });

  test("in-sync tree is untouched (idempotent)", () => {
    const result = applyBump({ pkgVersion: "0.9.44", chartYaml: chartYaml(), readme: readme() });
    expect(result.changed).toBe(false);
    expect(result.chartYaml).toBe(chartYaml());
    expect(result.readme).toBe(readme());
  });

  test("hand-written changes line is preserved when only the image tag drifted", () => {
    const custom = chartYaml({ imageTag: "0.9.43" }).replace(
      /- "Track app release .*/,
      '- "Hand-written chart-only changelog entry"',
    );
    const result = applyBump({ pkgVersion: "0.9.44", chartYaml: custom, readme: readme() });
    expect(result.changed).toBe(true);
    expect(result.chartYaml).toContain("image: ghcr.io/libredb/libredb-studio:0.9.44");
    expect(result.chartYaml).toContain('- "Hand-written chart-only changelog entry"');
  });

  test("rewrites a legacy unquoted Track line into the quoted form", () => {
    const legacy = chartYaml().replace(
      /- "Track app release .*/,
      "- Track app release 0.9.44 (appVersion bump; default image tag follows)",
    );
    const result = applyBump({ pkgVersion: "0.9.45", chartYaml: legacy, readme: readme() });
    expect(result.chartYaml).toContain('- "Track app release 0.9.45 (appVersion bump; default image tag follows)"');
    expect(result.chartYaml).not.toContain("\n    - Track app release");
  });

  test("rewrites every duplicated image line and --version example, not just the first (#151)", () => {
    const dupChart = `${chartYaml()}      image: ghcr.io/libredb/libredb-studio:0.9.44\n`;
    const dupReadme = `${readme()}helm upgrade libredb libredb/libredb-studio --version 0.1.3\n`;
    const result = applyBump({ pkgVersion: "0.9.45", chartYaml: dupChart, readme: dupReadme });
    expect(result.changed).toBe(true);
    expect([...result.chartYaml.matchAll(/libredb-studio:0\.9\.45/g)].length).toBe(2);
    expect(result.chartYaml).not.toContain("libredb-studio:0.9.44");
    expect([...result.readme.matchAll(/--version 0\.1\.4/g)].length).toBe(2);
    expect(result.readme).not.toContain("--version 0.1.3");
  });
});

const SCRIPT = join(import.meta.dir, "../../scripts/sync-chart-version.mjs");

function writeTree(root: string, pkgVersion: string, chart: string, readmeText: string): void {
  mkdirSync(join(root, "charts/libredb-studio"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: pkgVersion }));
  writeFileSync(join(root, "charts/libredb-studio/Chart.yaml"), chart);
  writeFileSync(join(root, "charts/libredb-studio/README.md"), readmeText);
}

function runCheck(root: string, env: Record<string, string> = {}) {
  return Bun.spawnSync(["node", SCRIPT, "--check", "--root", root], {
    env: { ...process.env, CHART_SYNC_STRICT: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("CLI (--check via subprocess)", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeFixture(pkgVersion: string, chart: string, readmeText: string): string {
    const root = mkdtempSync(join(tmpdir(), "chart-sync-"));
    fixtureRoots.push(root);
    writeTree(root, pkgVersion, chart, readmeText);
    return root;
  }

  test("in-sync fixture passes without git (warn + skip base checks)", () => {
    const root = makeFixture("0.9.44", chartYaml(), readme());
    const result = runCheck(root);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("base-comparison checks skipped");
  });

  test("violation exits 1 with the chart:bump hint", () => {
    const root = makeFixture("0.9.99", chartYaml(), readme());
    const result = runCheck(root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("bun run chart:bump");
  });

  test("strict mode fails when origin/main is not resolvable", () => {
    const root = makeFixture("0.9.44", chartYaml(), readme());
    const result = runCheck(root, { CHART_SYNC_STRICT: "1" });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("CHART_SYNC_STRICT");
    // #151: the missing-ref message is distinct from the unparseable-Chart.yaml one
    expect(stderr).toContain("origin/main not resolvable");
    expect(stderr).not.toContain("unparseable");
  });

  test("strict early-exit still reports content violations first (#151)", () => {
    const root = makeFixture("0.9.99", chartYaml(), readme());
    const result = runCheck(root, { CHART_SYNC_STRICT: "1" });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("appVersion '0.9.44' does not equal package.json version '0.9.99'");
    expect(stderr).toContain("CHART_SYNC_STRICT");
  });

  test("--check and --write together exits 2 with usage", () => {
    const root = makeFixture("0.9.44", chartYaml(), readme());
    const result = Bun.spawnSync(["node", SCRIPT, "--check", "--write", "--root", root], {
      env: { ...process.env, CHART_SYNC_STRICT: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("Usage:");
  });

  test("--root with no value exits 2 with the --root error", () => {
    const result = Bun.spawnSync(["node", SCRIPT, "--check", "--root"], {
      env: { ...process.env, CHART_SYNC_STRICT: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("--root requires");
  });
});

describe("CLI (--check against git fixtures, #151)", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    fixtureRoots.push(dir);
    return dir;
  }

  // Hermetic git: no user/system config, fixed identity, so fixtures behave the same on any box.
  function runGit(cwd: string, ...args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@test",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@test",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
    }
    return result.stdout.toString().trim();
  }

  test("stale branch passes --check after a released chart bump merged to origin/main (merge-base comparison)", () => {
    // Upstream: base commit (chart 0.1.3, released as tag libredb-studio-0.1.3), then a
    // release bump to 0.1.4/0.9.45 merged to main.
    const upstream = makeDir("chart-sync-upstream-");
    runGit(upstream, "init", "-q", "-b", "main");
    writeTree(upstream, "0.9.44", chartYaml(), readme());
    runGit(upstream, "add", "-A");
    runGit(upstream, "commit", "-q", "-m", "base");
    const baseSha = runGit(upstream, "rev-parse", "HEAD");
    runGit(upstream, "tag", "libredb-studio-0.1.3", baseSha);
    writeTree(upstream, "0.9.45", chartYaml({ version: "0.1.4", appVersion: "0.9.45" }), readme("0.1.4"));
    runGit(upstream, "add", "-A");
    runGit(upstream, "commit", "-q", "-m", "release 0.9.45");

    // A clone whose feature branch still sits at the pre-release base commit: its tree is
    // fully in sync, and it changed nothing chart-related. Comparing against the origin/main
    // TIP sees appVersion 0.9.45 vs 0.9.44 and flags chart 0.1.3 as already released; the
    // merge-base sees the branch point (identical chart) and stays quiet.
    const root = makeDir("chart-sync-");
    runGit(root, "clone", "-q", upstream, ".");
    runGit(root, "checkout", "-q", "-b", "stale", baseSha);

    const result = runCheck(root);
    expect(result.stderr.toString()).not.toContain("already released");
    expect(result.exitCode).toBe(0);
  });

  test("strict mode reports an unparseable base Chart.yaml distinctly from a missing origin/main", () => {
    const root = makeDir("chart-sync-");
    writeTree(root, "0.9.44", "apiVersion: v2\nname: libredb-studio\n", readme());
    runGit(root, "init", "-q", "-b", "main");
    runGit(root, "add", "-A");
    runGit(root, "commit", "-q", "-m", "unparseable chart");
    runGit(root, "update-ref", "refs/remotes/origin/main", runGit(root, "rev-parse", "HEAD"));
    // Working tree is valid; only the committed base (the merge-base) is unparseable.
    writeFileSync(join(root, "charts/libredb-studio/Chart.yaml"), chartYaml());

    const result = runCheck(root, { CHART_SYNC_STRICT: "1" });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("unparseable");
    expect(stderr).toContain("CHART_SYNC_STRICT");
    expect(stderr).not.toContain("not resolvable");
  });

  test("falls back to the origin/main tip when no merge-base is computable (shallow CI checkout)", () => {
    // ci.yml checks out the PR merge ref at depth 1 and fetches main with --depth=1: HEAD
    // and origin/main are grafted roots with no common ancestor, so `git merge-base` fails
    // while `git show origin/main:...` still works. Strict mode must fall back to the tip
    // comparison there, not hard-fail. Emulated via two unrelated root commits.
    const root = makeDir("chart-sync-");
    writeTree(root, "0.9.44", chartYaml(), readme());
    runGit(root, "init", "-q", "-b", "main");
    runGit(root, "add", "-A");
    runGit(root, "commit", "-q", "-m", "head");
    runGit(root, "checkout", "-q", "--orphan", "unrelated-main");
    runGit(root, "commit", "-q", "-m", "main tip with no shared history");
    runGit(root, "update-ref", "refs/remotes/origin/main", runGit(root, "rev-parse", "HEAD"));
    runGit(root, "checkout", "-q", "main");
    // Fixture self-check: the merge-base genuinely does not exist, the tip ref does.
    expect(() => runGit(root, "merge-base", "HEAD", "origin/main")).toThrow();
    expect(runGit(root, "show", "origin/main:charts/libredb-studio/Chart.yaml")).toContain("appVersion");

    const result = runCheck(root, { CHART_SYNC_STRICT: "1" });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("strict mode fails when the released-version tag query is needed but origin is unreachable", () => {
    // Pinning test (expected green from the start): the strict tag-query-null path exists
    // today but had no automated coverage. origin/main resolves locally; the remote does not.
    const root = makeDir("chart-sync-");
    writeTree(root, "0.9.44", chartYaml(), readme());
    runGit(root, "init", "-q", "-b", "main");
    runGit(root, "add", "-A");
    runGit(root, "commit", "-q", "-m", "base");
    runGit(root, "update-ref", "refs/remotes/origin/main", runGit(root, "rev-parse", "HEAD"));
    runGit(root, "remote", "add", "origin", join(root, "no-such-remote.git"));
    // Uncommitted release bump: appVersion and chart version both moved off the base,
    // so the released-version check needs the (unreachable) origin tag list.
    writeTree(root, "0.9.45", chartYaml({ version: "0.1.4", appVersion: "0.9.45" }), readme("0.1.4"));

    const result = runCheck(root, { CHART_SYNC_STRICT: "1" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("could not query origin tags");
  });
});

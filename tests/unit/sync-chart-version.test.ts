/**
 * Unit tests for the chart version sync guard
 * (scripts/sync-chart-version.mjs, issue #138). Pure string checks - no git,
 * no network, no filesystem writes.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBump, bumpPatch, checkSync, parseChart } from "../../scripts/sync-chart-version.mjs";

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
    - Track app release ${appVersion} (appVersion bump; default image tag follows)
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

describe("applyBump", () => {
  test("round-trip: a behind tree becomes check-clean", () => {
    const result = applyBump({ pkgVersion: "0.9.45", chartYaml: chartYaml(), readme: readme() });
    expect(result.changed).toBe(true);
    expect(result.version).toBe("0.1.4");
    expect(result.appVersion).toBe("0.9.45");
    expect(result.chartYaml).toContain('appVersion: "0.9.45"');
    expect(result.chartYaml).toContain("image: ghcr.io/libredb/libredb-studio:0.9.45");
    expect(result.chartYaml).toContain("- Track app release 0.9.45 (appVersion bump; default image tag follows)");
    expect(result.readme).toContain("--version 0.1.4");
    expect(checkSync({ pkgVersion: "0.9.45", chartYaml: result.chartYaml, readme: result.readme })).toEqual([]);
  });

  test("in-sync tree is untouched (idempotent)", () => {
    const result = applyBump({ pkgVersion: "0.9.44", chartYaml: chartYaml(), readme: readme() });
    expect(result.changed).toBe(false);
    expect(result.chartYaml).toBe(chartYaml());
    expect(result.readme).toBe(readme());
  });
});

describe("CLI (--check via subprocess)", () => {
  const SCRIPT = join(import.meta.dir, "../../scripts/sync-chart-version.mjs");

  function makeFixture(pkgVersion: string, chart: string, readmeText: string): string {
    const root = mkdtempSync(join(tmpdir(), "chart-sync-"));
    mkdirSync(join(root, "charts/libredb-studio"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: pkgVersion }));
    writeFileSync(join(root, "charts/libredb-studio/Chart.yaml"), chart);
    writeFileSync(join(root, "charts/libredb-studio/README.md"), readmeText);
    return root;
  }

  function runCheck(root: string, env: Record<string, string> = {}) {
    return Bun.spawnSync(["node", SCRIPT, "--check", "--root", root], {
      env: { ...process.env, CHART_SYNC_STRICT: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("in-sync fixture passes without git (warn + skip base checks)", () => {
    const root = makeFixture("0.9.44", chartYaml(), readme());
    const result = runCheck(root);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("base-comparison checks skipped");
    rmSync(root, { recursive: true, force: true });
  });

  test("violation exits 1 with the chart:bump hint", () => {
    const root = makeFixture("0.9.99", chartYaml(), readme());
    const result = runCheck(root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("bun run chart:bump");
    rmSync(root, { recursive: true, force: true });
  });

  test("strict mode fails when origin/main is not resolvable", () => {
    const root = makeFixture("0.9.44", chartYaml(), readme());
    const result = runCheck(root, { CHART_SYNC_STRICT: "1" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("CHART_SYNC_STRICT");
    rmSync(root, { recursive: true, force: true });
  });
});

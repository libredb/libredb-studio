#!/usr/bin/env node
/**
 * Chart version sync guard (issue #138).
 *
 * Enforces the invariant that the Helm chart always deploys the app version
 * in package.json: appVersion == package.json version, the artifacthub image
 * tag matches appVersion, and the chart README example matches the chart
 * version. `--check` (bun run chart:check) validates and is wired into the
 * required lint-and-build CI job; `--write` (bun run chart:bump) applies the
 * canonical bump. Both modes share the pure functions below, which are unit
 * tested in tests/unit/sync-chart-version.test.ts.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHART_YAML = "charts/libredb-studio/Chart.yaml";
const CHART_README = "charts/libredb-studio/README.md";

export function parseChart(chartYaml) {
  const version = chartYaml.match(/^version:\s*(\S+)\s*$/m)?.[1];
  const appVersion = chartYaml.match(/^appVersion:\s*"?([^"\s]+)"?\s*$/m)?.[1];
  if (!version || !appVersion) {
    throw new Error(`${CHART_YAML}: could not parse version/appVersion`);
  }
  return { version, appVersion };
}

export function parseImageTag(chartYaml) {
  const tag = chartYaml.match(/image:\s*ghcr\.io\/libredb\/libredb-studio:(\S+)/)?.[1];
  if (!tag) {
    throw new Error(`${CHART_YAML}: could not find the artifacthub.io/images image tag`);
  }
  return tag;
}

export function parseReadmeVersion(readme) {
  const version = readme.match(/--version\s+(\S+)/)?.[1];
  if (!version) {
    throw new Error(`${CHART_README}: could not find a --version example`);
  }
  return version;
}

export function bumpPatch(version) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) {
    throw new Error(`cannot patch-bump non-x.y.z chart version '${version}' - bump it by hand`);
  }
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/**
 * Returns violation messages (empty = in sync). baseChart is main's parsed
 * Chart.yaml or null when unavailable; chartTagExists is true/false, or null
 * when origin tags could not be queried (check skipped, CLI prints a warning).
 *
 * @param {{
 *   pkgVersion: string,
 *   chartYaml: string,
 *   readme: string,
 *   baseChart?: { version: string, appVersion: string } | null,
 *   chartTagExists?: boolean | null,
 * }} input
 * @returns {string[]}
 */
export function checkSync({ pkgVersion, chartYaml, readme, baseChart = null, chartTagExists = null }) {
  const violations = [];
  const { version, appVersion } = parseChart(chartYaml);
  if (appVersion !== pkgVersion) {
    violations.push(`${CHART_YAML}: appVersion '${appVersion}' does not equal package.json version '${pkgVersion}'`);
  }
  const imageTag = parseImageTag(chartYaml);
  if (imageTag !== appVersion) {
    violations.push(`${CHART_YAML}: artifacthub.io/images tag '${imageTag}' does not equal appVersion '${appVersion}'`);
  }
  const readmeVersion = parseReadmeVersion(readme);
  if (readmeVersion !== version) {
    violations.push(`${CHART_README}: --version example '${readmeVersion}' does not equal chart version '${version}'`);
  }
  if (baseChart && baseChart.appVersion !== appVersion) {
    if (baseChart.version === version) {
      violations.push(
        `${CHART_YAML}: appVersion changed (${baseChart.appVersion} -> ${appVersion}) but chart version is still ` +
          `'${version}' - chart-releaser (skip_existing) would silently publish nothing`,
      );
    } else if (chartTagExists === true) {
      violations.push(
        `${CHART_YAML}: chart version '${version}' is already released (tag libredb-studio-${version} exists) - ` +
          `bump to an unreleased version`,
      );
    }
  }
  return violations;
}

/** Applies the canonical bump; returns changed=false (inputs untouched) when already in sync. */
export function applyBump({ pkgVersion, chartYaml, readme }) {
  const { version, appVersion } = parseChart(chartYaml);
  const inSync =
    appVersion === pkgVersion && parseImageTag(chartYaml) === pkgVersion && parseReadmeVersion(readme) === version;
  if (inSync) {
    return { chartYaml, readme, changed: false, version, appVersion };
  }
  const newVersion = appVersion === pkgVersion ? version : bumpPatch(version);
  let newChartYaml = chartYaml
    .replace(/^version:\s*\S+\s*$/m, `version: ${newVersion}`)
    .replace(/^appVersion:\s*.*$/m, `appVersion: "${pkgVersion}"`)
    .replace(/(image:\s*ghcr\.io\/libredb\/libredb-studio:)\S+/, `$1${pkgVersion}`);
  if (appVersion !== pkgVersion) {
    newChartYaml = newChartYaml.replace(
      /- Track app release .*/,
      `- Track app release ${pkgVersion} (appVersion bump; default image tag follows)`,
    );
  }
  const newReadme = readme.replace(/--version\s+\S+/, `--version ${newVersion}`);
  return { chartYaml: newChartYaml, readme: newReadme, changed: true, version: newVersion, appVersion: pkgVersion };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** main's Chart.yaml, or null when origin/main is not resolvable (shallow local clone). */
function readBaseChart(root) {
  try {
    return parseChart(git(root, ["show", `origin/main:${CHART_YAML}`]));
  } catch {
    return null;
  }
}

/** true/false from origin, or null (skip + warn) when the remote is unreachable. */
function chartTagExistsOnOrigin(root, version) {
  try {
    return git(root, ["ls-remote", "--tags", "origin", `refs/tags/libredb-studio-${version}`]) !== "";
  } catch {
    console.warn("WARN: could not query origin tags (offline?) - skipping the released-version check");
    return null;
  }
}

function main(argv) {
  const hasCheck = argv.includes("--check");
  const hasWrite = argv.includes("--write");
  if (hasCheck === hasWrite) {
    console.error("Usage: node scripts/sync-chart-version.mjs --check|--write [--root <dir>]");
    process.exit(2);
  }
  const mode = hasWrite ? "write" : "check";
  const rootIdx = argv.indexOf("--root");
  const rootArg = rootIdx === -1 ? undefined : argv[rootIdx + 1];
  if (rootIdx !== -1 && (rootArg === undefined || rootArg.startsWith("--"))) {
    console.error("ERROR: --root requires a directory path");
    process.exit(2);
  }
  const root = rootIdx === -1 ? process.cwd() : path.resolve(rootArg);
  const strict = /^(1|true)$/i.test(process.env.CHART_SYNC_STRICT ?? "");

  const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const chartPath = path.join(root, CHART_YAML);
  const readmePath = path.join(root, CHART_README);
  const chartYaml = fs.readFileSync(chartPath, "utf8");
  const readme = fs.readFileSync(readmePath, "utf8");

  if (mode === "check") {
    const { version, appVersion } = parseChart(chartYaml);
    const baseChart = readBaseChart(root);
    if (!baseChart && strict) {
      console.error(
        "ERROR: origin/main not resolvable and CHART_SYNC_STRICT is set - refusing to skip base-comparison checks",
      );
      process.exit(1);
    }
    let chartTagExists = null;
    const tagQueryNeeded = Boolean(baseChart && baseChart.appVersion !== appVersion && baseChart.version !== version);
    if (tagQueryNeeded) {
      chartTagExists = chartTagExistsOnOrigin(root, version);
      if (chartTagExists === null && strict) {
        console.error(
          "ERROR: could not query origin tags and CHART_SYNC_STRICT is set - refusing to skip the released-version check",
        );
        process.exit(1);
      }
    }
    const violations = checkSync({ pkgVersion, chartYaml, readme, baseChart, chartTagExists });
    if (violations.length > 0) {
      for (const violation of violations) console.error(`ERROR: ${violation}`);
      console.error("\nFix: run 'bun run chart:bump', review the diff, and commit it in this PR.");
      process.exit(1);
    }
    if (!baseChart) {
      console.warn("WARN: origin/main not resolvable - base-comparison checks skipped");
    }
    console.log(`OK: chart ${version} / appVersion ${appVersion} in sync with package.json ${pkgVersion}`);
    return;
  }

  const result = applyBump({ pkgVersion, chartYaml, readme });
  if (!result.changed) {
    console.log(`OK: already in sync (chart ${result.version} / appVersion ${result.appVersion}) - nothing to write`);
    return;
  }
  fs.writeFileSync(chartPath, result.chartYaml);
  fs.writeFileSync(readmePath, result.readme);
  console.log(`Bumped chart to ${result.version} / appVersion ${result.appVersion} - review the diff and commit.`);
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

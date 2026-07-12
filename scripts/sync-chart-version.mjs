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
  const tags = [...chartYaml.matchAll(/^\s*image:\s*ghcr\.io\/libredb\/libredb-studio:(\S+)\s*$/gm)].map((m) => m[1]);
  if (tags.length === 0) {
    throw new Error(`${CHART_YAML}: could not find the artifacthub.io/images image tag`);
  }
  if (new Set(tags).size > 1) {
    throw new Error(`${CHART_YAML}: image tags disagree (${tags.join(", ")}) - they must all match`);
  }
  return tags[0];
}

export function parseReadmeVersion(readme) {
  const versions = [...readme.matchAll(/--version\s+(\S+)/g)].map((m) => m[1]);
  if (versions.length === 0) {
    throw new Error(`${CHART_README}: could not find a --version example`);
  }
  if (new Set(versions).size > 1) {
    throw new Error(`${CHART_README}: --version examples disagree (${versions.join(", ")}) - they must all match`);
  }
  return versions[0];
}

export function bumpPatch(version) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) {
    throw new Error(`cannot patch-bump non-x.y.z chart version '${version}' - bump it by hand`);
  }
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/**
 * ArtifactHub refuses to index a chart version whose artifacthub.io/changes entries
 * contain any of {}:[],&*#?|-<>=!%@ unquoted ("error preparing package ... invalid
 * changes annotation"); released 0.1.1 and 0.1.9-0.1.11 are missing from the AH
 * listing for exactly this reason. House style therefore requires every entry to be
 * a double-quoted plain string, which sidesteps the character list entirely.
 * Continuation lines (deeper indentation) are not entries and are ignored.
 *
 * @param {string} chartYaml
 * @returns {string[]} violation messages (empty = clean or annotation absent)
 */
export function checkChangesAnnotation(chartYaml) {
  const violations = [];
  // Normalize CRLF and guarantee a trailing newline so the block regex sees
  // every line the same way regardless of checkout/editor settings.
  let text = chartYaml.replace(/\r\n/g, "\n");
  if (!text.endsWith("\n")) {
    text += "\n";
  }
  if (!/^[ \t]*artifacthub\.io\/changes:/m.test(text)) {
    return violations;
  }
  // Locate the block scalar independent of the key's indentation: its body is
  // every following line indented deeper than the key (or blank). If the key
  // exists but this extraction fails, the guard must fail LOUDLY - a silent
  // pass here is exactly the failure mode this check exists to prevent.
  const block = text.match(/^([ \t]*)artifacthub\.io\/changes:[ \t]*\|[^\n]*\n((?:\1[ \t]+[^\n]*\n|[ \t]*\n)*)/m);
  if (!block) {
    violations.push(
      `${CHART_YAML}: artifacthub.io/changes exists but its block scalar could not be parsed - ` +
        `use a literal block ("changes: |" with indented entries) or update checkChangesAnnotation`,
    );
    return violations;
  }
  const lines = block[2].split("\n").filter((line) => line.trim() !== "");
  const entryIndent = lines.length > 0 ? lines[0].match(/^[ \t]*/)[0].length : 0;
  for (const raw of lines) {
    if (raw.match(/^[ \t]*/)[0].length > entryIndent) {
      continue; // continuation of a multi-line entry; the entry's first line is judged
    }
    const entry = raw.trim();
    if (!/^- "[^"]*"$/.test(entry)) {
      violations.push(
        `${CHART_YAML}: artifacthub.io/changes entry must be a single-line double-quoted string ` +
          `(ArtifactHub refuses unquoted {}:[],&*#?|-<>=!%@ and skips the whole chart version): ${entry}`,
      );
    }
  }
  return violations;
}

/**
 * The released-version check only matters when the appVersion changed against the base
 * AND the chart version moved off the base's (otherwise the chart-releaser violation
 * covers it). Shared by checkSync() and main() so the gating cannot drift (#151).
 *
 * @param {{ baseChart: { version: string, appVersion: string } | null, version: string, appVersion: string }} input
 * @returns {boolean}
 */
export function tagQueryNeeded({ baseChart, version, appVersion }) {
  return Boolean(baseChart && baseChart.appVersion !== appVersion && baseChart.version !== version);
}

/**
 * Returns violation messages (empty = in sync). baseChart is the parsed Chart.yaml at
 * the merge-base of HEAD and origin/main, or null when unavailable; chartTagExists is
 * true/false, or null when origin tags could not be queried (check skipped, CLI prints
 * a warning).
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
  violations.push(...checkChangesAnnotation(chartYaml));
  const readmeVersion = parseReadmeVersion(readme);
  if (readmeVersion !== version) {
    violations.push(`${CHART_README}: --version example '${readmeVersion}' does not equal chart version '${version}'`);
  }
  if (baseChart && baseChart.appVersion !== appVersion && baseChart.version === version) {
    violations.push(
      `${CHART_YAML}: appVersion changed (${baseChart.appVersion} -> ${appVersion}) but chart version is still ` +
        `'${version}' - chart-releaser (skip_existing) would silently publish nothing`,
    );
  }
  if (tagQueryNeeded({ baseChart, version, appVersion }) && chartTagExists === true) {
    violations.push(
      `${CHART_YAML}: chart version '${version}' is already released (tag libredb-studio-${version} exists) - ` +
        `bump to an unreleased version`,
    );
  }
  return violations;
}

/**
 * Applies the canonical bump; returns changed=false (inputs untouched) when already in
 * sync. Throws (via the parsers) when duplicated image/--version occurrences disagree -
 * an ambiguous chart must be fixed by hand, not auto-repaired.
 */
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
    .replace(/^(\s*image:\s*ghcr\.io\/libredb\/libredb-studio:)\S+/gm, `$1${pkgVersion}`);
  if (appVersion !== pkgVersion) {
    newChartYaml = newChartYaml.replace(
      /- "?Track app release .*/,
      `- "Track app release ${pkgVersion} (appVersion bump; default image tag follows)"`,
    );
  }
  const newReadme = readme.replace(/--version\s+\S+/g, `--version ${newVersion}`);
  return { chartYaml: newChartYaml, readme: newReadme, changed: true, version: newVersion, appVersion: pkgVersion };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Chart.yaml at the merge-base of HEAD and origin/main - not the origin/main tip, so a
 * release merged to main after the branch point cannot false-positive the already-released
 * check on a stale branch (#151). Shallow CI checkouts (ci.yml: depth-1 merge ref plus a
 * depth-1 fetch of main) have no computable merge-base; there the origin/main tip is used
 * as before - effectively exact on PR merge refs, which are built against the current main tip.
 * Returns { chart, reason }: chart is null when unavailable, with reason "missing-ref"
 * (origin/main not resolvable, e.g. a git-less fixture dir) or "unparseable" (the base
 * Chart.yaml exists but has no version/appVersion) kept distinct for strict-mode reporting.
 */
function readBaseChart(root) {
  let content;
  try {
    let baseRef;
    try {
      baseRef = git(root, ["merge-base", "HEAD", "origin/main"]);
    } catch {
      baseRef = "origin/main";
    }
    content = git(root, ["show", `${baseRef}:${CHART_YAML}`]);
  } catch {
    return { chart: null, reason: "missing-ref" };
  }
  try {
    return { chart: parseChart(content), reason: null };
  } catch {
    return { chart: null, reason: "unparseable" };
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
    const { chart: baseChart, reason: baseReason } = readBaseChart(root);
    const baseUnavailable =
      baseReason === "unparseable"
        ? `${CHART_YAML} at the merge-base of HEAD and origin/main is unparseable`
        : "origin/main not resolvable";
    if (!baseChart && strict) {
      // Content violations first, so a developer is not told about them one CI re-run later.
      for (const violation of checkSync({ pkgVersion, chartYaml, readme })) console.error(`ERROR: ${violation}`);
      console.error(`ERROR: ${baseUnavailable} and CHART_SYNC_STRICT is set - refusing to skip base-comparison checks`);
      process.exit(1);
    }
    let chartTagExists = null;
    if (tagQueryNeeded({ baseChart, version, appVersion })) {
      chartTagExists = chartTagExistsOnOrigin(root, version);
      if (chartTagExists === null && strict) {
        for (const violation of checkSync({ pkgVersion, chartYaml, readme, baseChart, chartTagExists })) {
          console.error(`ERROR: ${violation}`);
        }
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
      console.warn(`WARN: ${baseUnavailable} - base-comparison checks skipped`);
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

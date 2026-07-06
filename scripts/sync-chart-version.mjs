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
  const newChartYaml = chartYaml
    .replace(/^version:\s*\S+\s*$/m, `version: ${newVersion}`)
    .replace(/^appVersion:\s*.*$/m, `appVersion: "${pkgVersion}"`)
    .replace(/(image:\s*ghcr\.io\/libredb\/libredb-studio:)\S+/, `$1${pkgVersion}`)
    .replace(
      /- Track app release .*/,
      `- Track app release ${pkgVersion} (appVersion bump; default image tag follows)`,
    );
  const newReadme = readme.replace(/--version\s+\S+/, `--version ${newVersion}`);
  return { chartYaml: newChartYaml, readme: newReadme, changed: true, version: newVersion, appVersion: pkgVersion };
}

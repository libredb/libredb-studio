/**
 * Unit tests for the Helm CLI version matrix pinned across the five workflows
 * that run `azure/setup-helm` (seven sites in total).
 *
 * This exists because of #434. Its NOTES.txt assertions used
 * `helm install --dry-run=client`, which is green on Helm 4 (the maintainer's
 * local binary) and red on Helm 3.16 (the CI pin), because Helm 3.16 calls
 * IsReachable() before it renders anything and so demands a cluster even for a
 * client-side dry run. The defect was structural, not textual: two jobs run the
 * same helm-touching test suite (`ci.yml` -> test, `npm-publish.yml` ->
 * validate) and nothing stopped their Helm versions from drifting apart, or
 * from drifting away from what contributors run locally.
 *
 * The matrix is deliberately NOT uniform, and the asymmetry is the point:
 *   - Six sites run Helm 4, so the test suite, the lint job and every
 *     byte-producing release step use the client the project develops against.
 *   - `helm-release.yml` -> lint-test stays on Helm 3.16, because its two
 *     `ct install` runs are the only place in this repo where a Helm 3 client
 *     installs the chart into a cluster at all, and our users install with Helm
 *     3 (the packaged chart README promises a floor of Helm >= 3.12). Nothing
 *     else runs a Helm 3 client against the chart: helm-index-check.yml only
 *     curls the index and compares sha256. Raising that one pin would leave the
 *     project publishing for Helm 3 users while only ever install-testing as
 *     Helm 4.
 *
 * Be precise about what that job proves, because the marker comment at the site
 * is the thing a future maintainer reads: `ct install` installs the chart SOURCE
 * directory, never the .tgz that release-github-pages packages with Helm 4. So
 * the evidence is "a Helm 3 client installs this chart into a cluster", NOT "a
 * Helm 3 client installs the released artifact". Closing that residual gap (a
 * pinned Helm 3 `repo add` + `pull` + `install` of the published .tgz in
 * helm-index-check.yml) is tracked in docs/BACKLOG.md.
 *
 * So a future "consistency fix" that unifies the odd one out must fail HERE,
 * with the reason attached, rather than silently retiring the only evidence
 * that the published chart installs for the clients users actually run.
 *
 * The assertions are pure string checks over the workflow files themselves - no
 * network, no helm binary (CI is the only place a helm binary exists).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const WORKFLOWS = join(REPO_ROOT, ".github/workflows");
/**
 * EVERY workflow file, derived - never a literal. A new publishing workflow (a
 * Rancher partner-charts push, an ArtifactHub mirror, a repaired-index job) is
 * exactly the case this test exists for: it must arrive as an unclassified-key
 * failure against EXPECTED_PINS below, not slip past a hard-coded four-file scan.
 */
const WORKFLOW_FILES = readdirSync(WORKFLOWS)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort();

const SETUP_HELM_SHA = "9bc31f4ebc9c6b171d7bfbaa5d006ae7abdb4310";
const HELM_4 = "v4.1.3";
const HELM_3 = "v3.16.0";

/**
 * The whole matrix, hard-coded. A site that changes version, a site that
 * disappears, and a site that is added without being classified all fail.
 */
const EXPECTED_PINS: Record<string, string> = {
  // Required "Unit & Integration Tests" check: spawns `helm template` from the
  // ten helm-chart-*.test.ts files. Produces no published byte.
  "ci.yml:test": HELM_4,
  // Advisory chart lint + a conditional kind `ct install`. Raised on purpose so
  // chart-testing under Helm 4 is exercised somewhere non-blocking.
  "ci.yml:helm-lint": HELM_4,
  // Runs the same helm-touching suite as ci.yml:test - see the drift test below.
  "npm-publish.yml:validate": HELM_4,
  // THE DELIBERATE ODD ONE OUT. Do not "fix" this. See the header.
  "helm-release.yml:lint-test": HELM_3,
  // helm dependency build + helm package + helm repo index --merge.
  "helm-release.yml:release-github-pages": HELM_4,
  // helm registry login + helm package + helm push to oci://ghcr.io/libredb/charts.
  "helm-release.yml:release-oci": HELM_4,
  // helm dependency build, vendoring the mirror chart into the operator image.
  "operator-release.yml:build-and-push": HELM_4,
};

/** The site whose Helm 3 pin is load-bearing evidence, not an oversight. */
const HELM3_PINNED_SITE = "helm-release.yml:lint-test";

/** The two jobs that run the helm-touching test suite; #434 was their drift. */
const SUITE_SITES = ["ci.yml:test", "npm-publish.yml:validate"];

interface HelmPin {
  site: string;
  file: string;
  job: string;
  line: number;
  sha: string;
  version: string;
  /** Contiguous comment lines immediately above the step. */
  comments: string[];
}

/** The enclosing job key for every line of a workflow file. */
function jobAtLine(lines: string[]): string[] {
  const owners: string[] = [];
  let inJobs = false;
  let job = "";
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) inJobs = true;
    else if (/^\S/.test(line)) inJobs = false;
    const jobStart = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line) : null;
    if (jobStart) job = jobStart[1];
    owners.push(job);
  }
  return owners;
}

/** Every `azure/setup-helm` step in one workflow file, with its resolved version. */
function parseHelmPins(text: string, file: string): HelmPin[] {
  const lines = text.split("\n");
  const owners = jobAtLine(lines);
  const pins: HelmPin[] = [];
  for (let i = 0; i < lines.length; i++) {
    const uses = /uses:\s*azure\/setup-helm@([0-9a-f]{40})/.exec(lines[i]);
    if (!uses) continue;
    let version = "";
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const found = /^\s*version:\s*(\S+)\s*$/.exec(lines[j]);
      if (found) {
        version = found[1];
        break;
      }
      if (/^\s*-\s/.test(lines[j])) break;
    }
    // Walk up to the step's `- name:` line, then collect the comment block above it.
    let start = i;
    while (start > 0 && !/^\s*-\s/.test(lines[start])) start--;
    const comments: string[] = [];
    for (let k = start - 1; k >= 0 && /^\s*#/.test(lines[k]); k--) comments.unshift(lines[k].trim());
    pins.push({
      site: `${file}:${owners[i]}`,
      file,
      job: owners[i],
      line: i + 1,
      sha: uses[1],
      version,
      comments,
    });
  }
  return pins;
}

/**
 * Command-carrying lines of one job: every line the job owns, minus comments.
 * Comments are dropped so that documenting a flag (`# never add --timeout here`)
 * cannot turn the required check red, nor satisfy a guard that wants the flag.
 */
function jobCommandLines(text: string, job: string): string[] {
  const lines = text.split("\n");
  const owners = jobAtLine(lines);
  return lines.filter((line, i) => owners[i] === job && !/^\s*#/.test(line));
}

function readWorkflow(file: string): string {
  return readFileSync(join(WORKFLOWS, file), "utf8");
}

const ALL_PINS: HelmPin[] = WORKFLOW_FILES.flatMap((file) => parseHelmPins(readWorkflow(file), file));
const BY_SITE = new Map(ALL_PINS.map((pin) => [pin.site, pin]));

function major(version: string): number {
  return Number.parseInt(version.replace(/^v/, "").split(".")[0], 10);
}

describe("parseHelmPins", () => {
  test("reads the job, sha and version of a setup-helm step", () => {
    const text = [
      "jobs:",
      "  build:",
      "    steps:",
      "      # why this one is different",
      "      - name: Set up Helm",
      `        uses: azure/setup-helm@${SETUP_HELM_SHA} # v5.0.1`,
      "        with:",
      "          version: v4.1.3",
      "",
    ].join("\n");
    expect(parseHelmPins(text, "x.yml")).toEqual([
      {
        site: "x.yml:build",
        file: "x.yml",
        job: "build",
        line: 6,
        sha: SETUP_HELM_SHA,
        version: "v4.1.3",
        comments: ["# why this one is different"],
      },
    ]);
  });

  test("finds no pin in a workflow that never sets up helm", () => {
    expect(parseHelmPins("jobs:\n  build:\n    steps:\n      - run: echo hi\n", "x.yml")).toEqual([]);
  });
});

describe("jobCommandLines", () => {
  const text = [
    "jobs:",
    "  a:",
    "    steps:",
    "      # never add --timeout to `helm repo add bitnami` here",
    "      - run: helm repo add bitnami https://charts.bitnami.com/bitnami",
    "  b:",
    "    steps:",
    "      - run: helm repo add bitnami https://charts.bitnami.com/bitnami --timeout 5m",
    "",
  ].join("\n");

  test("returns the job's command lines and drops its comments", () => {
    expect(jobCommandLines(text, "a")).toEqual([
      "  a:",
      "    steps:",
      "      - run: helm repo add bitnami https://charts.bitnami.com/bitnami",
    ]);
  });

  test("a comment mentioning a flag neither satisfies nor violates a flag guard", () => {
    // The flag guards below match on substrings. Without comment filtering,
    // documenting `--timeout` in the Helm 3 job would redden the required check.
    expect(jobCommandLines(text, "a").some((line) => line.includes("--timeout"))).toBe(false);
    expect(jobCommandLines(text, "b").some((line) => line.includes("--timeout 5m"))).toBe(true);
  });
});

describe("the seven setup-helm sites", () => {
  test("there are exactly seven, and every one is classified", () => {
    expect(ALL_PINS).toHaveLength(7);
    expect([...BY_SITE.keys()].sort()).toEqual(Object.keys(EXPECTED_PINS).sort());
  });

  test("every site pins the exact version the matrix assigns it", () => {
    const actual = Object.fromEntries([...BY_SITE].map(([site, pin]) => [site, pin.version]));
    expect(actual).toEqual(EXPECTED_PINS);
  });

  test("the scan covers every workflow file, not a hand-kept subset", () => {
    // The guard above is only worth anything if a NEW publishing workflow that
    // packages or pushes the chart is scanned too. Assert the list is derived:
    // it must contain workflows that have nothing to do with helm.
    const onDisk = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
    expect(WORKFLOW_FILES).toEqual([...onDisk].sort());
    expect(WORKFLOW_FILES).toContain("codeql.yml");
    expect(WORKFLOW_FILES.length).toBeGreaterThan(Object.keys(EXPECTED_PINS).length);
  });

  test("every site uses the same pinned setup-helm action sha", () => {
    // The action resolves `version:` into a get.helm.sh URL with no major-version
    // branch, so Helm 4 needs no action bump - only the scalar moves.
    expect([...new Set(ALL_PINS.map((pin) => pin.sha))]).toEqual([SETUP_HELM_SHA]);
  });
});

describe("#434 regression: the two suite-running jobs cannot drift apart", () => {
  test("ci.yml:test and npm-publish.yml:validate pin the identical Helm version", () => {
    // Asserted against each other, not against a literal: the defect in #434 was
    // one helm here and another there, whatever the versions happened to be.
    const [ci, npm] = SUITE_SITES.map((site) => BY_SITE.get(site)?.version);
    expect(ci).toBe(npm as string);
  });

  test("reintroducing `helm install --dry-run=client` requires a Helm 4 suite pin", () => {
    // The workaround in helm-chart-dualstack.test.ts exists only because Helm
    // 3.16 calls IsReachable() on a client-side dry run. The idiom becomes legal
    // again the moment - and only the moment - the suite pins are Helm 4.
    const usesDryRun = readdirSync(join(REPO_ROOT, "tests/unit"))
      .filter((name) => /^helm-chart-.*\.test\.ts$/.test(name))
      .some((name) =>
        readFileSync(join(REPO_ROOT, "tests/unit", name), "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .some((line) => line.includes("--dry-run=client")),
      );
    if (!usesDryRun) return;
    for (const site of SUITE_SITES) expect(major(BY_SITE.get(site)?.version ?? "v0")).toBeGreaterThanOrEqual(4);
  });
});

describe("the Helm 3 site is pinned on purpose and says so", () => {
  test("helm-release.yml lint-test stays on Helm 3.16", () => {
    // Its two `ct install` runs are the only cluster install in the repo, and
    // Helm 3 is what users run. Do not unify this with the other six.
    expect(BY_SITE.get(HELM3_PINNED_SITE)?.version).toBe(HELM_3);
  });

  test("a marker comment above the step explains why, so deleting the reason is a red build", () => {
    const comments = (BY_SITE.get(HELM3_PINNED_SITE)?.comments ?? []).join(" ");
    expect(comments).toMatch(/#\s*helm3-pinned:/);
    expect(comments).toContain("Helm 3");
    expect(comments).toContain("install");
  });
});

describe("Helm-4-only flags stay out of the Helm 3 job", () => {
  test("the Helm 3 job's `helm repo add bitnami` carries no --timeout", () => {
    // `--timeout` does not exist on `helm repo add` in 3.16; it would hard-fail.
    const pin = BY_SITE.get(HELM3_PINNED_SITE);
    const runs = jobCommandLines(readWorkflow(pin?.file ?? ""), pin?.job ?? "").filter((line) =>
      line.includes("helm repo add bitnami"),
    );
    expect(runs.length).toBeGreaterThan(0);
    for (const line of runs) expect(line).not.toContain("--timeout");
  });

  test("every Helm 4 job's `helm repo add bitnami` carries --timeout 5m", () => {
    // Helm 4 imposes a 2m0s deadline on the index download; bitnami's index is
    // big enough that this has already been reproduced as a hard failure.
    for (const pin of ALL_PINS) {
      if (pin.site === HELM3_PINNED_SITE) continue;
      const runs = jobCommandLines(readWorkflow(pin.file), pin.job).filter((line) =>
        line.includes("helm repo add bitnami"),
      );
      if (runs.length === 0) continue;
      for (const line of runs) expect(`${pin.site}: ${line}`).toContain("--timeout 5m");
    }
  });
});

describe("the second index download is skipped, not merely timed out", () => {
  test("every `helm dependency build` carries --skip-refresh", () => {
    // `helm repo add --timeout 5m` covers only the FIRST index download. Helm 4's
    // `dependency build` refreshes the repository cache again by default and
    // exposes no --timeout of its own, so the 2m0s deadline is only off the
    // release path once the refresh itself is skipped. --skip-refresh exists in
    // 3.16 as well, so this is safe on every pin in the matrix.
    const seen: string[] = [];
    for (const file of WORKFLOW_FILES) {
      for (const line of readWorkflow(file).split("\n")) {
        if (/^\s*#/.test(line) || !line.includes("helm dependency build")) continue;
        seen.push(`${file}: ${line.trim()}`);
        expect(`${file}: ${line.trim()}`).toContain("--skip-refresh");
      }
    }
    expect(seen).not.toEqual([]);
  });
});

describe("`helm registry login` targets a bare domain", () => {
  test("no login target carries a path component", () => {
    // Helm 4 breaking change: the login must be the domain only. `ghcr.io` is
    // fine, `ghcr.io/libredb` would break the OCI publish with no other signal.
    for (const file of WORKFLOW_FILES) {
      for (const line of readWorkflow(file).split("\n")) {
        const login = /helm registry login\s+(\S+)/.exec(line);
        if (login) expect(`${file}: ${login[1]}`).not.toContain("/");
      }
    }
  });
});

describe("the release runbook records the split", () => {
  test("cut-release SKILL.md points at this test as the matrix's enforcement", () => {
    // SKILL.md is the single written inventory of the seven sites; without this
    // pointer the next reader re-unifies them from the runbook.
    const skill = readFileSync(join(REPO_ROOT, ".claude/skills/cut-release/SKILL.md"), "utf8");
    const mentions = skill.split("\n").filter((line) => line.includes("helm-pin-matrix.test.ts"));
    expect(mentions).not.toEqual([]);
  });
});

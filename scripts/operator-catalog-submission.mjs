#!/usr/bin/env node
/**
 * Decides whether a release should be submitted to one community operator
 * catalog, and which bundle it replaces there (issue #656).
 *
 * Everything that decides is a pure function below. The CLI at the bottom is a
 * thin shell: it reads the version directories of a checked-out catalog and
 * the target repository's open pull requests, then prints GITHUB_OUTPUT lines.
 * That split is deliberate - the same logic used to live as a `sort -V |
 * grep -B1` pipeline inside a workflow step, where it could not be tested.
 *
 * Why the predecessor cannot come from this repository: `spec.replaces` must
 * name the version immediately preceding ours *in the catalog being submitted
 * to*, which lags our releases by however many submissions are unmerged and
 * differs between the two catalogs. Both upstream gates reject a graph that is
 * not linked that way, and neither accepts `olm.skipRange` as a substitute:
 *
 *   k8s-operatorhub  `opm index add --mode replaces` ->
 *                    "add prunes bundle ... skips/replaces []"
 *   community-operators-prod (FBC)  `opm validate` ->
 *                    "multiple channel heads found in graph"
 *
 * Both were measured, the second on community-operators-prod#11106.
 *
 * Pure functions are unit tested in tests/unit/operator-catalog-submission.test.ts.
 */

import fs from "node:fs";

/** Bare `x.y.z` only. Our operator versions are app versions, which carry no prerelease suffix. */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * The version directories a catalog holds, ascending. A catalog directory also
 * holds non-version entries - `ci.yaml` on both catalogs, plus `Makefile` and
 * `catalog-templates` on the FBC one - so this filters rather than assuming.
 */
export function catalogVersions(entries) {
  return entries.filter((name) => SEMVER.test(name)).sort(compareVersions);
}

export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] - pb[i];
    }
  }
  return 0;
}

/**
 * The version immediately below ours in that catalog, or null when ours would
 * be the lowest (a first submission, where `replaces` must be omitted).
 *
 * Note what this is NOT: the highest version the catalog serves. Those answer
 * the same when we are always ahead, and disagree the moment a higher version
 * is already listed - where the highest would point the graph forwards.
 */
export function predecessorVersion(entries, version) {
  const below = catalogVersions(entries).filter((v) => compareVersions(v, version) < 0);
  return below.length === 0 ? null : below[below.length - 1];
}

/**
 * The versions a pull request submits, read from its changed paths.
 *
 * Paths rather than the title, because the hub rewrites submission titles on
 * open and on every push, inserting markers ("operator [N] [CI] <name>
 * (<version>)") and, for a multi-version PR, more than one version inside the
 * parentheses. A title regex is therefore display text that changes under us;
 * the changed files are the submission.
 *
 * Only `operators/<operator>/<version>/...` counts. A `ci.yaml` edit is not a
 * submission, and `catalogs/v4.x/<operator>/catalog.yaml` is the FBC bot's
 * follow-up pull request, not ours.
 */
export function submittedVersions(paths, operator) {
  const prefix = `operators/${operator}/`;
  const found = new Set();
  for (const path of paths) {
    if (!path.startsWith(prefix)) {
      continue;
    }
    const segment = path.slice(prefix.length).split("/")[0];
    if (SEMVER.test(segment)) {
      found.add(segment);
    }
  }
  return [...found].sort(compareVersions);
}

/**
 * Whether an open pull request is the one this workflow manages for this
 * version: our fork, and the branch `create-pull-request` pushes.
 *
 * The distinction matters because the version exemption below would otherwise
 * let a duplicate through the very hole it exists to close. A rerun for our
 * own version must not block, since the action updates that branch in place -
 * but a same-version submission from any other branch or fork is a second
 * pull request for one version, and the action will never touch it.
 */
export function isManagedSubmission(head, fork, operator, version) {
  return head.headRepo === fork && head.headRef === `${operator}-${version}`;
}

/**
 * Open submissions that must stop this one, each with the pull request that
 * holds it. The predecessor is read from the catalog's default branch, so an
 * unmerged submission is invisible to it: submitting past a pending version
 * would leave that bundle dangling once both merge, which is the failure mode
 * that lost VictoriaMetrics 0.48.2.
 *
 * Our own version is only exempt when the pull request is the managed one -
 * see isManagedSubmission. The pull request number IS carried, because a skip
 * that does not say what to go and merge is a mute.
 *
 * @param {{number: number, versions: string[], managed: boolean}[]} openSubmissions
 * @returns {{version: string, number: number}[]}
 */
export function blockingSubmissions(openSubmissions, version) {
  const blockers = new Map();
  for (const submission of openSubmissions) {
    for (const found of submission.versions) {
      const exempt = found === version && submission.managed;
      if (!exempt && !blockers.has(found)) {
        blockers.set(found, submission.number);
      }
    }
  }
  return [...blockers.entries()]
    .map(([found, number]) => ({ version: found, number }))
    .sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * @param {{version: string, operator: string, entries: string[] | null,
 *           openSubmissions: {number: number, versions: string[], managed: boolean}[]}} input
 *   `entries` is null when the operator directory is absent upstream.
 * @returns {{enabled: boolean, reason: string, predecessor: string | null}}
 */
export function submissionDecision({ version, operator, entries, openSubmissions }) {
  if (entries === null) {
    return {
      enabled: false,
      reason: `${operator} is not listed in this catalog; the first submission is manual`,
      predecessor: null,
    };
  }
  const listed = catalogVersions(entries);
  // Already-listed is checked first on purpose: a rerun after a merge must
  // read as "done", not as "blocked by something still open".
  if (listed.includes(version)) {
    return { enabled: false, reason: `the catalog already carries ${version}`, predecessor: null };
  }
  // A version below the channel head cannot be linked by a predecessor
  // pointer: the head keeps no replaces of its own, so both stay heads and
  // `opm validate` rejects the catalog with "multiple channel heads found in
  // graph". Linking that is a judgement call, not a derivation.
  const above = listed.filter((candidate) => compareVersions(candidate, version) > 0);
  if (above.length > 0) {
    return {
      enabled: false,
      reason: `the catalog already carries ${above.join(", ")}, above ${version}; submitting it would leave two channel heads - link the graph by hand`,
      predecessor: null,
    };
  }
  // A version the catalog already holds is not a pending submission, whatever
  // an open pull request does to its directory. Blocking on one of those
  // would mute every release for as long as that pull request stayed open.
  const blockers = blockingSubmissions(openSubmissions, version).filter((blocker) => !listed.includes(blocker.version));
  if (blockers.length > 0) {
    const named = blockers.map((blocker) => `${blocker.version} (#${blocker.number})`).join(", ");
    return {
      enabled: false,
      reason: `a submission for another version is still open - ${named}; merge it before submitting ${version}`,
      predecessor: null,
    };
  }
  const predecessor = predecessorVersion(entries, version);
  return {
    enabled: true,
    reason: predecessor
      ? `${version} is not listed; replaces ${predecessor}`
      : `${version} is not listed; first submission, no replaces`,
    predecessor,
  };
}

/**
 * GITHUB_OUTPUT lines, in the shape the release workflow's submit step reads.
 * `replaces` is the CSV field value, empty when there is no predecessor, so a
 * downstream step can test for emptiness instead of reimplementing the rule.
 * A reason is flattened to one line - a newline would end the output entry
 * early and silently drop the rest.
 */
export function submissionOutputs(decision, operator) {
  return [
    `enabled=${decision.enabled}`,
    `reason=${decision.reason.replace(/\s*\n\s*/g, " ")}`,
    `predecessor=${decision.predecessor ?? ""}`,
    `replaces=${decision.predecessor ? `${operator}.v${decision.predecessor}` : ""}`,
  ];
}

/**
 * The CSV text with `spec.replaces` set, inserted immediately above
 * `spec.version` at the same indent.
 *
 * A targeted text edit rather than a YAML round trip: the submitted bundle
 * must be the released bundle plus one line, and re-emitting the document
 * would reflow quoting, key order and block scalars across a 380-line file,
 * turning a one-line change into an unreviewable diff.
 *
 * The anchor is the two-space `version:` key, i.e. the one directly under
 * `spec`. A CSV also carries nested `version:` keys under
 * `customresourcedefinitions.owned`, which are API versions and must not be
 * touched.
 */
export function withReplaces(csvText, replacesName) {
  const anchor = /^ {2}version: .*$/m;
  if (!anchor.test(csvText)) {
    throw new Error("cannot set replaces: the CSV has no spec.version line to anchor on");
  }
  const withoutExisting = csvText.replace(/^ {2}replaces: .*\n/m, "");
  return withoutExisting.replace(anchor, (line) => `  replaces: ${replacesName}\n${line}`);
}

/**
 * Directory entries of a checked-out catalog's operator dir, or null when the
 * operator genuinely has no directory there.
 *
 * ONLY a missing path is null. Anything else - a path that is not a directory,
 * an unreadable one, a changed upstream layout - is thrown, because reporting
 * it as "not listed, the first submission is manual" would stop submitting
 * for good while every run stayed green.
 */
export function readOperatorEntries(operatorDir) {
  try {
    return fs.readdirSync(operatorDir);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Open submissions in the target repository, each with the versions it
 * touches. Two reads per candidate: the search API finds pull requests that
 * mention this operator at all, then each one's changed files decide whether
 * it is really a submission and for which versions.
 *
 * The search is deliberately not restricted to titles. A false negative here
 * is the dangerous direction - it lets a submission be opened past a pending
 * one - so recall matters more than the extra call.
 *
 * `apiBase` is a parameter so the tests can point both endpoints at a local
 * server and the suite never touches the network.
 */
export async function readOpenSubmissions({ apiBase, repo, operator, fork, version, timeoutMs = 15000 }) {
  const query = encodeURIComponent(`repo:${repo} is:pr is:open ${operator}`);
  const search = await fetchJson(`${apiBase}/search/issues?q=${query}&per_page=100`, timeoutMs);
  if (!Array.isArray(search.items)) {
    throw new Error("open-submission search returned no items array");
  }
  const submissions = [];
  for (const item of search.items) {
    // per_page=100 is one page for any real submission: a bundle directory is
    // about ten files. A pull request larger than that is not one of ours, and
    // the versions we would miss on page two cannot be ours either.
    const files = await fetchJson(`${apiBase}/repos/${repo}/pulls/${item.number}/files?per_page=100`, timeoutMs);
    if (!Array.isArray(files)) {
      throw new Error(`pull request ${item.number}: changed files unreadable`);
    }
    // A second read for the head. The search result does not carry it, and
    // without it a same-version pull request from another branch or fork
    // cannot be told apart from our own rerun.
    const pull = await fetchJson(`${apiBase}/repos/${repo}/pulls/${item.number}`, timeoutMs);
    const versions = submittedVersions(
      files.map((file) => file.filename ?? ""),
      operator,
    );
    submissions.push({
      number: item.number,
      versions,
      managed: isManagedSubmission(
        { headRepo: pull?.head?.repo?.full_name ?? null, headRef: pull?.head?.ref ?? null },
        fork,
        operator,
        version,
      ),
    });
  }
  return submissions;
}

async function fetchJson(url, timeoutMs) {
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    // Never degrade to "submit": a decision made on an unread search is how a
    // duplicate or a graph-breaking pull request gets opened.
    throw new Error(`GitHub API read failed (status ${response.status}) for ${url}`);
  }
  return response.json();
}

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

/**
 * Two commands rather than one, because the workflow needs two distinct
 * things: a decision before it touches anything, and a patch applied to the
 * bundle copy afterwards. Naming them keeps each one's required flags obvious
 * and makes an unknown command an error instead of a plausible default.
 */
export async function main(argv) {
  const command = argv[0];
  if (command === "decide") {
    return decide(argv.slice(1));
  }
  if (command === "set-replaces") {
    return setReplaces(argv.slice(1));
  }
  console.error(`ERROR: unknown command '${command ?? ""}' - expected 'decide' or 'set-replaces'`);
  return 2;
}

function setReplaces(argv) {
  const csvPath = flag(argv, "csv");
  const replacesName = flag(argv, "replaces");
  if (!csvPath || !replacesName) {
    console.error("ERROR: set-replaces needs --csv and --replaces");
    return 2;
  }
  fs.writeFileSync(csvPath, withReplaces(fs.readFileSync(csvPath, "utf8"), replacesName));
  console.log(`set replaces: ${replacesName}`);
  return 0;
}

async function decide(argv) {
  const version = flag(argv, "version");
  const operatorDir = flag(argv, "operator-dir");
  const repo = flag(argv, "repo");
  const operatorFlag = argv.indexOf("--operator");
  const operator = operatorFlag === -1 ? "libredb-studio-operator" : flag(argv, "operator");
  const apiBase = flag(argv, "api-base") ?? "https://api.github.com";
  const fork = flag(argv, "fork");

  for (const [name, value] of [
    ["version", version],
    ["operator-dir", operatorDir],
    ["repo", repo],
    ["operator", operator],
    ["fork", fork],
  ]) {
    if (!value) {
      console.error(`ERROR: --${name} is required`);
      return 2;
    }
  }
  if (!SEMVER.test(version)) {
    console.error(`ERROR: --version must be a bare semver, got '${version}'`);
    return 2;
  }

  const entries = readOperatorEntries(operatorDir);
  // The search only matters when a submission is otherwise possible, and it is
  // the one step that can fail for reasons outside this repository. Skipping
  // it for an absent operator or an already-listed version keeps those two
  // answers offline and certain.
  const needsSearch = entries !== null && !catalogVersions(entries).includes(version);
  const openSubmissions = needsSearch ? await readOpenSubmissions({ apiBase, repo, operator, fork, version }) : [];

  const decision = submissionDecision({ version, operator, entries, openSubmissions });
  for (const line of submissionOutputs(decision, operator)) {
    console.log(line);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`ERROR: ${error.message}`);
      process.exit(1);
    });
}

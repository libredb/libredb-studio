/**
 * Unit tests for the operator catalog submission helper
 * (scripts/operator-catalog-submission.mjs, issue #656).
 *
 * The helper answers one question per catalog: should this release be
 * submitted, and if so which bundle does it replace. Everything that decides
 * that is a pure function here; the CLI is a thin shell around
 * `submissionDecision` that reads a checked-out catalog directory and the
 * target repo's open pull requests.
 *
 * The predecessor cannot come from this repo. `spec.replaces` must name the
 * version immediately preceding ours *in the catalog being submitted to*, and
 * both upstream gates reject a graph that is not linked that way:
 * `opm index add --mode replaces` prunes the previous bundle on k8s-operatorhub,
 * and `opm validate` fails with "multiple channel heads found in graph" on the
 * FBC side. A skipRange satisfies neither.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  blockingSubmissions,
  catalogVersions,
  compareVersions,
  isManagedSubmission,
  submittedVersions,
  predecessorVersion,
  submissionDecision,
  submissionOutputs,
  withReplaces,
} from "../../scripts/operator-catalog-submission.mjs";

const OPERATOR = "libredb-studio-operator";
const FORK = "libredb/community-operators";

describe("catalogVersions", () => {
  test("keeps semver directories and sorts them ascending", () => {
    expect(catalogVersions(["0.14.1", "0.9.59", "0.10.0"])).toEqual(["0.9.59", "0.10.0", "0.14.1"]);
  });

  test("drops the non-version entries a catalog directory also holds", () => {
    // Real neighbours of the version dirs: ci.yaml on both catalogs, plus
    // Makefile and catalog-templates on the FBC one.
    expect(catalogVersions(["ci.yaml", "Makefile", "catalog-templates", "0.9.59"])).toEqual(["0.9.59"]);
  });

  test("sorts numerically, not lexically", () => {
    expect(catalogVersions(["0.9.9", "0.10.0", "0.9.59"])).toEqual(["0.9.9", "0.9.59", "0.10.0"]);
  });

  test("returns an empty list for a catalog that holds no version yet", () => {
    expect(catalogVersions(["ci.yaml"])).toEqual([]);
  });
});

describe("compareVersions", () => {
  // Every component matters. A comparator that ignores one of them still
  // sorts most real catalogs correctly, which is why each is asserted
  // separately: dropping the patch arm would otherwise leave the suite green
  // and pick the wrong predecessor between two same-minor releases.
  test("orders by major", () => {
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  test("orders by minor when the major is equal", () => {
    expect(compareVersions("0.10.0", "0.9.59")).toBeGreaterThan(0);
  });

  test("orders by patch when major and minor are equal", () => {
    expect(compareVersions("0.14.2", "0.14.1")).toBeGreaterThan(0);
    expect(compareVersions("0.14.1", "0.14.2")).toBeLessThan(0);
  });

  test("is zero for equal versions", () => {
    expect(compareVersions("0.14.1", "0.14.1")).toBe(0);
  });
});

describe("predecessorVersion", () => {
  test("is the version immediately below ours", () => {
    expect(predecessorVersion(["0.9.59", "0.13.7"], "0.14.1")).toBe("0.13.7");
  });

  test("skips the versions we never submitted", () => {
    // 0.14.0 was never submitted anywhere, so 0.14.1 replaces 0.9.59.
    expect(predecessorVersion(["ci.yaml", "0.9.59"], "0.14.1")).toBe("0.9.59");
  });

  test("is null on a first submission, where replaces must be omitted", () => {
    expect(predecessorVersion(["ci.yaml"], "0.14.1")).toBeNull();
  });

  test("stays the immediate predecessor even when a higher version is already listed", () => {
    // "the highest version the catalog serves" would answer 0.15.0 here and
    // point the graph forwards. The immediate predecessor is the only correct
    // answer, and this is why the catalog listing is sorted rather than maxed.
    expect(predecessorVersion(["0.9.59", "0.13.7", "0.15.0"], "0.14.1")).toBe("0.13.7");
  });

  test("ignores our own version when it is already present", () => {
    expect(predecessorVersion(["0.9.59", "0.14.1"], "0.14.1")).toBe("0.9.59");
  });

  test("is null when ours is the lowest version in the catalog", () => {
    expect(predecessorVersion(["0.15.0"], "0.14.1")).toBeNull();
  });

  test("distinguishes two releases that differ only in patch", () => {
    expect(predecessorVersion(["0.14.1", "0.14.2", "0.9.59"], "0.14.3")).toBe("0.14.2");
  });
});

describe("submittedVersions", () => {
  test("reads the versions a pull request touches from its changed paths", () => {
    expect(
      submittedVersions(
        [`operators/${OPERATOR}/0.13.7/manifests/x.yaml`, `operators/${OPERATOR}/0.13.7/metadata/annotations.yaml`],
        OPERATOR,
      ),
    ).toEqual(["0.13.7"]);
  });

  test("ignores paths belonging to another operator", () => {
    expect(submittedVersions(["operators/camel-k/2.11.0/manifests/x.yaml"], OPERATOR)).toEqual([]);
  });

  test("ignores our own non-version files, so a ci.yaml edit is not a submission", () => {
    expect(submittedVersions([`operators/${OPERATOR}/ci.yaml`], OPERATOR)).toEqual([]);
  });

  test("ignores the rendered FBC catalogs, which are the bot's follow-up PR", () => {
    expect(submittedVersions([`catalogs/v4.15/${OPERATOR}/catalog.yaml`], OPERATOR)).toEqual([]);
  });

  test("reports every version a pull request touches, deduplicated and sorted", () => {
    expect(
      submittedVersions(
        [
          `operators/${OPERATOR}/0.15.0/manifests/x.yaml`,
          `operators/${OPERATOR}/0.13.7/manifests/x.yaml`,
          `operators/${OPERATOR}/0.13.7/metadata/y.yaml`,
        ],
        OPERATOR,
      ),
    ).toEqual(["0.13.7", "0.15.0"]);
  });
});

describe("isManagedSubmission", () => {
  const fork = "libredb/community-operators";

  test("recognises the branch this workflow pushes", () => {
    expect(isManagedSubmission({ headRepo: fork, headRef: `${OPERATOR}-0.14.1` }, fork, OPERATOR, "0.14.1")).toBe(true);
  });

  test("rejects the same branch name on a different fork", () => {
    expect(
      isManagedSubmission(
        { headRepo: "someone/community-operators", headRef: `${OPERATOR}-0.14.1` },
        fork,
        OPERATOR,
        "0.14.1",
      ),
    ).toBe(false);
  });

  test("rejects a different branch on our own fork", () => {
    expect(isManagedSubmission({ headRepo: fork, headRef: "manual-fix" }, fork, OPERATOR, "0.14.1")).toBe(false);
  });

  test("rejects a branch for another version", () => {
    expect(isManagedSubmission({ headRepo: fork, headRef: `${OPERATOR}-0.13.7` }, fork, OPERATOR, "0.14.1")).toBe(
      false,
    );
  });

  test("is false when the head is unknown", () => {
    expect(isManagedSubmission({ headRepo: null, headRef: null }, fork, OPERATOR, "0.14.1")).toBe(false);
  });
});

describe("blockingSubmissions", () => {
  test("an open submission for another version blocks", () => {
    // The predecessor is read from the catalog's default branch, so an
    // unmerged submission is invisible to it. Submitting past it would leave
    // the pending bundle dangling once both merge.
    expect(blockingSubmissions([{ number: 7, versions: ["0.13.7"], managed: false }], "0.14.1")).toEqual([
      { version: "0.13.7", number: 7 },
    ]);
  });

  test("our own managed pull request for this version does not block", () => {
    // The rerun case: create-pull-request updates that branch in place.
    expect(blockingSubmissions([{ number: 7, versions: ["0.14.1"], managed: true }], "0.14.1")).toEqual([]);
  });

  test("somebody else's pull request for this version DOES block", () => {
    // Same version, different head. create-pull-request only ever updates its
    // own branch, so proceeding here opens a second submission for one
    // version - which is the duplicate the version exemption exists to avoid,
    // arriving through the exemption itself.
    expect(blockingSubmissions([{ number: 7, versions: ["0.14.1"], managed: false }], "0.14.1")).toEqual([
      { version: "0.14.1", number: 7 },
    ]);
  });

  test("a higher pending version blocks too", () => {
    expect(blockingSubmissions([{ number: 7, versions: ["0.15.0"], managed: false }], "0.14.1")).toEqual([
      { version: "0.15.0", number: 7 },
    ]);
  });

  test("a pull request touching no version of ours does not block", () => {
    expect(blockingSubmissions([{ number: 7, versions: [], managed: false }], "0.14.1")).toEqual([]);
  });

  test("carries the pull request number, so the skip names what to go and merge", () => {
    expect(blockingSubmissions([{ number: 7, versions: ["0.13.7"], managed: false }], "0.14.1")).toEqual([
      { version: "0.13.7", number: 7 },
    ]);
  });

  test("reports each blocking version once, sorted", () => {
    expect(
      blockingSubmissions(
        [
          { number: 8, versions: ["0.15.0"], managed: false },
          { number: 7, versions: ["0.13.7", "0.15.0"], managed: false },
        ],
        "0.14.1",
      ),
    ).toEqual([
      { version: "0.13.7", number: 7 },
      { version: "0.15.0", number: 8 },
    ]);
  });
});

describe("submissionDecision", () => {
  const base = { version: "0.14.1", operator: OPERATOR, entries: ["ci.yaml", "0.9.59"], openSubmissions: [] };

  test("submits with the derived predecessor when the catalog is behind", () => {
    expect(submissionDecision(base)).toEqual({
      enabled: true,
      reason: "0.14.1 is not listed; replaces 0.9.59",
      predecessor: "0.9.59",
    });
  });

  test("submits with no predecessor on a first listing", () => {
    expect(submissionDecision({ ...base, entries: ["ci.yaml"] })).toEqual({
      enabled: true,
      reason: "0.14.1 is not listed; first submission, no replaces",
      predecessor: null,
    });
  });

  test("skips when the catalog already carries this version", () => {
    const decision = submissionDecision({ ...base, entries: ["0.9.59", "0.14.1"] });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toMatch(/already carries 0\.14\.1/);
    expect(decision.predecessor).toBeNull();
  });

  test("skips when an earlier submission is still open, naming it and its pull request", () => {
    const decision = submissionDecision({
      ...base,
      openSubmissions: [{ number: 7, versions: ["0.13.7"], managed: false }],
    });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toMatch(/still open/);
    expect(decision.reason).toMatch(/0\.13\.7/);
    expect(decision.reason).toMatch(/#7/);
    expect(decision.predecessor).toBeNull();
  });

  test("does not treat a pull request touching an already-merged version as pending", () => {
    // Someone else editing operators/<operator>/0.9.59/ is not a submission:
    // 0.9.59 is in the catalog already. Blocking on it would mute every
    // release for as long as that pull request stayed open.
    const decision = submissionDecision({
      ...base,
      entries: ["ci.yaml", "0.9.59"],
      openSubmissions: [{ number: 12345, versions: ["0.9.59"], managed: false }],
    });
    expect(decision.enabled).toBe(true);
    expect(decision.predecessor).toBe("0.9.59");
  });

  test("refuses when the catalog already carries a HIGHER version", () => {
    // Adding a version below the channel head leaves both unreplaced, which
    // is the "multiple channel heads" failure. Linking that graph is a
    // judgement call, so it stops here rather than guessing.
    const decision = submissionDecision({ ...base, entries: ["0.9.59", "0.15.0"] });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toMatch(/0\.15\.0/);
    expect(decision.reason).toMatch(/above/);
    expect(decision.predecessor).toBeNull();
  });

  test("skips when the operator is not in the catalog at all, because a first listing is manual", () => {
    // A null entry list means the operator directory is absent upstream.
    // Creating a listing needs review and metadata this path does not carry.
    const decision = submissionDecision({ ...base, entries: null });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toMatch(/not listed/);
    expect(decision.reason).toMatch(/manual/);
  });

  test("checks already-listed before the open-submission block", () => {
    // A rerun after a merge must read as "done", not as "blocked".
    const decision = submissionDecision({
      ...base,
      entries: ["0.9.59", "0.14.1"],
      openSubmissions: [{ number: 7, versions: ["0.13.7"], managed: false }],
    });
    expect(decision.reason).toMatch(/already carries/);
  });
});

describe("submissionOutputs", () => {
  test("emits the shape a workflow step reads, with the predecessor as a CSV name", () => {
    expect(submissionOutputs({ enabled: true, reason: "go", predecessor: "0.9.59" }, OPERATOR)).toEqual([
      "enabled=true",
      "reason=go",
      "predecessor=0.9.59",
      `replaces=${OPERATOR}.v0.9.59`,
    ]);
  });

  test("emits an empty replaces when there is no predecessor, so the field is omitted downstream", () => {
    expect(submissionOutputs({ enabled: true, reason: "first", predecessor: null }, OPERATOR)).toEqual([
      "enabled=true",
      "reason=first",
      "predecessor=",
      "replaces=",
    ]);
  });

  test("collapses newlines in a reason, which would otherwise break GITHUB_OUTPUT parsing", () => {
    const [, reason] = submissionOutputs({ enabled: false, reason: "a\nb", predecessor: null }, OPERATOR);
    expect(reason).toBe("reason=a b");
  });
});

describe("withReplaces", () => {
  const csv = ["spec:", "  maturity: alpha", "  minKubeVersion: 1.26.0", "  version: 0.14.1"].join("\n") + "\n";

  test("inserts the pointer immediately above the version, at the same indent", () => {
    expect(withReplaces(csv, `${OPERATOR}.v0.9.59`)).toBe(
      [
        "spec:",
        "  maturity: alpha",
        "  minKubeVersion: 1.26.0",
        `  replaces: ${OPERATOR}.v0.9.59`,
        "  version: 0.14.1",
      ].join("\n") + "\n",
    );
  });

  test("changes nothing else, so the submitted bundle stays the released one plus a line", () => {
    const patched = withReplaces(csv, `${OPERATOR}.v0.9.59`);
    expect(patched.split("\n").filter((line: string) => !line.includes("replaces"))).toEqual(csv.split("\n"));
  });

  test("replaces an existing pointer rather than adding a second one", () => {
    const already = withReplaces(csv, `${OPERATOR}.v0.9.59`);
    expect(withReplaces(already, `${OPERATOR}.v0.13.7`)).toBe(withReplaces(csv, `${OPERATOR}.v0.13.7`));
  });

  test("refuses a CSV with no spec.version to anchor on", () => {
    // Silently returning the text unchanged would ship an unlinked bundle and
    // fail upstream instead of here.
    expect(() => withReplaces("spec:\n  maturity: alpha\n", `${OPERATOR}.v0.9.59`)).toThrow(/spec\.version/);
  });

  test("patches the real committed CSV, inserting exactly one line", () => {
    // The unit fixtures cannot prove the anchor survives a 380-line document
    // with nested version keys, block scalars and quoted strings, so this runs
    // against the file that is actually submitted.
    const real = readFileSync(
      join(import.meta.dir, "../../operator/bundle/manifests/libredb-studio-operator.clusterserviceversion.yaml"),
      "utf8",
    );
    const patched = withReplaces(real, `${OPERATOR}.v0.9.59`);
    const added = patched.split("\n").filter((line: string) => !real.split("\n").includes(line));
    expect(added).toEqual([`  replaces: ${OPERATOR}.v0.9.59`]);
    expect(patched).toMatch(new RegExp(`^  replaces: ${OPERATOR}\\.v0\\.9\\.59\\n  version: `, "m"));
  });

  test("leaves the nested API versions of the real CSV untouched", () => {
    const real = readFileSync(
      join(import.meta.dir, "../../operator/bundle/manifests/libredb-studio-operator.clusterserviceversion.yaml"),
      "utf8",
    );
    // A control: the real document does contain deeper `version:` keys, so the
    // indent anchor is doing work rather than matching the only candidate.
    expect(real).toMatch(/^ {4,}version: /m);
    const patched = withReplaces(real, `${OPERATOR}.v0.9.59`);
    expect((patched.match(/^ *replaces: /gm) ?? []).length).toBe(1);
  });

  test("anchors on the spec-level version, not a nested one", () => {
    const nested =
      ["spec:", "  customresourcedefinitions:", "    owned:", "    - version: v1alpha1", "  version: 0.14.1"].join(
        "\n",
      ) + "\n";
    const patched = withReplaces(nested, `${OPERATOR}.v0.9.59`);
    expect(patched).toContain(`  replaces: ${OPERATOR}.v0.9.59\n  version: 0.14.1`);
    expect(patched).toContain("    - version: v1alpha1");
  });
});

// ---------------------------------------------------------------------------
// The CLI shell: a real subprocess against a temp catalog checkout and a local
// server standing in for the search API. No network.
// ---------------------------------------------------------------------------

describe("CLI", () => {
  const servers: Array<{ stop: () => void }> = [];
  const roots: string[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.stop();
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** A checked-out catalog holding the given entries as version directories. */
  function catalogDir(entries: string[] | null): string {
    const root = mkdtempSync(join(tmpdir(), "catalog-"));
    roots.push(root);
    const dir = join(root, "operators", OPERATOR);
    if (entries === null) {
      // The operator leaf is absent but the catalog layout is intact, which is
      // what a genuine first listing looks like. Skipping the parent here
      // would model a broken checkout instead.
      mkdirSync(join(root, "operators"), { recursive: true });
      return dir;
    }
    mkdirSync(dir, { recursive: true });
    for (const entry of entries) {
      if (entry.endsWith(".yaml")) {
        writeFileSync(join(dir, entry), "---\n");
      } else {
        mkdirSync(join(dir, entry), { recursive: true });
      }
    }
    return dir;
  }

  /**
   * A stand-in for the two GitHub endpoints the CLI reads: the issue search
   * and each candidate pull request's changed files.
   */
  function apiServing(
    prs: Array<{ number: number; files: string[]; headRepo?: string; headRef?: string }>,
    status = 200,
  ): string {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        if (status !== 200) {
          return new Response("nope", { status });
        }
        const path = new URL(req.url).pathname;
        if (path === "/search/issues") {
          return Response.json({ items: prs.map((pr) => ({ number: pr.number, title: "whatever" })) });
        }
        const files = path.match(/\/repos\/.+\/pulls\/(\d+)\/files$/);
        if (files) {
          const pr = prs.find((candidate) => candidate.number === Number(files[1]));
          return Response.json((pr?.files ?? []).map((filename) => ({ filename })));
        }
        const pull = path.match(/\/repos\/.+\/pulls\/(\d+)$/);
        if (pull) {
          const pr = prs.find((candidate) => candidate.number === Number(pull[1]));
          return Response.json({
            head: { ref: pr?.headRef ?? "somebody-elses-branch", repo: { full_name: pr?.headRepo ?? "someone/fork" } },
          });
        }
        return new Response("unexpected path", { status: 404 });
      },
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  }

  async function run(args: string[]) {
    const proc = Bun.spawn(["node", join(import.meta.dir, "../../scripts/operator-catalog-submission.mjs"), ...args], {
      env: { ...process.env, GITHUB_TOKEN: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test("prints the outputs a workflow step reads when a submission is due", async () => {
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      catalogDir(["ci.yaml", "0.9.59"]),
      "--repo",
      "k8s-operatorhub/community-operators",
      "--fork",
      FORK,
      "--api-base",
      apiServing([]),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("enabled=true");
    expect(result.stdout).toContain("predecessor=0.9.59");
    expect(result.stdout).toContain(`replaces=${OPERATOR}.v0.9.59`);
  });

  test("skips an already-listed version without calling the search API at all", async () => {
    // The stand-in server would 500 if it were reached, so a pass here proves
    // the offline answer stays offline.
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      catalogDir(["0.9.59", "0.14.1"]),
      "--repo",
      "k8s-operatorhub/community-operators",
      "--fork",
      FORK,
      "--api-base",
      apiServing([], 500),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("enabled=false");
    expect(result.stdout).toMatch(/reason=.*already carries 0\.14\.1/);
  });

  test("skips when the operator has no directory upstream", async () => {
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      catalogDir(null),
      "--repo",
      "k8s-operatorhub/community-operators",
      "--fork",
      FORK,
      "--api-base",
      apiServing([], 500),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("enabled=false");
    expect(result.stdout).toMatch(/reason=.*first submission is manual/);
  });

  test("skips and names the pending version when an earlier submission is open", async () => {
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      catalogDir(["ci.yaml", "0.9.59"]),
      "--repo",
      "k8s-operatorhub/community-operators",
      "--fork",
      FORK,
      "--api-base",
      apiServing([{ number: 7, files: [`operators/${OPERATOR}/0.13.7/manifests/csv.yaml`] }]),
    ]);
    expect(result.stdout).toContain("enabled=false");
    expect(result.stdout).toMatch(/reason=.*still open - 0\.13\.7 \(#7\)/);
  });

  test("does not block on a pull request that only touches our ci.yaml", async () => {
    // The search matches on the operator name anywhere, so unrelated pull
    // requests reach the files check. Blocking on one of those would stall
    // every release for no reason.
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      catalogDir(["ci.yaml", "0.9.59"]),
      "--repo",
      "k8s-operatorhub/community-operators",
      "--fork",
      FORK,
      "--api-base",
      apiServing([{ number: 9, files: [`operators/${OPERATOR}/ci.yaml`] }]),
    ]);
    expect(result.stdout).toContain("enabled=true");
    expect(result.stdout).toContain("predecessor=0.9.59");
  });

  test("fails loudly when the search API cannot be read", async () => {
    // A submission decision that depends on an unread search must not default
    // to "go" - that is how a duplicate or graph-breaking PR gets opened.
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      catalogDir(["ci.yaml", "0.9.59"]),
      "--repo",
      "k8s-operatorhub/community-operators",
      "--fork",
      FORK,
      "--api-base",
      apiServing([], 403),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/GitHub API read failed \(status 403\)/);
    expect(result.stdout).not.toContain("enabled=true");
  });

  test("prints exactly the four output lines, so a stray line cannot corrupt GITHUB_OUTPUT", async () => {
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      catalogDir(["ci.yaml", "0.9.59"]),
      "--repo",
      "k8s-operatorhub/community-operators",
      "--fork",
      FORK,
      "--api-base",
      apiServing([]),
    ]);
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "enabled=true",
      "reason=0.14.1 is not listed; replaces 0.9.59",
      "predecessor=0.9.59",
      `replaces=${OPERATOR}.v0.9.59`,
    ]);
  });

  test("fails on an unreadable operator directory instead of calling it a first submission", async () => {
    // An absent directory is a first listing; a path that exists but is not a
    // directory is a broken invocation or a changed upstream layout, and
    // reporting that as "first submission is manual" would stop submitting
    // for good with a green run.
    const root = mkdtempSync(join(tmpdir(), "notdir-"));
    roots.push(root);
    const file = join(root, "operators");
    writeFileSync(file, "not a directory");
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      file,
      "--repo",
      "k8s-operatorhub/community-operators",
      "--fork",
      FORK,
      "--api-base",
      apiServing([]),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ENOTDIR|not a directory/i);
  });

  test("a rerun for our own version updates rather than blocks, but a stranger's pull request blocks", async () => {
    const mine = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      catalogDir(["ci.yaml", "0.9.59"]),
      "--repo",
      "k8s-operatorhub/community-operators",
      "--fork",
      FORK,
      "--api-base",
      apiServing([
        {
          number: 7,
          files: [`operators/${OPERATOR}/0.14.1/manifests/csv.yaml`],
          headRepo: FORK,
          headRef: `${OPERATOR}-0.14.1`,
        },
      ]),
    ]);
    expect(mine.stdout).toContain("enabled=true");

    const theirs = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      catalogDir(["ci.yaml", "0.9.59"]),
      "--repo",
      "k8s-operatorhub/community-operators",
      "--fork",
      FORK,
      "--api-base",
      apiServing([
        {
          number: 8,
          files: [`operators/${OPERATOR}/0.14.1/manifests/csv.yaml`],
          headRepo: "stranger/community-operators",
          headRef: `${OPERATOR}-0.14.1`,
        },
      ]),
    ]);
    expect(theirs.stdout).toContain("enabled=false");
    expect(theirs.stdout).toMatch(/reason=.*0\.14\.1 \(#8\)/);
  });

  test("fails when the catalog layout itself is missing, not just the operator", async () => {
    // readdir raises ENOENT for a missing PARENT too, so "operators/ is gone"
    // and "this operator has no directory yet" arrive as the same error. Only
    // the second is a manual first listing; reading the first that way would
    // green-skip every release after an upstream rename.
    const root = mkdtempSync(join(tmpdir(), "nolayout-"));
    roots.push(root);
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      join(root, "operators", OPERATOR),
      "--repo",
      "a/b",
      "--fork",
      FORK,
      "--api-base",
      apiServing([], 500),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/operators/);
    expect(result.stdout).not.toContain("first submission is manual");
  });

  test("still reports a genuinely unlisted operator as a manual first listing", async () => {
    // The control for the test above: the parent exists, the leaf does not.
    const root = mkdtempSync(join(tmpdir(), "nooperator-"));
    roots.push(root);
    mkdirSync(join(root, "operators"), { recursive: true });
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      join(root, "operators", OPERATOR),
      "--repo",
      "a/b",
      "--fork",
      FORK,
      "--api-base",
      apiServing([], 500),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/first submission is manual/);
  });

  test("fails when the search response is not the expected shape", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ nope: true }) });
    servers.push(server);
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      catalogDir(["ci.yaml", "0.9.59"]),
      "--repo",
      "a/b",
      "--fork",
      FORK,
      "--api-base",
      `http://127.0.0.1:${server.port}`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/no items array/);
  });

  test("fails when a pull request's changed files are not a list", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/search/issues"
          ? Response.json({ items: [{ number: 4 }] })
          : Response.json({ message: "Not Found" }),
    });
    servers.push(server);
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      catalogDir(["ci.yaml", "0.9.59"]),
      "--repo",
      "a/b",
      "--fork",
      FORK,
      "--api-base",
      `http://127.0.0.1:${server.port}`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/changed files unreadable/);
  });

  test("refuses an empty --operator rather than building a malformed replaces", async () => {
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator",
      "",
      "--operator-dir",
      catalogDir(["ci.yaml", "0.9.59"]),
      "--repo",
      "a/b",
      "--fork",
      FORK,
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/--operator/);
  });

  test("set-replaces refuses a missing flag", async () => {
    const missingReplaces = await run(["set-replaces", "--csv", "/tmp/does-not-matter"]);
    expect(missingReplaces.exitCode).toBe(2);
    expect(missingReplaces.stderr).toMatch(/--csv and --replaces/);
  });

  test("refuses a missing or malformed version instead of guessing", async () => {
    const dir = catalogDir(["0.9.59"]);
    const missing = await run(["decide", "--operator-dir", dir, "--repo", "a/b", "--fork", FORK]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toMatch(/--version is required/);

    const noDir = await run(["decide", "--version", "0.14.1", "--repo", "a/b", "--fork", FORK]);
    expect(noDir.exitCode).toBe(2);
    expect(noDir.stderr).toMatch(/--operator-dir is required/);

    const malformed = await run([
      "decide",
      "--version",
      "v0.14.1",
      "--operator-dir",
      dir,
      "--repo",
      "a/b",
      "--fork",
      FORK,
    ]);
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stderr).toMatch(/bare semver/);
  });

  test("set-replaces writes the pointer into a CSV file in place", async () => {
    const root = mkdtempSync(join(tmpdir(), "csv-"));
    roots.push(root);
    const file = join(root, "csv.yaml");
    writeFileSync(file, "spec:\n  maturity: alpha\n  version: 0.14.1\n");
    const result = await run(["set-replaces", "--csv", file, "--replaces", `${OPERATOR}.v0.9.59`]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      `spec:\n  maturity: alpha\n  replaces: ${OPERATOR}.v0.9.59\n  version: 0.14.1\n`,
    );
  });

  test("set-replaces fails rather than shipping an unlinked bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "csv-"));
    roots.push(root);
    const file = join(root, "csv.yaml");
    writeFileSync(file, "spec:\n  maturity: alpha\n");
    const result = await run(["set-replaces", "--csv", file, "--replaces", `${OPERATOR}.v0.9.59`]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/spec\.version/);
  });

  test("refuses an unknown command instead of doing something plausible", async () => {
    const result = await run(["publish"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/unknown command/);
  });

  test("refuses when the target repo is not given", async () => {
    const result = await run([
      "decide",
      "--version",
      "0.14.1",
      "--operator-dir",
      catalogDir(["0.9.59"]),
      "--fork",
      FORK,
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/--repo is required/);
  });
});

// ---------------------------------------------------------------------------
// Workflow wiring. The matrix that decides where a submission is pushed is
// configuration, so nothing else in the suite would notice a typo'd slug or a
// fork paired with the wrong upstream until a release tried it.
// ---------------------------------------------------------------------------

describe("the submit-catalogs matrix", () => {
  const workflow = parse(
    readFileSync(join(import.meta.dir, "../../.github/workflows/operator-release.yml"), "utf8"),
  ) as {
    jobs: Record<
      string,
      {
        needs?: string;
        if?: string;
        strategy?: {
          "fail-fast"?: boolean;
          matrix?: { catalog?: Array<{ label: string; upstream: string; fork: string; release_config: boolean }> };
        };
      }
    >;
  };
  const job = workflow.jobs["submit-catalogs"];
  const catalogs = job.strategy?.matrix?.catalog ?? [];

  test("covers both community catalogs", () => {
    expect(catalogs.map((entry) => entry.upstream).sort()).toEqual([
      "k8s-operatorhub/community-operators",
      "redhat-openshift-ecosystem/community-operators-prod",
    ]);
  });

  test("pairs each upstream with the fork of that same upstream", () => {
    // A fork paired with the wrong upstream would push a bundle into the other
    // catalog's fork and open a pull request that cannot merge. The fork name
    // mirrors the upstream repository name, which is what makes this checkable
    // without the network.
    for (const entry of catalogs) {
      expect(entry.fork).toBe(`libredb/${entry.upstream.split("/")[1]}`);
    }
  });

  test("every fork is org-owned, because they were transferred there", () => {
    for (const entry of catalogs) {
      expect(entry.fork.startsWith("libredb/")).toBe(true);
    }
  });

  test("release-config is written for the FBC catalog only", () => {
    const withConfig = catalogs.filter((entry) => entry.release_config).map((entry) => entry.upstream);
    expect(withConfig).toEqual(["redhat-openshift-ecosystem/community-operators-prod"]);
  });

  test("release_config is a boolean, not a string that would read as truthy", () => {
    // `release_config: "false"` in YAML is a non-empty string, so the step's
    // `&& matrix.catalog.release_config` guard would run for both catalogs.
    for (const entry of catalogs) {
      expect(typeof entry.release_config).toBe("boolean");
    }
  });

  test("one catalog failing does not cancel the other", () => {
    expect(job.strategy?.["fail-fast"]).toBe(false);
  });

  test("the job runs only after the controller image is pushed, and only for a submittable version", () => {
    expect(job.needs).toBe("build-and-push");
    expect(job.if).toContain("needs.build-and-push.outputs.skip != 'true'");
    expect(job.if).toContain("needs.build-and-push.outputs.submittable == 'true'");
  });
});

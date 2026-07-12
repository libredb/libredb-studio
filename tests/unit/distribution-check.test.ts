/**
 * Unit tests for the distribution visibility matrix checker
 * (scripts/distribution-check.mjs, distribution/channels.yaml).
 * The core functions (parseChannels, extractPin, evaluateChannel,
 * strictFailures, renderTable, linkLabel) are pure; the CLI describe blocks
 * run the real script as a subprocess against throwaway temp-dir fixtures,
 * with remote pins served by a local Bun.serve instance - no real network.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateChannel,
  extractPin,
  linkLabel,
  parseChannels,
  renderTable,
  strictFailures,
} from "../../scripts/distribution-check.mjs";

function channelsYaml(rows: string): string {
  return `channels:\n${rows}`;
}

const HELM_ROW = `  - id: helm
    name: Helm chart
    status: live
    tier: 1
    kind: chart
    update:
      method: ci_publish
      sla: every_release
    links:
      tracking_issue: https://github.com/libredb/libredb-studio/issues/138
    pin:
      strategy: local_file
      files:
        - charts/libredb-studio/Chart.yaml
      extract: 'appVersion: "(\\d+\\.\\d+\\.\\d+)"'
`;

const NONE_ROW = `  - id: npm
    name: npm package
    status: live
    tier: 0
    kind: package-registry
    update:
      method: ci_publish
      sla: every_release
    pin:
      strategy: none
      note: Published by npm-publish.yml on every release.
`;

describe("parseChannels", () => {
  test("parses a valid inventory", () => {
    const channels = parseChannels(channelsYaml(HELM_ROW + NONE_ROW));
    expect(channels.length).toBe(2);
    expect(channels[0].id).toBe("helm");
    expect(channels[0].pin.files).toEqual(["charts/libredb-studio/Chart.yaml"]);
    expect(channels[1].pin.strategy).toBe("none");
  });

  test("throws when the top-level channels list is missing", () => {
    expect(() => parseChannels("foo: bar\n")).toThrow(/channels/);
  });

  test("throws on a duplicate id", () => {
    expect(() => parseChannels(channelsYaml(HELM_ROW + HELM_ROW))).toThrow(/duplicate/i);
  });

  test("throws on an unknown pin strategy", () => {
    const bad = HELM_ROW.replace("strategy: local_file", "strategy: registry_api");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/strategy/);
  });

  test("throws on an unknown status", () => {
    const bad = HELM_ROW.replace("status: live", "status: shipped");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/status/);
  });

  test("throws when a local_file channel has no files", () => {
    const bad = HELM_ROW.replace(/ {6}files:\n {8}- [^\n]+\n/, "");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/files/);
  });

  test("throws when a measurable pin has no extract capture group", () => {
    const bad = HELM_ROW.replace("extract: 'appVersion: \"(\\d+\\.\\d+\\.\\d+)\"'", "extract: 'appVersion'");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/capture group/);
  });

  test("throws when a measurable pin has more than one capture group (extractPin reads only the first)", () => {
    const bad = HELM_ROW.replace(
      "extract: 'appVersion: \"(\\d+\\.\\d+\\.\\d+)\"'",
      "extract: '(appVersion): \"(\\d+\\.\\d+\\.\\d+)\"'",
    );
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/capture group/);
  });

  test("throws when a remote_file channel has no url", () => {
    const bad = HELM_ROW.replace("strategy: local_file", "strategy: remote_file").replace(
      / {6}files:\n {8}- [^\n]+\n/,
      "",
    );
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/url/);
  });
});

describe("extractPin", () => {
  test("extracts a single pinned version", () => {
    expect(
      extractPin("image: ghcr.io/libredb/libredb-studio:0.9.27\n", "libredb-studio:(\\d+\\.\\d+\\.\\d+)", "x"),
    ).toBe("0.9.27");
  });

  test("agreeing duplicate matches collapse to one version", () => {
    const content = "a: libredb-studio:0.9.22\nb: libredb-studio:0.9.22\n";
    expect(extractPin(content, "libredb-studio:(\\d+\\.\\d+\\.\\d+)", "x")).toBe("0.9.22");
  });

  test("throws when nothing matches", () => {
    expect(() => extractPin("no pins here", "libredb-studio:(\\d+\\.\\d+\\.\\d+)", "railway")).toThrow(/railway/);
  });

  test("throws when matches disagree instead of silently using the first", () => {
    const content = "a: libredb-studio:0.9.22\nb: libredb-studio:0.9.27\n";
    expect(() => extractPin(content, "libredb-studio:(\\d+\\.\\d+\\.\\d+)", "x")).toThrow(/disagree/);
  });

  test("extracts across lines (kubero repository/tag style)", () => {
    const content = "    repository: ghcr.io/libredb/libredb-studio\n    tag: 0.9.27\n";
    expect(extractPin(content, "ghcr\\.io/libredb/libredb-studio\\s+tag:\\s*(\\d+\\.\\d+\\.\\d+)", "kubero")).toBe(
      "0.9.27",
    );
  });
});

function helmChannel() {
  return parseChannels(channelsYaml(HELM_ROW))[0];
}

describe("evaluateChannel", () => {
  const chartInSync = 'version: 0.1.13\nappVersion: "0.9.53"\n';
  const chartBehind = 'version: 0.1.12\nappVersion: "0.9.44"\n';

  test("a matching local pin is ok", () => {
    const row = evaluateChannel(helmChannel(), "0.9.53", {
      "charts/libredb-studio/Chart.yaml": chartInSync,
    });
    expect(row.status).toBe("ok");
    expect(row.observed).toBe("0.9.53");
    expect(row.expected).toBe("0.9.53");
  });

  test("a drifted local pin is drift", () => {
    const row = evaluateChannel(helmChannel(), "0.9.53", {
      "charts/libredb-studio/Chart.yaml": chartBehind,
    });
    expect(row.status).toBe("drift");
    expect(row.observed).toBe("0.9.44");
  });

  test("files that disagree among themselves are drift and both versions are visible", () => {
    const channel = parseChannels(
      channelsYaml(
        HELM_ROW.replace(/ {6}files:\n {8}- [^\n]+\n/, "      files:\n        - a.yaml\n        - b.yaml\n"),
      ),
    )[0];
    const row = evaluateChannel(channel, "0.9.53", {
      "a.yaml": 'appVersion: "0.9.53"\n',
      "b.yaml": 'appVersion: "0.9.22"\n',
    });
    expect(row.status).toBe("drift");
    expect(row.observed).toContain("0.9.53");
    expect(row.observed).toContain("0.9.22");
  });

  test("an unreadable source is unknown, not a crash", () => {
    const row = evaluateChannel(helmChannel(), "0.9.53", {
      "charts/libredb-studio/Chart.yaml": null,
    });
    expect(row.status).toBe("unknown");
    expect(row.detail).toContain("Chart.yaml");
  });

  test("a source where the extract regex finds nothing is unknown with a detail", () => {
    const row = evaluateChannel(helmChannel(), "0.9.53", {
      "charts/libredb-studio/Chart.yaml": "totally unrelated content",
    });
    expect(row.status).toBe("unknown");
    expect(row.detail).toContain("no version");
  });

  test("a pin-less channel is skip", () => {
    const channel = parseChannels(channelsYaml(NONE_ROW))[0];
    const row = evaluateChannel(channel, "0.9.53", {});
    expect(row.status).toBe("skip");
    expect(row.observed).toBe("-");
  });

  test("a pending channel is skip even with a measurable pin", () => {
    const channel = parseChannels(channelsYaml(HELM_ROW.replace("status: live", "status: pending")))[0];
    const row = evaluateChannel(channel, "0.9.53", {});
    expect(row.status).toBe("skip");
  });
});

describe("strictFailures", () => {
  function row(overrides: Record<string, unknown>) {
    return {
      id: "x",
      status: "drift",
      strategy: "local_file",
      sla: "every_release",
      ...overrides,
    };
  }

  test("a drifted every_release local pin fails strict", () => {
    expect(strictFailures([row({})]).length).toBe(1);
  });

  test("an unknown every_release local pin fails strict (owned file must be measurable)", () => {
    expect(strictFailures([row({ status: "unknown" })]).length).toBe(1);
  });

  test("an on_demand local pin never fails strict", () => {
    expect(strictFailures([row({ sla: "on_demand" })]).length).toBe(0);
  });

  test("remote pins never fail strict in v1", () => {
    expect(strictFailures([row({ strategy: "remote_file" })]).length).toBe(0);
  });

  test("ok and skip rows never fail strict", () => {
    expect(strictFailures([row({ status: "ok" }), row({ status: "skip" })]).length).toBe(0);
  });
});

describe("linkLabel", () => {
  test("shortens an issue in this repo to #N", () => {
    expect(linkLabel("https://github.com/libredb/libredb-studio/issues/56")).toBe("#56");
  });

  test("keeps owner/repo for an upstream PR", () => {
    expect(linkLabel("https://github.com/Dokploy/templates/pull/931")).toBe("Dokploy/templates#931");
  });

  test("falls back to the word link for a non-GitHub url", () => {
    expect(linkLabel("https://templates.dokploy.com")).toBe("link");
  });
});

describe("renderTable", () => {
  test("renders one row per channel with plain-text statuses and links", () => {
    const channels = parseChannels(channelsYaml(HELM_ROW + NONE_ROW));
    const rows = [
      evaluateChannel(channels[0], "0.9.53", {
        "charts/libredb-studio/Chart.yaml": 'appVersion: "0.9.44"\n',
      }),
      evaluateChannel(channels[1], "0.9.53", {}),
    ];
    const table = renderTable(rows, "0.9.53");
    expect(table).toContain("| DRIFT |");
    expect(table).toContain("| SKIP |");
    expect(table).toContain("helm");
    expect(table).toContain("0.9.44");
    expect(table).toContain("[#138](https://github.com/libredb/libredb-studio/issues/138)");
    // No emoji, ever (house rule): the status column is plain text.
    expect(table).not.toMatch(/[\u{1F300}-\u{1FAFF}✅❌⚠]/u);
  });
});

const SCRIPT = join(import.meta.dir, "../../scripts/distribution-check.mjs");

function writeFixture(root: string, pkgVersion: string, channels: string): void {
  mkdirSync(join(root, "distribution"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: pkgVersion }));
  writeFileSync(join(root, "distribution/channels.yaml"), channels);
}

function runCheck(root: string, args: string[] = [], env: Record<string, string> = {}) {
  return Bun.spawnSync(["node", SCRIPT, "--root", root, ...args], {
    env: { ...process.env, GITHUB_STEP_SUMMARY: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("CLI (subprocess against temp fixtures)", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeFixture(pkgVersion: string, channels: string): string {
    const root = mkdtempSync(join(tmpdir(), "dist-check-"));
    fixtureRoots.push(root);
    writeFixture(root, pkgVersion, channels);
    return root;
  }

  function localRow(sla: string): string {
    return `  - id: railway
    name: Railway template
    status: live
    tier: 2
    kind: paas-template
    update:
      method: manual_ui
      sla: ${sla}
    pin:
      strategy: local_file
      files:
        - deploy/railway/template.json
      extract: 'libredb-studio:(\\d+\\.\\d+\\.\\d+)'
`;
  }

  function fixtureWithLocalPin(sla: string, pinned: string): string {
    const root = makeFixture("0.9.53", channelsYaml(localRow(sla)));
    mkdirSync(join(root, "deploy/railway"), { recursive: true });
    writeFileSync(join(root, "deploy/railway/template.json"), `{"image": "ghcr.io/libredb/libredb-studio:${pinned}"}`);
    return root;
  }

  test("drift is reported in the table but exits 0 by default (warn-only)", () => {
    const root = fixtureWithLocalPin("on_demand", "0.9.22");
    const result = runCheck(root);
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("DRIFT");
    expect(stdout).toContain("0.9.22");
    expect(stdout).toContain("0.9.53");
  });

  test("--strict exits 1 when an every_release local pin drifts", () => {
    const root = fixtureWithLocalPin("every_release", "0.9.22");
    const result = runCheck(root, ["--strict"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("strict");
  });

  test("--strict exits 0 when only an on_demand local pin drifts", () => {
    const root = fixtureWithLocalPin("on_demand", "0.9.22");
    const result = runCheck(root, ["--strict"]);
    expect(result.exitCode).toBe(0);
  });

  test("--json emits machine-readable rows", () => {
    const root = fixtureWithLocalPin("on_demand", "0.9.22");
    const result = runCheck(root, ["--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.toString());
    expect(parsed.expected).toBe("0.9.53");
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0].status).toBe("drift");
  });

  test("the table is appended to GITHUB_STEP_SUMMARY when set", () => {
    const root = fixtureWithLocalPin("on_demand", "0.9.22");
    const summaryFile = join(root, "summary.md");
    writeFileSync(summaryFile, "existing\n");
    const result = runCheck(root, [], { GITHUB_STEP_SUMMARY: summaryFile });
    expect(result.exitCode).toBe(0);
    const summary = readFileSync(summaryFile, "utf8");
    expect(summary).toContain("existing");
    expect(summary).toContain("DRIFT");
  });

  test("a missing local pin file is unknown, not a crash", () => {
    const root = makeFixture("0.9.53", channelsYaml(localRow("on_demand")));
    const result = runCheck(root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("UNKNOWN");
  });

  test("--root with no value exits 2 with usage", () => {
    const result = Bun.spawnSync(["node", SCRIPT, "--root"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("--root requires");
  });
});

describe("CLI (remote pins against a local server)", () => {
  const fixtureRoots: string[] = [];
  const servers: Array<{ stop: () => void }> = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const server of servers.splice(0)) server.stop();
  });

  function remoteFixture(url: string): string {
    const root = mkdtempSync(join(tmpdir(), "dist-check-remote-"));
    fixtureRoots.push(root);
    const row = `  - id: dokploy
    name: Dokploy template
    status: live
    tier: 3
    kind: paas-template
    update:
      method: upstream_pr
      sla: on_demand
    pin:
      strategy: remote_file
      url: ${url}
      extract: 'libredb-studio:(\\d+\\.\\d+\\.\\d+)'
`;
    writeFixture(root, "0.9.53", channelsYaml(row));
    return root;
  }

  function serve(handler: (req: Request) => Response): string {
    const server = Bun.serve({ port: 0, fetch: handler });
    servers.push(server);
    return `http://127.0.0.1:${server.port}/pin.yml`;
  }

  // Bun.spawnSync would block the event loop and deadlock against the
  // in-process Bun.serve fixture, so the remote tests spawn asynchronously.
  async function runCheckAsync(root: string) {
    const proc = Bun.spawn(["node", SCRIPT, "--root", root], {
      env: { ...process.env, GITHUB_STEP_SUMMARY: "", DISTRIBUTION_CHECK_TIMEOUT_MS: "3000" },
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

  test("a reachable remote pin is compared like a local one", async () => {
    const url = serve(() => new Response("image: ghcr.io/libredb/libredb-studio:0.9.27\n"));
    const result = await runCheckAsync(remoteFixture(url));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DRIFT");
    expect(result.stdout).toContain("0.9.27");
  });

  test("a failing remote fetch degrades to UNKNOWN and still exits 0", async () => {
    const url = serve(() => new Response("boom", { status: 500 }));
    const result = await runCheckAsync(remoteFixture(url));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("UNKNOWN");
  });

  test("an unreachable host degrades to UNKNOWN and still exits 0", async () => {
    // Port 1 is reserved and closed: connection refused, no timeout wait.
    const result = await runCheckAsync(remoteFixture("http://127.0.0.1:1/pin.yml"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("UNKNOWN");
  });
});

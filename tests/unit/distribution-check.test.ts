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
  SWITCHABLE_CHANNEL_IDS,
  applyMatrixMarkers,
  buildChannelsDoc,
  channelHref,
  ciEnabledOutputs,
  digestVerdict,
  docsHref,
  evaluateChannel,
  extractPin,
  githubAuthHeaders,
  guideLabel,
  humanizeSla,
  linkLabel,
  maxPublishedVersion,
  parseChannels,
  parseSnapVersions,
  platformCell,
  renderChannelMatrix,
  renderScorecard,
  renderTable,
  strictFailures,
  updateSummary,
} from "../../scripts/distribution-check.mjs";

function channelsYaml(rows: string): string {
  return `channels:\n${rows}`;
}

const HELM_ROW = `  - id: helm
    name: Helm chart
    status: live
    category: kubernetes-operators
    platforms: [kubernetes]
    tier: 1
    kind: helm-chart
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
    category: registries-releases
    platforms: [linux, macos, windows]
    tier: 0
    kind: package-registry
    update:
      method: ci_publish
      sla: every_release
    pin:
      strategy: none
      note: Published by npm-publish.yml on every release.
`;

const PROBE_ROW = `  - id: docker-ghcr
    name: Docker image (GHCR, canonical)
    status: live
    category: containers
    platforms: [container]
    tier: 0
    kind: container-image
    update:
      method: ci_publish
      sla: every_release
    pin:
      strategy: probe
      probe: ghcr-tag-digest
      urls:
        token: https://ghcr.io/token?service=ghcr.io&scope=repository:libredb/libredb-studio:pull
        manifest: https://ghcr.io/v2/libredb/libredb-studio/manifests/{ref}
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

  test("throws when category is missing", () => {
    const bad = HELM_ROW.replace("    category: kubernetes-operators\n", "");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/category/);
  });

  test("throws on an unknown category", () => {
    const bad = HELM_ROW.replace("category: kubernetes-operators", "category: not-a-real-bucket");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/category/);
  });

  test("accepts a known category", () => {
    const channels = parseChannels(channelsYaml(HELM_ROW));
    expect(channels[0].category).toBe("kubernetes-operators");
  });

  test("throws when kind is missing", () => {
    const bad = HELM_ROW.replace(/ {4}kind: [^\n]+\n/, "");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/kind/);
  });

  test("throws on an unknown kind", () => {
    const bad = HELM_ROW.replace(/kind: [^\n]+/, "kind: not-a-real-kind");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/kind/);
  });

  test("accepts a known kind", () => {
    const channels = parseChannels(channelsYaml(NONE_ROW));
    expect(channels[0].kind).toBe("package-registry");
  });

  test("throws when platforms is missing", () => {
    const bad = HELM_ROW.replace("    platforms: [kubernetes]\n", "");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/platforms must be a non-empty list/);
  });

  test("throws when platforms is empty", () => {
    const bad = HELM_ROW.replace("platforms: [kubernetes]", "platforms: []");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/platforms must be a non-empty list/);
  });

  test("throws on an unknown platform id", () => {
    const bad = HELM_ROW.replace("platforms: [kubernetes]", "platforms: [kubernetes, plan9]");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/platforms entries must be one of/);
  });

  test("accepts a multi-valued platforms list", () => {
    const row = HELM_ROW.replace("platforms: [kubernetes]", "platforms: [macos, linux]");
    expect(parseChannels(channelsYaml(row))[0].platforms).toEqual(["macos", "linux"]);
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

  test("parses a probe channel", () => {
    const channels = parseChannels(channelsYaml(PROBE_ROW));
    expect(channels[0].pin.strategy).toBe("probe");
    expect(channels[0].pin.probe).toBe("ghcr-tag-digest");
    expect(channels[0].pin.urls.manifest).toContain("{ref}");
  });

  test("a probe pin needs no extract pattern", () => {
    expect(() => parseChannels(channelsYaml(PROBE_ROW))).not.toThrow();
  });

  test("throws on an unknown probe id", () => {
    const bad = PROBE_ROW.replace("probe: ghcr-tag-digest", "probe: guess-the-version");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/pin\.probe must be one of/);
  });

  test("throws when a probe channel omits a url its probe requires", () => {
    const bad = PROBE_ROW.replace(/ {8}manifest: [^\n]+\n/, "");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/needs pin\.urls\.manifest/);
  });

  test("throws when a probe channel has no urls block at all", () => {
    const bad = PROBE_ROW.replace(/ {6}urls:\n(?: {8}[^\n]+\n)+/, "");
    expect(() => parseChannels(channelsYaml(bad))).toThrow(/needs pin\.urls/);
  });
});

describe("githubAuthHeaders", () => {
  const original = process.env.GITHUB_TOKEN;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = original;
    }
  });

  test("attaches the token to api.github.com, where the anonymous rate limit bites", () => {
    process.env.GITHUB_TOKEN = "ghp_example";
    expect(githubAuthHeaders("https://api.github.com/repos/microsoft/winget-pkgs/contents/x")).toEqual({
      authorization: "Bearer ghp_example",
    });
  });

  test("never leaks the token to another host", () => {
    process.env.GITHUB_TOKEN = "ghp_example";
    expect(githubAuthHeaders("https://hub.docker.com/v2/repositories/libredb/libredb-studio/tags/latest")).toEqual({});
  });

  test("sends no authorization at all when no token is configured", () => {
    delete process.env.GITHUB_TOKEN;
    expect(githubAuthHeaders("https://api.github.com/repos/microsoft/winget-pkgs/contents/x")).toEqual({});
  });
});

describe("digestVerdict (GHCR / Docker Hub served-tag comparison)", () => {
  test("equal digests report the expected version", () => {
    const result = digestVerdict({
      latest: { status: 200, digest: "sha256:aaa" },
      tagged: { status: 200, digest: "sha256:aaa" },
      expected: "0.9.64",
    });
    expect(result.versions).toEqual([{ source: "latest", version: "0.9.64" }]);
  });

  test("differing digests report a version that cannot equal the expected one", () => {
    const result = digestVerdict({
      latest: { status: 200, digest: "sha256:old" },
      tagged: { status: 200, digest: "sha256:new" },
      expected: "0.9.64",
    });
    expect(result.versions?.[0]?.version).toBe("!=0.9.64");
    expect(result.detail).toContain("sha256:old");
    expect(result.detail).toContain("sha256:new");
  });

  test("a missing version tag is drift, not unknown - this is the silently-skipped mirror push", () => {
    const result = digestVerdict({
      latest: { status: 200, digest: "sha256:aaa" },
      tagged: { status: 404, digest: null },
      expected: "0.9.64",
    });
    expect(result.error).toBeUndefined();
    expect(result.versions?.[0]?.version).toBe("!=0.9.64");
    expect(result.detail).toMatch(/0\.9\.64.*not published|no 0\.9\.64/i);
  });

  test("a missing latest tag is drift - nobody can pull :latest", () => {
    const result = digestVerdict({
      latest: { status: 404, digest: null },
      tagged: { status: 200, digest: "sha256:aaa" },
      expected: "0.9.64",
    });
    expect(result.versions?.[0]?.version).toBe("!=0.9.64");
    expect(result.detail).toMatch(/latest/i);
  });

  test("a transient registry error degrades to UNKNOWN rather than inventing drift", () => {
    const result = digestVerdict({
      latest: { status: 500, digest: null },
      tagged: { status: 200, digest: "sha256:aaa" },
      expected: "0.9.64",
    });
    expect(result.error).toMatch(/unreachable/i);
    expect(result.versions).toBeUndefined();
  });

  test("a network failure degrades to UNKNOWN rather than inventing drift", () => {
    const result = digestVerdict({
      latest: { status: null, digest: null },
      tagged: { status: 200, digest: "sha256:aaa" },
      expected: "0.9.64",
    });
    expect(result.error).toMatch(/unreachable/i);
    expect(result.versions).toBeUndefined();
  });
});

describe("parseSnapVersions", () => {
  const info = {
    "channel-map": [
      { channel: { track: "latest", risk: "stable", architecture: "amd64" }, version: "0.9.64" },
      { channel: { track: "latest", risk: "stable", architecture: "arm64" }, version: "0.9.64" },
      { channel: { track: "latest", risk: "edge", architecture: "amd64" }, version: "0.9.52" },
    ],
  };

  test("reads the stable version of every requested architecture", () => {
    expect(parseSnapVersions(info, ["amd64", "arm64"])).toEqual({
      versions: [
        { source: "amd64", version: "0.9.64" },
        { source: "arm64", version: "0.9.64" },
      ],
    });
  });

  test("ignores the edge channel, which may legitimately differ from stable", () => {
    const result = parseSnapVersions(info, ["amd64"]);
    expect(result.versions).toEqual([{ source: "amd64", version: "0.9.64" }]);
  });

  test("a stale architecture surfaces as two disagreeing sources, not a silent pass", () => {
    const lagging = {
      "channel-map": [
        { channel: { track: "latest", risk: "stable", architecture: "amd64" }, version: "0.9.64" },
        { channel: { track: "latest", risk: "stable", architecture: "arm64" }, version: "0.9.63" },
      ],
    };
    expect(parseSnapVersions(lagging, ["amd64", "arm64"]).versions).toEqual([
      { source: "amd64", version: "0.9.64" },
      { source: "arm64", version: "0.9.63" },
    ]);
  });

  test("an architecture missing from the stable channel is an error", () => {
    expect(parseSnapVersions(info, ["amd64", "riscv64"]).error).toMatch(/riscv64/);
  });

  test("a response without a channel-map is an error", () => {
    expect(parseSnapVersions({}, ["amd64"]).error).toMatch(/channel-map/);
  });
});

describe("maxPublishedVersion (winget enumerates every version, with no floating latest)", () => {
  test("picks the highest version", () => {
    expect(maxPublishedVersion(["0.9.59", "0.9.64"]).versions).toEqual([{ source: "catalog", version: "0.9.64" }]);
  });

  test("compares numerically, not lexicographically", () => {
    expect(maxPublishedVersion(["0.9.9", "0.9.64", "0.10.0"]).versions?.[0]?.version).toBe("0.10.0");
  });

  test("ignores entries that are not versions", () => {
    expect(maxPublishedVersion([".validation", "0.9.64"]).versions?.[0]?.version).toBe("0.9.64");
  });

  test("an enumeration with no version at all is an error", () => {
    expect(maxPublishedVersion([".validation"]).error).toMatch(/no published version/i);
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

  test("a probe whose resolved version matches is ok", () => {
    const channel = parseChannels(channelsYaml(PROBE_ROW))[0];
    const row = evaluateChannel(channel, "0.9.64", {
      "probe:docker-ghcr": { versions: [{ source: "latest", version: "0.9.64" }] },
    });
    expect(row.status).toBe("ok");
    expect(row.observed).toBe("0.9.64");
  });

  test("a probe verdict that cannot equal the expected version is drift, and its detail is kept", () => {
    const channel = parseChannels(channelsYaml(PROBE_ROW))[0];
    const row = evaluateChannel(channel, "0.9.65", {
      "probe:docker-ghcr": {
        versions: [{ source: "latest", version: "!=0.9.65" }],
        detail: "latest -> sha256:old, 0.9.65 -> sha256:new",
      },
    });
    expect(row.status).toBe("drift");
    expect(row.detail).toBe("latest -> sha256:old, 0.9.65 -> sha256:new");
  });

  test("a probe error is unknown, never drift", () => {
    const channel = parseChannels(channelsYaml(PROBE_ROW))[0];
    const row = evaluateChannel(channel, "0.9.64", {
      "probe:docker-ghcr": { error: "registry unreachable (latest=500, 0.9.64=200)" },
    });
    expect(row.status).toBe("unknown");
    expect(row.detail).toContain("unreachable");
  });

  test("a probe that never ran is unknown", () => {
    const channel = parseChannels(channelsYaml(PROBE_ROW))[0];
    expect(evaluateChannel(channel, "0.9.64", {}).status).toBe("unknown");
  });

  test("probe sources that disagree are drift with every source visible", () => {
    const channel = parseChannels(channelsYaml(PROBE_ROW))[0];
    const row = evaluateChannel(channel, "0.9.64", {
      "probe:docker-ghcr": {
        versions: [
          { source: "amd64", version: "0.9.64" },
          { source: "arm64", version: "0.9.63" },
        ],
      },
    });
    expect(row.status).toBe("drift");
    expect(row.detail).toContain("amd64=0.9.64");
    expect(row.detail).toContain("arm64=0.9.63");
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

// ---------------------------------------------------------------------------
// update.ci_enabled - the release CI's per-channel automation switch
// ---------------------------------------------------------------------------

function switchableRow(id: string, enabled: boolean): string {
  return `  - id: ${id}
    name: ${id} channel
    status: live
    category: package-managers
    platforms: [linux]
    tier: 1
    kind: package-manager
    update:
      method: ci_publish
      sla: every_release
      ci_enabled: ${enabled}
    pin:
      strategy: none
      note: Publishing is gated on ci_enabled.
`;
}

describe("update.ci_enabled", () => {
  test("the switchable set is exactly the optional channels", () => {
    // The core release path (github-release, docker-ghcr, npm, helm) and the
    // required release assets are deliberately absent: a flag there would be a
    // way to publish a release with no npm package or no image.
    expect([...SWITCHABLE_CHANNEL_IDS].sort()).toEqual([
      "chocolatey",
      "docker-hub-mirror",
      "homebrew",
      "snap",
      "winget",
    ]);
  });

  test("accepts a boolean flag on a switchable channel", () => {
    const channels = parseChannels(channelsYaml(switchableRow("snap", true) + switchableRow("chocolatey", false)));
    expect(channels[0].update.ci_enabled).toBe(true);
    expect(channels[1].update.ci_enabled).toBe(false);
  });

  test("throws when a switchable channel omits the flag", () => {
    const row = switchableRow("snap", true).replace("      ci_enabled: true\n", "");
    expect(() => parseChannels(channelsYaml(row))).toThrow(/snap.*ci_enabled/);
  });

  test("throws when the flag is not a boolean", () => {
    const row = switchableRow("snap", true).replace("ci_enabled: true", 'ci_enabled: "on"');
    expect(() => parseChannels(channelsYaml(row))).toThrow(/ci_enabled/);
  });

  test("throws when the flag appears on a channel that must not be switchable", () => {
    const row = NONE_ROW.replace("      sla: every_release\n", "      sla: every_release\n      ci_enabled: false\n");
    expect(() => parseChannels(channelsYaml(row))).toThrow(/npm.*ci_enabled/);
  });

  test("ciEnabledOutputs emits one GITHUB_OUTPUT line per switchable channel", () => {
    const channels = parseChannels(
      channelsYaml(switchableRow("snap", true) + switchableRow("docker-hub-mirror", false) + NONE_ROW),
    );
    // Dashes become underscores: a GitHub expression cannot dot-access an
    // output name containing a dash.
    expect(ciEnabledOutputs(channels)).toEqual(["snap=true", "docker_hub_mirror=false"]);
  });

  test("the real inventory declares the flag for every switchable channel", () => {
    const channels = parseChannels(readFileSync(join(import.meta.dir, "../../distribution/channels.yaml"), "utf8"));
    const declared = channels.filter((c: { update: { ci_enabled?: boolean } }) => c.update.ci_enabled !== undefined);
    expect(declared.map((c: { id: string }) => c.id).sort()).toEqual([...SWITCHABLE_CHANNEL_IDS].sort());
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
    category: paas-catalogs
    platforms: [cloud]
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

  // The release workflow reads these modes; they must answer from the inventory
  // alone - no package.json, no network - so a gate check cannot fail for an
  // unrelated reason and take a channel down with it.
  test("--ci-outputs prints the flag of every switchable channel", () => {
    const root = mkdtempSync(join(tmpdir(), "dist-check-"));
    fixtureRoots.push(root);
    mkdirSync(join(root, "distribution"), { recursive: true });
    writeFileSync(
      join(root, "distribution/channels.yaml"),
      channelsYaml(switchableRow("snap", true) + switchableRow("chocolatey", false)),
    );
    const result = runCheck(root, ["--ci-outputs"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual(["snap=true", "chocolatey=false"]);
  });

  test("--ci-enabled <id> prints the flag alone", () => {
    const root = makeFixture("0.9.61", channelsYaml(switchableRow("chocolatey", false)));
    const result = runCheck(root, ["--ci-enabled", "chocolatey"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("false");
  });

  test("--ci-enabled rejects a channel that is not switchable", () => {
    const root = makeFixture("0.9.61", channelsYaml(NONE_ROW));
    const result = runCheck(root, ["--ci-enabled", "npm"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("npm");
  });

  test("--ci-enabled with no value exits 2 with usage", () => {
    const result = Bun.spawnSync(["node", SCRIPT, "--ci-enabled"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("--ci-enabled requires");
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
    category: paas-catalogs
    platforms: [cloud]
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

describe("CLI (probes against a local registry/store/catalog)", () => {
  const fixtureRoots: string[] = [];
  const servers: Array<{ stop: () => void }> = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const server of servers.splice(0)) server.stop();
  });

  function serveBase(handler: (req: Request) => Response): string {
    const server = Bun.serve({ port: 0, fetch: handler });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  }

  function probeFixture(row: string): string {
    const root = mkdtempSync(join(tmpdir(), "dist-check-probe-"));
    fixtureRoots.push(root);
    writeFixture(root, "0.9.53", channelsYaml(row));
    return root;
  }

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

  function ghcrRow(base: string): string {
    return `  - id: docker-ghcr
    name: Docker image (GHCR)
    status: live
    category: containers
    platforms: [container]
    tier: 0
    kind: container-image
    update:
      method: ci_publish
      sla: every_release
    pin:
      strategy: probe
      probe: ghcr-tag-digest
      urls:
        token: ${base}/token
        manifest: ${base}/v2/libredb/libredb-studio/manifests/{ref}
`;
  }

  /** Digest per tag; a tag absent from the map answers 404, as a registry does. */
  function registry(digests: Record<string, string>): string {
    return serveBase((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/token") {
        return Response.json({ token: "anonymous-token" });
      }
      const ref = pathname.split("/").pop() as string;
      const digest = digests[ref];
      if (!digest) {
        return new Response("not found", { status: 404 });
      }
      return new Response(null, { headers: { "docker-content-digest": digest } });
    });
  }

  test("GHCR latest pointing at the released version is OK", async () => {
    const base = registry({ latest: "sha256:same", "0.9.53": "sha256:same" });
    const result = await runCheckAsync(probeFixture(ghcrRow(base)));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("| OK | docker-ghcr |");
    expect(result.stdout).toContain("0.9.53");
  });

  test("GHCR latest still pointing at the previous image is DRIFT with both digests", async () => {
    const base = registry({ latest: "sha256:previous", "0.9.53": "sha256:current" });
    const result = await runCheckAsync(probeFixture(ghcrRow(base)));
    expect(result.stdout).toContain("| DRIFT | docker-ghcr |");
    expect(result.stdout).toContain("sha256:previous");
    expect(result.stdout).toContain("sha256:current");
  });

  test("a GHCR token exchange that fails degrades to UNKNOWN", async () => {
    const base = serveBase(() => new Response("no token for you", { status: 403 }));
    const result = await runCheckAsync(probeFixture(ghcrRow(base)));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("| UNKNOWN | docker-ghcr |");
  });

  test("an unreachable registry degrades to UNKNOWN, never drift", async () => {
    const result = await runCheckAsync(probeFixture(ghcrRow("http://127.0.0.1:1")));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("| UNKNOWN | docker-ghcr |");
  });

  test("a Docker Hub mirror missing the released tag is DRIFT - the silently skipped push", async () => {
    const base = serveBase((req) => {
      const ref = new URL(req.url).pathname.split("/").pop();
      return ref === "latest" ? Response.json({ digest: "sha256:stale" }) : new Response("not found", { status: 404 });
    });
    const row = `  - id: docker-hub-mirror
    name: Docker Hub mirror
    status: live
    category: containers
    platforms: [container]
    tier: 0
    kind: container-image
    update:
      method: ci_publish
      sla: every_release
      ci_enabled: true
    pin:
      strategy: probe
      probe: dockerhub-tag-digest
      urls:
        tag: ${base}/v2/repositories/libredb/libredb-studio/tags/{ref}
`;
    const result = await runCheckAsync(probeFixture(row));
    expect(result.stdout).toContain("| DRIFT | docker-hub-mirror |");
    expect(result.stdout).toContain("no 0.9.53 tag published");
  });

  function snapRow(base: string): string {
    return `  - id: snap
    name: Snap Store
    status: live
    category: package-managers
    platforms: [linux]
    tier: 1
    kind: package-manager
    update:
      method: ci_publish
      sla: every_release
      ci_enabled: true
    pin:
      strategy: probe
      probe: snap-store-channel
      architectures:
        - amd64
        - arm64
      urls:
        info: ${base}/v2/snaps/info/libredb-studio
`;
  }

  test("the Snap Store stable channel is measured per architecture and the device-series header is sent", async () => {
    const seenHeaders: Array<string | null> = [];
    const base = serveBase((req) => {
      seenHeaders.push(req.headers.get("snap-device-series"));
      return Response.json({
        "channel-map": [
          { channel: { track: "latest", risk: "stable", architecture: "amd64" }, version: "0.9.53" },
          { channel: { track: "latest", risk: "stable", architecture: "arm64" }, version: "0.9.53" },
          { channel: { track: "latest", risk: "edge", architecture: "amd64" }, version: "0.9.40" },
        ],
      });
    });
    const result = await runCheckAsync(probeFixture(snapRow(base)));
    expect(seenHeaders).toEqual(["16"]);
    expect(result.stdout).toContain("| OK | snap |");
  });

  test("one lagging Snap architecture is DRIFT even though the other is current", async () => {
    const base = serveBase(() =>
      Response.json({
        "channel-map": [
          { channel: { track: "latest", risk: "stable", architecture: "amd64" }, version: "0.9.53" },
          { channel: { track: "latest", risk: "stable", architecture: "arm64" }, version: "0.9.40" },
        ],
      }),
    );
    const result = await runCheckAsync(probeFixture(snapRow(base)));
    expect(result.stdout).toContain("| DRIFT | snap |");
    expect(result.stdout).toContain("arm64=0.9.40");
  });

  test("a Snap Store error degrades to UNKNOWN", async () => {
    const base = serveBase(() => new Response("maintenance", { status: 503 }));
    const result = await runCheckAsync(probeFixture(snapRow(base)));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("| UNKNOWN | snap |");
  });

  function wingetRow(base: string): string {
    return `  - id: winget
    name: winget community repository
    status: live
    category: package-managers
    platforms: [windows]
    tier: 4
    kind: package-manager
    update:
      method: ci_publish
      sla: every_release
      ci_enabled: true
    pin:
      strategy: probe
      probe: winget-max-version
      urls:
        versions: ${base}/repos/microsoft/winget-pkgs/contents/manifests/l/LibreDB/Studio
`;
  }

  test("winget is measured by the highest version its catalog enumerates", async () => {
    const base = serveBase(() => Response.json([{ name: ".validation" }, { name: "0.9.40" }, { name: "0.9.53" }]));
    const result = await runCheckAsync(probeFixture(wingetRow(base)));
    expect(result.stdout).toContain("| OK | winget |");
  });

  test("a winget catalog stuck on an older version is DRIFT", async () => {
    const base = serveBase(() => Response.json([{ name: "0.9.40" }]));
    const result = await runCheckAsync(probeFixture(wingetRow(base)));
    expect(result.stdout).toContain("| DRIFT | winget |");
    expect(result.stdout).toContain("0.9.40");
  });

  test("a winget catalog listing that cannot be read degrades to UNKNOWN", async () => {
    const base = serveBase(() => new Response("rate limited", { status: 429 }));
    const result = await runCheckAsync(probeFixture(wingetRow(base)));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("| UNKNOWN | winget |");
  });
});

// ---------------------------------------------------------------------------
// Coverage matrix for users, developers and buyers (docs/CHANNELS.md)
// ---------------------------------------------------------------------------

const MATRIX_FIXTURE = `channels:
  - id: npm
    name: npm package
    status: live
    category: registries-releases
    platforms: [linux, macos, windows]
    tier: 0
    kind: package-registry
    update:
      method: ci_publish
      sla: every_release
    links:
      catalog: https://www.npmjs.com/package/@libredb/studio
      docs: docs/DISTRIBUTION.md
    pin:
      strategy: none
      note: x
  - id: chocolatey
    name: Chocolatey
    status: pending
    category: package-managers
    platforms: [windows]
    tier: 4
    kind: package-manager
    update:
      method: ci_publish
      sla: every_release
      ci_enabled: false
    pin:
      strategy: none
      note: x
  - id: flathub
    name: Flathub
    status: deprecated
    category: package-managers
    platforms: [linux]
    tier: 4
    kind: package-manager
    update:
      method: upstream_pr
      sla: on_demand
    links:
      docs: packaging/flatpak/README.md
    pin:
      strategy: none
      note: x
`;

describe("humanizeSla / docsHref", () => {
  test("humanizeSla maps known SLAs", () => {
    expect(humanizeSla("every_release")).toBe("Every release");
    expect(humanizeSla("on_demand")).toBe("On demand");
    expect(humanizeSla("custom")).toBe("custom");
  });

  test("docsHref rewrites paths relative to docs/CHANNELS.md", () => {
    expect(docsHref(undefined)).toBe("DISTRIBUTION.md");
    expect(docsHref("docs/HELM_CHART.md")).toBe("HELM_CHART.md");
    expect(docsHref("desktop/README.md")).toBe("../desktop/README.md");
  });
});

describe("matrix cell helpers", () => {
  test("channelHref resolves get, then catalog, then upstream_repo", () => {
    expect(channelHref({ links: { get: "G", catalog: "C", upstream_repo: "U" } })).toBe("G");
    expect(channelHref({ links: { catalog: "C", upstream_repo: "U" } })).toBe("C");
    expect(channelHref({ links: { upstream_repo: "U" } })).toBe("U");
    expect(channelHref({ links: {} })).toBeUndefined();
    expect(channelHref({})).toBeUndefined();
  });

  test("channelHref returns nothing for a deprecated channel that still has links", () => {
    expect(channelHref({ status: "deprecated", links: { upstream_repo: "U" } })).toBeUndefined();
    expect(channelHref({ status: "live", links: { upstream_repo: "U" } })).toBe("U");
  });

  test("platformCell renders canonical order regardless of yaml order", () => {
    expect(platformCell(["macos", "linux"])).toBe("Linux, macOS");
    expect(platformCell(["cloud"])).toBe("Cloud");
    expect(platformCell(["windows", "container", "linux"])).toBe("Linux, Windows, Container");
  });

  test("updateSummary separates automated from manual and retires deprecated", () => {
    expect(updateSummary({ status: "live", update: { method: "ci_publish", sla: "every_release" } })).toBe(
      "Automated, every release",
    );
    expect(updateSummary({ status: "live", update: { method: "upstream_pr", sla: "on_demand" } })).toBe(
      "Manual, on demand",
    );
    expect(updateSummary({ status: "pending", update: { method: "manual_ui", sla: "minor_plus" } })).toBe(
      "Manual, minor+",
    );
    expect(updateSummary({ status: "deprecated", update: { method: "upstream_pr", sla: "on_demand" } })).toBe("—");
  });

  test("updateSummary marks a switched-off channel as paused", () => {
    expect(
      updateSummary({ status: "pending", update: { method: "ci_publish", sla: "every_release", ci_enabled: false } }),
    ).toBe("Automated (paused), every release");
    expect(
      updateSummary({ status: "live", update: { method: "ci_publish", sla: "every_release", ci_enabled: true } }),
    ).toBe("Automated, every release");
    expect(updateSummary({ status: "live", update: { method: "ci_publish", sla: "every_release" } })).toBe(
      "Automated, every release",
    );
  });

  test("guideLabel strips the relative prefix", () => {
    expect(guideLabel("DISTRIBUTION.md")).toBe("DISTRIBUTION.md");
    expect(guideLabel("HELM_CHART.md")).toBe("HELM_CHART.md");
    expect(guideLabel("../deploy/railway/PUBLISH.md")).toBe("deploy/railway/PUBLISH.md");
  });
});

describe("renderScorecard / renderChannelMatrix", () => {
  const channels = parseChannels(MATRIX_FIXTURE);

  test("scorecard totals and category rows", () => {
    const scorecard = renderScorecard(channels);
    expect(scorecard).toContain("**3 channels · 1 live · 1 pending · 1 deprecated**");
    expect(scorecard).toContain("| Registries & releases | 1 | 0 | 0 |");
    expect(scorecard).toContain("| Package managers | 0 | 1 | 1 |");
  });

  test("scorecard counts live channels per platform, once per platform", () => {
    // Only `npm` is live in the fixture, and it lists three platforms.
    expect(renderScorecard(channels)).toContain("Live channels by platform: **Linux 1 · macOS 1 · Windows 1**");
  });

  test("scorecard no longer emits the category coverage sentence", () => {
    expect(renderScorecard(channels)).not.toContain("Coverage:");
  });

  test("scorecard omits the platform line when nothing is live", () => {
    const noLive = parseChannels(MATRIX_FIXTURE.replace("status: live", "status: pending"));
    expect(renderScorecard(noLive)).not.toContain("Live channels by platform");
  });

  test("matrix table renders six columns, ordered by category then status", () => {
    const table = renderChannelMatrix(channels);
    expect(table).toContain("| Channel | Category | Platform | Status | Updates | Guide |");
    expect(table).toContain(
      "| [npm package](https://www.npmjs.com/package/@libredb/studio) | Registries & releases | " +
        "Linux, macOS, Windows | live | Automated, every release | [DISTRIBUTION.md](DISTRIBUTION.md) |",
    );
    expect(table).toContain(
      "| Chocolatey | Package managers | Windows | pending | Automated (paused), every release | " +
        "[DISTRIBUTION.md](DISTRIBUTION.md) |",
    );
    expect(table).toContain(
      "| Flathub | Package managers | Linux | deprecated | — | " +
        "[packaging/flatpak/README.md](../packaging/flatpak/README.md) |",
    );
    const npmAt = table.indexOf("npm package");
    const chocoAt = table.indexOf("Chocolatey");
    const flatAt = table.indexOf("Flathub");
    expect(npmAt).toBeLessThan(chocoAt);
    expect(chocoAt).toBeLessThan(flatAt);
    expect(table).not.toContain("[link](");
    expect(table).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  test("short_name wins over name in the table", () => {
    const withShort = parseChannels(
      MATRIX_FIXTURE.replace("    name: npm package\n", "    name: npm package\n    short_name: npm\n"),
    );
    expect(renderChannelMatrix(withShort)).toContain("| [npm](https://www.npmjs.com/package/@libredb/studio) |");
  });
});

// MATRIX_FIXTURE above puts every channel in its own category, so a table
// render never falls past the category comparator: the status and id
// tie-breaks inside sortedMatrixChannels never execute against it. This
// fixture isolates both tie-breaks with a separate, deliberately scrambled
// input order.
const MATRIX_TIEBREAK_FIXTURE = `channels:
  - id: ctr-mike
    name: Mike Deprecated
    status: deprecated
    category: containers
    platforms: [container]
    kind: container-image
    update:
      method: upstream_pr
      sla: on_demand
    pin:
      strategy: none
      note: x
  - id: ctr-zulu
    name: Zulu Live
    status: live
    category: containers
    platforms: [container]
    kind: container-image
    update:
      method: ci_publish
      sla: every_release
    pin:
      strategy: none
      note: x
  - id: ctr-alpha
    name: Alpha Pending
    status: pending
    category: containers
    platforms: [container]
    kind: container-image
    update:
      method: ci_publish
      sla: every_release
    pin:
      strategy: none
      note: x
  - id: desk-bravo
    name: Bravo Desktop
    status: live
    category: os-desktop
    platforms: [linux]
    kind: os-package
    update:
      method: manual_ui
      sla: on_demand
    pin:
      strategy: none
      note: x
  - id: desk-alpha
    name: Alpha Desktop
    status: live
    category: os-desktop
    platforms: [linux]
    kind: os-package
    update:
      method: manual_ui
      sla: on_demand
    pin:
      strategy: none
      note: x
`;

describe("sortedMatrixChannels tie-breaks (via renderChannelMatrix)", () => {
  const channels = parseChannels(MATRIX_TIEBREAK_FIXTURE);
  const table = renderChannelMatrix(channels);

  test("same category, different status: live before pending before deprecated", () => {
    const liveAt = table.indexOf("Zulu Live");
    const pendingAt = table.indexOf("Alpha Pending");
    const deprecatedAt = table.indexOf("Mike Deprecated");
    expect(liveAt).toBeGreaterThan(-1);
    expect(pendingAt).toBeGreaterThan(-1);
    expect(deprecatedAt).toBeGreaterThan(-1);
    expect(liveAt).toBeLessThan(pendingAt);
    expect(pendingAt).toBeLessThan(deprecatedAt);
  });

  test("same category and status: falls back to id.localeCompare", () => {
    const alphaAt = table.indexOf("Alpha Desktop");
    const bravoAt = table.indexOf("Bravo Desktop");
    expect(alphaAt).toBeGreaterThan(-1);
    expect(bravoAt).toBeGreaterThan(-1);
    expect(alphaAt).toBeLessThan(bravoAt);
  });
});

describe("applyMatrixMarkers / buildChannelsDoc", () => {
  const skeleton = `# Title

intro

<!-- BEGIN:CHANNEL-SCORECARD -->

old scorecard

<!-- END:CHANNEL-SCORECARD -->

mid

<!-- BEGIN:CHANNEL-TABLE -->

old table

<!-- END:CHANNEL-TABLE -->

footer
`;

  test("rewrites only marker regions", () => {
    const next = applyMatrixMarkers(skeleton, "SCORE\n", "TABLE\n");
    expect(next).toContain("# Title");
    expect(next).toContain("intro");
    expect(next).toContain("mid");
    expect(next).toContain("footer");
    expect(next).toContain("SCORE");
    expect(next).toContain("TABLE");
    expect(next).not.toContain("old scorecard");
    expect(next).not.toContain("old table");
  });

  test("throws when markers are missing", () => {
    expect(() => applyMatrixMarkers("# no markers\n", "a", "b")).toThrow(/missing markers/);
  });

  test("buildChannelsDoc is idempotent", () => {
    const channels = parseChannels(MATRIX_FIXTURE);
    const once = buildChannelsDoc(skeleton, channels);
    const twice = buildChannelsDoc(once, channels);
    expect(twice).toBe(once);
  });
});

describe("CLI --matrix", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function matrixRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "dist-matrix-"));
    fixtureRoots.push(root);
    mkdirSync(join(root, "distribution"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "distribution/channels.yaml"), MATRIX_FIXTURE);
    writeFileSync(
      join(root, "docs/CHANNELS.md"),
      `# Channels\n\n<!-- BEGIN:CHANNEL-SCORECARD -->\n\n<!-- END:CHANNEL-SCORECARD -->\n\n<!-- BEGIN:CHANNEL-TABLE -->\n\n<!-- END:CHANNEL-TABLE -->\n`,
    );
    return root;
  }

  test("--matrix writes scorecard and table regions", () => {
    const root = matrixRoot();
    const result = Bun.spawnSync(["node", SCRIPT, "--matrix", "--root", root], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const doc = readFileSync(join(root, "docs/CHANNELS.md"), "utf8");
    expect(doc).toContain("**3 channels · 1 live · 1 pending · 1 deprecated**");
    expect(doc).toContain(
      "| [npm package](https://www.npmjs.com/package/@libredb/studio) | Registries & releases | " +
        "Linux, macOS, Windows | live | Automated, every release | [DISTRIBUTION.md](DISTRIBUTION.md) |",
    );
  });

  test("--matrix --check exits 0 when fresh and 1 when stale", () => {
    const root = matrixRoot();
    const write = Bun.spawnSync(["node", SCRIPT, "--matrix", "--root", root], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(write.exitCode).toBe(0);
    const ok = Bun.spawnSync(["node", SCRIPT, "--matrix", "--check", "--root", root], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(ok.exitCode).toBe(0);
    writeFileSync(
      join(root, "docs/CHANNELS.md"),
      readFileSync(join(root, "docs/CHANNELS.md"), "utf8").replace("1 live", "0 live"),
    );
    const stale = Bun.spawnSync(["node", SCRIPT, "--matrix", "--check", "--root", root], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr.toString()).toContain("stale");
  });

  test("--check without --matrix exits 2", () => {
    const result = Bun.spawnSync(["node", SCRIPT, "--check"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("--matrix");
  });
});

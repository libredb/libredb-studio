#!/usr/bin/env node
/**
 * Distribution visibility matrix checker.
 *
 * Reads the human-maintained channel inventory (distribution/channels.yaml),
 * measures every live channel's pinned version against package.json, and
 * prints a markdown drift table (also appended to GITHUB_STEP_SUMMARY when
 * set). Warn-only by default so existing PaaS drift never breaks a release;
 * `--strict` exits 1 only for owned local_file pins whose update SLA is
 * every_release - remote catalogs are upstream-owned and never gate.
 *
 * The checker only ever READS channels.yaml; version bumps in pin files and
 * inventory edits are human work (see docs/DISTRIBUTION.md). Mirrors the
 * style of scripts/sync-chart-version.mjs; the pure functions below are unit
 * tested in tests/unit/distribution-check.test.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const CHANNELS_YAML = "distribution/channels.yaml";
const STATUSES = ["live", "pending", "deprecated"];
const STRATEGIES = ["local_file", "remote_file", "probe", "none"];
const METHODS = ["ci_publish", "commit", "upstream_pr", "manual_ui"];
const SLAS = ["every_release", "minor_plus", "major_only", "on_demand"];

/**
 * Channels whose release-CI publish step may be switched off from this file via
 * `update.ci_enabled`, because they can be unavailable for reasons outside this
 * repository (a package awaiting community moderation, a listing still under
 * review) and a channel that cannot publish must not paint a good release run
 * red.
 *
 * The set is deliberately closed and deliberately small. The core release path
 * - github-release, docker-ghcr, npm, helm - and the assets publish-release
 * requires (deb/rpm, AppImage, the win32 zip) are absent on purpose: a switch
 * there would be a way to ship a release with no npm package or no image, and
 * one mistyped `false` would do it silently. parseChannels rejects the flag
 * anywhere else, so that invariant is enforced, not merely documented.
 */
export const SWITCHABLE_CHANNEL_IDS = new Set(["docker-hub-mirror", "homebrew", "snap", "winget", "chocolatey"]);

/**
 * Probes measure channels whose served state is not one document a single
 * regex can read: a registry that answers "which digest does this tag point
 * at" rather than "which version", or a catalog that enumerates every
 * published version with no floating "latest" entry.
 *
 * Each entry declares the pin.urls keys it needs (validated at parse time, so
 * a typo in the inventory is a startup error and never a silent UNKNOWN) and
 * a `run` that resolves the served version. Probe URLs live in channels.yaml
 * rather than in this file on purpose: the unit tests point them at a local
 * server, so the checker's own suite never touches the real network.
 */
const PROBES = {
  "ghcr-tag-digest": {
    requiredUrls: ["token", "manifest"],
    async run({ pin, expected, timeoutMs }) {
      // Public packages need no secret, only the anonymous pull token GHCR
      // hands out to anyone who asks - so this probe works in a fork's CI too.
      const token = await fetchJson(pin.urls.token, timeoutMs);
      if (typeof token.body?.token !== "string") {
        return { error: `ghcr token exchange failed (status ${token.status})` };
      }
      const headers = {
        authorization: `Bearer ${token.body.token}`,
        // Without these the registry answers with a single-platform manifest
        // and the digests of two multi-arch tags would never compare equal.
        accept: [
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
        ].join(","),
      };
      const [latest, tagged] = await Promise.all([
        fetchDigest(pin.urls.manifest.replace("{ref}", "latest"), timeoutMs, headers),
        fetchDigest(pin.urls.manifest.replace("{ref}", expected), timeoutMs, headers),
      ]);
      return digestVerdict({ latest, tagged, expected });
    },
  },

  "dockerhub-tag-digest": {
    requiredUrls: ["tag"],
    async run({ pin, expected, timeoutMs }) {
      // The per-tag endpoint carries the digest inline, so the mirror needs no
      // pagination walk: a push that silently skipped leaves the version tag
      // absent, which digestVerdict reports as drift rather than unknown.
      const [latest, tagged] = await Promise.all([
        fetchJson(pin.urls.tag.replace("{ref}", "latest"), timeoutMs),
        fetchJson(pin.urls.tag.replace("{ref}", expected), timeoutMs),
      ]);
      return digestVerdict({
        latest: { status: latest.status, digest: latest.body?.digest ?? null },
        tagged: { status: tagged.status, digest: tagged.body?.digest ?? null },
        expected,
      });
    },
  },

  "snap-store-channel": {
    requiredUrls: ["info"],
    requiredArrays: ["architectures"],
    async run({ pin, timeoutMs }) {
      // The store rejects the request without a device series, whatever the
      // snap name, so this header is part of the probe and not a nicety.
      const info = await fetchJson(pin.urls.info, timeoutMs, { "snap-device-series": "16" });
      if (info.status !== 200) {
        return { error: `snap store unreachable (status ${info.status})` };
      }
      return parseSnapVersions(info.body, pin.architectures);
    },
  },

  "winget-max-version": {
    requiredUrls: ["versions"],
    async run({ pin, timeoutMs }) {
      // A directory listing is not paginated: the contents API returns the whole
      // directory in one response and ignores per_page (verified against
      // winget-pkgs, 785 entries in a single body). Its documented ceiling is
      // 1,000 entries, above which GitHub directs callers to the Git Trees API -
      // 1,000 published winget versions is not a reachable horizon here.
      const listing = await fetchJson(pin.urls.versions, timeoutMs, githubAuthHeaders(pin.urls.versions));
      if (!Array.isArray(listing.body)) {
        return { error: `catalog listing unavailable (status ${listing.status})` };
      }
      return maxPublishedVersion(listing.body.map((entry) => entry.name));
    },
  },
};

/**
 * api.github.com rate-limits anonymous callers hard enough to turn a weekly
 * check into a coin flip; raw.githubusercontent.com needs no auth at all, so
 * the token is attached there and nowhere else.
 */
export function githubAuthHeaders(url) {
  if (url.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN) {
    return { authorization: `Bearer ${process.env.GITHUB_TOKEN}` };
  }
  return {};
}

async function fetchJson(url, timeoutMs, headers = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
    if (!response.ok) {
      return { status: response.status, body: null };
    }
    return { status: response.status, body: await response.json() };
  } catch {
    return { status: null, body: null };
  }
}

/** A registry reports which image a tag resolves to in a header, not a body. */
async function fetchDigest(url, timeoutMs, headers) {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs), headers });
    return { status: response.status, digest: response.headers.get("docker-content-digest") };
  } catch {
    return { status: null, digest: null };
  }
}

/**
 * A probe result is either `{ versions: [{ source, version }], detail? }` -
 * fed through the same agree/compare path as a multi-file local pin - or
 * `{ error }`, which degrades that row to UNKNOWN. The distinction is load
 * bearing: "the registry did not answer" must never render as drift, and
 * "the tag is genuinely absent" must never render as unknown.
 *
 * @typedef {{ source: string, version: string }} ProbedVersion
 * @typedef {{ versions?: ProbedVersion[], detail?: string, error?: string }} ProbeResult
 */

/**
 * Container registries answer "which digest does this tag point at", not
 * "which version". Equal digests for `latest` and the expected version tag
 * mean the channel serves that version; anything else yields a version string
 * that cannot compare equal, so the caller reports drift and the digests land
 * in the detail column.
 *
 * @returns {ProbeResult}
 */
export function digestVerdict({ latest, tagged, expected }) {
  const drift = (detail) => ({ versions: [{ source: "latest", version: `!=${expected}` }], detail });
  if (latest.status === 404) {
    return drift("latest tag is missing from the registry");
  }
  if (tagged.status === 404) {
    return drift(`no ${expected} tag published`);
  }
  if (latest.status !== 200 || tagged.status !== 200) {
    return { error: `registry unreachable (latest=${latest.status}, ${expected}=${tagged.status})` };
  }
  if (latest.digest !== tagged.digest) {
    return drift(`latest -> ${latest.digest}, ${expected} -> ${tagged.digest}`);
  }
  return { versions: [{ source: "latest", version: expected }] };
}

/**
 * The Snap Store reports one version per channel and architecture. Only the
 * stable risk of the default track is the served state - edge may legitimately
 * run ahead or behind - and each architecture is measured separately so a
 * single lagging build shows up as disagreeing sources rather than a pass.
 *
 * @returns {ProbeResult}
 */
export function parseSnapVersions(info, architectures) {
  const map = info?.["channel-map"];
  if (!Array.isArray(map)) {
    return { error: "store response has no channel-map" };
  }
  const versions = [];
  for (const architecture of architectures) {
    const entry = map.find(
      (item) =>
        item?.channel?.track === "latest" &&
        item?.channel?.risk === "stable" &&
        item?.channel?.architecture === architecture,
    );
    if (!entry) {
      return { error: `no stable channel entry for ${architecture}` };
    }
    versions.push({ source: architecture, version: entry.version });
  }
  return { versions };
}

/**
 * Catalogs that publish every version as its own entry and no floating
 * "latest" document (winget-pkgs) are measured by the highest version they
 * list. Comparison is numeric per component: 0.9.64 is newer than 0.9.9,
 * which a string sort gets backwards.
 *
 * @returns {ProbeResult}
 */
export function maxPublishedVersion(names) {
  const parsed = names
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .map((name) => ({ name, parts: name.split(".").map(Number) }));
  if (parsed.length === 0) {
    return { error: "no published version in the catalog listing" };
  }
  const newest = parsed.reduce((best, candidate) => {
    for (let i = 0; i < 3; i++) {
      if (candidate.parts[i] !== best.parts[i]) {
        return candidate.parts[i] > best.parts[i] ? candidate : best;
      }
    }
    return best;
  });
  return { versions: [{ source: "catalog", version: newest.name }] };
}

function countCaptureGroups(pattern) {
  // Appending an empty alternative makes the regex match the empty string, so
  // exec() always returns: array length - 1 == number of capture groups.
  return new RegExp(`${pattern}|`).exec("").length - 1;
}

/**
 * Parses and validates the inventory. Throws on structural problems (bad
 * enum values, missing pin fields, duplicate ids) - a channel that cannot be
 * measured on purpose must say so explicitly with `strategy: none`.
 */
export function parseChannels(yamlText) {
  const doc = parseYaml(yamlText);
  if (!doc || !Array.isArray(doc.channels)) {
    throw new Error(`${CHANNELS_YAML}: top-level 'channels' list is missing`);
  }
  const seen = new Set();
  for (const channel of doc.channels) {
    const id = channel?.id;
    if (typeof id !== "string" || id === "") {
      throw new Error(`${CHANNELS_YAML}: every channel needs a non-empty string id`);
    }
    if (seen.has(id)) {
      throw new Error(`${CHANNELS_YAML}: duplicate channel id '${id}'`);
    }
    seen.add(id);
    if (!STATUSES.includes(channel.status)) {
      throw new Error(`${CHANNELS_YAML}: ${id}: status must be one of ${STATUSES.join("|")}`);
    }
    if (!channel.update || !METHODS.includes(channel.update.method)) {
      throw new Error(`${CHANNELS_YAML}: ${id}: update.method must be one of ${METHODS.join("|")}`);
    }
    if (!SLAS.includes(channel.update.sla)) {
      throw new Error(`${CHANNELS_YAML}: ${id}: update.sla must be one of ${SLAS.join("|")}`);
    }
    const ciEnabled = channel.update.ci_enabled;
    if (SWITCHABLE_CHANNEL_IDS.has(id)) {
      // Required, not defaulted: the release CI's behaviour for these channels
      // has to be a stated decision in this file, never an omission.
      if (typeof ciEnabled !== "boolean") {
        throw new Error(`${CHANNELS_YAML}: ${id}: update.ci_enabled must be true or false`);
      }
    } else if (ciEnabled !== undefined) {
      throw new Error(
        `${CHANNELS_YAML}: ${id}: update.ci_enabled is only allowed on ${[...SWITCHABLE_CHANNEL_IDS].join(", ")}`,
      );
    }
    const pin = channel.pin;
    if (!pin || !STRATEGIES.includes(pin.strategy)) {
      throw new Error(`${CHANNELS_YAML}: ${id}: pin.strategy must be one of ${STRATEGIES.join("|")}`);
    }
    if (pin.strategy === "local_file" && (!Array.isArray(pin.files) || pin.files.length === 0)) {
      throw new Error(`${CHANNELS_YAML}: ${id}: local_file pin needs a non-empty 'files' list`);
    }
    if (pin.strategy === "remote_file" && typeof pin.url !== "string") {
      throw new Error(`${CHANNELS_YAML}: ${id}: remote_file pin needs a 'url'`);
    }
    if (pin.strategy === "probe") {
      const probe = PROBES[pin.probe];
      if (!probe) {
        throw new Error(`${CHANNELS_YAML}: ${id}: pin.probe must be one of ${Object.keys(PROBES).join("|")}`);
      }
      for (const key of probe.requiredUrls) {
        if (typeof pin.urls?.[key] !== "string") {
          throw new Error(`${CHANNELS_YAML}: ${id}: probe '${pin.probe}' needs pin.urls.${key}`);
        }
      }
      for (const key of probe.requiredArrays ?? []) {
        if (!Array.isArray(pin[key]) || pin[key].length === 0) {
          throw new Error(`${CHANNELS_YAML}: ${id}: probe '${pin.probe}' needs a non-empty pin.${key} list`);
        }
      }
    }
    // Probes resolve a version in code, so only the regex strategies carry an
    // extract - and theirs must have exactly one capture group: extractPin
    // reads m[1] only, so a second group would be measured or ignored
    // silently. Use (?:...) for grouping.
    if (pin.strategy === "local_file" || pin.strategy === "remote_file") {
      if (typeof pin.extract !== "string" || countCaptureGroups(pin.extract) !== 1) {
        throw new Error(`${CHANNELS_YAML}: ${id}: pin.extract must be a regex with exactly one capture group`);
      }
    }
  }
  return doc.channels;
}

/**
 * `<name>=<bool>` lines for $GITHUB_OUTPUT, one per switchable channel present.
 * Dashes become underscores because a GitHub expression cannot dot-access an
 * output name that contains one.
 */
export function ciEnabledOutputs(channels) {
  return channels
    .filter((channel) => SWITCHABLE_CHANNEL_IDS.has(channel.id))
    .map((channel) => `${channel.id.replaceAll("-", "_")}=${channel.update.ci_enabled}`);
}

/**
 * Applies a channel's extract regex to one source. Multiple matches must
 * agree - an ambiguous pin is reported, never silently resolved to the first
 * occurrence (same rule as sync-chart-version's parseImageTag, #151).
 */
export function extractPin(content, extract, sourceLabel) {
  const versions = [...content.matchAll(new RegExp(extract, "gm"))].map((m) => m[1]);
  if (versions.length === 0) {
    throw new Error(`${sourceLabel}: no version matched by the extract pattern`);
  }
  const unique = [...new Set(versions)];
  if (unique.length > 1) {
    throw new Error(`${sourceLabel}: extracted versions disagree (${unique.join(", ")})`);
  }
  return unique[0];
}

/**
 * Builds one report row. `sources` maps every file path / url the channel
 * pins to its text content, or null when unreadable (missing file, failed
 * fetch) - fetching is the CLI's job so this stays pure and testable.
 *
 * Statuses: ok | drift | unknown (pin exists but is not measurable right
 * now) | skip (pending/deprecated channel, or strategy none by design).
 */
export function evaluateChannel(channel, pkgVersion, sources) {
  const row = {
    id: channel.id,
    name: channel.name ?? channel.id,
    tier: channel.tier ?? "-",
    channelStatus: channel.status,
    strategy: channel.pin.strategy,
    method: channel.update.method,
    sla: channel.update.sla,
    links: channel.links ?? {},
    expected: pkgVersion,
    observed: "-",
    detail: channel.pin.note ?? "",
  };
  if (channel.status !== "live" || channel.pin.strategy === "none") {
    return { ...row, status: "skip", expected: "-" };
  }
  const { problems, versions, detail } =
    channel.pin.strategy === "probe" ? readProbe(channel, sources[probeKey(channel)]) : readPins(channel, sources);
  if (problems.length > 0) {
    return { ...row, status: "unknown", observed: "?", detail: problems.join("; ") };
  }
  const unique = [...new Set(versions.map((v) => v.version))];
  if (unique.length > 1) {
    const disagreement = versions.map((v) => `${v.key}=${v.version}`).join(", ");
    return { ...row, status: "drift", observed: unique.join(", "), detail: `sources disagree: ${disagreement}` };
  }
  const observed = unique[0];
  return { ...row, status: observed === pkgVersion ? "ok" : "drift", observed, detail: detail ?? row.detail };
}

/** Where the CLI parks a channel's probe result for evaluateChannel to read. */
export function probeKey(channel) {
  return `probe:${channel.id}`;
}

function readPins(channel, sources) {
  const keys = channel.pin.strategy === "local_file" ? channel.pin.files : [channel.pin.url];
  const problems = [];
  const versions = [];
  for (const key of keys) {
    const content = sources[key];
    if (content === null || content === undefined) {
      problems.push(`${key}: unreadable`);
      continue;
    }
    try {
      versions.push({ key, version: extractPin(content, channel.pin.extract, key) });
    } catch (error) {
      problems.push(error.message);
    }
  }
  return { problems, versions };
}

/**
 * Adapts a probe result onto the same shape a file pin produces, so a lagging
 * Snap architecture reaches the caller as two disagreeing sources - exactly
 * how two disagreeing pin files already do.
 */
function readProbe(channel, result) {
  if (!result) {
    return { problems: [`probe '${channel.pin.probe}' did not run`], versions: [] };
  }
  if (result.error) {
    return { problems: [result.error], versions: [] };
  }
  return {
    problems: [],
    versions: result.versions.map((entry) => ({ key: entry.source, version: entry.version })),
    detail: result.detail,
  };
}

/**
 * Strict mode gates only what this repo owns and promises to bump on every
 * release: local_file pins with sla every_release. Anything else (remote
 * catalogs, on_demand PaaS templates) stays warn-only in v1, so strict can
 * actually be enabled without first paying off historical PaaS drift.
 */
export function strictFailures(rows) {
  return rows.filter(
    (row) =>
      row.strategy === "local_file" &&
      row.sla === "every_release" &&
      (row.status === "drift" || row.status === "unknown"),
  );
}

/** Short display text for a provenance link: #56, Dokploy/templates#931, or the word link. */
export function linkLabel(url) {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/);
  if (!match) {
    return "link";
  }
  const [, owner, repo, number] = match;
  return owner === "libredb" && repo === "libredb-studio" ? `#${number}` : `${owner}/${repo}#${number}`;
}

function linkCell(url) {
  return url ? `[${linkLabel(url)}](${url})` : "-";
}

/** Markdown drift table. Plain-text statuses only (house rule: no emoji). */
export function renderTable(rows, pkgVersion) {
  const lines = [
    `## Distribution channels (expected version: ${pkgVersion})`,
    "",
    "| Status | Channel | Tier | Observed | Expected | SLA | Tracking | First PR | Last bump | Detail |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.status.toUpperCase()} | ${row.id} | ${row.tier} | ${row.observed} | ${row.expected} | ${row.sla} | ` +
        `${linkCell(row.links.tracking_issue)} | ${linkCell(row.links.first_pr)} | ${linkCell(row.links.last_bump_pr)} | ` +
        `${row.detail || "-"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function fetchText(url, timeoutMs) {
  const headers = githubAuthHeaders(url);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}

async function main(argv) {
  const strict = argv.includes("--strict");
  const json = argv.includes("--json");
  const rootIdx = argv.indexOf("--root");
  const rootArg = rootIdx === -1 ? undefined : argv[rootIdx + 1];
  if (rootIdx !== -1 && (rootArg === undefined || rootArg.startsWith("--"))) {
    console.error("ERROR: --root requires a directory path");
    process.exit(2);
  }
  const root = rootIdx === -1 ? process.cwd() : path.resolve(rootArg);
  const timeoutMs = Number(process.env.DISTRIBUTION_CHECK_TIMEOUT_MS ?? 10_000);

  // The release workflow's automation gates. They answer from the inventory
  // alone - no package.json read, no network - so a gate check can never fail
  // for an unrelated reason and take a working channel down with it.
  const ciOutputs = argv.includes("--ci-outputs");
  const ciIdx = argv.indexOf("--ci-enabled");
  const ciId = ciIdx === -1 ? undefined : argv[ciIdx + 1];
  if (ciIdx !== -1 && (ciId === undefined || ciId.startsWith("--"))) {
    console.error("ERROR: --ci-enabled requires a channel id");
    process.exit(2);
  }
  if (ciOutputs || ciIdx !== -1) {
    const inventory = parseChannels(fs.readFileSync(path.join(root, CHANNELS_YAML), "utf8"));
    if (ciOutputs) {
      for (const line of ciEnabledOutputs(inventory)) console.log(line);
      return;
    }
    if (!SWITCHABLE_CHANNEL_IDS.has(ciId)) {
      console.error(`ERROR: '${ciId}' is not a switchable channel (${[...SWITCHABLE_CHANNEL_IDS].join(", ")})`);
      process.exit(2);
    }
    const channel = inventory.find((entry) => entry.id === ciId);
    if (!channel) {
      console.error(`ERROR: channel '${ciId}' is not in ${CHANNELS_YAML}`);
      process.exit(2);
    }
    console.log(String(channel.update.ci_enabled));
    return;
  }

  const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const channels = parseChannels(fs.readFileSync(path.join(root, CHANNELS_YAML), "utf8"));

  const sources = {};
  const fetches = [];
  for (const channel of channels) {
    if (channel.status !== "live") {
      continue;
    }
    if (channel.pin.strategy === "local_file") {
      for (const file of channel.pin.files) {
        try {
          sources[file] = fs.readFileSync(path.join(root, file), "utf8");
        } catch {
          sources[file] = null;
        }
      }
    } else if (channel.pin.strategy === "remote_file") {
      const { url } = channel.pin;
      fetches.push(fetchText(url, timeoutMs).then((content) => (sources[url] = content)));
    } else if (channel.pin.strategy === "probe") {
      const run = PROBES[channel.pin.probe].run({ pin: channel.pin, expected: pkgVersion, timeoutMs });
      fetches.push(run.then((result) => (sources[probeKey(channel)] = result)));
    }
  }
  await Promise.all(fetches);

  const rows = channels.map((channel) => evaluateChannel(channel, pkgVersion, sources));
  const table = renderTable(rows, pkgVersion);
  if (json) {
    console.log(JSON.stringify({ expected: pkgVersion, rows }, null, 2));
  } else {
    console.log(table);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  }

  const failures = strictFailures(rows);
  if (strict && failures.length > 0) {
    for (const row of failures) {
      console.error(`ERROR: strict: ${row.id} is ${row.status} (observed ${row.observed}, expected ${pkgVersion})`);
    }
    process.exit(1);
  }
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

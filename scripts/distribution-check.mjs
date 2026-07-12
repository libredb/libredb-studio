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
const STRATEGIES = ["local_file", "remote_file", "none"];
const METHODS = ["ci_publish", "commit", "upstream_pr", "manual_ui"];
const SLAS = ["every_release", "minor_plus", "major_only", "on_demand"];

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
    if (pin.strategy !== "none") {
      // Exactly one: extractPin reads m[1] only, so a second capture group
      // would be measured or ignored silently. Use (?:...) for grouping.
      if (typeof pin.extract !== "string" || countCaptureGroups(pin.extract) !== 1) {
        throw new Error(`${CHANNELS_YAML}: ${id}: pin.extract must be a regex with exactly one capture group`);
      }
    }
  }
  return doc.channels;
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
  if (problems.length > 0) {
    return { ...row, status: "unknown", observed: "?", detail: problems.join("; ") };
  }
  const unique = [...new Set(versions.map((v) => v.version))];
  if (unique.length > 1) {
    const detail = versions.map((v) => `${v.key}=${v.version}`).join(", ");
    return { ...row, status: "drift", observed: unique.join(", "), detail: `pin files disagree: ${detail}` };
  }
  const observed = unique[0];
  return { ...row, status: observed === pkgVersion ? "ok" : "drift", observed };
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
  const headers = {};
  // raw.githubusercontent.com needs no auth for public repos; the token only
  // helps api.github.com rate limits, so it is attached there and nowhere else.
  if (url.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
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

#!/usr/bin/env node
/**
 * Login-page channel showcase generator (issue #425).
 *
 * Reads the human-maintained channel inventory (distribution/channels.yaml)
 * and emits src/lib/distribution/channels.generated.ts: the live channels the
 * login hero advertises, plus the platforms they cover. The generated module is
 * committed, and `--check` (bun run channels:showcase:check) regenerates it in
 * memory and fails on drift - wired into the required lint-and-build job next
 * to the chart:check gate, so the product UI can never fall behind the
 * inventory the release process already maintains.
 *
 * Generated rather than fetched on purpose: /login is unauthenticated, so it
 * must not gain an API route or parse yaml at runtime for a list that only
 * changes when someone edits this repository.
 *
 * This script only ever READS the inventory. Schema validation (statuses,
 * kinds, runtimes, pins) belongs to scripts/distribution-check.mjs, which
 * gates the same file; the two rules enforced here are the ones that decide
 * what reaches the UI. Mirrors the style of scripts/distribution-check.mjs;
 * the pure functions below are unit tested in
 * tests/unit/generate-channel-showcase.test.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const CHANNELS_YAML = "distribution/channels.yaml";
const GENERATED_FILE = "src/lib/distribution/channels.generated.ts";
const REGENERATE_COMMAND = "bun run channels:showcase";

/**
 * Inventory category -> the row the login hero renders it in. Deliberately
 * exhaustive and deliberately many-to-one: the hero has four rows, the
 * inventory has eight business buckets, and collapsing them is a UI decision
 * that belongs here rather than in JSX. A category with no entry throws
 * (groupForCategory), so adding a bucket to channels.yaml breaks this script
 * loudly instead of quietly dropping a channel off the login page.
 */
export const CATEGORY_GROUPS = {
  containers: "containers",
  "kubernetes-operators": "kubernetes",
  "paas-catalogs": "paas",
  "deploy-recipes": "paas",
  "cloud-marketplaces": "paas",
  "package-managers": "packages",
  "os-desktop": "packages",
  "registries-releases": "packages",
};

/**
 * The canonical platform order documented at the top of channels.yaml. Output
 * follows it regardless of the order written in yaml, so a reordered inventory
 * row never shows up as generated-file drift.
 */
export const SHOWCASE_PLATFORMS = ["linux", "macos", "windows", "container", "kubernetes", "cloud"];

export function groupForCategory(category) {
  if (!Object.hasOwn(CATEGORY_GROUPS, category)) {
    throw new Error(
      `${CHANNELS_YAML}: unknown category '${category}' - map it in CATEGORY_GROUPS (scripts/generate-channel-showcase.mjs)`,
    );
  }
  return CATEGORY_GROUPS[category];
}

/**
 * The live inventory as the UI needs it: `{ channels, platforms }`.
 *
 * Only `status: live` reaches the product. `pending` is not installable yet and
 * `deprecated` must never render at all (docs/CHANNELS.md: "a deprecated
 * channel renders no link at all"). The label is `short_name` when the
 * inventory provides one - `name` carries qualifiers written for the docs
 * matrix ("Docker image (GHCR, canonical)") that are too long for a hero row.
 */
export function buildShowcase(yamlText) {
  const doc = parseYaml(yamlText);
  if (!doc || !Array.isArray(doc.channels)) {
    throw new Error(`${CHANNELS_YAML}: top-level 'channels' list is missing`);
  }
  const live = doc.channels.filter((channel) => channel.status === "live");
  const channels = live.map((channel) => ({
    id: channel.id,
    label: channel.short_name ?? channel.name,
    group: groupForCategory(channel.category),
  }));
  const covered = new Set();
  for (const channel of live) {
    for (const platform of channel.platforms) {
      if (!SHOWCASE_PLATFORMS.includes(platform)) {
        throw new Error(
          `${CHANNELS_YAML}: ${channel.id}: platforms entries must be one of ${SHOWCASE_PLATFORMS.join("|")}`,
        );
      }
      covered.add(platform);
    }
  }
  return { channels, platforms: SHOWCASE_PLATFORMS.filter((platform) => covered.has(platform)) };
}

/**
 * Renders the committed TypeScript module. The output is written the way Biome
 * formats it (double quotes, trailing commas, 2-space indent, lineWidth 120),
 * because `bun run format` checks src/** and a generated file that needed
 * reformatting would fail the very gate that keeps it honest.
 */
export function renderModule({ channels, platforms }) {
  const rows = channels
    .map(
      (channel) =>
        `  { id: ${JSON.stringify(channel.id)}, label: ${JSON.stringify(channel.label)}, group: ${JSON.stringify(channel.group)} },`,
    )
    .join("\n");
  // Biome keeps an array on one line while it fits in lineWidth 120 and breaks
  // it one-per-line otherwise, so the generator has to make the same call - a
  // file that `bun run format` would rewrite fails the gate that guards it.
  const quoted = platforms.map((platform) => JSON.stringify(platform));
  const oneLine = `export const LIVE_PLATFORMS: readonly ShowcasePlatform[] = [${quoted.join(", ")}];`;
  const platformDeclaration =
    oneLine.length <= 120
      ? oneLine
      : `export const LIVE_PLATFORMS: readonly ShowcasePlatform[] = [\n${quoted.map((platform) => `  ${platform},`).join("\n")}\n];`;
  return `// GENERATED FILE - do not edit. Run: ${REGENERATE_COMMAND}
//
// Source: ${CHANNELS_YAML} (live channels only), via
// scripts/generate-channel-showcase.mjs. CI fails on drift
// (bun run channels:showcase:check), so this file is always the inventory.

/** The row of the login hero's deploy block a channel belongs to. */
export type ShowcaseGroup = "containers" | "kubernetes" | "paas" | "packages";

/** Platforms a live channel serves, in the canonical order of ${CHANNELS_YAML}. */
export type ShowcasePlatform = ${SHOWCASE_PLATFORMS.map((platform) => JSON.stringify(platform)).join(" | ")};

export interface ShowcaseChannel {
  id: string;
  label: string;
  group: ShowcaseGroup;
}

export const LIVE_CHANNELS: readonly ShowcaseChannel[] = [
${rows}
];

${platformDeclaration}
`;
}

/**
 * The committed module's current text, or `null` when it is not there yet.
 *
 * Read-and-catch rather than `existsSync` then read. The stat bought nothing - the write
 * below is unconditional and never consults the result - while leaving a check-then-use
 * window CodeQL reports as `js/file-system-race`. Only `ENOENT` is swallowed: any other
 * errno (a directory in the file's place, a permission failure) is a real problem and must
 * surface, not read as "stale" and send someone off to run the generator again.
 */
function readGeneratedOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function main(argv) {
  const checkOnly = argv.includes("--check");
  const rootIdx = argv.indexOf("--root");
  const rootArg = rootIdx === -1 ? undefined : argv[rootIdx + 1];
  if (rootIdx !== -1 && (rootArg === undefined || rootArg.startsWith("--"))) {
    console.error("ERROR: --root requires a directory path");
    process.exit(2);
  }
  const root = rootIdx === -1 ? process.cwd() : path.resolve(rootArg);

  const generatedPath = path.join(root, GENERATED_FILE);
  const next = renderModule(buildShowcase(fs.readFileSync(path.join(root, CHANNELS_YAML), "utf8")));
  // Absent counts as stale: the file is committed, so "not there" and "out of
  // date" are the same failure with the same fix.
  const current = readGeneratedOrNull(generatedPath);

  if (checkOnly) {
    if (current !== next) {
      console.error(`ERROR: ${GENERATED_FILE} is stale; run: ${REGENERATE_COMMAND}`);
      process.exit(1);
    }
    console.log(`${GENERATED_FILE} is up to date`);
    return;
  }

  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.writeFileSync(generatedPath, next);
  console.log(`Wrote ${GENERATED_FILE}`);
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

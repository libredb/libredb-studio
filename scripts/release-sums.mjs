#!/usr/bin/env node
/**
 * Rebuild the release's combined SHA256SUMS so it covers every payload asset
 * (issue #913).
 *
 * Why not in the `publish` job: it runs before the snap, SBOM and desktop jobs
 * have attached anything, so the file it writes can only cover the standalone
 * tarballs and the win32 zip. The .deb/.rpm/.AppImage assets were given
 * per-file `<name>.sha256` sidecars as a workaround, and the two snaps and the
 * CycloneDX SBOM ended up with neither - so a reader who downloads a .snap
 * from the release page has nothing to check it against.
 *
 * This runs in `publish-release`, immediately before the draft is published,
 * when every payload asset exists and the asset set can still be amended.
 *
 *   - every payload asset is covered (anything that is not SHA256SUMS itself
 *     and not a `.sha256` sidecar);
 *   - the digests come from the releases API, which records the sha256 of the
 *     bytes as stored - hashing a fresh download would be a second opinion on
 *     the same bytes, at the cost of pulling ~1.5 GB in the last job of the
 *     release chain. An asset with no digest recorded is downloaded and hashed
 *     locally instead;
 *   - every entry the file already carried must survive with the same hash.
 *     The npx launcher, the Homebrew formula and the Chocolatey/winget
 *     renderers all read this file, so the rebuild may only widen it;
 *   - the `sha256sum` output format is preserved (hash, two spaces, bare file
 *     name, newline) and names are sorted, which is the order the `publish`
 *     job's glob already produced.
 *
 * Usage:
 *   gh api "repos/<owner>/<repo>/releases/tags/<version>" > release.json
 *   gh release download <version> --pattern SHA256SUMS --dir dist
 *   node scripts/release-sums.mjs release.json --existing dist/SHA256SUMS > SHA256SUMS
 *
 *   --existing <path>  the SHA256SUMS already on the release; its entries are
 *                      asserted to survive unchanged
 *   --allow-download   hash an asset locally when the API records no digest for
 *                      it (without this flag that is an error)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const SUMS_NAME = "SHA256SUMS";
const SIDECAR_SUFFIX = ".sha256";
const DIGEST_PREFIX = "sha256:";
const HEX64 = /^[0-9a-f]{64}$/;
const SUMS_LINE = /^([0-9a-f]{64}) {2}(.+)$/;

/** Payload assets are everything a user downloads and runs. */
export function isPayloadAsset(name) {
  return name !== SUMS_NAME && !name.endsWith(SIDECAR_SUFFIX);
}

/** The sha256 the releases API records for an asset, or null when it has none. */
export function assetSha256(asset) {
  const digest = typeof asset?.digest === "string" ? asset.digest : "";
  if (!digest.startsWith(DIGEST_PREFIX)) return null;
  const hex = digest.slice(DIGEST_PREFIX.length);
  return HEX64.test(hex) ? hex : null;
}

/** One `sha256sum` output line. Bare file name: consumers look entries up by name. */
export function formatSum(hash, name) {
  return `${hash}  ${name}\n`;
}

/** Payload assets, sorted by name - the order the release's own glob produces. */
export function payloadAssets(assets) {
  const payload = (assets ?? []).filter((asset) => isPayloadAsset(asset?.name));
  const names = new Set();
  for (const asset of payload) {
    if (names.has(asset.name)) throw new Error(`Release asset list carries '${asset.name}' twice`);
    names.add(asset.name);
  }
  return payload.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function parseSums(text) {
  const entries = new Map();
  for (const line of (text ?? "").split("\n")) {
    if (line.trim() === "") continue;
    const match = SUMS_LINE.exec(line);
    if (!match) throw new Error(`Malformed SHA256SUMS line: ${JSON.stringify(line)}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

/** Hash a fetch Response body. */
export async function hashResponse(response) {
  if (!response.ok) throw new Error(`Cannot download the asset: HTTP ${response.status}`);
  const hash = crypto.createHash("sha256");
  for await (const chunk of Readable.fromWeb(response.body)) hash.update(chunk);
  return hash.digest("hex");
}

export async function hashUrl(url, fetchImpl = fetch) {
  return hashResponse(await fetchImpl(url));
}

/**
 * Rebuild the combined checksum file from a release's asset list.
 * Throws rather than emitting a partial file: this runs on a draft that is
 * about to become immutable, so a wrong file is permanent.
 */
export async function buildSums(assets, { allowDownload = false, fetchImpl = fetch } = {}) {
  const payload = payloadAssets(assets);
  if (payload.length === 0) throw new Error("Release asset list has no payload assets");

  let sums = "";
  for (const asset of payload) {
    let hash = assetSha256(asset);
    if (hash === null) {
      if (!allowDownload) {
        throw new Error(
          `Release asset '${asset.name}' has no sha256 digest recorded - re-run with --allow-download to hash it locally`,
        );
      }
      if (!asset.browser_download_url) {
        throw new Error(`Release asset '${asset.name}' has no digest and no download URL`);
      }
      hash = await hashUrl(asset.browser_download_url, fetchImpl);
    }
    sums += formatSum(hash, asset.name);
  }
  return sums;
}

/** Every entry the previous file carried must survive, unchanged. */
export function assertSuperset(existingText, rebuiltText) {
  const existing = parseSums(existingText);
  const rebuilt = parseSums(rebuiltText);
  for (const [name, hash] of existing) {
    const current = rebuilt.get(name);
    if (current === undefined) {
      throw new Error(`Rebuilt SHA256SUMS dropped the existing entry for '${name}'`);
    }
    if (current !== hash) {
      throw new Error(`Rebuilt SHA256SUMS changed the hash for '${name}' (was ${hash}, now ${current})`);
    }
  }
}

function parseArgs(argv) {
  const args = { releasePath: "", existingPath: "", allowDownload: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--allow-download") {
      args.allowDownload = true;
    } else if (arg === "--existing") {
      args.existingPath = argv[i + 1] ?? "";
      if (args.existingPath === "") throw new Error("--existing needs a path");
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (args.releasePath === "") {
      args.releasePath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (args.releasePath === "") {
    throw new Error("Usage: node scripts/release-sums.mjs <release.json> [--existing <SHA256SUMS>] [--allow-download]");
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const release = JSON.parse(fs.readFileSync(args.releasePath, "utf8"));
  const rebuilt = await buildSums(release.assets, { allowDownload: args.allowDownload });
  if (args.existingPath !== "") {
    assertSuperset(fs.readFileSync(args.existingPath, "utf8"), rebuilt);
  }
  process.stdout.write(rebuilt);
  console.error(`Rebuilt SHA256SUMS over ${rebuilt.trimEnd().split("\n").length} payload assets`);
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`release-sums: ${error.message}`);
    process.exit(1);
  });
}

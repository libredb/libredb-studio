#!/usr/bin/env node
/**
 * Render the Flatpak manifest template (issue #232).
 *
 * The manifest that lives on Flathub repacks the AppImage release CI publishes,
 * so it has to name a concrete release URL plus its sha256 per architecture.
 * This script fills those in from the checksum sidecars the AppImage job writes
 * (or from any sha256sum-format file), exactly like
 * scripts/render-homebrew-formula.mjs does for the Homebrew tap.
 *
 * Usage:
 *   node scripts/render-flatpak-manifest.mjs <template> <sums> <version> <output>
 *   node scripts/render-flatpak-manifest.mjs <template> <sums> <version> <output> \
 *     --local <arch> <appimage-path>
 *
 * --local rewrites the architecture source to a local file instead of a release
 * URL, which is how the manifest is built and E2E-tested BEFORE the first
 * AppImage has ever been released (see packaging/flatpak/README.md).
 *
 * Pure rendering logic is exported and unit tested in
 * tests/unit/render-flatpak-manifest.test.ts (no network access).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { parseSha256Sums, sha256File } from "../bin/lib/launcher-utils.mjs";

/** Flathub application id; must equal the metainfo <id> and the manifest file name. */
export const APP_ID = "org.libredb.Studio";

/**
 * Architectures the Flathub build covers. `flatpak` is the only-arches label,
 * `asset` is the label the release asset uses (the repo-wide x64/arm64
 * convention, see scripts/build-desktop-appimage.sh).
 */
export const FLATPAK_ARCHES = [
  { flatpak: "x86_64", asset: "x64", placeholder: "SHA256_LINUX_X64" },
  { flatpak: "aarch64", asset: "arm64", placeholder: "SHA256_LINUX_ARM64" },
];

/** Same semver shape the release workflow guard enforces (no v prefix). */
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/**
 * Release asset name of the desktop AppImage.
 *
 * @param {string} version release version, no v prefix
 * @param {string} assetArch "x64" or "arm64"
 * @returns {string}
 */
export function appImageName(version, assetArch) {
  return `libredb-studio-desktop-${version}-linux-${assetArch}.AppImage`;
}

/**
 * Render the manifest template into a submittable manifest.
 *
 * @param {string} template raw template text
 * @param {string} sumsText sha256sum-format checksums covering both AppImages
 * @param {string} version release version, no v prefix (e.g. "0.9.60")
 * @returns {string} the rendered manifest
 */
export function renderFlatpakManifest(template, sumsText, version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Version '${version}' is not a valid semver (no v prefix)`);
  }

  const sums = parseSha256Sums(sumsText);
  let rendered = template.replaceAll("{{VERSION}}", version);

  for (const arch of FLATPAK_ARCHES) {
    const asset = appImageName(version, arch.asset);
    const digest = sums.get(asset);
    if (!digest) {
      throw new Error(`Checksum input has no entry for ${asset}`);
    }
    rendered = rendered.replaceAll(`{{${arch.placeholder}}}`, digest);
  }

  // Any surviving marker (known or misspelled) means a broken manifest.
  const leftover = /\{\{[^}\n]*\}\}/.exec(rendered) ?? (rendered.includes("{{") ? ["{{"] : null);
  if (leftover) {
    throw new Error(`Unfilled placeholder ${leftover[0]} in rendered manifest`);
  }

  return rendered;
}

/**
 * Point a rendered manifest at a locally built AppImage instead of a release.
 *
 * Keeps the manifest otherwise identical - same build commands, same launcher,
 * desktop entry and metainfo sources - so a local flatpak-builder run exercises
 * what Flathub will actually build. The other architecture's source is dropped
 * because flatpak-builder resolves sources before honouring only-arches.
 *
 * @param {string} manifestText a rendered manifest
 * @param {string} flatpakArch "x86_64" or "aarch64"
 * @param {string} appImagePath path to the local AppImage, relative to the manifest
 * @returns {string} the localized manifest
 */
export function localizeFlatpakManifest(manifestText, flatpakArch, appImagePath) {
  const doc = parseDocument(manifestText);
  const sources = doc.getIn(["modules", 0, "sources"]);
  const kept = [];
  let localized = false;

  for (const source of sources.items) {
    const arches = source.get("only-arches");
    if (!arches) {
      kept.push(source);
      continue;
    }
    if (!arches.toJSON().includes(flatpakArch)) {
      continue;
    }
    for (const key of ["only-arches", "url", "sha256", "x-checker-data"]) {
      source.delete(key);
    }
    source.set("path", appImagePath);
    kept.push(source);
    localized = true;
  }

  if (!localized) {
    throw new Error(`Manifest has no AppImage source for architecture '${flatpakArch}'`);
  }

  sources.items = kept;
  return doc.toString();
}

/**
 * Checksums for a local build: the real digest of the AppImage being tested,
 * plus a well-formed dummy for the other architecture. The dummy is never part
 * of the output - localizeFlatpakManifest drops that source - it only exists so
 * the strict renderer above still sees a complete checksum set.
 */
async function localSums(version, flatpakArch, appImagePath) {
  const target = FLATPAK_ARCHES.find((arch) => arch.flatpak === flatpakArch);
  if (!target) {
    throw new Error(`Unknown architecture '${flatpakArch}' (expected x86_64 or aarch64)`);
  }
  const digest = await sha256File(appImagePath);
  return FLATPAK_ARCHES.map(
    (arch) => `${arch === target ? digest : "0".repeat(64)}  ${appImageName(version, arch.asset)}`,
  ).join("\n");
}

async function main(argv) {
  const [templatePath, sumsPath, version, outputPath, localFlag, localArch, localAppImage] = argv;
  if (!templatePath || !sumsPath || !version || !outputPath) {
    console.error(
      "Usage: node scripts/render-flatpak-manifest.mjs <template> <sums> <version> <output> [--local <arch> <appimage>]",
    );
    process.exit(1);
  }
  if (localFlag && (localFlag !== "--local" || !localArch || !localAppImage)) {
    console.error("--local needs an architecture (x86_64|aarch64) and a path to the AppImage");
    process.exit(1);
  }

  const template = fs.readFileSync(templatePath, "utf8");
  // In --local mode the checksum file is ignored in favour of the real digest of
  // the AppImage under test; pass any existing path (e.g. the sidecar) for it.
  const appImage = localFlag ? path.resolve(localAppImage) : null;
  const sumsText = localFlag ? await localSums(version, localArch, appImage) : fs.readFileSync(sumsPath, "utf8");

  let rendered = renderFlatpakManifest(template, sumsText, version);
  if (localFlag) {
    // flatpak-builder resolves `path:` against the manifest's directory. Emit a
    // relative path so the rendered manifest survives being moved between jobs
    // or into a container together with the AppImage next to it.
    const relative = path.relative(path.dirname(path.resolve(outputPath)), appImage);
    rendered = localizeFlatpakManifest(rendered, localArch, relative);
  }

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, rendered);
  console.log(`Rendered ${outputPath} for version ${version}${localFlag ? ` (local ${localArch} build)` : ""}`);
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

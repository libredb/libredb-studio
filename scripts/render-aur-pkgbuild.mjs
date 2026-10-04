#!/usr/bin/env node
/**
 * Render the AUR PKGBUILD for a release (issue #971).
 *
 * packaging/aur/PKGBUILD is a real, buildable PKGBUILD for the last version
 * someone verified by hand, not a template. This rewrites exactly its version
 * and digest fields for another release: pkgver, pkgrel (reset to 1), the three
 * packaging/linux digests in sha256sums, and the two tarball digests, which
 * come from the release's SHA256SUMS. Everything else passes through unchanged.
 *
 * The packaging/linux digests are hashed from the checkout rather than
 * downloaded: the release workflow runs at the tag, and the PKGBUILD fetches
 * the same three files from that tag, so both sides hash the same bytes.
 *
 * Fails loudly when a field is missing or a digest is absent - a half-rendered
 * PKGBUILD must never reach the AUR. makepkg in the release job then downloads
 * every source and checks each digest, so a wrong one fails there too.
 *
 * Usage: node scripts/render-aur-pkgbuild.mjs <PKGBUILD> <sums> <version> <packaging-linux-dir> <output>
 *
 * Pure rendering logic is exported and unit tested in
 * tests/unit/render-aur-pkgbuild.test.ts (no network access).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactName, parseSha256Sums } from "../bin/lib/launcher-utils.mjs";

/** packaging/linux files in the order of source=() in the PKGBUILD. */
export const LINUX_SOURCE_FILES = [
  { key: "launcher", name: "libredb-studio" },
  { key: "service", name: "libredb-studio.service" },
  { key: "env", name: "env" },
];

/** Release versions pkgver can hold: plain semver. makepkg rejects a hyphen. */
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function replaceOnce(text, pattern, replacement, field) {
  const matches = text.match(new RegExp(pattern.source, "gm"));
  if (!matches || matches.length !== 1) {
    throw new Error(`PKGBUILD must define ${field} exactly once (found ${matches ? matches.length : 0})`);
  }
  return text.replace(new RegExp(pattern.source, "m"), replacement);
}

/**
 * Render the PKGBUILD for one release.
 *
 * @param {string} pkgbuild the committed PKGBUILD
 * @param {string} sumsText SHA256SUMS content (sha256sum output format)
 * @param {string} version release version, no v prefix (e.g. "0.18.0")
 * @param {{launcher: string, service: string, env: string}} linuxDigests sha256 of the packaging/linux files
 * @returns {string} the rendered PKGBUILD
 */
export function renderAurPkgbuild(pkgbuild, sumsText, version, linuxDigests) {
  if (version.includes("-")) {
    throw new Error(
      `Version '${version}' is a prerelease: pkgver cannot hold a hyphen, and the AUR gets stable releases only`,
    );
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Version '${version}' is not a valid semver (no v prefix)`);
  }

  const sums = parseSha256Sums(sumsText);
  const tarballDigest = (arch) => {
    const tarball = artifactName(version, "linux", arch);
    const digest = sums.get(tarball);
    if (!digest) {
      throw new Error(`SHA256SUMS has no entry for ${tarball}`);
    }
    return digest;
  };

  const linux = LINUX_SOURCE_FILES.map(({ key }) => {
    const digest = linuxDigests[key];
    if (!SHA256_PATTERN.test(digest ?? "")) {
      throw new Error(`packaging/linux digest for ${key} is not a sha256: '${digest}'`);
    }
    return `'${digest}'`;
  });

  let rendered = replaceOnce(pkgbuild, /^pkgver=.*$/, `pkgver=${version}`, "pkgver");
  rendered = replaceOnce(rendered, /^pkgrel=.*$/, "pkgrel=1", "pkgrel");
  rendered = replaceOnce(
    rendered,
    /^sha256sums=\([^)]*\)/,
    `sha256sums=(${linux.join("\n            ")})`,
    "sha256sums",
  );
  rendered = replaceOnce(
    rendered,
    /^sha256sums_x86_64=\([^)]*\)/,
    `sha256sums_x86_64=('${tarballDigest("x64")}')`,
    "sha256sums_x86_64",
  );
  rendered = replaceOnce(
    rendered,
    /^sha256sums_aarch64=\([^)]*\)/,
    `sha256sums_aarch64=('${tarballDigest("arm64")}')`,
    "sha256sums_aarch64",
  );
  return rendered;
}

function main(argv) {
  const [pkgbuildPath, sumsPath, version, linuxDir, outputPath] = argv;
  if (!pkgbuildPath || !sumsPath || !version || !linuxDir || !outputPath) {
    console.error(
      "Usage: node scripts/render-aur-pkgbuild.mjs <PKGBUILD> <sums> <version> <packaging-linux-dir> <output>",
    );
    process.exit(1);
  }

  const linuxDigests = Object.fromEntries(
    LINUX_SOURCE_FILES.map(({ key, name }) => [
      key,
      createHash("sha256")
        .update(fs.readFileSync(path.join(linuxDir, name)))
        .digest("hex"),
    ]),
  );
  const rendered = renderAurPkgbuild(
    fs.readFileSync(pkgbuildPath, "utf8"),
    fs.readFileSync(sumsPath, "utf8"),
    version,
    linuxDigests,
  );

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, rendered);
  console.log(`Rendered ${outputPath} for version ${version}`);
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

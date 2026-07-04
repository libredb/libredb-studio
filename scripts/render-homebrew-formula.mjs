#!/usr/bin/env node
/**
 * Render the Homebrew formula template (issue #111).
 *
 * Fills {{VERSION}} and the per-platform {{SHA256_*}} placeholders in
 * packaging/homebrew/libredb-studio.rb.tmpl from the SHA256SUMS file that the
 * release workflow attaches to the GitHub release. Fails loudly when a
 * platform digest is missing or a placeholder would survive rendering - a
 * half-rendered formula must never reach the tap.
 *
 * Usage: node scripts/render-homebrew-formula.mjs <template> <sums> <version> <output>
 *
 * Pure rendering logic is exported and unit tested in
 * tests/unit/render-homebrew-formula.test.ts (no network access).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactName, parseSha256Sums } from "../bin/lib/launcher-utils.mjs";

/**
 * Template placeholder per release target. The targets must mirror the build
 * matrix in .github/workflows/release-artifacts.yml (artifactName throws for
 * anything the release workflow does not build).
 */
const PLACEHOLDER_BY_TARGET = {
  "darwin-x64": "SHA256_DARWIN_X64",
  "darwin-arm64": "SHA256_DARWIN_ARM64",
  "linux-x64": "SHA256_LINUX_X64",
  "linux-arm64": "SHA256_LINUX_ARM64",
};

/** Same semver shape the release workflow guard enforces (no v prefix). */
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/**
 * Render the formula template into a concrete formula.
 *
 * @param {string} template raw template text
 * @param {string} sumsText SHA256SUMS content (sha256sum output format)
 * @param {string} version release version, no v prefix (e.g. "0.9.41")
 * @returns {string} the rendered formula
 */
export function renderHomebrewFormula(template, sumsText, version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Version '${version}' is not a valid semver (no v prefix)`);
  }

  const sums = parseSha256Sums(sumsText);
  let rendered = template.replaceAll("{{VERSION}}", version);

  for (const [target, placeholder] of Object.entries(PLACEHOLDER_BY_TARGET)) {
    const [platform, arch] = target.split("-");
    const tarball = artifactName(version, platform, arch);
    const digest = sums.get(tarball);
    if (!digest) {
      throw new Error(`SHA256SUMS has no entry for ${tarball}`);
    }
    rendered = rendered.replaceAll(`{{${placeholder}}}`, digest);
  }

  // Any surviving marker (known or misspelled) means a broken formula.
  const leftover = /\{\{[^}\n]*\}\}/.exec(rendered) ?? (rendered.includes("{{") ? ["{{"] : null);
  if (leftover) {
    throw new Error(`Unfilled placeholder ${leftover[0]} in rendered formula`);
  }

  return rendered;
}

function main(argv) {
  const [templatePath, sumsPath, version, outputPath] = argv;
  if (!templatePath || !sumsPath || !version || !outputPath) {
    console.error("Usage: node scripts/render-homebrew-formula.mjs <template> <sums> <version> <output>");
    process.exit(1);
  }

  const template = fs.readFileSync(templatePath, "utf8");
  const sumsText = fs.readFileSync(sumsPath, "utf8");
  const rendered = renderHomebrewFormula(template, sumsText, version);

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, rendered);
  console.log(`Rendered ${outputPath} for version ${version}`);
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

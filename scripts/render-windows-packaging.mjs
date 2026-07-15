#!/usr/bin/env node
/**
 * Render a Windows packaging template (issue #114) - the win32 sibling of
 * scripts/render-homebrew-formula.mjs, shared by the winget manifests
 * (packaging/winget/*.tmpl) and the Chocolatey package
 * (packaging/chocolatey/**.tmpl).
 *
 * Fills {{VERSION}} and {{SHA256_WIN32_X64}} (the win32-x64 zip digest)
 * from the SHA256SUMS file the release workflow attaches to the GitHub
 * release. Fails loudly when the digest is missing or a placeholder would
 * survive rendering - a half-rendered manifest must never reach a package
 * repository.
 *
 * Usage: node scripts/render-windows-packaging.mjs <template> <sums> <version> <output>
 *
 * Pure rendering logic is exported and unit tested in
 * tests/unit/render-windows-packaging.test.ts (no network access).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactName, parseSha256Sums } from "../bin/lib/launcher-utils.mjs";

/** Same semver shape the release workflow guard enforces (no v prefix). */
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/**
 * Render a winget/Chocolatey template into a concrete package file.
 *
 * @param {string} template raw template text
 * @param {string} sumsText SHA256SUMS content (sha256sum output format)
 * @param {string} version release version, no v prefix (e.g. "0.9.41")
 * @returns {string} the rendered file
 */
export function renderWindowsPackagingTemplate(template, sumsText, version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Version '${version}' is not a valid semver (no v prefix)`);
  }

  const sums = parseSha256Sums(sumsText);
  const zipName = artifactName(version, "win32", "x64");
  const digest = sums.get(zipName);
  if (!digest) {
    throw new Error(`SHA256SUMS has no entry for ${zipName}`);
  }

  const rendered = template.replaceAll("{{VERSION}}", version).replaceAll("{{SHA256_WIN32_X64}}", digest);

  // Any surviving marker (known, misspelled, or a stray half - e.g. a
  // typoed {VERSION}} leaving a bare "}}") means a broken package file.
  const leftover =
    /\{\{[^}\n]*\}\}/.exec(rendered) ??
    (rendered.includes("{{") ? ["{{"] : null) ??
    (rendered.includes("}}") ? ["}}"] : null);
  if (leftover) {
    throw new Error(`Unfilled placeholder ${leftover[0]} in rendered template`);
  }

  return rendered;
}

function main(argv) {
  const [templatePath, sumsPath, version, outputPath] = argv;
  if (!templatePath || !sumsPath || !version || !outputPath) {
    console.error("Usage: node scripts/render-windows-packaging.mjs <template> <sums> <version> <output>");
    process.exit(1);
  }

  const template = fs.readFileSync(templatePath, "utf8");
  const sumsText = fs.readFileSync(sumsPath, "utf8");
  const rendered = renderWindowsPackagingTemplate(template, sumsText, version);

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, rendered);
  console.log(`Rendered ${outputPath} for version ${version}`);
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

// Writes THIRD_PARTY_NOTICES.txt's text from the bundles' metafiles (part 5, "Third-party notices").
// The VSIX carries bundles, not node_modules, so each bundled package's licence and notice files travel here.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inputPackage } from "./bundle-checks.mjs";

/**
 * The licences a bundled package may carry; a new one is a reviewed change to this list.
 * A package passes with one of these ids, or with an OR expression of plain ids one of which is here (the distributor
 * may take that one); an expression with AND or WITH stays refused and is reviewed by hand when one appears.
 */
export const LICENSE_ALLOWLIST = [
  "MIT",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
];

/**
 * Beside package.json, committed and not shipped: the licence text of a package that publishes no licence file, as
 * <name>@<version>.txt (a scope's "/" written "__"), whose first line is "Source: <URL>" naming where it was copied
 * from. A version bump finds no file and fails the build, so the text is checked again.
 */
export const VENDORED_LICENSES = "third-party-licenses";

/** Reviewed licences for packages whose package.json names none, by exact name@version. */
export const LICENSE_OVERRIDES = {
  "precond@0.2.3": {
    license: "MIT",
    stated: "README.md, License: free to use under the terms of the MIT license (http://mturcotte.mit-license.org/)",
  },
};

const HEADER =
  "Third-party notices for LibreDB Studio for VS Code\n\n" +
  "Each entry below names a package whose code the extension's bundles in dist/ include, its version and its licence,\n" +
  "followed by the text of the package's licence and notice files.\n";

const LICENCE_FILE = /^(LICENSE|LICENCE|NOTICE|COPYING)/i;
const SPDX_ID = /^[A-Za-z0-9.+-]+$/;
const SOURCE_LINE = /^Source: https?:\/\/\S+\n/;

/** THIRD_PARTY_NOTICES.txt's text for every package that contributed an input to the given metafiles. */
export function renderNotices(metafiles, workingDir) {
  const packageDirs = new Set();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const pkg = inputPackage(input);
      if (pkg === null) continue;
      const at = input.lastIndexOf(`node_modules/${pkg}/`);
      packageDirs.add(resolve(workingDir, input.slice(0, at), "node_modules", pkg));
    }
  }
  if (packageDirs.size === 0) return `${HEADER}\nNo third-party package is bundled.\n`;
  const entries = [...packageDirs]
    .map((dir) => readPackage(dir, workingDir))
    .sort((a, b) => compare(a.name, b.name) || compare(a.title, b.title));
  return `${HEADER}${entries.map((entry) => `\n${"-".repeat(80)}\n${entry.title}\n${entry.texts}`).join("")}`;
}

function readPackage(dir, workingDir) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const id = `${manifest.name}@${manifest.version}`;
  const license = licenseOf(manifest, id);
  return { name: manifest.name, title: `${id} (${license})`, texts: licenceTexts(dir, manifest, id, workingDir) };
}

/** The licence a package is bundled under: license, else npm's legacy licenses array, else LICENSE_OVERRIDES. */
function licenseOf(manifest, id) {
  const { license, licenses } = manifest;
  if (typeof license === "string") return allowed(id, license, spdxAllowed(license));
  if (license === undefined) {
    const types = legacyTypes(licenses);
    if (types !== null) {
      return allowed(
        id,
        types.join(", "),
        types.every((type) => LICENSE_ALLOWLIST.includes(type)),
      );
    }
    if (Object.hasOwn(LICENSE_OVERRIDES, id)) {
      const reviewed = LICENSE_OVERRIDES[id].license;
      return allowed(id, reviewed, spdxAllowed(reviewed));
    }
  }
  throw new Error(`${id} has no SPDX license string in its package.json (found ${JSON.stringify(license)}).`);
}

/** The types of npm's legacy licenses array, [{ type, url }], or null when the field is not such an array. */
function legacyTypes(licenses) {
  if (!Array.isArray(licenses) || licenses.length === 0) return null;
  const types = licenses.map((entry) => entry?.type);
  return types.every((type) => typeof type === "string") ? types : null;
}

/** An id on LICENSE_ALLOWLIST, or an OR expression of plain ids with one on it. */
function spdxAllowed(expression) {
  const alternatives = expression.replace(/^\((.*)\)$/, "$1").split(" OR ");
  return (
    alternatives.every((alternative) => SPDX_ID.test(alternative)) &&
    alternatives.some((alternative) => LICENSE_ALLOWLIST.includes(alternative))
  );
}

function allowed(id, license, isAllowed) {
  if (!isAllowed) {
    throw new Error(`${id} is licensed "${license}", which is not on LICENSE_ALLOWLIST in scripts/notices.mjs.`);
  }
  return license;
}

/** The package's own licence and notice files, else its text in VENDORED_LICENSES, else a refusal naming both. */
function licenceTexts(dir, manifest, id, workingDir) {
  const files = readdirSync(dir)
    .filter((file) => LICENCE_FILE.test(file))
    .sort(compare);
  if (files.length > 0) return files.map((file) => section(file, readFileSync(join(dir, file), "utf8"))).join("");
  const vendored = `${manifest.name.replace("/", "__")}@${manifest.version}.txt`;
  const path = join(workingDir, VENDORED_LICENSES, vendored);
  if (!existsSync(path)) {
    throw new Error(
      `${id} has no LICENSE, LICENCE, NOTICE or COPYING file in ${dir}, and ${VENDORED_LICENSES}/ holds no ${vendored}.`,
    );
  }
  const label = `${VENDORED_LICENSES}/${vendored}`;
  const text = readFileSync(path, "utf8");
  if (!SOURCE_LINE.test(text)) {
    throw new Error(`${label} must start with a "Source: <URL>" line naming where its text was copied from.`);
  }
  return section(label, text);
}

function section(label, text) {
  return `\n${label}:\n\n${text.trimEnd()}\n`;
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Writes THIRD_PARTY_NOTICES.txt's text from the bundles' metafiles (part 5, "Third-party notices").
// The VSIX carries bundles, not node_modules, so each bundled package's licence and notice files travel here.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inputPackage } from "./bundle-checks.mjs";

/** The licences a bundled package may carry; a new one is a reviewed change to this list. */
export const LICENSE_ALLOWLIST = [
  "MIT",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
];

const HEADER =
  "Third-party notices for LibreDB Studio for VS Code\n\n" +
  "Each entry below names a package whose code the extension's bundles in dist/ include, its version and its licence,\n" +
  "followed by the text of the package's licence and notice files.\n";

const LICENCE_FILE = /^(LICENSE|LICENCE|NOTICE|COPYING)/i;

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
  const entries = [...packageDirs].map(readPackage).sort((a, b) => compare(a.name, b.name) || compare(a.title, b.title));
  return `${HEADER}${entries.map((entry) => `\n${"-".repeat(80)}\n${entry.title}\n${entry.texts}`).join("")}`;
}

function readPackage(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const id = `${manifest.name}@${manifest.version}`;
  const license = manifest.license;
  if (typeof license !== "string") {
    throw new Error(`${id} has no SPDX license string in its package.json (found ${JSON.stringify(license)}).`);
  }
  if (!LICENSE_ALLOWLIST.includes(license)) {
    throw new Error(`${id} is licensed "${license}", which is not on LICENSE_ALLOWLIST in scripts/notices.mjs.`);
  }
  const files = readdirSync(dir)
    .filter((file) => LICENCE_FILE.test(file))
    .sort(compare);
  if (files.length === 0) throw new Error(`${id} has no LICENSE, LICENCE, NOTICE or COPYING file in ${dir}.`);
  const texts = files.map((file) => `\n${file}:\n\n${readFileSync(join(dir, file), "utf8").trimEnd()}\n`).join("");
  return { name: manifest.name, title: `${id} (${license})`, texts };
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Writes the elkjs section of THIRD_PARTY_NOTICES.txt (issue #1292).
//
// elkjs is offered as EPL-2.0 OR GPL-3.0-or-later and this project takes it
// under EPL-2.0. The Next.js build bundles its lib files, unmodified, into the
// web client's chunks, and upstream's minified files carry no license header,
// so the EPL-2.0 text and the source location travel in the notices file that
// every image and payload already carries at its root.
//
// The section is the tail of the file, from its banner to the end, and is
// generated from the installed package: bumping elkjs means running this again,
// and tests/unit/elkjs-notice.test.ts fails until it is. generate-db2-node-notices.sh
// calls this after it rewrites the file, so a full regeneration keeps the section.
//
// Usage: node scripts/generate-elkjs-notice.mjs [notices file]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RULE = "=".repeat(80);
const BANNER = `${RULE}\nelkjs `;

/** The elkjs section's text, read from node_modules/elkjs under the given repository root. */
export function renderElkjsNotice(root) {
  const dir = join(root, "node_modules", "elkjs");
  const { version, license } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (license !== "EPL-2.0 OR GPL-3.0-or-later") {
    throw new Error(`elkjs ${version} declares ${license}; review the license choice before shipping it`);
  }
  const text = readFileSync(join(dir, "LICENSE.md"), "utf8").replace(/\r$/gm, "");
  return [
    RULE,
    `elkjs ${version} (https://github.com/kieler/elkjs)`,
    "License: EPL-2.0 (offered as EPL-2.0 OR GPL-3.0-or-later; distributed here under EPL-2.0)",
    RULE,
    "",
    "The schema diagram's layout engine. The web client's JavaScript chunks",
    "include elkjs's lib/elk-api.js, lib/elk-worker.min.js and lib/elk.bundled.js",
    "unmodified; those files carry no license header of their own.",
    "",
    "Source code:",
    `  https://github.com/kieler/elkjs/tree/${version}`,
    "  and the Eclipse Layout Kernel it is transpiled from, https://github.com/eclipse-elk/elk",
    "",
    text.endsWith("\n") ? text : `${text}\n`,
  ].join("\n");
}

/** The notices text with its elkjs section replaced by the given one, or appended when it has none. */
export function replaceElkjsSection(notices, section) {
  const at = notices.indexOf(BANNER);
  const head = at === -1 ? notices : notices.slice(0, at).replace(/\n$/, "");
  return `${head}\n${section}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const out = process.argv[2] ?? join(root, "THIRD_PARTY_NOTICES.txt");
  writeFileSync(out, replaceElkjsSection(readFileSync(out, "utf8"), renderElkjsNotice(root)));
  console.log(`Wrote the elkjs section of ${out}`);
}

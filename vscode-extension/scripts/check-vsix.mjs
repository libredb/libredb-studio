// Holds a packed VSIX to part 5 "Packaging": its budget, its allowlist and its pre-release flag.
// Run as `node scripts/check-vsix.mjs <file>`: prints each violation and exits 1, or prints the size and entry count.

import { statSync } from "node:fs";
import yauzl from "yauzl";
import { isDirectExecution } from "./direct-execution.mjs";

const MIB = 1024 * 1024;

export const BUDGET = { vsixBytes: 8 * MIB, unpackedBytes: 24 * MIB, backendBytes: 16 * MIB };

/** Entries every VSIX must hold, the results webview's script and stylesheet among them; LICENSE matches with or without the .txt vsce appends. */
export const REQUIRED = [
  "extension/package.json",
  "extension/dist/extension.js",
  "extension/dist/backend.js",
  "extension/dist/webview/results.js",
  "extension/dist/webview/results.css",
  "extension/THIRD_PARTY_NOTICES.txt",
  /^extension\/LICENSE(\.txt)?$/,
  "extension/media/icon.png",
  "extension/media/libredb.svg",
  "extension/media/engines/index.json",
];

/**
 * Every entry a VSIX may hold, mirroring .vscodeignore's allowlist plus what vsce adds:
 * its manifest, [Content_Types].xml, README.md renamed readme.md and LICENSE renamed LICENSE.txt.
 * A file that .vscodeignore lets through but this list does not name still fails, so a widened .vscodeignore needs a second reviewed line here.
 */
export const ALLOWED = [
  ...REQUIRED,
  "extension.vsixmanifest",
  "[Content_Types].xml",
  "extension/readme.md",
  "extension/package.nls.json",
  /^extension\/media\/engines\/[a-z0-9-]+\.(light|dark)\.svg$/,
];

/** [test on an entry's path, rule]; an entry reports the first rule it breaks, and one on none of them is held to ALLOWED. */
const FORBIDDEN = [
  [(path) => path.split("/").includes("node_modules"), "a node_modules entry ships"],
  [(path) => path.startsWith("extension/src/"), "a source file ships"],
  [(path) => path.startsWith("extension/test/"), "a test file ships"],
  [(path) => path.endsWith(".node"), "a native addon ships"],
  [(path) => path.endsWith(".map"), "a source map ships"],
];

/** @param {{ entries: { path: string, size: number }[], vsixBytes: number, version: string, preRelease: boolean }} vsix */
export function vsixViolations(vsix) {
  const violations = [];
  if (vsix.vsixBytes > BUDGET.vsixBytes) {
    violations.push(`The VSIX is ${vsix.vsixBytes} bytes, above its budget of ${BUDGET.vsixBytes}.`);
  }
  const unpacked = vsix.entries.reduce((sum, entry) => sum + entry.size, 0);
  if (unpacked > BUDGET.unpackedBytes) {
    violations.push(`The unpacked content is ${unpacked} bytes, above its budget of ${BUDGET.unpackedBytes}.`);
  }
  const backend = vsix.entries.find((entry) => entry.path === "extension/dist/backend.js");
  if (backend && backend.size > BUDGET.backendBytes) {
    violations.push(`extension/dist/backend.js is ${backend.size} bytes, above its budget of ${BUDGET.backendBytes}.`);
  }
  for (const entry of vsix.entries) {
    const broken = FORBIDDEN.find(([test]) => test(entry.path));
    if (broken) violations.push(`${entry.path}: ${broken[1]}.`);
    else if (!ALLOWED.some((allowed) => matches(allowed, entry.path))) {
      violations.push(`${entry.path}: not on the VSIX allowlist.`);
    }
  }
  for (const required of REQUIRED) {
    const present = vsix.entries.some((entry) => matches(required, entry.path));
    if (!present) violations.push(`${typeof required === "string" ? required : required.source} is missing.`);
  }
  const oddMinor = Number(vsix.version.split(".")[1]) % 2 === 1;
  if (vsix.preRelease !== oddMinor) {
    violations.push(
      `Version ${vsix.version} has ${oddMinor ? "an odd" : "an even"} minor, so the VSIX must ${oddMinor ? "" : "not "}be marked pre-release.`,
    );
  }
  return violations;
}

function matches(rule, path) {
  return typeof rule === "string" ? path === rule : rule.test(path);
}

/** The shape vsixViolations takes, read from the zip; version and preRelease from extension.vsixmanifest. */
export async function readVsix(file) {
  const zip = await new Promise((done, fail) =>
    yauzl.open(file, { lazyEntries: true }, (error, opened) => (error ? fail(error) : done(opened))),
  );
  const entries = [];
  let manifest;
  await new Promise((done, fail) => {
    zip.on("error", fail);
    zip.on("end", done);
    zip.on("entry", (entry) => {
      entries.push({ path: entry.fileName, size: entry.uncompressedSize });
      if (entry.fileName !== "extension.vsixmanifest") return zip.readEntry();
      zip.openReadStream(entry, (error, stream) => {
        if (error) return fail(error);
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", fail);
        stream.on("end", () => {
          manifest = Buffer.concat(chunks).toString("utf8");
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
  if (manifest === undefined) throw new Error(`${file} holds no extension.vsixmanifest.`);
  const version = /<Identity\b[^>]*\bVersion="([^"]+)"/.exec(manifest)?.[1];
  if (version === undefined) throw new Error(`${file}'s extension.vsixmanifest names no Identity Version.`);
  const preRelease = /<Property Id="Microsoft\.VisualStudio\.Code\.PreRelease" Value="true"\s*\/>/.test(manifest);
  return { entries, vsixBytes: statSync(file).size, version, preRelease };
}

/** Prints each violation and exits 1, or prints the VSIX's size and entry count. */
async function main(file) {
  if (!file) throw new Error("Usage: node scripts/check-vsix.mjs <file.vsix>");
  const vsix = await readVsix(file);
  const violations = vsixViolations(vsix);
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  console.log(`${file}: ${vsix.vsixBytes} bytes, ${vsix.entries.length} entries, within budget.`);
}

// No top-level await: the unit leg loads this module through tsx's CommonJS transform.
if (isDirectExecution(process.argv[1], import.meta.url)) {
  main(process.argv[2]).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * Which modules each package entry carries, read from the built package rather than assumed.
 *
 * tsup splits chunks (`splitting: true` in tsup.config.ts), so an entry file holds little more than requires of
 * `./chunk-<hash>.js`, and grepping `dist/workspace.js` alone proves nothing about what a host that imports it
 * loads. This walks the CommonJS require closure of an entry inside `dist/` and checks the package claim of the
 * declared credential warning:
 *
 * - the closure of `dist/components.js` holds the fixed sentence frame of `credentialWarningFor`, so a host that
 *   mounts the exported `ConnectionModal` draws the warning;
 * - the closure of `dist/workspace.js` holds neither the `ConnectionModal` nor the `useConnectionForm` module,
 *   so `StudioWorkspace`, which mounts no connection dialog, shows none.
 *
 * Run after `bun run build:lib`: `bun run lib:closure`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A relative require of a sibling file, in either quote: the only kind tsup writes between dist files. */
const RELATIVE_REQUIRE = /require\((["'])(\.\/[^"']+)\1\)/g;

/** The frame `credentialWarningFor` builds every sentence from (src/lib/db/credential-warnings.ts). */
export const CREDENTIAL_WARNING_FRAME = "Credential warning: ";

const CONNECTION_MODAL = /\bfunction ConnectionModal\(/;
const USE_CONNECTION_FORM = /\bfunction useConnectionForm\(/;

/**
 * Every dist file the entry requires, directly or through another, the entry included, sorted.
 * @param {string} distDir
 * @param {string} entry
 * @returns {string[]}
 */
export function requireClosure(distDir, entry) {
  const seen = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(path.join(distDir, file), "utf8");
    for (const match of text.matchAll(RELATIVE_REQUIRE)) pending.push(path.posix.normalize(match[2]));
  }
  return [...seen].sort();
}

function closureText(distDir, entry) {
  return requireClosure(distDir, entry)
    .map((file) => fs.readFileSync(path.join(distDir, file), "utf8"))
    .join("\n");
}

/**
 * The broken claims, one sentence each; empty when every claim holds.
 * @param {string} distDir
 * @returns {string[]}
 */
export function checkLibClosure(distDir) {
  const failures = [];
  const components = closureText(distDir, "components.js");
  if (!components.includes(CREDENTIAL_WARNING_FRAME)) {
    failures.push(
      `dist/components.js: its require closure does not hold the credential warning frame "${CREDENTIAL_WARNING_FRAME}", so a host mounting ConnectionModal would draw no warning.`,
    );
  }
  if (!CONNECTION_MODAL.test(components)) {
    failures.push(
      "dist/components.js: its require closure holds no ConnectionModal function, so the workspace check would prove nothing.",
    );
  }
  const workspace = closureText(distDir, "workspace.js");
  if (CONNECTION_MODAL.test(workspace))
    failures.push("dist/workspace.js: its require closure holds the ConnectionModal module.");
  if (USE_CONNECTION_FORM.test(workspace)) {
    failures.push("dist/workspace.js: its require closure holds the useConnectionForm module.");
  }
  return failures;
}

function main(argv) {
  const distFlag = argv.indexOf("--dist");
  const distDir = path.resolve(distFlag === -1 ? "dist" : argv[distFlag + 1]);
  const failures = checkLibClosure(distDir);
  for (const failure of failures) console.error(failure);
  if (failures.length === 0) {
    console.log("lib closure: components carries the credential warning; workspace carries no connection dialog.");
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

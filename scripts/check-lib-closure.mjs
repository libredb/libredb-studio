#!/usr/bin/env node
/**
 * Which modules each package entry carries, read from the built package rather than assumed.
 *
 * tsup splits chunks (`splitting: true` in tsup.config.ts), so an entry file holds little more than requires of
 * `./chunk-<hash>.js`, and grepping `dist/workspace.js` alone proves nothing about what a host that imports it
 * loads. This walks the closure of relative requires and imports of each entry inside `dist/`, for both the
 * CommonJS entries (`.js`, which a `require` host loads) and the ESM ones (`.mjs`, which an `import` host and most
 * bundlers load), and checks the package claim of the declared credential warning:
 *
 * - the closure of `dist/components.js` and of `dist/components.mjs` holds the fixed sentence frame of
 *   `credentialWarningFor`, so a host that mounts the exported `ConnectionModal` draws the warning;
 * - the closure of `dist/workspace.js` and of `dist/workspace.mjs` holds neither the `ConnectionModal` nor the
 *   `useConnectionForm` module, so `StudioWorkspace`, which mounts no connection dialog, shows none.
 *
 * Run after `bun run build:lib`: `bun run lib:closure`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A relative specifier of a sibling file, in either quote, in the forms tsup writes between dist files: a
 * `require(...)`, an `import ... from`, a bare `import`, and a dynamic `import(...)`.
 */
const RELATIVE_SPECIFIER = /(?:\brequire\(|\bimport\(|\bfrom\s*|\bimport\s*)(["'])(\.\/[^"']+)\1/g;

/** The two entry pairs a host can load, with the word for how each reaches its chunks. */
const ENTRY_PAIRS = [
  { components: "components.js", workspace: "workspace.js", closure: "require" },
  { components: "components.mjs", workspace: "workspace.mjs", closure: "import" },
];

/** The frame `credentialWarningFor` builds every sentence from (src/lib/db/credential-warnings.ts). */
export const CREDENTIAL_WARNING_FRAME = "Credential warning: ";

const CONNECTION_MODAL = /\bfunction ConnectionModal\(/;
const USE_CONNECTION_FORM = /\bfunction useConnectionForm\(/;

/**
 * Every dist file the entry requires or imports, directly or through another, the entry included, sorted.
 * @param {string} distDir
 * @param {string} entry
 * @returns {string[]}
 */
export function moduleClosure(distDir, entry) {
  const seen = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(path.join(distDir, file), "utf8");
    for (const match of text.matchAll(RELATIVE_SPECIFIER)) pending.push(path.posix.normalize(match[2]));
  }
  return [...seen].sort();
}

function closureText(distDir, entry) {
  return moduleClosure(distDir, entry)
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
  for (const pair of ENTRY_PAIRS) {
    const components = closureText(distDir, pair.components);
    if (!components.includes(CREDENTIAL_WARNING_FRAME)) {
      failures.push(
        `dist/${pair.components}: its ${pair.closure} closure does not hold the credential warning frame "${CREDENTIAL_WARNING_FRAME}", so a host mounting ConnectionModal would draw no warning.`,
      );
    }
    if (!CONNECTION_MODAL.test(components)) {
      failures.push(
        `dist/${pair.components}: its ${pair.closure} closure holds no ConnectionModal function, so the workspace check would prove nothing.`,
      );
    }
    const workspace = closureText(distDir, pair.workspace);
    if (CONNECTION_MODAL.test(workspace)) {
      failures.push(`dist/${pair.workspace}: its ${pair.closure} closure holds the ConnectionModal module.`);
    }
    if (USE_CONNECTION_FORM.test(workspace)) {
      failures.push(`dist/${pair.workspace}: its ${pair.closure} closure holds the useConnectionForm module.`);
    }
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

/**
 * Whether this file runs as the program rather than as the unit test's import. Real paths are compared on both
 * sides, as `scripts/generate-etcd-descriptor.mjs` does, so the check also runs from a symlinked checkout, where
 * `process.argv[1]` keeps the link and `import.meta.url` is the real file (docs/BACKLOG.md REL5).
 * @param {string | undefined} argv1
 */
function isDirectExecution(argv1) {
  return (
    argv1 !== undefined &&
    fs.existsSync(argv1) &&
    fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url))
  );
}

if (isDirectExecution(process.argv[1])) {
  main(process.argv.slice(2));
}

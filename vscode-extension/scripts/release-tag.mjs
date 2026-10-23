// The release workflow's tag guard (docs/DISTRIBUTION.md, "VS Code extension (Marketplace)"): a pushed
// vscode-extension-<version> tag releases the extension only when <version> is vscode-extension/package.json's version.
// The workflow checks separately that the tag's commit is on main.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.mjs";

/** The extension's tag namespace (part 5 "Release path"): product tags stay bare semver, chart tags libredb-studio-<chart version>. */
export const TAG_PREFIX = "vscode-extension-";

/** The Marketplace takes major.minor.patch only: a pre-release is a flag, never a semver suffix. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Why `tag` may not release a manifest at `version`; empty when it may. */
export function releaseTagViolations(tag, version) {
  if (!tag.startsWith(TAG_PREFIX)) return [`The tag ${tag} is not in the ${TAG_PREFIX} namespace.`];
  const named = tag.slice(TAG_PREFIX.length);
  if (!VERSION.test(named)) return [`The tag ${tag} names ${named}, which is not major.minor.patch.`];
  if (named !== version) return [`The tag ${tag} names ${named}, but vscode-extension/package.json is at ${version}.`];
  return [];
}

function main(tag) {
  if (tag === undefined) {
    console.error("Usage: node scripts/release-tag.mjs <tag>");
    process.exit(1);
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const violations = releaseTagViolations(tag, version);
  for (const violation of violations) console.error(violation);
  if (violations.length > 0) process.exit(1);
  console.log(`${tag} releases ${version}.`);
}

// No top-level await: the unit leg loads this module through tsx's CommonJS transform.
if (isDirectExecution(process.argv[1], import.meta.url)) main(process.argv[2]);

#!/usr/bin/env node
/**
 * Monaco asset staging (issue #247).
 *
 * `@monaco-editor/react` fetches Monaco from cdn.jsdelivr.net unless its loader is
 * pointed elsewhere, which leaves the SQL editor broken on air-gapped installs and
 * makes CI depend on a third-party CDN. This step copies the AMD bundle that ships
 * with the `monaco-editor` dependency into `public/monaco/vs`, so Next serves it from
 * our own origin; `src/lib/editor/monaco-loader.ts` is the matching client-side half.
 *
 * Wired into the `dev` and `build` scripts in package.json, and into the Dockerfile,
 * which calls `next build` directly and so does not inherit the npm script. Every other
 * artifact (standalone tarballs, .deb/.rpm, snap, AppImage, Flatpak, npx) is derived from
 * `bun run build`, so they inherit it. Unit tested in tests/unit/copy-monaco.test.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_SUBPATH = path.join("node_modules", "monaco-editor", "min", "vs");
const TARGET_SUBPATH = path.join("public", "monaco", "vs");

/**
 * Copies the Monaco AMD bundle into the served `public/` tree.
 *
 * @param {string} root Repository root to stage within.
 * @returns {{ source: string, target: string, version: string }}
 */
export function stageMonacoAssets(root) {
  const source = path.join(root, SOURCE_SUBPATH);
  const target = path.join(root, TARGET_SUBPATH);
  const manifest = path.join(root, "node_modules", "monaco-editor", "package.json");

  if (!fs.existsSync(source)) {
    throw new Error(
      `Cannot stage the editor: ${SOURCE_SUBPATH} is missing. Install dependencies (bun install) so the monaco-editor package is on disk.`,
    );
  }

  // Remove first: a plain overwrite would leave files behind that a newer
  // monaco-editor no longer ships, and stale AMD chunks break the loader.
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });

  const { version } = JSON.parse(fs.readFileSync(manifest, "utf8"));
  return { source, target, version };
}

function main() {
  try {
    const { target, version } = stageMonacoAssets(process.cwd());
    console.log(`Staged monaco-editor ${version} into ${path.relative(process.cwd(), target)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

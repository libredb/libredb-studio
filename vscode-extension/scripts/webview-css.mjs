// The webview stylesheet's build (part 5 "Builds", the CSS row): the Tailwind 4 CLI compiles src/webview/results.css
// after the bundles, and these checks hold its output and its @source list to the bundle esbuild wrote.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, relative } from "node:path";
import { repoPath } from "./bundle-checks.mjs";

export const CSS_INPUT = "src/webview/results.css";
export const CSS_OUTPUT = "dist/webview/results.css";

/** The CLI's arguments: -i CSS_INPUT -o CSS_OUTPUT, plus --minify, or --watch under --watch. */
export function tailwindArgs({ watch }) {
  return ["-i", CSS_INPUT, "-o", CSS_OUTPUT, watch ? "--watch" : "--minify"];
}

/** The Tailwind CLI's script, resolved from workingDir as its package.json's bin names it. */
export function tailwindCli(workingDir) {
  const require = createRequire(join(workingDir, "package.json"));
  const manifestPath = require.resolve("@tailwindcss/cli/package.json");
  return join(dirname(manifestPath), require(manifestPath).bin.tailwindcss);
}

/**
 * A metafile-shaped object whose one input is the tailwindcss package the CLI compiled from, so renderNotices lists it:
 * its preflight is compiled into results.css. Throws when tailwindcss does not resolve from workingDir.
 */
export function tailwindNoticeInput(workingDir) {
  const manifest = createRequire(join(workingDir, "package.json")).resolve("tailwindcss/package.json");
  const input = relative(workingDir, manifest).split("\\").join("/");
  return { inputs: { [input]: { bytes: 0, imports: [] } }, outputs: {} };
}

/** Every @source path of a stylesheet's text, in order. */
export function sourcesOf(css) {
  return [...css.matchAll(/^@source\s+"([^"]+)"\s*;/gm)].map((match) => match[1]);
}

/** The text of every top-level `@theme inline { ... }` block, comments dropped and whitespace-normalised. */
export function themeInlineBlocks(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  let depth = 0;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "{") depth++;
    else if (text[at] === "}") depth--;
    else if (depth === 0 && text.startsWith("@theme inline", at)) {
      const open = text.indexOf("{", at);
      const close = text.indexOf("}", open);
      blocks.push(
        text
          .slice(open + 1, close)
          .replace(/\s+/g, " ")
          .trim(),
      );
      at = close;
    }
  }
  return blocks;
}

/** The built stylesheet's rules: not empty, carrying the bridge, and loading nothing the CSP would refuse. */
export function stylesheetViolations(css) {
  const violations = [];
  if (css.trim() === "") violations.push(`${CSS_OUTPUT}: the stylesheet is empty`);
  if (!css.includes("--vscode-panel-background")) {
    violations.push(`${CSS_OUTPUT}: the stylesheet lacks the bridge's --vscode-panel-background`);
  }
  if (css.includes("url(")) {
    violations.push(`${CSS_OUTPUT}: the stylesheet loads url(, which the CSP has no img-src or font-src for`);
  }
  return violations;
}

/**
 * Every webview input under src/components/ lies under one of results.css's @source paths, resolved from
 * src/webview/, and every @source path exists, so a moved component fails the build rather than losing its classes.
 * @param {(path: string) => boolean} [exists] whether a path exists; the file system by default.
 */
export function sourceCoverageViolations(metafile, sources, workingDir, exists = existsSync) {
  const from = posix.join(workingDir.split("\\").join("/"), posix.dirname(CSS_INPUT));
  const violations = [];
  const covered = [];
  for (const source of sources) {
    const absolute = posix.resolve(from, source);
    const path = repoPath(absolute, workingDir);
    if (!exists(absolute)) violations.push(`${path}: an @source path of results.css that does not exist`);
    covered.push(path.replace(/\/$/, ""));
  }
  for (const input of Object.keys(metafile.inputs)) {
    const path = repoPath(input, workingDir);
    if (!path.startsWith("src/components/")) continue;
    if (!covered.some((source) => path === source || path.startsWith(`${source}/`))) {
      violations.push(`${path}: a bundled component that no @source path of results.css covers`);
    }
  }
  return violations;
}

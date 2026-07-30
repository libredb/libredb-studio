/**
 * Unit test for the Monaco asset wiring (issue #247). Self-hosting only holds if
 * EVERY path that builds the app stages `public/monaco/vs` first: the package.json
 * scripts (dev, build - the latter also feeds the standalone payload and therefore the
 * tarballs, .deb/.rpm, snap, AppImage and Flatpak) and the Dockerfile, which calls
 * `next build` directly and so does not inherit the package.json script.
 *
 * Asserted as text because a real build in a unit test is not viable; the runtime proof
 * is e2e/offline-editor.spec.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const STAGE_STEP = "scripts/copy-monaco.mjs";

function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

describe("Monaco asset staging wiring", () => {
  const pkg = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };

  test.each(["dev", "build"])("the %s script stages Monaco before Next runs", (scriptName) => {
    const script = pkg.scripts[scriptName];

    expect(script).toContain(STAGE_STEP);
    expect(script.indexOf(STAGE_STEP)).toBeLessThan(script.indexOf("next"));
  });

  test("the Dockerfile stages Monaco before its direct next build", () => {
    const dockerfile = readRepoFile("Dockerfile");

    expect(dockerfile).toContain(STAGE_STEP);
    expect(dockerfile.indexOf(STAGE_STEP)).toBeLessThan(dockerfile.indexOf("next build"));
  });

  test("the staged copy is generated, not committed", () => {
    expect(readRepoFile(".gitignore")).toMatch(/^\/?public\/monaco\/?$/m);
  });

  // 16 MB of minified vendor JS lands in the working tree once anything has built.
  // ESLint OOMs on it (Babel deoptimises, heap exhausted), so the lint gate has to
  // skip it — and it only breaks *after* a build, which is easy to miss locally.
  test.each([
    [".oxlintrc.json", "ignorePatterns"],
    ["eslint.config.mjs", "globalIgnores"],
  ])("%s excludes the staged assets from linting", (configFile) => {
    expect(readRepoFile(configFile)).toContain("public/monaco/**");
  });

  test("the formatter only scans first-party trees, never public/", () => {
    const biome = JSON.parse(readRepoFile("biome.json")) as { files: { includes: string[] } };

    expect(biome.files.includes.some((glob) => glob.startsWith("public"))).toBe(false);
  });
});

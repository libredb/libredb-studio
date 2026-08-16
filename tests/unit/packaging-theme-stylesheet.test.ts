import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  files: string[];
  exports: Record<string, unknown>;
  scripts: Record<string, string>;
};

/**
 * The token stylesheet is the one piece of studio's CSS that ships.
 *
 * `src/app/globals.css` is not packaged, so a component whose colour resolves
 * through `var(--studio-*)` is colourless wherever the library surface is
 * embedded — invalid at computed-value time, which drops grounds to transparent
 * and hairlines to `currentColor`. `dist/styles.css` is what a consumer imports
 * to avoid that.
 *
 * Every assertion here guards a link in that chain that has already broken once:
 * `prepublishOnly` ran a bare `tsup`, and since tsup is `clean: true` it wiped
 * `dist/` and never re-copied the stylesheet — so the published package pointed
 * `exports["./styles.css"]` at a file that was not there. Nothing failed loudly;
 * the export map is not resolved at pack time, and `attw` cannot type-check CSS.
 */
describe("the theme stylesheet reaches the published package", () => {
  test("`files` carries dist, which is where the stylesheet is staged", () => {
    expect(pkg.files).toContain("dist");
  });

  test("the export map offers it under a name a consumer can import", () => {
    expect(pkg.exports["./styles.css"]).toBe("./dist/styles.css");
  });

  /**
   * The link that broke. `tsup` alone is not enough: it CLEANS dist first, so
   * whatever copied the stylesheet must run after it — which is exactly what
   * `build:lib` is.
   */
  test("prepublishOnly builds through build:lib, not tsup alone", () => {
    const prepublish = pkg.scripts.prepublishOnly;
    expect(prepublish).toContain("build:lib");
    expect(prepublish).not.toMatch(/(^|\s|&)tsup(\s|$|&)/);
  });

  test("build:lib stages the stylesheet after tsup has cleaned dist", () => {
    const buildLib = pkg.scripts["build:lib"];
    expect(buildLib).toContain("copy-theme");
    expect(buildLib.indexOf("tsup")).toBeLessThan(buildLib.indexOf("copy-theme"));
  });

  test("the staging script and its source both exist", () => {
    expect(existsSync(join(ROOT, "scripts", "copy-theme.mjs"))).toBe(true);
    expect(existsSync(join(ROOT, "src", "styles", "theme.css"))).toBe(true);
  });

  /**
   * `attw` is told to skip this entry point because it cannot resolve a CSS file
   * as a module — which also means it is NOT the gate that protects the chain
   * above. Pinning the exclusion here keeps that trade explicit rather than
   * leaving it to look like coverage nobody checked.
   */
  test("attw skips the CSS entry point, so these tests are the gate instead", () => {
    expect(pkg.scripts.attw).toContain("--exclude-entrypoints styles.css");
  });
});

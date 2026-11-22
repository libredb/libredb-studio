import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
/** The line copy-theme writes first into `dist/styles.css`. */
const XYFLOW_IMPORT = '@import "@xyflow/react/dist/style.css";';
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

/** A throwaway root holding copy-theme and the token stylesheet, with node_modules linked to the repository's when asked. */
function copyThemeRoot(linkNodeModules: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "copy-theme-"));
  copyThemeRoots.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "src", "styles"), { recursive: true });
  copyFileSync(join(ROOT, "scripts", "copy-theme.mjs"), join(root, "scripts", "copy-theme.mjs"));
  copyFileSync(join(ROOT, "src", "styles", "theme.css"), join(root, "src", "styles", "theme.css"));
  writeFileSync(join(root, "package.json"), '{ "name": "copy-theme-root", "private": true }\n');
  // A junction needs no privilege on Windows; on POSIX the type argument is ignored.
  if (linkNodeModules) symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "junction");
  return root;
}

const copyThemeRoots: string[] = [];
afterAll(() => {
  for (const root of copyThemeRoots) rmSync(root, { recursive: true, force: true });
});

function runCopyTheme(root: string) {
  const run = spawnSync("node", [join(root, "scripts", "copy-theme.mjs")], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (run.error) throw run.error;
  return run;
}

/**
 * The published JavaScript imports no stylesheet: Node cannot load a `.css` import, so a host that ran
 * `import("@libredb/studio")` under Node failed on the ER diagram's `@xyflow/react/dist/style.css` import. The ER
 * diagram's base styles reach an embedding host through `dist/styles.css` instead, as an `@import` its bundler
 * resolves from the package's own location.
 */
describe("the ER diagram's stylesheet reaches hosts through styles.css, not the JavaScript", () => {
  test("copy-theme puts the ER diagram's stylesheet import first and the tokens after it, unchanged", () => {
    const root = copyThemeRoot(true);

    const run = runCopyTheme(root);

    expect(run.status).toBe(0);
    const written = readFileSync(join(root, "dist", "styles.css"), "utf8");
    const theme = readFileSync(join(ROOT, "src", "styles", "theme.css"), "utf8");
    expect(written).toBe(`${XYFLOW_IMPORT}\n${theme}`);
  });

  test("copy-theme refuses when the ER diagram's stylesheet does not resolve", () => {
    const root = copyThemeRoot(false);

    const run = runCopyTheme(root);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("@xyflow/react/dist/style.css");
    expect(existsSync(join(root, "dist", "styles.css"))).toBe(false);
  });

  test("the imported stylesheet is an export of a declared dependency", () => {
    const dependencies = (pkg as unknown as { dependencies: Record<string, string> }).dependencies;
    expect(Object.keys(dependencies)).toContain("@xyflow/react");
    const xyflow = JSON.parse(readFileSync(join(ROOT, "node_modules", "@xyflow", "react", "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(xyflow.exports["./dist/style.css"]).toBe("./dist/style.css");
  });

  test("tsup turns every stylesheet import into an empty module", async () => {
    const config = (await import("../../tsup.config.ts")).default as {
      loader?: Record<string, string>;
      noExternal?: (string | RegExp)[];
      esbuildPlugins?: { name: string }[];
    };

    expect(config.loader?.[".css"]).toBe("empty");
    expect((config.noExternal ?? []).some((entry) => entry instanceof RegExp && entry.source === "\\.css$")).toBe(true);
    expect((config.esbuildPlugins ?? []).map((plugin) => plugin.name)).not.toContain("handle-css-and-xyflow");
  });
});

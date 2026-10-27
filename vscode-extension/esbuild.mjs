// The extension's single build entry (part 5, "Builds"): the engine logos, the Marketplace icon, the LICENSE copy, the host, child and webview bundles,
// their metafile checks, the webview stylesheet through the Tailwind CLI, and THIRD_PARTY_NOTICES.txt. Production is the default; --watch builds unminified.
// --e2e-tests bundles the e2e leg's test files into out/ and builds nothing else: the leg runs against the dist/ that ships.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  assertNoViolations,
  CHILD_ALIASES,
  CHILD_EXTERNALS,
  CHILD_IMPORT_META,
  childViolations,
  hostViolations,
  webviewOutputViolations,
  webviewViolations,
} from "./scripts/bundle-checks.mjs";
import { ICON_OUTPUT, ICON_SOURCE, writeMarketplaceIcon } from "./scripts/marketplace-icon.mjs";
import { renderNotices } from "./scripts/notices.mjs";
import {
  CSS_INPUT,
  CSS_OUTPUT,
  sourceCoverageViolations,
  sourcesOf,
  stylesheetViolations,
  tailwindArgs,
  tailwindCli,
  tailwindNoticeInput,
} from "./scripts/webview-css.mjs";
import { shimPlugin } from "./scripts/webview-shims.mjs";

const root = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
for (const arg of args) if (arg !== "--watch" && arg !== "--e2e-tests") throw new Error(`Unknown argument: ${arg}`);
const watch = args.includes("--watch");
const e2eTests = args.includes("--e2e-tests");
if (watch && e2eTests) throw new Error("--e2e-tests builds once and does not take --watch.");

const shared = {
  absWorkingDir: root,
  bundle: true,
  metafile: true,
  tsconfig: "tsconfig.json",
  platform: "node",
  format: "cjs",
  target: "node24",
  minify: !watch,
  keepNames: true,
  sourcemap: "linked",
  logLevel: "info",
};

const bundles = [
  {
    label: "host",
    options: { entryPoints: ["src/host/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] },
    metafilePath: "dist/extension.meta.json",
    violations: hostViolations,
  },
  {
    label: "child",
    options: {
      entryPoints: ["src/backend/main.ts"],
      outfile: "dist/backend.js",
      external: CHILD_EXTERNALS,
      alias: CHILD_ALIASES,
      inject: CHILD_IMPORT_META.inject,
      define: CHILD_IMPORT_META.define,
      logOverride: CHILD_IMPORT_META.logOverride,
    },
    metafilePath: "dist/backend.meta.json",
    violations: childViolations,
  },
  {
    // The Results webview (part 4 "Bundling ResultsGrid for the webview"): a classic script for the browser, since the
    // entry reads its nonce from document.currentScript; React and the grid come from the root's install.
    label: "webview",
    options: {
      entryPoints: ["src/webview/main.tsx"],
      outfile: "dist/webview/results.js",
      platform: "browser",
      format: "iife",
      target: "es2022",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      keepNames: false,
      sourcemap: watch ? "linked" : false,
      plugins: [shimPlugin(root)],
    },
    metafilePath: "dist/webview/meta.json",
    violations: (metafile, workingDir) => [
      ...webviewViolations(metafile, workingDir),
      ...webviewOutputViolations(metafile, readFileSync(join(workingDir, "dist/webview/results.js"), "utf8")),
      ...sourceCoverageViolations(metafile, sourcesOf(readFileSync(join(workingDir, CSS_INPUT), "utf8")), workingDir),
    ],
  },
];

const metafiles = new Map();

/**
 * Writes the bundle's metafile, holds it to its boundary, and writes the notices once every bundle has one; the
 * stylesheet's tailwindcss joins them, since its preflight is compiled into results.css.
 */
function finish(bundle, metafile) {
  writeFileSync(join(root, bundle.metafilePath), JSON.stringify(metafile, null, 2));
  assertNoViolations(bundle.label, bundle.violations(metafile, root));
  metafiles.set(bundle.label, metafile);
  if (metafiles.size === bundles.length) {
    const inputs = [...metafiles.values(), tailwindNoticeInput(root)];
    writeFileSync(join(root, "THIRD_PARTY_NOTICES.txt"), renderNotices(inputs, root));
  }
}

/** The CLI's command line: Node itself running the CLI's script, as scripts/package.mjs runs vsce. */
const tailwindCommand = (options) => [tailwindCli(root), ...tailwindArgs(options)];

/**
 * Writes media/engines/** from scripts/engine-icons.tsx, bundled into out/ so the build needs no TypeScript loader at run
 * time; the script's bundle never reaches dist/.
 */
async function writeEngineIcons() {
  const outfile = join(root, "out", "scripts", "engine-icons.cjs");
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["scripts/engine-icons.tsx"],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    jsx: "automatic",
    tsconfig: "tsconfig.json",
    logLevel: "warning",
  });
  createRequire(import.meta.url)(outfile).writeShippedEngineIcons(root);
}

if (e2eTests) {
  for (const leg of ["e2e", "e2e-workspace", "e2e-coexistence"]) {
    rmSync(join(root, "out", "test", leg), { recursive: true, force: true });
  }
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["test/e2e/**/*.test.ts", "test/e2e-workspace/**/*.test.ts", "test/e2e-coexistence/**/*.test.ts"],
    outbase: ".",
    outdir: "out",
    bundle: true,
    tsconfig: "tsconfig.json",
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["vscode", "mocha"],
    logLevel: "info",
  });
} else {
  await writeEngineIcons();
  await writeMarketplaceIcon(join(root, ICON_SOURCE), join(root, ICON_OUTPUT));
  copyFileSync(join(root, "..", "LICENSE"), join(root, "LICENSE"));
  if (watch) {
    for (const bundle of bundles) {
      const checks = {
        name: "libredb-bundle-checks",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length > 0) return;
            try {
              finish(bundle, result.metafile);
            } catch (error) {
              console.error(error.message);
            }
          });
        },
      };
      const plugins = [...(bundle.options.plugins ?? []), checks];
      const context = await esbuild.context({ ...shared, ...bundle.options, plugins });
      await context.watch();
    }
    // The CLI watches its own sources for the life of the build, and ends with it.
    const css = spawn(process.execPath, tailwindCommand({ watch: true }), { cwd: root, stdio: "inherit" });
    process.on("exit", () => css.kill());
  } else {
    for (const bundle of bundles) {
      const result = await esbuild.build({ ...shared, ...bundle.options });
      finish(bundle, result.metafile);
    }
    const css = spawnSync(process.execPath, tailwindCommand({ watch: false }), { cwd: root, stdio: "inherit" });
    if (css.status !== 0)
      throw new Error(`The Tailwind CLI exited with ${css.status ?? css.signal} building ${CSS_OUTPUT}.`);
    assertNoViolations("webview stylesheet", stylesheetViolations(readFileSync(join(root, CSS_OUTPUT), "utf8")));
  }
}

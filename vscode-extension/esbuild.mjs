// The extension's single build entry (part 5, "Builds"): the LICENSE copy, the host and child bundles,
// their metafile checks and THIRD_PARTY_NOTICES.txt. Production is the default; --watch builds unminified.

import { copyFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  assertNoViolations,
  CHILD_EXTERNALS,
  childViolations,
  hostViolations,
} from "./scripts/bundle-checks.mjs";
import { renderNotices } from "./scripts/notices.mjs";

const root = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
for (const arg of args) if (arg !== "--watch") throw new Error(`Unknown argument: ${arg}`);
const watch = args.includes("--watch");

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
    options: { entryPoints: ["src/backend/main.ts"], outfile: "dist/backend.js", external: CHILD_EXTERNALS },
    metafilePath: "dist/backend.meta.json",
    violations: childViolations,
  },
];

const metafiles = new Map();

/** Writes the bundle's metafile, holds it to its boundary, and writes the notices once every bundle has one. */
function finish(bundle, metafile) {
  writeFileSync(join(root, bundle.metafilePath), JSON.stringify(metafile, null, 2));
  assertNoViolations(bundle.label, bundle.violations(metafile, root));
  metafiles.set(bundle.label, metafile);
  if (metafiles.size === bundles.length) {
    writeFileSync(join(root, "THIRD_PARTY_NOTICES.txt"), renderNotices([...metafiles.values()], root));
  }
}

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
    const context = await esbuild.context({ ...shared, ...bundle.options, plugins: [checks] });
    await context.watch();
  }
} else {
  for (const bundle of bundles) {
    const result = await esbuild.build({ ...shared, ...bundle.options });
    finish(bundle, result.metafile);
  }
}

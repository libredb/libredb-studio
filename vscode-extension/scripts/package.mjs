// Packs the universal VSIX with vsce (part 5, "Packaging"), then holds it to scripts/check-vsix.mjs.
// vsce runs vscode:prepublish, the production build, first.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.mjs";

/** vsce's arguments: package --no-dependencies --out dist-vsix/libredb-studio-<version>.vsix, plus --pre-release on an odd minor. */
export function vscePackageArgs(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`The version "${version}" is not major.minor.patch.`);
  const args = ["package", "--no-dependencies", "--out", `dist-vsix/libredb-studio-${version}.vsix`];
  return Number(match[2]) % 2 === 1 ? [...args, "--pre-release"] : args;
}

if (isDirectExecution(process.argv[1], import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const args = vscePackageArgs(version);
  // A plain require.resolve call, which knip reads as the use of @vscode/vsce.
  const require = createRequire(import.meta.url);
  const vsce = require.resolve("@vscode/vsce/vsce");
  const run = (command) => {
    const result = spawnSync(process.execPath, command, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  // vsce writes --out into an existing directory only.
  mkdirSync(join(root, "dist-vsix"), { recursive: true });
  run([vsce, ...args]);
  run([join(root, "scripts", "check-vsix.mjs"), join(root, args[3])]);
}

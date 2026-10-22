// Publishes the VSIX the release workflow's gates tested to the Visual Studio Marketplace, from the release
// workflow's publish job (docs/DISTRIBUTION.md, "VS Code extension (Marketplace)"). Nothing is rebuilt: the job
// downloads the gates' vscode-extension-vsix artifact into dist-vsix/ first.
//
// --oidc trades the job's GitHub OIDC token for a Marketplace token, against the trusted publisher the libredb
// publisher names, so no Marketplace secret is stored. --pre-release on an odd minor makes vsce check that the
// packed manifest says so.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.mjs";
import { isPreRelease, vsixPath } from "./package.mjs";

/** vsce's arguments: publish --oidc --packagePath dist-vsix/libredb-studio-<version>.vsix, plus --pre-release on an odd minor. */
export function vscePublishArgs(version) {
  const args = ["publish", "--oidc", "--packagePath", vsixPath(version)];
  return isPreRelease(version) ? [...args, "--pre-release"] : args;
}

if (isDirectExecution(process.argv[1], import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const args = vscePublishArgs(version);
  if (!existsSync(join(root, args[3]))) throw new Error(`No tested VSIX at ${args[3]}.`);
  const vsce = createRequire(import.meta.url).resolve("@vscode/vsce/vsce");
  const result = spawnSync(process.execPath, [vsce, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

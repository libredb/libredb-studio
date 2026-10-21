// Installs the packed VSIX into the stable VS Code build (main design section 3, step 1): the e2e leg runs the
// production dist/ from the development path, which proves the files and not the package. The install goes into a
// scratch profile, never the shared .vscode-test/extensions, so no later e2e host loads the packed copy beside the
// development one.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";
import { isDirectExecution } from "./check-vsix.mjs";
import { vscePackageArgs } from "./package.mjs";

/** The extension's id as VS Code lists it: <publisher>.<name> from the manifest. */
export function extensionId(manifest) {
  return `${manifest.publisher}.${manifest.name}`;
}

/** The resolved CLI arguments with their --extensions-dir and --user-data-dir replaced by `dirs`. */
function profileArgs(cliArgs, dirs) {
  const kept = cliArgs.filter((arg) => !/^--(extensions-dir|user-data-dir)(=|$)/.test(arg));
  return [...kept, `--extensions-dir=${dirs.extensions}`, `--user-data-dir=${dirs.userData}`];
}

/**
 * The CLI arguments that install `extensions` (VSIX paths or pinned <id>@<version>) into a profile: the resolved CLI
 * arguments with their --extensions-dir and --user-data-dir replaced by `dirs`, then one --install-extension before
 * each. scripts/coexistence-extensions.mjs installs through it too.
 */
export function installArgs(cliArgs, extensions, dirs) {
  return [...profileArgs(cliArgs, dirs), ...extensions.flatMap((extension) => ["--install-extension", extension])];
}

/** The arguments that list the scratch profile's extensions with their versions. */
export function listArgs(cliArgs, dirs) {
  return [...profileArgs(cliArgs, dirs), "--list-extensions", "--show-versions"];
}

/** The version `id` is listed at in `--list-extensions --show-versions` output, or undefined. */
export function listedVersion(stdout, id) {
  for (const line of stdout.split(/\r?\n/).map((raw) => raw.trim())) {
    const at = line.lastIndexOf("@");
    if (at > 0 && line.slice(0, at).toLowerCase() === id.toLowerCase()) return line.slice(at + 1);
  }
  return undefined;
}

/** A CLI run that failed, carrying the CLI's own stderr as its message. */
export class CliFailure extends Error {}

/** Runs the CLI with no shell and returns its stdout, or throws its own stderr. */
export function runCli([command, ...args]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new CliFailure(result.stderr || `${command} exited with ${result.status}.`);
  return result.stdout;
}

async function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const versions = JSON.parse(readFileSync(join(root, "test", "vscode-versions.json"), "utf8"));
  const vsix = join(root, vscePackageArgs(manifest.version)[3]);
  const id = extensionId(manifest);
  // The cached builds live in .vscode-test/ under the extension's root, where the e2e leg keeps them.
  const executable = await downloadAndUnzipVSCode({ version: versions.stable, cachePath: join(root, ".vscode-test") });
  const cliArgs = resolveCliArgsFromVSCodeExecutablePath(executable);
  const dirs = {
    extensions: mkdtempSync(join(tmpdir(), "libredb-vsix-extensions-")),
    userData: mkdtempSync(join(tmpdir(), "libredb-vsix-user-data-")),
  };
  try {
    const started = Date.now();
    runCli(installArgs(cliArgs, [vsix], dirs));
    const version = listedVersion(runCli(listArgs(cliArgs, dirs)), id);
    if (version === undefined) {
      console.error(`The packed VSIX did not install: ${id} is not listed.`);
      process.exitCode = 1;
      return;
    }
    console.log(`${id}@${version}`);
    console.log(`Installed into VS Code ${versions.stable} in ${Date.now() - started} ms.`);
  } finally {
    rmSync(dirs.extensions, { recursive: true, force: true });
    rmSync(dirs.userData, { recursive: true, force: true });
  }
}

// No top-level await: the unit leg loads this module through tsx's CommonJS transform.
if (isDirectExecution(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof CliFailure ? error.message : error);
    process.exit(1);
  });
}

// Installs the extensions the coexistence leg runs beside LibreDB (part 3 criterion 21, "Coexisting with pgsql and
// mssql") into an extensions directory of their own: @vscode/test-cli installs every installExtensions entry into the
// shared .vscode-test/extensions, so mssql would load into every other e2e host after it. The leg downloads from the
// Marketplace, so it runs in the coexistence subset only (LIBREDB_E2E_SUBSET=coexistence), in the daily workflow and
// by hand, never in the pull request job; a failed install fails the run and never skips the leg.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";
import { isDirectExecution } from "./check-vsix.mjs";
import { CliFailure, installArgs, listArgs, listedVersion, runCli } from "./vsix-install-check.mjs";

/**
 * The extensions the coexistence leg installs beside LibreDB, pinned, so each run records the same extensions.
 * 1.46.0 is the newest mssql the Marketplace lists, and its engines.vscode (^1.105.0) admits both pinned builds.
 * mssql 1.46.0 declares an extensionPack of the other four, which the CLI would otherwise fetch at their latest
 * versions; named in the same install call, each one installs at its pin instead.
 */
export const COEXISTENCE_EXTENSIONS = [
  "ms-dotnettools.vscode-dotnet-runtime@3.2.0",
  "ms-mssql.data-workspace-vscode@0.7.0",
  "ms-mssql.sql-bindings-vscode@0.4.1",
  "ms-mssql.sql-database-projects-vscode@1.8.0",
  "ms-mssql.mssql@1.46.0",
];

/** Where they are installed, relative to vscode-extension/: never the shared .vscode-test/extensions. */
export const COEXISTENCE_EXTENSIONS_DIR = ".vscode-test/extensions-coexistence";

/** The user data directory the installing CLI uses, beside the extensions directory. */
const COEXISTENCE_USER_DATA_DIR = ".vscode-test/user-data-coexistence";

/** The builds to install for: the one LIBREDB_VSCODE_VERSION names, else floor and stable; none outside the coexistence subset. */
export function coexistenceBuilds(env, versions) {
  if (env.LIBREDB_E2E_SUBSET !== "coexistence") return [];
  return env.LIBREDB_VSCODE_VERSION ? [env.LIBREDB_VSCODE_VERSION] : [versions.floor, versions.stable];
}

/** Splits a pinned <id>@<version> into its id and version. */
function splitPin(pinned) {
  const at = pinned.lastIndexOf("@");
  return { id: pinned.slice(0, at), version: pinned.slice(at + 1) };
}

/**
 * What `--list-extensions --show-versions` output gets wrong against `pins`: a pinned extension listed at another
 * version or not listed, and a listed extension nobody pinned. Empty when the directory holds exactly the pinned set.
 */
export function listingViolations(stdout, pins) {
  const violations = [];
  for (const pinned of pins) {
    const { id, version } = splitPin(pinned);
    const listed = listedVersion(stdout, id);
    if (listed === undefined) violations.push(`${id} is not listed, pinned at ${version}`);
    else if (listed !== version) violations.push(`${id} is listed at ${listed}, pinned at ${version}`);
  }
  const pinnedIds = new Set(pins.map((pinned) => splitPin(pinned).id.toLowerCase()));
  for (const line of stdout.split(/\r?\n/).map((raw) => raw.trim())) {
    if (line && !pinnedIds.has(splitPin(line).id.toLowerCase())) violations.push(`${line} is listed but not pinned`);
  }
  return violations;
}

async function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const versions = JSON.parse(readFileSync(join(root, "test", "vscode-versions.json"), "utf8"));
  const dirs = { extensions: join(root, COEXISTENCE_EXTENSIONS_DIR), userData: join(root, COEXISTENCE_USER_DATA_DIR) };
  for (const version of coexistenceBuilds(process.env, versions)) {
    mkdirSync(dirs.extensions, { recursive: true });
    const executable = await downloadAndUnzipVSCode({ version, cachePath: join(root, ".vscode-test") });
    const cliArgs = resolveCliArgsFromVSCodeExecutablePath(executable);
    const listed = runCli(listArgs(cliArgs, dirs));
    const missing = COEXISTENCE_EXTENSIONS.filter((pinned) => {
      const { id, version } = splitPin(pinned);
      return listedVersion(listed, id) !== version;
    });
    const started = Date.now();
    if (missing.length > 0) runCli(installArgs(cliArgs, missing, dirs));
    const now = runCli(listArgs(cliArgs, dirs));
    const violations = listingViolations(now, COEXISTENCE_EXTENSIONS);
    if (violations.length > 0) {
      throw new CliFailure(
        `VS Code ${version}: ${COEXISTENCE_EXTENSIONS_DIR} is not the pinned set: ${violations.join("; ")}.`,
      );
    }
    console.log(
      `VS Code ${version}: installed ${JSON.stringify(missing)} in ${Date.now() - started} ms; ${COEXISTENCE_EXTENSIONS_DIR} lists ${JSON.stringify(now.trim().split(/\r?\n/))}`,
    );
  }
}

// No top-level await: the unit leg loads this module through tsx's CommonJS transform.
if (isDirectExecution(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof CliFailure ? error.message : error);
    process.exit(1);
  });
}

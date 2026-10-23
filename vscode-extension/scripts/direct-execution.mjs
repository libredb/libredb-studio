// Whether node runs a script directly, as `node scripts/<name>.mjs`, or the module was imported.
// It imports only node builtins, so a script that needs nothing installed, like release-tag.mjs in the release
// workflow's verify job, can use it on a bare checkout.

import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether node runs the module at moduleUrl as its program, rather than a module that imports it (the unit leg does).
 * Both sides are made real: process.argv[1] keeps the path node was given, which through a symlinked directory is the link,
 * while import.meta.url is the real file, so comparing the two as given skipped the check and exited 0 without a word.
 * Under --preserve-symlinks-main import.meta.url keeps the link as well.
 * An argv[1] that names no file means node runs no file of its own (`node -e` puts its first argument there).
 * scripts/package.mjs guards itself with it too.
 * @param {string | undefined} argv1
 * @param {string} moduleUrl
 */
export function isDirectExecution(argv1, moduleUrl) {
  return argv1 !== undefined && existsSync(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
}

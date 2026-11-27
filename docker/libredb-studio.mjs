#!/usr/bin/env node
/**
 * The image's `libredb-studio` command (docs/DISTRIBUTION.md, "Docker"): it serves one subcommand,
 * `libredb-studio providers lock --dir <absolute directory>`, which writes the lock of a providers
 * directory (docs/providers/CONTRACT.md, C-91).
 *
 * It imports the lock command's module beside it, /usr/local/lib/libredb-studio/providers-lock.mjs,
 * which the builder stage builds from scripts/providers-lock.ts (scripts/build-lock-module.mjs), and
 * runs its `main` with the arguments after `providers lock`; the exit code is the command's. Any other
 * argument prints the command's usage on stderr, exit 2, and runs nothing. It never starts the server.
 *
 * Each Dockerfile copies it next to the module, root-owned, makes it executable and links it as
 * /usr/local/bin/libredb-studio. Node.js runs a main module reached through a link by its real path,
 * so the import below resolves beside this file. Like bind-address.mjs it lives outside the standalone
 * payload and imports only what sits beside it.
 */
import { main, USAGE } from "./providers-lock.mjs";

const [command, subcommand, ...rest] = process.argv.slice(2);
if (command === "providers" && subcommand === "lock") {
  process.exitCode = main(rest);
} else {
  console.error(USAGE);
  process.exitCode = 2;
}

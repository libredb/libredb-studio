#!/usr/bin/env node
/**
 * The launcher of `bun dev` and `bun start` (package.json `dev` and `start`): runs the Next.js CLI with SEED_ASSETS_DIR
 * set to this checkout's own seed-assets directory, the built-in samples' assets, unless the shell or a .env file
 * Next.js loads sets it (docs/DISTRIBUTION.md, "Built-in sample assets").
 *
 * The server never takes that directory from its working directory (src/lib/seed/samples.ts), so a checkout's server
 * needs it set, as every packaged channel's launcher sets it for its payload. The default is computed from this file's
 * own location and is absolute.
 *
 * Next.js reads the process environment before any .env file and skips a key already there, so this launcher has to
 * know whether Next.js would find a non-blank SEED_ASSETS_DIR itself. To know, it calls Next.js's own loader,
 * loadEnvConfig of @next/env, on its working directory, the project directory under `bun dev` and `bun start`, in the
 * mode Next.js uses for the command: development for `dev`, production for any other, and test when NODE_ENV is test.
 * The loader prints nothing here, and the Next.js CLI gets the caller's environment plus the default, never what the
 * loader loaded, so Next.js loads the same files itself and reports one it cannot read. Each of those files is thus
 * read twice, first by this launcher, so a .env that is a named pipe has to serve every read.
 *
 * Under `start`, and only there, the Next.js CLI also gets NEXT_MANUAL_SIG_HANDLE=true when this process runs on Node.js
 * and its caller set none, so Studio's shutdown handler ends the server (docs/DISTRIBUTION.md, "Stopping the server").
 * The CLI runs with this process's own runtime, so on Bun, where the server refuses `true` at boot, nothing is added;
 * a value the caller set, the empty one included, is passed on as given. `next dev` supports no manual signal
 * handling, and no other command starts a server. The variable is read from the caller's environment before the .env
 * files are loaded, and a value that only a .env file Next.js loads for `start` sets stops this launcher with exit
 * code 1 before the CLI runs: the documented rule is never to set it in a .env file, and this launcher's own `true` in
 * the process environment would otherwise replace the file's value unseen. The refusal names each file that sets it,
 * from the loader's loadedEnvFiles. It holds on Bun as on Node.js: under `bun start` Bun runs the script's `node`,
 * as Bun itself under `bun --bun run start` or where no Node.js is installed, and loads no .env file into its
 * environment; only a direct `bun scripts/next-with-seed-assets.mjs` run, which no package.json script makes, has Bun
 * load its own .env files first (.env, .env.local and the one for its NODE_ENV, development when unset), so that a
 * value from one of them arrives as the caller's.
 *
 * Every argument is passed to the Next.js CLI unchanged. The CLI is the `next` binary named by the `bin` field of the
 * checkout's own node_modules/next/package.json, run with this Node.js, so no shell, no PATH lookup and no package
 * lookup is involved on any OS. @next/env is loaded by path from the first place that holds it, in the order next's
 * own require looks: node_modules/next/node_modules/@next/env; the @next/env beside next's real directory when that
 * directory lies inside the checkout's node_modules, as in bun's isolated store and pnpm's; node_modules/@next/env. A
 * next or an @next/env installed only in a parent directory, through NODE_PATH or in a global folder is never used, a
 * missing one is an error, exit 1, and a link among them, as `bun link` makes, is followed.
 *
 * SIGINT and SIGTERM are forwarded to the Next.js CLI; this process exits with its exit code, or ends itself with the
 * signal that ended it. On Windows, Node.js forwards a signal by ending the process at once: the console delivers a
 * Ctrl+C to the server too, which starts its own graceful stop, and the forwarded one ends it part way through, under
 * `bun start` as under `bun dev`, cutting in-flight requests and the closes of its pools.
 *
 * An inspector set in NODE_OPTIONS, such as --inspect or --inspect-brk, is taken by this process, which starts first,
 * and --inspect-brk waits for a debugger on this process before anything is spawned. The Next.js CLI's own attempt
 * then reports the port in use. Under `bun start` the server is that process, so it has no inspector; under `bun dev`
 * the CLI gives the server it forks the next port, as before this launcher. Debug the server with
 * `bun start --inspect` or `bun run dev --inspect`, which reach the Next.js CLI as arguments.
 *
 * Tested by tests/unit/next-with-seed-assets.test.ts, which spawns it.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANUAL_SIGNAL_HANDLING_VARIABLE, manualSignalHandlingEnv, seedAssetsEnv } from "../bin/lib/launcher-utils.mjs";

const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = path.join(CHECKOUT, "node_modules");
const NEXT_MANIFEST = path.join(NODE_MODULES, "next", "package.json");
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"];

/** The Next.js CLI this checkout installs; throws when next is not installed or declares no `next` binary. */
function nextCli() {
  const { bin } = JSON.parse(readFileSync(NEXT_MANIFEST, "utf8"));
  const relative = typeof bin === "string" ? bin : bin?.next;
  if (typeof relative !== "string") throw new Error(`${NEXT_MANIFEST} declares no next binary`);
  return path.join(path.dirname(NEXT_MANIFEST), relative);
}

/** The @next/env this checkout's next loads .env files with; throws when no place holds one. */
function nextEnv() {
  const holder = path.dirname(realpathSync(path.dirname(NEXT_MANIFEST)));
  const inStore = holder.startsWith(realpathSync(NODE_MODULES) + path.sep);
  const places = [
    path.join(path.dirname(NEXT_MANIFEST), "node_modules", "@next", "env"),
    ...(inStore ? [path.join(holder, "@next", "env")] : []),
    path.join(NODE_MODULES, "@next", "env"),
  ];
  const found = places.find((place) => existsSync(path.join(place, "package.json")));
  if (found === undefined) throw new Error(`none of ${places.join(", ")} holds a package`);
  return createRequire(NEXT_MANIFEST)(found);
}

let cli;
let loadEnvConfig;
try {
  cli = nextCli();
} catch (error) {
  console.error(
    `Cannot find this checkout's Next.js CLI (run bun install): ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
try {
  ({ loadEnvConfig } = nextEnv());
} catch (error) {
  console.error(
    `Cannot find this checkout's @next/env (run bun install): ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const callerEnv = { ...process.env };
// Read from process.env, which is case-insensitive on Windows, before the loader below writes the .env files into it.
const callerManualSignalHandling = process.env[MANUAL_SIGNAL_HANDLING_VARIABLE];
const command = process.argv[2];
const silent = { info() {}, error() {} };
const { combinedEnv, loadedEnvFiles } = loadEnvConfig(process.cwd(), command === "dev", silent);
const start = command === "start";
if (start && callerManualSignalHandling === undefined && combinedEnv[MANUAL_SIGNAL_HANDLING_VARIABLE] !== undefined) {
  // Windows compares environment names without letter case, as process.env does there.
  const sameName =
    process.platform === "win32"
      ? (name) => name.toUpperCase() === MANUAL_SIGNAL_HANDLING_VARIABLE
      : (name) => name === MANUAL_SIGNAL_HANDLING_VARIABLE;
  const setters = loadedEnvFiles.filter((file) => Object.keys(file.env).some(sameName)).map((file) => file.path);
  console.error(
    `${MANUAL_SIGNAL_HANDLING_VARIABLE} is set in a .env file Next.js loads for start (${setters.join(", ")}), ` +
      "where it is not honoured: set it in the environment bun start runs in, or remove it from the file " +
      "(docs/DISTRIBUTION.md#stopping-the-server).",
  );
  process.exit(1);
}
const env = {
  ...callerEnv,
  ...seedAssetsEnv(CHECKOUT, combinedEnv.SEED_ASSETS_DIR),
  ...(start ? manualSignalHandlingEnv(process.versions, callerManualSignalHandling) : {}),
};
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { env, stdio: "inherit" });
const forward = (signal) => child.kill(signal);
for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
child.on("error", (error) => {
  console.error(`Could not start the Next.js CLI: ${error.message}`);
  process.exit(1);
});
// Node.js reports exactly one of the two.
child.on("exit", (code, signal) => {
  if (signal === null) process.exit(code);
  // End with the same signal, so whatever started this process sees what ended the Next.js CLI; with the forwarding
  // listeners gone, the signal takes its default action.
  for (const forwarded of FORWARDED_SIGNALS) process.off(forwarded, forward);
  process.kill(process.pid, signal);
});

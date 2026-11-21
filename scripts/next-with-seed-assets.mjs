#!/usr/bin/env node
/**
 * The launcher of `bun dev` and `bun start` (package.json `dev` and `start`): runs the Next.js CLI with SEED_ASSETS_DIR
 * set to this checkout's own seed-assets directory, the built-in samples' assets (docs/DISTRIBUTION.md, "Built-in
 * sample assets").
 *
 * The server never takes that directory from its working directory (src/lib/seed/samples.ts), so a checkout's server
 * needs it set, as every packaged channel's launcher sets it for its payload. The path is computed from this file's own
 * location and is absolute. A non-blank SEED_ASSETS_DIR the caller set is kept as given: Next.js runs in this process's
 * working directory, so a relative value means the same to it.
 *
 * Next.js reads the process environment before any .env file and skips a key already there, so a SEED_ASSETS_DIR
 * assigned in a .env file would be dropped without a word once this launcher sets the default. So when the caller set
 * none, `dev` and `start` first look in the working directory, the project directory Next.js loads .env files from
 * when it is given no directory argument, as under `bun dev` and `bun start`, at the files Next.js reads for that command, in its documented load order: `.env.$(NODE_ENV).local`, `.env.local`
 * (not when NODE_ENV is test), `.env.$(NODE_ENV)` and `.env`, where NODE_ENV is test when the caller set it so, and
 * otherwise development for `dev` and production for `start`. A line of one of them that assigns SEED_ASSETS_DIR, in
 * any form Next.js's parser reads, is an error, exit 1, naming the file: export the value in the shell instead. The
 * check matches the assignment and never reads the value, and any other command runs with no check.
 *
 * Every argument is passed to the Next.js CLI unchanged. The CLI is the `next` binary this checkout installs, found
 * through the `bin` field of next's package.json and run with this Node.js, so no shell and no PATH lookup is involved
 * on any OS. Node.js looks for that package.json in the checkout's node_modules, then in every parent directory's,
 * then through NODE_PATH and its global folders; a package.json it finds outside the checkout's node_modules is
 * refused, never run, so a missing Next.js CLI, wherever another one is installed, is an error, exit 1.
 *
 * SIGINT and SIGTERM are forwarded to the Next.js CLI; this process exits with its exit code, or ends itself with the
 * signal that ended it. On Windows, Node.js forwards a signal by ending the process at once: the console delivers a
 * Ctrl+C to the server too, which starts its own graceful stop, and the forwarded one ends it part way through, under
 * `bun start` as under `bun dev`, cutting in-flight requests and the closes of its pools.
 *
 * An inspector set in NODE_OPTIONS, such as --inspect or --inspect-brk, is taken by this process, which starts first,
 * not by the server: the server's own attempt reports the port in use, and --inspect-brk waits for a debugger on this
 * process before anything is spawned. Debug the server with `bun start --inspect` or `bun run dev --inspect`, which
 * reach the Next.js CLI as arguments.
 *
 * Tested by tests/unit/next-with-seed-assets.test.ts, which spawns it.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedAssetsEnv } from "../bin/lib/launcher-utils.mjs";

const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"];

/**
 * The Next.js CLI this checkout installs; throws when next is not installed, is found only outside the checkout's
 * node_modules, or declares no `next` binary.
 */
function nextCli() {
  const manifest = createRequire(import.meta.url).resolve("next/package.json");
  // Node.js reports the package.json at its real path, so the checkout's node_modules is compared at its own, which
  // keeps a node_modules that is a link to another directory inside.
  const modules = path.join(CHECKOUT, "node_modules");
  const inside = existsSync(modules) ? path.relative(realpathSync(modules), manifest) : "..";
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new Error(`${manifest} is outside ${modules}`);
  }
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  const relative = typeof bin === "string" ? bin : bin?.next;
  if (typeof relative !== "string") throw new Error(`${manifest} declares no next binary`);
  return path.join(path.dirname(manifest), relative);
}

let cli;
try {
  cli = nextCli();
} catch (error) {
  console.error(
    `Cannot find this checkout's Next.js CLI (run bun install): ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

/** The .env files Next.js reads for `command` (its "Environment Variable Load Order"), or none for another command. */
function nextEnvFiles(command) {
  if (command !== "dev" && command !== "start") return [];
  const mode = process.env.NODE_ENV === "test" ? "test" : command === "dev" ? "development" : "production";
  return [`.env.${mode}.local`, ...(mode === "test" ? [] : [".env.local"]), `.env.${mode}`, ".env"];
}

/** A line that assigns SEED_ASSETS_DIR, in the `KEY=value`, `export KEY=value` and `KEY: value` forms Next.js parses. */
const SEED_ASSETS_ASSIGNMENT = /^[^\S\n]*(?:export[^\S\n]+)?SEED_ASSETS_DIR(?:[^\S\n]*=|:[^\S\n])/m;

const seedAssets = seedAssetsEnv(CHECKOUT, process.env.SEED_ASSETS_DIR);
if (seedAssets.SEED_ASSETS_DIR !== undefined) {
  for (const name of nextEnvFiles(process.argv[2])) {
    const file = path.join(process.cwd(), name);
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (SEED_ASSETS_ASSIGNMENT.test(content)) {
      console.error(
        `SEED_ASSETS_DIR is assigned in ${file}, and Next.js would drop that value, because this launcher sets ` +
          "SEED_ASSETS_DIR in the process environment, which Next.js reads first. Remove it from the file and " +
          'export SEED_ASSETS_DIR in the shell instead (docs/DISTRIBUTION.md, "Built-in sample assets").',
      );
      process.exit(1);
    }
  }
}

const env = { ...process.env, ...seedAssets };
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

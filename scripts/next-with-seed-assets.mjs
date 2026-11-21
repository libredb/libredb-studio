#!/usr/bin/env node
/**
 * The launcher of `bun dev` and `bun start` (package.json `dev` and `start`): runs the Next.js CLI with SEED_ASSETS_DIR
 * set to this checkout's own seed-assets directory, the built-in samples' assets (docs/DISTRIBUTION.md, "Built-in
 * sample assets").
 *
 * The server never takes that directory from its working directory (src/lib/seed/samples.ts), so a checkout's server
 * needs it set, as every packaged channel's launcher sets it for its payload. The path is computed from this file's own
 * location and is absolute. A non-blank SEED_ASSETS_DIR the caller set is kept as given: Next.js runs in this process's
 * working directory, so a relative value means the same to it. Next.js reads the process environment before any .env
 * file, so under this launcher a SEED_ASSETS_DIR in .env.local is not read; export it in the shell instead.
 *
 * Every argument is passed to the Next.js CLI unchanged. The CLI is the `next` binary this checkout installs, found
 * through the `bin` field of next's package.json and run with this Node.js, so no shell and no PATH lookup is involved
 * on any OS. SIGINT and SIGTERM are forwarded to it; this process exits with its exit code, or ends itself with the
 * signal that ended it. A missing Next.js CLI is an error, exit 1.
 *
 * Tested by tests/unit/next-with-seed-assets.test.ts, which spawns it.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedAssetsEnv } from "../bin/lib/launcher-utils.mjs";

const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"];

/** The Next.js CLI this checkout installs; throws when next is not installed or declares no `next` binary. */
function nextCli() {
  const manifest = createRequire(import.meta.url).resolve("next/package.json");
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

const env = { ...process.env, ...seedAssetsEnv(CHECKOUT, process.env.SEED_ASSETS_DIR) };
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

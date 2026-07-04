#!/usr/bin/env node
/**
 * npx launcher for LibreDB Studio (issue #110): `npx @libredb/studio`.
 *
 * The npm package stays a pure library for libredb-platform - the server
 * build is never shipped inside it. Instead this launcher downloads the
 * platform's standalone server tarball from GitHub Releases (built by
 * .github/workflows/release-artifacts.yml), verifies it against the
 * SHA256SUMS release asset, caches it under ~/.libredb-studio/<version>/,
 * and spawns `node server.js` from the unpacked payload. Missing secrets
 * are handled by the server's zero-config bootstrap (issue #109), which
 * generates and prints admin credentials on first run.
 *
 * ESM in a .js file: bin/package.json sets "type": "module" for this
 * directory only - the root package.json must stay typeless because the
 * library dist ships CJS .js files consumed via require().
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  artifactName,
  LauncherUsageError,
  parseLauncherArgs,
  parseSha256Sums,
  releaseDownloadUrl,
  resolveCacheDir,
  sha256File,
} from "./lib/launcher-utils.mjs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const USAGE = `LibreDB Studio ${pkg.version} launcher

Usage: npx @libredb/studio [options]

Starts the LibreDB Studio standalone server. On first run the launcher
downloads the release tarball for this platform from GitHub Releases,
verifies its SHA256 checksum, and caches it in ~/.libredb-studio/${pkg.version}/.
Later runs start straight from the cache.

Options:
  --port <n>        Port to listen on (default: $PORT or 3000)
  --archive <path>  Start from a local standalone tarball instead of
                    downloading (env: LIBREDB_STUDIO_ARCHIVE)
  --help, -h        Show this help

All environment variables are forwarded to the server (PORT, HOSTNAME,
JWT_SECRET, ADMIN_PASSWORD, STORAGE_PROVIDER, STORAGE_SQLITE_PATH, ...).
When JWT_SECRET or ADMIN_PASSWORD are not set, the server generates them on
first run and prints the admin credentials once.`;

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Download a release asset to a local file (atomic: .partial then rename).
 * Node's global fetch follows the GitHub -> CDN redirect automatically.
 *
 * @param {string} url
 * @param {string} destination
 */
async function download(url, destination) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (response.status === 404) {
    fail(
      [
        `Release ${pkg.version} has no standalone server artifacts yet (HTTP 404 for ${url}).`,
        "Standalone tarballs are attached to GitHub releases by CI and do not exist for older versions.",
        "Options:",
        "  - run a newer release:  npx @libredb/studio@latest",
        "  - use a locally built tarball:  npx @libredb/studio --archive <path>",
        "    (build one with scripts/build-standalone-payload.sh from the repository)",
      ].join("\n"),
    );
  }
  if (!response.ok || !response.body) {
    fail(`Download failed with HTTP ${response.status} for ${url}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
    fs.renameSync(partial, destination);
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

/**
 * Unpack a payload tarball into payloadDir (atomic: staging dir then rename).
 * `tar` exists on all supported POSIX platforms (linux, darwin).
 *
 * @param {string} tarballPath
 * @param {string} payloadDir
 */
function extract(tarballPath, payloadDir) {
  console.log(`Unpacking into ${payloadDir}`);
  const staging = `${payloadDir}.extracting`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const result = spawnSync("tar", ["-xzf", tarballPath, "-C", staging], { stdio: "inherit" });
  if (result.error) fail(`Could not run tar: ${result.error.message}`);
  if (result.status !== 0) fail(`tar exited with code ${result.status} while unpacking ${tarballPath}`);
  fs.rmSync(payloadDir, { recursive: true, force: true });
  fs.renameSync(staging, payloadDir);
}

/**
 * Ensure the release payload is downloaded, checksum-verified, and unpacked.
 *
 * @param {string} cacheDir
 * @param {string} payloadDir
 */
async function preparePayload(cacheDir, payloadDir) {
  const name = artifactName(pkg.version, process.platform, process.arch);
  const tarballPath = path.join(cacheDir, name);
  const sumsPath = path.join(cacheDir, "SHA256SUMS");
  fs.mkdirSync(cacheDir, { recursive: true });

  if (fs.existsSync(tarballPath)) console.log(`Using cached download ${tarballPath}`);
  else await download(releaseDownloadUrl(pkg.version, name), tarballPath);
  if (!fs.existsSync(sumsPath)) await download(releaseDownloadUrl(pkg.version, "SHA256SUMS"), sumsPath);

  const sums = parseSha256Sums(fs.readFileSync(sumsPath, "utf8"));
  const expected = sums.get(name);
  if (!expected) {
    fail(`SHA256SUMS of release ${pkg.version} has no entry for ${name} - refusing to unpack an unverifiable archive`);
  }
  const actual = await sha256File(tarballPath);
  if (actual !== expected) {
    fs.rmSync(tarballPath, { force: true });
    fail(
      `SHA256 mismatch for ${name}: expected ${expected}, got ${actual}. ` +
        "The corrupted download was deleted - run the command again.",
    );
  }
  console.log("Checksum verified");
  extract(tarballPath, payloadDir);
}

/**
 * Spawn `node server.js` from the payload, forwarding the full environment.
 *
 * @param {string} payloadDir
 * @param {number | null} port
 */
function startServer(payloadDir, port) {
  const env = { ...process.env };
  if (port !== null) env.PORT = String(port);
  if (!env.NODE_ENV) env.NODE_ENV = "production";
  console.log(`Starting LibreDB Studio ${pkg.version} on http://localhost:${env.PORT || "3000"}`);
  const child = spawn(process.execPath, ["server.js"], { cwd: payloadDir, env, stdio: "inherit" });
  child.on("error", (error) => fail(`Could not start server.js: ${error.message}`));
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}

async function main() {
  let args;
  try {
    args = parseLauncherArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof LauncherUsageError) {
      console.error(`${error.message}\n`);
      fail(USAGE);
    }
    throw error;
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }

  if (process.platform === "win32") {
    fail(
      [
        "LibreDB Studio standalone tarballs are not available for Windows yet.",
        "Run Studio with Docker instead:",
        "  docker run -p 3000:3000 ghcr.io/libredb/libredb-studio:latest",
        "Native Windows support is tracked in https://github.com/libredb/libredb-studio/issues/114",
      ].join("\n"),
    );
  }

  const cacheDir = resolveCacheDir(pkg.version, os.homedir());
  const archive = args.archive || process.env.LIBREDB_STUDIO_ARCHIVE || null;
  let payloadDir;
  if (archive) {
    const archivePath = path.resolve(archive);
    if (!fs.existsSync(archivePath)) fail(`Archive not found: ${archivePath}`);
    // Local archives bypass download AND checksum verification; they are
    // re-extracted on every run so a rebuilt tarball always takes effect.
    payloadDir = path.join(cacheDir, "payload-local");
    console.log(`Using local archive ${archivePath} (checksum verification skipped)`);
    extract(archivePath, payloadDir);
  } else {
    payloadDir = path.join(cacheDir, "payload");
    if (fs.existsSync(path.join(payloadDir, "server.js"))) {
      console.log(`Using cached payload ${payloadDir}`);
    } else {
      await preparePayload(cacheDir, payloadDir);
    }
  }

  if (!fs.existsSync(path.join(payloadDir, "server.js"))) {
    fail(`Payload in ${payloadDir} has no server.js - not a LibreDB Studio standalone tarball`);
  }
  startServer(payloadDir, args.port);
}

main().catch((error) => {
  fail(`LibreDB Studio launcher failed: ${error instanceof Error ? error.message : String(error)}`);
});

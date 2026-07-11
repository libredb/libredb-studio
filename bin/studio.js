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
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  artifactName,
  assessNodeRuntime,
  extractTarball,
  LauncherUsageError,
  parseLauncherArgs,
  parseSha256Sums,
  preservePayloadData,
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
  --host <addr>     Address to bind (default: $HOSTNAME or 127.0.0.1;
                    use --host 0.0.0.0 to expose on the network)
  --archive <path>  Start from a local standalone tarball instead of
                    downloading (env: LIBREDB_STUDIO_ARCHIVE). WARNING:
                    local archives skip checksum verification unless
                    --archive-sha256 is given - only use tarballs you
                    built or obtained from a trusted source.
  --archive-sha256 <hex>
                    Expected sha256 of the --archive tarball; mismatch
                    refuses to start
  --verify-cache    Re-verify the cached tarball checksum and re-extract
                    the payload before starting
  --help, -h        Show this help

The server binds to 127.0.0.1 by default; exposing it on the network is an
explicit opt-in (--host or HOSTNAME). All environment variables are forwarded
to the server (PORT, HOSTNAME, JWT_SECRET, ADMIN_PASSWORD, STORAGE_PROVIDER,
STORAGE_SQLITE_PATH, ...). When JWT_SECRET or ADMIN_PASSWORD are not set, the
server generates them on first run and prints the admin credentials once.`;

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(message);
  process.exit(1);
}

const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const DOWNLOAD_ATTEMPTS = 3;

/** A download failure that a retry cannot change (definitive HTTP answers). */
class NoRetryError extends Error {}

/**
 * Download a release asset to a local file (atomic: .partial then rename).
 * Node's global fetch follows the GitHub -> CDN redirect automatically.
 * An idle watchdog aborts the request when no data arrives for
 * DOWNLOAD_IDLE_TIMEOUT_MS, so a hung connection never blocks forever while
 * slow-but-alive links stay unaffected.
 *
 * @param {string} url
 * @param {string} destination
 */
async function downloadOnce(url, destination) {
  const controller = new AbortController();
  /** @type {NodeJS.Timeout | undefined} */
  let idleTimer;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new Error(`no data received for ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s`)),
      DOWNLOAD_IDLE_TIMEOUT_MS,
    );
  };
  armIdleTimer();
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (response.status === 404) {
      throw new NoRetryError(
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
      const message = `Download failed with HTTP ${response.status} for ${url}`;
      // Other 4xx answers are definitive; 5xx and truncated bodies may recover.
      if (response.status >= 400 && response.status < 500) throw new NoRetryError(message);
      throw new Error(message);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const partial = `${destination}.partial`;
    try {
      const body = Readable.fromWeb(response.body);
      body.on("data", armIdleTimer);
      await pipeline(body, fs.createWriteStream(partial));
      fs.renameSync(partial, destination);
    } finally {
      fs.rmSync(partial, { force: true });
    }
  } finally {
    clearTimeout(idleTimer);
  }
}

/**
 * downloadOnce with bounded retries and linear backoff for transient
 * failures (network errors, idle timeouts, 5xx). Definitive answers
 * (404 guidance, other 4xx) fail immediately.
 *
 * @param {string} url
 * @param {string} destination
 */
async function download(url, destination) {
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(attempt === 1 ? `Downloading ${url}` : `Retrying download (${attempt}/${DOWNLOAD_ATTEMPTS}): ${url}`);
      // eslint-disable-next-line no-await-in-loop -- retries are sequential by design
      await downloadOnce(url, destination);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof NoRetryError || attempt >= DOWNLOAD_ATTEMPTS) fail(message);
      const delaySeconds = attempt * 2;
      console.warn(`Download failed (${message}); retrying in ${delaySeconds}s`);
      // eslint-disable-next-line no-await-in-loop -- backoff between sequential attempts
      await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    }
  }
}

/**
 * Unpack a payload tarball into payloadDir (atomic: staging dir then rename).
 * `tar` exists on all supported POSIX platforms (linux, darwin). The tarball
 * is packed under a top-level libredb-studio-<version>/ root (issue #133),
 * which extractTarball strips. A previous payload's data/ dir (generated
 * credentials, SQLite storage) is preserved across the swap - see
 * preservePayloadData (issue #132).
 *
 * @param {string} tarballPath
 * @param {string} payloadDir
 */
function extract(tarballPath, payloadDir) {
  console.log(`Unpacking into ${payloadDir}`);
  const staging = `${payloadDir}.extracting`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const { status, error } = extractTarball(tarballPath, staging);
  if (error) fail(`Could not run tar: ${error.message}`);
  if (status !== 0) fail(`tar exited with code ${status} while unpacking ${tarballPath}`);
  preservePayloadData(payloadDir, staging);
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
  // Log-line contract: "Checksum verified" is asserted verbatim by the
  // post-release npx-engine-smoke workflow - keep the wording stable.
  console.log("Checksum verified");
  extract(tarballPath, payloadDir);
}

/**
 * Spawn `node server.js` from the payload, forwarding the full environment.
 * Local-first: without --host/HOSTNAME the server binds to loopback only
 * (the standalone Next server would otherwise default to 0.0.0.0).
 *
 * @param {string} payloadDir
 * @param {number | null} port
 * @param {string | null} host
 */
function startServer(payloadDir, port, host) {
  const env = { ...process.env };
  if (port !== null) env.PORT = String(port);
  if (host !== null) env.HOSTNAME = host;
  if (!env.HOSTNAME) env.HOSTNAME = "127.0.0.1";
  if (!env.NODE_ENV) env.NODE_ENV = "production";
  // Log-line contract: npx-engine-smoke.yml parses the resolved version from
  // "Starting LibreDB Studio <version> " - keep the prefix stable.
  console.log(`Starting LibreDB Studio ${pkg.version} on http://${env.HOSTNAME}:${env.PORT || "3000"}`);
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

  // Refuse runtimes the payload cannot run on and surface degraded tiers
  // up front, before any download happens (see assessNodeRuntime).
  const runtime = assessNodeRuntime(process.versions.node);
  if (runtime.action === "fail") fail(runtime.message);
  if (runtime.action === "warn") console.warn(runtime.message);

  const cacheDir = resolveCacheDir(pkg.version, os.homedir());
  const archive = args.archive || process.env.LIBREDB_STUDIO_ARCHIVE || null;
  let payloadDir;
  if (archive) {
    const archivePath = path.resolve(archive);
    if (!fs.existsSync(archivePath)) fail(`Archive not found: ${archivePath}`);
    // Local archives bypass download and, unless --archive-sha256 pins a
    // digest, checksum verification too; they are re-extracted on every run
    // so a rebuilt tarball always takes effect.
    if (args.archiveSha256) {
      const actual = await sha256File(archivePath);
      if (actual !== args.archiveSha256) {
        fail(`SHA256 mismatch for ${archivePath}: expected ${args.archiveSha256}, got ${actual}`);
      }
      console.log(`Using local archive ${archivePath} (checksum verified)`);
    } else {
      console.log(`Using local archive ${archivePath} (checksum verification skipped)`);
    }
    payloadDir = path.join(cacheDir, "payload-local");
    extract(archivePath, payloadDir);
  } else {
    if (args.archiveSha256) fail("--archive-sha256 requires --archive");
    payloadDir = path.join(cacheDir, "payload");
    if (!args.verifyCache && fs.existsSync(path.join(payloadDir, "server.js"))) {
      console.log(`Using cached payload ${payloadDir} (re-check it anytime with --verify-cache)`);
    } else {
      // --verify-cache re-runs the full prepare flow: the cached tarball is
      // re-hashed against the cached SHA256SUMS and the payload re-extracted.
      await preparePayload(cacheDir, payloadDir);
    }
  }

  if (!fs.existsSync(path.join(payloadDir, "server.js"))) {
    fail(`Payload in ${payloadDir} has no server.js - not a LibreDB Studio standalone tarball`);
  }
  startServer(payloadDir, args.port, args.host);
}

main().catch((error) => {
  fail(`LibreDB Studio launcher failed: ${error instanceof Error ? error.message : String(error)}`);
});

/**
 * Pure helpers for the npx launcher (bin/studio.js, issue #110).
 *
 * Zero runtime dependencies, Node builtins only, and no network access:
 * everything here is unit tested in tests/unit/launcher-utils.test.ts.
 * The CLI entry stays thin and composes these helpers.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, renameSync, rmSync } from "node:fs";
import * as path from "node:path";

/**
 * Platform/arch pairs the release workflow builds standalone tarballs for
 * (must mirror the matrix in .github/workflows/release-artifacts.yml).
 */
const SUPPORTED_TARGETS = {
  linux: ["x64", "arm64"],
  darwin: ["x64", "arm64"],
};

/** Thrown for user-facing CLI mistakes; the entry prints the message plus usage. */
export class LauncherUsageError extends Error {}

/**
 * Release versions in this repo are plain semver without a "v" prefix.
 * The version read from package.json is used in download URLs and cache
 * paths, so anything else (path separators, dots-only traversal, URL
 * metacharacters) is rejected before it can steer a request or escape the
 * cache directory - a corrupted or tampered manifest must fail loudly.
 */
const RELEASE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/**
 * Validate a release version string and return it.
 *
 * @param {string} version
 * @returns {string}
 */
export function assertReleaseVersion(version) {
  if (typeof version !== "string" || !RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid release version ${JSON.stringify(version)} (expected plain semver, e.g. 0.9.42)`);
  }
  return version;
}

/**
 * Map a Node process.platform/process.arch pair to the release artifact name.
 * The naming must mirror scripts/build-standalone-payload.sh:
 * libredb-studio-standalone-<version>-<os>-<arch>.tar.gz
 * Throws for targets the release workflow does not build.
 *
 * @param {string} version
 * @param {string} platform value of process.platform
 * @param {string} arch value of process.arch
 * @returns {string}
 */
export function artifactName(version, platform, arch) {
  assertReleaseVersion(version);
  const archs = SUPPORTED_TARGETS[platform];
  if (!archs || !archs.includes(arch)) {
    throw new Error(
      `No standalone artifact is published for ${platform}-${arch}. ` +
        "Supported targets: linux-x64, linux-arm64, darwin-x64, darwin-arm64.",
    );
  }
  return `libredb-studio-standalone-${version}-${platform}-${arch}.tar.gz`;
}

/**
 * Download URL of a release asset. Release tags drop the "v" prefix
 * (tag == package.json version), so the path uses the bare version.
 *
 * @param {string} version
 * @param {string} fileName
 * @returns {string}
 */
export function releaseDownloadUrl(version, fileName) {
  return `https://github.com/libredb/libredb-studio/releases/download/${assertReleaseVersion(version)}/${encodeURIComponent(fileName)}`;
}

/**
 * Per-version cache directory: <home>/.libredb-studio/<version>
 *
 * @param {string} version
 * @param {string} homeDir
 * @returns {string}
 */
export function resolveCacheDir(version, homeDir) {
  return path.join(homeDir, ".libredb-studio", assertReleaseVersion(version));
}

/**
 * Parse `sha256sum` output (the SHA256SUMS release asset): one
 * "<hex>  <name>" line per file, with an optional "*" binary marker before
 * the name. Returns a Map of file name to lowercase hex digest; malformed
 * lines are skipped rather than failing the whole file.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/**
 * Stream a file through node:crypto sha256.
 *
 * @param {string} filePath
 * @returns {Promise<string>} lowercase hex digest
 */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Move a previous payload's data/ directory (generated auth-bootstrap.json,
 * SQLite storage state) over a freshly extracted staging directory's own
 * data/ dir before it replaces the payload directory. Every release tarball
 * ships an empty data/ (scripts/build-standalone-payload.sh), so a re-extract
 * (--verify-cache, --archive) would otherwise silently wipe generated
 * credentials and server-side SQLite storage on every run (issue #132). A
 * no-op when there is nothing to preserve: first extraction (no payloadDir
 * yet) or a payloadDir with no data/ dir.
 *
 * @param {string} payloadDir the previous payload root (may not exist)
 * @param {string} stagingDir the freshly extracted staging directory
 */
export function preservePayloadData(payloadDir, stagingDir) {
  const existingData = path.join(payloadDir, "data");
  if (!existsSync(existingData)) return;
  const stagingData = path.join(stagingDir, "data");
  rmSync(stagingData, { recursive: true, force: true });
  renameSync(existingData, stagingData);
}

/**
 * Extract a tarball into destDir via the system `tar`. Release tarballs are
 * packed under a top-level libredb-studio-<version>/ root (issue #133,
 * scripts/lib/pack-standalone-tarball.sh) instead of a tarbomb, so every
 * entry is unwrapped one path component - the payload (server.js, etc.)
 * lands directly in destDir, matching every caller's expectation.
 *
 * @param {string} tarballPath
 * @param {string} destDir
 * @returns {{ status: number | null, error: Error | null }}
 */
export function extractTarball(tarballPath, destDir) {
  const result = spawnSync("tar", ["-xzf", tarballPath, "-C", destDir, "--strip-components=1"], {
    stdio: "inherit",
  });
  return { status: result.status, error: result.error ?? null };
}

/**
 * Runtime tiers for the payload (Next.js standalone server):
 * - Next.js 16 itself needs Node >= 20.9 - below that the server cannot run.
 * - node:sqlite (SQLite database connections) exists unflagged from 22.13.
 * - The bundled better-sqlite3 binding (server-side SQLite storage,
 *   STORAGE_PROVIDER=sqlite) targets the Node 24 ABI line.
 * Node 24 LTS is the fully supported runtime; older tiers run with the
 * degradations spelled out by assessNodeRuntime so users see them up front.
 */
const MINIMUM_NODE = { major: 20, minor: 9 };

/**
 * Assess a Node.js runtime version (process.versions.node shape, e.g.
 * "22.13.0") against the payload's requirements. Pure and injectable for
 * unit tests - never reads process state itself.
 *
 * @param {string} version
 * @returns {{ action: "fail" | "warn" | "ok", message: string | null }}
 */
export function assessNodeRuntime(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return {
      action: "fail",
      message: `LibreDB Studio launcher could not parse the Node.js version ${JSON.stringify(version)}. Node.js ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor}+ is required (Node 24 LTS recommended).`,
    };
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];

  if (major < MINIMUM_NODE.major || (major === MINIMUM_NODE.major && minor < MINIMUM_NODE.minor)) {
    return {
      action: "fail",
      message: [
        `LibreDB Studio requires Node.js ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor} or newer; this is Node ${version}.`,
        "Install Node 24 LTS (https://nodejs.org) or run Studio with Docker:",
        "  docker run -p 3000:3000 ghcr.io/libredb/libredb-studio:latest",
      ].join("\n"),
    };
  }
  if (major < 22 || (major === 22 && minor < 13)) {
    return {
      action: "warn",
      message:
        `Node ${version}: SQLite features are unavailable on this runtime - ` +
        "SQLite database connections need the built-in node:sqlite module (Node 22.13+) and " +
        "server-side SQLite storage (STORAGE_PROVIDER=sqlite) needs Node 24. " +
        "Everything else works; use Node 24 LTS for full functionality.",
    };
  }
  if (major < 24) {
    return {
      action: "warn",
      message:
        `Node ${version}: server-side SQLite storage (STORAGE_PROVIDER=sqlite) needs Node 24 - ` +
        "the bundled native module targets the Node 24 ABI. Everything else works " +
        "(node:sqlite may print a one-time ExperimentalWarning); use Node 24 LTS for full functionality.",
    };
  }
  return { action: "ok", message: null };
}

/**
 * Parse launcher CLI arguments. Returns { help, port, host, archive,
 * verifyCache }; port/host stay null when not given (the server then falls
 * back to $PORT / 3000 and the launcher's loopback default). Throws
 * LauncherUsageError on unknown flags, missing values, or invalid ports.
 *
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ help: boolean, port: number | null, host: string | null, archive: string | null, archiveSha256: string | null, verifyCache: boolean }}
 */
export function parseLauncherArgs(argv) {
  const args = {
    help: false,
    port: /** @type {number | null} */ (null),
    host: /** @type {string | null} */ (null),
    archive: /** @type {string | null} */ (null),
    archiveSha256: /** @type {string | null} */ (null),
    verifyCache: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = splitFlag(argv[i]);
    switch (flag) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--port": {
        const value = inlineValue ?? argv[++i];
        if (value === undefined) throw new LauncherUsageError("--port requires a value");
        const port = Number(value);
        if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw new LauncherUsageError(`Invalid --port value "${value}" (expected an integer between 1 and 65535)`);
        }
        args.port = port;
        break;
      }
      case "--host": {
        const value = inlineValue ?? argv[++i];
        if (value === undefined || value === "") throw new LauncherUsageError("--host requires an address");
        args.host = value;
        break;
      }
      case "--archive": {
        const value = inlineValue ?? argv[++i];
        if (value === undefined || value === "") throw new LauncherUsageError("--archive requires a path");
        args.archive = value;
        break;
      }
      case "--archive-sha256": {
        const value = inlineValue ?? argv[++i];
        if (value === undefined || !/^[0-9a-fA-F]{64}$/.test(value)) {
          throw new LauncherUsageError("--archive-sha256 requires a 64-char hex sha256 digest");
        }
        args.archiveSha256 = value.toLowerCase();
        break;
      }
      case "--verify-cache":
        args.verifyCache = true;
        break;
      default:
        throw new LauncherUsageError(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

/**
 * Split "--flag=value" into ["--flag", "value"]; other shapes pass through
 * as [arg, undefined].
 *
 * @param {string} arg
 * @returns {[string, string | undefined]}
 */
function splitFlag(arg) {
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    if (eq !== -1) return [arg.slice(0, eq), arg.slice(eq + 1)];
  }
  return [arg, undefined];
}

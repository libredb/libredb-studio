/**
 * Pure helpers for the npx launcher (bin/studio.js, issue #110).
 *
 * Zero runtime dependencies, Node builtins only, and no network access:
 * everything here is unit tested in tests/unit/launcher-utils.test.ts.
 * The CLI entry stays thin and composes these helpers.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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
  return `https://github.com/libredb/libredb-studio/releases/download/${version}/${fileName}`;
}

/**
 * Per-version cache directory: <home>/.libredb-studio/<version>
 *
 * @param {string} version
 * @param {string} homeDir
 * @returns {string}
 */
export function resolveCacheDir(version, homeDir) {
  return path.join(homeDir, ".libredb-studio", version);
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
 * Parse launcher CLI arguments. Returns { help, port, archive }; port stays
 * null when not given (the server then falls back to $PORT / 3000). Throws
 * LauncherUsageError on unknown flags, missing values, or invalid ports.
 *
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ help: boolean, port: number | null, archive: string | null }}
 */
export function parseLauncherArgs(argv) {
  const args = { help: false, port: /** @type {number | null} */ (null), archive: /** @type {string | null} */ (null) };
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
      case "--archive": {
        const value = inlineValue ?? argv[++i];
        if (value === undefined || value === "") throw new LauncherUsageError("--archive requires a path");
        args.archive = value;
        break;
      }
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

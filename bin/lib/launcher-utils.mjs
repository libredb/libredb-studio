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
 * Platform/arch pairs the release workflow builds standalone payloads for
 * (must mirror the build jobs in .github/workflows/release-artifacts.yml).
 */
const SUPPORTED_TARGETS = {
  linux: ["x64", "arm64"],
  darwin: ["x64", "arm64"],
  win32: ["x64"],
};

/**
 * Archive extension per platform: POSIX targets ship .tar.gz; Windows ships
 * a .zip (issue #114) because winget's InstallerType is zip and Windows has
 * no gzip/tar toolchain guarantee outside the System32 bsdtar.
 */
const ARCHIVE_EXTENSION = { linux: ".tar.gz", darwin: ".tar.gz", win32: ".zip" };

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
 * libredb-studio-standalone-<version>-<os>-<arch>.tar.gz (.zip on win32).
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
        "Supported targets: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.",
    );
  }
  return `libredb-studio-standalone-${version}-${platform}-${arch}${ARCHIVE_EXTENSION[platform]}`;
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
 * Build the archive extraction command for extractArchive. Pure so the
 * per-format/per-platform branches are unit-testable on any host:
 * - .tar.gz: system `tar`, stripping the top-level libredb-studio-<version>/
 *   root the tarballs are packed under (issue #133,
 *   scripts/lib/pack-standalone-tarball.sh).
 * - .zip (the win32-x64 payload, issue #114): flat by design - winget's
 *   NestedInstallerFiles.RelativeFilePath must stay stable across versions,
 *   so there is no versioned root and nothing to strip. On Windows the
 *   command is the absolute System32 bsdtar (reads zip natively): a bare
 *   `tar` could resolve to Git Bash's GNU tar, which cannot read zip. On
 *   macOS the system tar IS bsdtar, so plain `tar -xf` handles zip there.
 *   On linux GNU tar cannot read zip at all, so a zip --archive is refused
 *   with a clear error instead of a cryptic tar failure (npx on linux only
 *   ever downloads the .tar.gz artifact).
 *
 * @param {string} archivePath
 * @param {string} destDir
 * @param {string} platform value of process.platform
 * @param {Record<string, string | undefined>} env process.env shape
 * @returns {{ command: string, args: string[] }}
 */
export function extractionCommand(archivePath, destDir, platform, env) {
  if (archivePath.toLowerCase().endsWith(".zip")) {
    if (platform !== "win32" && platform !== "darwin") {
      throw new Error(
        `zip archives cannot be extracted on ${platform} (GNU tar has no zip support) - ` +
          "use the .tar.gz artifact instead (the zip is the win32 artifact)",
      );
    }
    const command = platform === "win32" ? `${env.SystemRoot || "C:\\Windows"}\\System32\\tar.exe` : "tar";
    return { command, args: ["-xf", archivePath, "-C", destDir] };
  }
  return { command: "tar", args: ["-xzf", archivePath, "-C", destDir, "--strip-components=1"] };
}

/**
 * Extract a release archive (tarball or win32 zip) into destDir - the
 * payload (server.js, etc.) lands directly in destDir on every platform
 * (see extractionCommand for the per-format layout contract).
 *
 * @param {string} archivePath
 * @param {string} destDir
 * @returns {{ status: number | null, error: Error | null }}
 */
export function extractArchive(archivePath, destDir) {
  const { command, args } = extractionCommand(archivePath, destDir, process.platform, process.env);
  const result = spawnSync(command, args, { stdio: "inherit" });
  return { status: result.status, error: result.error ?? null };
}

/**
 * Runtime requirement for the payload (Next.js standalone server). Node 24 LTS
 * is the reference runtime - it is what release-artifacts.yml builds the
 * payload on (issue #326 raised the floor here from 20.9 to clear the runway
 * for the agent runtime, which needs a modern Node and ESM).
 *
 * There is a floor but deliberately no ceiling. The payload's only native
 * module is better-sqlite3, and since v13 it is built on the N-API: one
 * prebuilt binary per platform, valid across Node majors. So a payload built
 * on Node 24 runs unchanged on Node 26, and every runtime at or above the
 * floor is fully supported rather than degraded - which is what the node26 leg
 * of scripts/engine-smoke.sh asserts.
 */
const MINIMUM_NODE = { major: 24, minor: 0 };

/**
 * Assess a Node.js runtime version (process.versions.node shape, e.g.
 * "22.13.0") against the payload's requirements. Pure and injectable for
 * unit tests - never reads process state itself.
 *
 * @param {string} version
 * @returns {{ action: "fail" | "ok", message: string | null }}
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
  return { action: "ok", message: null };
}

/**
 * First release whose artifacts carry signed SLSA build provenance
 * (release-artifacts.yml attests them, issue #123). Anything older has no
 * attestation to find, so "not found" says nothing about that download.
 */
const FIRST_ATTESTED_VERSION = { major: 0, minor: 9, patch: 63 };

/** The repository whose attestations are trusted for release archives. */
export const PROVENANCE_REPO = "libredb/libredb-studio";

/**
 * The only workflow allowed to have signed a release archive - passed to
 * `gh attestation verify --signer-workflow`, so an attestation minted by any
 * other workflow in this repo (or a branch build) fails the policy instead of
 * passing a repo-level check.
 *
 * Renaming or moving that workflow would make every launcher refuse to start,
 * so tests/unit/release-provenance.test.ts asserts this path still exists and
 * still attests the standalone archives - a rename breaks CI, not users.
 */
export const PROVENANCE_SIGNER_WORKFLOW = `${PROVENANCE_REPO}/.github/workflows/release-artifacts.yml`;

/**
 * Whether GitHub should hold an attestation for this release's artifacts.
 * Numeric triple compare (0.10.0 > 0.9.63, which a string compare gets
 * wrong); a prerelease suffix is ignored because the same CI signs it.
 * An unparseable version answers "no" - a corrupted manifest must not
 * manufacture a refusal to start.
 *
 * @param {string} version
 * @returns {boolean}
 */
function attestationsExpected(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const first = FIRST_ATTESTED_VERSION;
  if (major !== first.major) return major > first.major;
  if (minor !== first.minor) return minor > first.minor;
  return patch >= first.patch;
}

/**
 * Turn a `gh attestation verify` run into a launcher decision (issue #123).
 *
 * gh exits non-zero for every failure, so the stderr text is the only thing
 * separating "this machine cannot verify" from "verification says no". The
 * policy is tri-state and fails OPEN on the first kind: the launcher's
 * contract is zero dependencies, so a missing or unauthenticated gh, or no
 * network, must never stop a server from starting.
 *
 * It fails CLOSED on the second kind, and the important case there is a
 * missing attestation for a release that should have one. An attacker who can
 * replace a release asset can replace its SHA256SUMS line too - the checksum
 * still matches - but they cannot forge an attestation. So for an
 * attested-era release, "GitHub has no attestation for this digest" is the
 * tampering signal itself, not an absence of information. Treating it as
 * merely unverifiable would leave the check decorative against the one attack
 * it exists to catch.
 *
 * Pure and injectable: never spawns anything, never reads process state.
 *
 * @param {{ spawnError: (Error & { code?: string }) | null, exitCode: number | null, stderr: string, version: string, artifactName: string }} run
 * @returns {{ action: "ok" | "warn" | "fail", message: string }}
 */
export function assessProvenance({ spawnError, exitCode, stderr, version, artifactName }) {
  if (exitCode === 0) {
    return { action: "ok", message: `Provenance verified for ${artifactName}` };
  }
  const text = stderr || "";
  /** @param {string} reason */
  const cannotVerify = (reason) => ({
    action: /** @type {const} */ ("warn"),
    message:
      `Provenance not verified (${reason}) - continuing on checksum verification alone. ` +
      "The archive matched its published SHA256, which detects corruption but not substitution.",
  });
  /** @param {string} reason */
  const refuse = (reason) => ({
    action: /** @type {const} */ ("fail"),
    message:
      `Provenance REJECTED for ${artifactName}: ${reason}.\n` +
      "Refusing to start - the archive matches its published checksum but its origin cannot be " +
      "established, which is what a replaced release asset looks like.\n" +
      "  - delete the cache and retry: rm -rf ~/.libredb-studio && npx @libredb/studio@latest\n" +
      "  - if it persists, please report it: https://github.com/libredb/libredb-studio/issues\n" +
      "  - to start anyway (accepting the risk): LIBREDB_STUDIO_SKIP_PROVENANCE=1",
  });

  if (spawnError) {
    if (spawnError.code === "ENOENT") return cannotVerify("the GitHub CLI (gh) is not installed");
    return cannotVerify(`gh could not be run: ${spawnError.message}`);
  }
  // Auth shows up three ways, all captured from the live CLI: an HTTP 401/403
  // when a token exists but is rejected, gh's own "please run: gh auth login"
  // hint when none exists at all, and exit code 4 - gh's documented auth
  // status, matched on its own so a reworded hint still reads as auth.
  if (exitCode === 4 || /HTTP 40[13]|Bad credentials|gh auth login|GH_TOKEN/.test(text)) {
    return cannotVerify("gh is not authenticated - run `gh auth login`");
  }
  if (/no such host|connection refused|network is unreachable|i\/o timeout|dial tcp|EAI_AGAIN/i.test(text)) {
    return cannotVerify("GitHub is unreachable from this machine");
  }
  if (/HTTP 429|rate limit/i.test(text)) {
    return cannotVerify("the GitHub API rate limit is exhausted - retry later");
  }
  if (/HTTP 404/.test(text)) {
    if (!attestationsExpected(version)) {
      return cannotVerify(`release ${version} predates signed provenance`);
    }
    return refuse("GitHub holds no attestation for this file's digest");
  }
  if (/verifying with issuer|signature|does not match|verification failed/i.test(text)) {
    return refuse("the attestation exists but does not satisfy the expected signer policy");
  }
  // Unknown failure: fail open. A gh version that changes its wording must
  // degrade to a warning, never to a launcher that refuses to start - but quote
  // gh's own first line, because an opaque "exited 1" is undiagnosable (it cost
  // a debugging round while this was being written).
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return cannotVerify(
    firstLine ? `gh attestation verify exited ${exitCode}: ${firstLine}` : `gh attestation verify exited ${exitCode}`,
  );
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

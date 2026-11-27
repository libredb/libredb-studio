/**
 * Fixture provider packages for the tests of the providers directory and its lock
 * (src/lib/provider-host/providers-lock.ts): a scratch providers directory, an artifact written as
 * `<name>/<version>/` with its package.json, a minimal libredb-provider.json (its engines' ids and its runtime entry)
 * and its entry file, and a lock written with Studio's own serializer and digest, its import record scanned by the lock
 * command's own scanner (`moduleImports` in scripts/providers-lock.ts).
 *
 * Engine ids here are fixture ids, never one the bundled catalog serves; a test that needs a bundled id takes it from
 * `SHIPPED_DATABASE_TYPES`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactDigest, MANIFEST_FILE_NAME, walkArtifact } from "@/lib/provider-host/provider-artifact";
import { LOCK_FILE_NAME, type LockEntry, serializeProvidersLock } from "@/lib/provider-host/providers-lock-format";
import { moduleImports } from "../../scripts/providers-lock";

/** A package as a test writes it. */
export interface FixturePackage {
  readonly name: string;
  readonly version: string;
  readonly engines: readonly string[];
  /** The manifest's `runtime.entry`; `dist/index.mjs` when absent. */
  readonly entry?: string;
  /** More files, by path relative to the artifact, with their text. */
  readonly files?: Readonly<Record<string, string>>;
}

/** The entry every fixture declares unless it says otherwise. */
export const FIXTURE_ENTRY = "dist/index.mjs";

/** A new scratch directory under the system's temporary directory, named by its real path. */
export function scratchDirectory(prefix: string): string {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** Removes a scratch directory and everything in it. */
export function removeScratch(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

/** The directory a package's artifact sits in: `<providers>/<name>/<version>`, a scoped name split at its slash. */
export function artifactDirectoryOf(providers: string, pkg: Pick<FixturePackage, "name" | "version">): string {
  return path.join(providers, ...pkg.name.split("/"), pkg.version);
}

/** Writes a package's artifact under `providers` and answers its directory. */
export function writeArtifact(providers: string, pkg: FixturePackage): string {
  const directory = artifactDirectoryOf(providers, pkg);
  const entry = pkg.entry ?? FIXTURE_ENTRY;
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: pkg.name, version: pkg.version, type: "module" }, null, 2)}\n`,
    [MANIFEST_FILE_NAME]: `${JSON.stringify(
      { engines: pkg.engines.map((id) => ({ id })), runtime: { entry } },
      null,
      2,
    )}\n`,
    [entry]: "export default {};\n",
    ...pkg.files,
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(directory, ...relative.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return directory;
}

/**
 * The lock entry of a package as its artifact stands now: its import record scanned by the lock command's scanner, its
 * digest computed by Studio's own walk.
 */
export function lockEntryOf(providers: string, pkg: FixturePackage): LockEntry {
  const directory = artifactDirectoryOf(providers, pkg);
  const walked = walkArtifact(directory);
  if (!walked.ok) throw new Error(`the fixture ${pkg.name} ${pkg.version} does not walk: ${walked.fault.rule}`);
  const imports = moduleImports(directory, walked.files);
  if (typeof imports === "string") throw new Error(`the fixture ${pkg.name} ${pkg.version} does not scan: ${imports}`);
  return {
    name: pkg.name,
    version: pkg.version,
    engines: [...pkg.engines],
    entry: pkg.entry ?? FIXTURE_ENTRY,
    digest: artifactDigest(walked.files, imports),
    source: "local",
    imports,
  };
}

/** Writes the lock of `entries` into `providers` with Studio's serializer, and answers its path. */
export function writeLock(providers: string, entries: readonly LockEntry[]): string {
  const lock = path.join(providers, LOCK_FILE_NAME);
  writeFileSync(lock, serializeProvidersLock(entries));
  return lock;
}

/** Writes a lock whose text is exactly `text`, bypassing the serializer, and answers its path. */
export function writeLockText(providers: string, text: string | Uint8Array): string {
  const lock = path.join(providers, LOCK_FILE_NAME);
  writeFileSync(lock, text);
  return lock;
}

/** A digest of the right form that no artifact has. */
export const UNMATCHED_DIGEST = `sha256:${"0".repeat(64)}`;

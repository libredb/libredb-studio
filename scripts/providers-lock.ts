#!/usr/bin/env bun
/**
 * Writes the lock of a providers directory, `providers.lock.json` (docs/providers/CONTRACT.md, clauses C-91 to C-94):
 * one entry for every package the directory holds as `<name>/<version>/` or `@<scope>/<name>/<version>/`, each with
 * its name and version (from its path, checked against its package.json), its engine ids and entry (from its manifest,
 * libredb-provider.json), the digest of its files and its source, `local`.
 *
 * The digest and the identity are computed by the artifact functions Studio's own lock read uses
 * (src/lib/provider-host/provider-artifact.ts), so a lock this command writes is read unchanged, and a later edit to a
 * package is refused at the next read. The command never imports the lock reader, and never imports or runs a
 * package's code. It does not judge engine id collisions: Studio's read does, and the command records what the
 * directory holds.
 *
 * It refuses, writing nothing and exiting 1 with every refusal on stderr: an entry of the directory that is neither a
 * package nor the lock, a package directory holding anything but one version directory, and every refusal an artifact
 * draws (a link, a special file, a name outside the portable set, the limits, a package.json or manifest it cannot
 * read, a package.json naming another package, an entry that is not a file of the package). Otherwise it writes the
 * lock through a temporary file in the same directory and a rename, entries by name and engine ids in order, so the
 * same directory always gives the same bytes, and prints the lock's path and one line per package; exit 0.
 *
 * The directory must be absolute: `bun run` runs the script from the repository root, so a relative path would not
 * be the one typed. Any other argument prints the usage; exit 2.
 *
 * Run: bun run providers:lock -- --dir <absolute directory>
 */
import * as fs from "node:fs";
import path from "node:path";
import {
  artifactDigest,
  checkEntryFile,
  compareIdentity,
  readArtifactIdentity,
  resolveArtifactDirectory,
  walkArtifact,
} from "../src/lib/provider-host/provider-artifact";
import { type ArtifactFault, packageRefusal } from "../src/lib/provider-host/provider-refusals";
import { LOCK_FILE_NAME } from "../src/lib/provider-host/providers-dir";
import {
  LOCAL_SOURCE,
  type LockEntry,
  PACKAGE_NAME_FORM,
  PACKAGE_VERSION_FORM,
  serializeProvidersLock,
  type StringForm,
} from "../src/lib/provider-host/providers-lock-format";

const USAGE = "Usage: bun run providers:lock -- --dir <absolute directory>";
const PREFIX = "providers:lock";

/** The directory the arguments name, or null when they are not exactly one absolute `--dir`. */
function directoryArgument(argv: readonly string[]): string | null {
  const value =
    argv.length === 2 && argv[0] === "--dir"
      ? argv[1]
      : argv.length === 1 && argv[0]?.startsWith("--dir=")
        ? argv[0].slice("--dir=".length)
        : undefined;
  return value !== undefined && path.isAbsolute(value) ? value : null;
}

/** Whether `value` is a string of `form`. */
function inForm(value: string, form: StringForm): boolean {
  return value.length <= form.maxLength && form.pattern.test(value);
}

/** Whether `file` is a directory, following links. */
function isDirectory(file: string): boolean {
  return fs.statSync(file).isDirectory();
}

/** Code-unit order. */
function sorted(names: readonly string[]): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A package the directory holds: its name and version, from its path. */
interface FoundPackage {
  readonly name: string;
  readonly version: string;
}

/** The packages under `root`, and a sentence for each entry that is not one. */
function enumerate(root: string): { packages: FoundPackage[]; refusals: string[] } {
  const packages: FoundPackage[] = [];
  const refusals: string[] = [];
  const notAPackage = (relative: string) => refusals.push(`${PREFIX}: ${relative}: neither a package nor the lock`);
  const packageAt = (relative: string, name: string): void => {
    const versions = sorted(fs.readdirSync(path.join(root, relative)));
    if (versions.length !== 1) {
      refusals.push(
        `${PREFIX}: ${relative}: ${versions.length === 0 ? "no version of the package" : "two versions of one package"}`,
      );
      return;
    }
    const version = versions[0] as string;
    if (!inForm(version, PACKAGE_VERSION_FORM) || !isDirectory(path.join(root, relative, version))) {
      refusals.push(`${PREFIX}: ${path.join(relative, version)}: not a version of the package`);
      return;
    }
    packages.push({ name, version });
  };
  for (const entry of sorted(fs.readdirSync(root))) {
    if (entry === LOCK_FILE_NAME) continue;
    if (!isDirectory(path.join(root, entry))) {
      notAPackage(entry);
      continue;
    }
    if (!entry.startsWith("@")) {
      if (inForm(entry, PACKAGE_NAME_FORM)) packageAt(entry, entry);
      else notAPackage(entry);
      continue;
    }
    for (const scoped of sorted(fs.readdirSync(path.join(root, entry)))) {
      const relative = path.join(entry, scoped);
      const name = `${entry}/${scoped}`;
      if (inForm(name, PACKAGE_NAME_FORM) && isDirectory(path.join(root, relative))) packageAt(relative, name);
      else notAPackage(relative);
    }
  }
  return { packages, refusals };
}

/** The lock entry of one package, or the sentence of its refusal. */
function lockEntryOf(root: string, pkg: FoundPackage): LockEntry | string {
  const refuse = (fault: ArtifactFault): string => packageRefusal(pkg, fault).sentence;
  const resolved = resolveArtifactDirectory(root, pkg.name, pkg.version);
  if (!resolved.ok) return refuse(resolved.fault);
  const walked = walkArtifact(resolved.directory);
  if (!walked.ok) return refuse(walked.fault);
  const read = readArtifactIdentity(resolved.directory);
  if (!read.ok) return refuse(read.fault);
  const { identity } = read;
  const mismatch =
    compareIdentity(identity, { ...pkg, engines: identity.engines, entry: identity.entry }) ??
    checkEntryFile(walked.files, identity.entry);
  if (mismatch !== null) return refuse(mismatch);
  return {
    name: pkg.name,
    version: pkg.version,
    engines: identity.engines,
    entry: identity.entry,
    digest: artifactDigest(walked.files),
    source: LOCAL_SOURCE,
  };
}

/** Writes the lock of `directory`; the exit code. */
function writeLock(directory: string): number {
  let root: string;
  try {
    root = fs.realpathSync.native(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    console.error(`${PREFIX}: ${directory}: the providers directory does not exist`);
    console.error(`${PREFIX} wrote nothing`);
    return 1;
  }
  const { packages, refusals } = enumerate(root);
  const entries: LockEntry[] = [];
  for (const pkg of packages) {
    const entry = lockEntryOf(root, pkg);
    if (typeof entry === "string") refusals.push(entry);
    else entries.push(entry);
  }
  if (refusals.length > 0) {
    for (const refusal of refusals) console.error(refusal);
    console.error(`${PREFIX} wrote nothing`);
    return 1;
  }
  const lock = path.join(root, LOCK_FILE_NAME);
  const temporary = path.join(root, `.${LOCK_FILE_NAME}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, serializeProvidersLock(entries), { flag: "wx" });
  fs.renameSync(temporary, lock);
  console.log(`Wrote ${lock}`);
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    console.log(`${entry.name} ${entry.version} ${entry.digest}`);
  }
  return 0;
}

function main(argv: readonly string[]): number {
  const directory = directoryArgument(argv);
  if (directory === null) {
    console.error(USAGE);
    return 2;
  }
  return writeLock(directory);
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

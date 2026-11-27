#!/usr/bin/env bun
/**
 * Writes the lock of a providers directory, `providers.lock.json` (docs/providers/CONTRACT.md, clauses C-91 to C-94):
 * one entry for every package the directory holds as `<name>/<version>/` or `@<scope>/<name>/<version>/`, each with
 * its name and version (from its path, checked against its package.json), its engine ids and entry (from its manifest,
 * libredb-provider.json), the digest of its files and its import record, its source, `local`, and the import record.
 *
 * The import record (clause C-102) holds every static import of every module file of the package: each regular file
 * whose name ends in `.js`, `.mjs` or `.cjs` in any letter case, reached by the entry or not. A file of any other
 * extension is listed and digested but not scanned; a TypeScript file among them is not scanned either, since
 * admission refuses a package holding one by its listing, whatever its imports. Each module file is read as strict
 * UTF-8 and scanned with Bun's transpiler, `Bun.Transpiler#scanImports` (loader `js`), after a leading `#!` line is
 * removed, since the scanner refuses one. It reports import declarations, side-effect imports, re-exports, `import()`
 * of a string or a template without substitution and `require()` of a string, in dead branches too; not
 * `require.resolve` or `import.meta.resolve`, which load nothing. Each import is recorded with its kind, `importKind`:
 * `require` for a `require()` call, `import` for the rest. The command records; Studio's admission judges the record
 * (src/lib/provider-host/admission.ts and src/lib/provider-host/provider-closure.ts).
 *
 * The digest and the identity are computed by the artifact functions Studio's own lock read uses
 * (src/lib/provider-host/provider-artifact.ts), so a lock this command writes is read unchanged, and a later edit to a
 * package is refused at the next read. The sequence over one artifact directory, `artifactEntry`, is also the key
 * command's (scripts/providers-key.ts), so the digest it prints for a register row is the one this command writes. The
 * command never imports the lock reader, and never imports or runs a package's code. It does not judge engine id
 * collisions: Studio's read does, and the command records what the directory holds.
 *
 * It refuses, writing nothing and exiting 1 with every refusal on stderr: an entry of the directory that is neither a
 * package nor the lock, a package directory holding anything but one version directory, and every refusal an artifact
 * draws (a link, a special file, a name outside the portable set, the limits, a package.json or manifest it cannot
 * read, a package.json naming another package, an entry that is not a file of the package), a module file the scanner
 * cannot parse or that is not UTF-8, a specifier or module path outside the lock's forms, more than 4,096 imports in a
 * package, and a lock over the reader's byte cap. Otherwise it writes the
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
  type ArtifactFile,
  artifactDigest,
  checkEntryFile,
  compareIdentity,
  readArtifactIdentity,
  resolveArtifactDirectory,
  walkArtifact,
} from "../src/lib/provider-host/provider-artifact";
import { type ArtifactFault, type PackageName, packageRefusal } from "../src/lib/provider-host/provider-refusals";
import { LOCK_FILE_NAME } from "../src/lib/provider-host/providers-dir";
import {
  IMPORT_FROM_FORM,
  IMPORT_SPECIFIER_FORM,
  LOCAL_SOURCE,
  LOCK_BYTE_CAP,
  LOCK_IMPORT_CAP,
  type ImportKind,
  type LockEntry,
  type ModuleImport,
  PACKAGE_NAME_FORM,
  PACKAGE_VERSION_FORM,
  serializeProvidersLock,
  sortImports,
  type StringForm,
} from "../src/lib/provider-host/providers-lock-format";

const USAGE = "Usage: bun run providers:lock -- --dir <absolute directory>";
const PREFIX = "providers:lock";

/** The directory the arguments name, or null when they are not exactly one absolute `--dir`. */
export function directoryArgument(argv: readonly string[]): string | null {
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

/** A JavaScript module file by its extension, in any letter case: the only files the command scans. */
const MODULE_FILE = /\.[mc]?js$/i;
const SCAN_JAVASCRIPT = new Bun.Transpiler({ loader: "js" });
/** UTF-8 that refuses an invalid byte. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The kind the lock records for an import the scanner reports as `scannerKind`: `require` for a `require()` call,
 * `import` for an import declaration, a re-export or an `import()`.
 *
 * @throws {Error} For any other kind, which the scanner reports for no JavaScript or TypeScript file.
 */
export function importKind(scannerKind: string): ImportKind {
  if (scannerKind === "require-call") return "require";
  if (scannerKind === "import-statement" || scannerKind === "dynamic-import") return "import";
  throw new Error(
    `providers:lock: the scanner reported an import of the kind ${scannerKind}, which the lock does not record`,
  );
}

/** The imports `text` makes statically, or null when it is not UTF-8 or the scanner cannot parse it. */
function scanned(bytes: Buffer): { specifier: string; kind: ImportKind }[] | null {
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes).replace(/^#![^\n]*/, "");
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
  try {
    return SCAN_JAVASCRIPT.scanImports(text).map((found) => ({ specifier: found.path, kind: importKind(found.kind) }));
  } catch (error) {
    if (!(error instanceof BuildMessage) && !(error instanceof AggregateError)) throw error;
    return null;
  }
}

/**
 * The import record of the module files among `files`, the listing of the artifact at `directory`, sorted and each
 * import once; or why the package cannot be locked, one sentence.
 */
export function moduleImports(directory: string, files: readonly ArtifactFile[]): ModuleImport[] | string {
  const pairs = new Map<string, ModuleImport>();
  for (const file of files) {
    if (!MODULE_FILE.test(file.path)) continue;
    if (!inForm(file.path, IMPORT_FROM_FORM)) return "a module path is longer than 1024 characters";
    const found = scanned(fs.readFileSync(path.join(directory, ...file.path.split("/"))));
    if (found === null) return `${file.path}: its parser cannot read it, or it is not UTF-8`;
    for (const { specifier, kind } of found) {
      if (!inForm(specifier, IMPORT_SPECIFIER_FORM)) {
        return `${file.path}: it imports a specifier outside printable ASCII without spaces, or longer than 1024 characters`;
      }
      pairs.set(`${file.path} ${specifier} ${kind}`, { from: file.path, specifier, kind });
    }
    if (pairs.size > LOCK_IMPORT_CAP) return `its module files hold more than ${LOCK_IMPORT_CAP} imports`;
  }
  return sortImports([...pairs.values()]);
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

/**
 * The lock entry of the artifact at `directory`, a real path, as package `pkg`: its walk, its identity checked against
 * `pkg` and its entry file, its import record and its digest; or the sentence of its refusal, an artifact refusal in
 * `packageRefusal`'s words, or an import record's refusal after `command`, the name of the command that prints it.
 */
export function artifactEntry(directory: string, pkg: PackageName, command: string): LockEntry | string {
  const refuse = (fault: ArtifactFault): string => packageRefusal(pkg, fault).sentence;
  const walked = walkArtifact(directory);
  if (!walked.ok) return refuse(walked.fault);
  const read = readArtifactIdentity(directory);
  if (!read.ok) return refuse(read.fault);
  const { identity } = read;
  const mismatch =
    compareIdentity(identity, { ...pkg, engines: identity.engines, entry: identity.entry }) ??
    checkEntryFile(walked.files, identity.entry);
  if (mismatch !== null) return refuse(mismatch);
  const imports = moduleImports(directory, walked.files);
  if (typeof imports === "string") return `${command}: ${pkg.name} ${pkg.version}: ${imports}`;
  return {
    name: pkg.name,
    version: pkg.version,
    engines: identity.engines,
    entry: identity.entry,
    digest: artifactDigest(walked.files, imports),
    source: LOCAL_SOURCE,
    imports,
  };
}

/** The lock entry of one package, or the sentence of its refusal. */
function lockEntryOf(root: string, pkg: FoundPackage): LockEntry | string {
  const resolved = resolveArtifactDirectory(root, pkg.name, pkg.version);
  if (!resolved.ok) return packageRefusal(pkg, resolved.fault).sentence;
  return artifactEntry(resolved.directory, pkg, PREFIX);
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
  const text = serializeProvidersLock(entries);
  if (Buffer.byteLength(text) > LOCK_BYTE_CAP) {
    console.error(`${PREFIX}: the lock would be over its byte limit of ${LOCK_BYTE_CAP} bytes`);
    console.error(`${PREFIX} wrote nothing`);
    return 1;
  }
  const lock = path.join(root, LOCK_FILE_NAME);
  const temporary = path.join(root, `.${LOCK_FILE_NAME}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, text, { flag: "wx" });
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

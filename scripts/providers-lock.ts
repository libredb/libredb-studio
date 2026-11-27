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
 * UTF-8 and parsed by acorn (pinned to one version in package.json, since its version is the record's grammar), with
 * the latest syntax it reads, as a script that may also hold import and export declarations and top-level `return`,
 * twice: once with top-level `await` an operator, as in an ES module, and once with it an identifier, as in a CommonJS
 * file. The record holds the imports of every reading that parses, and a file neither reading parses is refused. The
 * only lexical difference between a script and a module, an HTML-like comment (`<!--`, or `-->` at a line's start), is
 * refused. A leading `#!` line ends at any line terminator, as in Node.js. `new.target` outside a function runs in a
 * CommonJS file, which Node.js wraps in a function, but the pinned parser has no option to read it there, so such a
 * file is refused as one the parser cannot read. The tree is walked with an explicit stack, so only the parser's own
 * depth bounds a file; that depth depends on the runtime's stack, and a file nested past it is refused by name under
 * Node.js and Bun alike, never raised.
 * Recorded, in dead branches too: import declarations, side-effect imports, re-exports with a source, `import()` of a
 * string or a template without substitution, and a call of the identifier `require` (an optional call included) whose
 * first argument is a string or a template without substitution, whatever follows it. Not recorded: a computed
 * `import()` or `require()`, `require.resolve` or `import.meta.resolve`, which load nothing, and a `require` reached
 * through a member or another name. Each import is recorded with its kind: `require` for a `require()` call, `import`
 * for the rest. The command records; Studio's admission judges the record (src/lib/provider-host/admission.ts and
 * src/lib/provider-host/provider-closure.ts). The command runs the same under Node.js and Bun: it imports acorn and
 * Node.js built-ins, and `main` is exported for a caller that runs it under Node.js.
 *
 * The digest and the identity are computed by the artifact functions Studio's own lock read uses
 * (src/lib/provider-host/provider-artifact.ts), so a lock this command writes is read unchanged, and a later edit to a
 * package is refused at the next read. The sequence over one artifact directory, `artifactEntry`, is also the key
 * command's (scripts/providers-key.ts), so the digest it prints for a register row is the one this command writes. The
 * command never imports the lock reader, and never imports or runs a package's code. It does not judge engine id
 * collisions: Studio's read does, and the command records what the directory holds.
 *
 * A `--dir` that names anything but a directory is refused alone. Otherwise it refuses, writing nothing and exiting 1
 * with every refusal on stderr, each naming its entry: an entry of the directory that is neither a package nor the
 * lock, a scope directory holding no package, an entry of a package directory that is not a version directory (at
 * each of the three levels, a link whose target does not exist is such an entry), a
 * package directory holding no entry or two version directories or more, more packages than the lock reader admits
 * (`LOCK_ENTRY_CAP`), and every refusal an artifact draws (a link, a special file, a name outside the portable set, the
 * limits, a package.json or manifest it cannot read, more engine ids than an entry holds among them, a package.json
 * naming another package, an entry that is not a file of the package), a module file the parser cannot read or that
 * is not UTF-8, a specifier or module path outside the lock's forms, more than 4,096 imports in a package, and a lock
 * over the reader's byte cap. None is passed over, so an operator removes a stray entry once, and the command never
 * writes a lock the reader refuses for a cap. The directory's refusals come first, in walk order, then the entry cap,
 * then each package's, by name: every package is read even past the entry cap, so one run prints every refusal.
 * Otherwise it writes the lock through a temporary file in the same directory and a rename, entries by name and
 * engine ids in order, so the same directory always gives the same bytes, and prints the lock's path and one line per
 * package; exit 0.
 *
 * The directory must be absolute: `bun run` runs the script from the repository root, so a relative path would not
 * be the one typed. Any other argument prints the usage; exit 2.
 *
 * Run: bun run providers:lock -- --dir <absolute directory>
 */
import * as fs from "node:fs";
import path from "node:path";
import { type AnyNode, type Comment, parse } from "acorn";
import {
  type ArtifactFile,
  artifactDigest,
  checkEntryFile,
  compareIdentity,
  readArtifactIdentity,
  resolveArtifactDirectory,
  walkArtifact,
} from "../src/lib/provider-host/provider-artifact";
import { packageRefusal } from "../src/lib/provider-host/lock-refusals";
import type { ArtifactFault, PackageName } from "../src/lib/provider-host/provider-refusals";
import {
  IMPORT_FROM_FORM,
  IMPORT_SPECIFIER_FORM,
  LOCAL_SOURCE,
  LOCK_BYTE_CAP,
  LOCK_ENTRY_CAP,
  LOCK_FILE_NAME,
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

/**
 * Whether `file` is a directory, following links: a link whose target does not exist is not one, so it is refused by
 * name as the entry it stands for. Any other failure to read it is raised.
 */
function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

/** Code-unit order. */
function sorted(names: readonly string[]): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A JavaScript module file by its extension, in any letter case: the only files the command scans. */
const MODULE_FILE = /\.[mc]?js$/i;
/** UTF-8 that refuses an invalid byte. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The string a node holds when it is a string literal or a template literal without substitution; else null. */
function staticString(node: AnyNode | undefined): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
  return null;
}

/** The import `node` makes, if it is one the lock records. */
function recordedImport(node: AnyNode): { specifier: string; kind: ImportKind } | null {
  switch (node.type) {
    case "ImportDeclaration":
    case "ExportAllDeclaration":
      return { specifier: node.source.value as string, kind: "import" };
    case "ExportNamedDeclaration":
      return node.source ? { specifier: node.source.value as string, kind: "import" } : null;
    case "ImportExpression": {
      const specifier = staticString(node.source);
      return specifier === null ? null : { specifier, kind: "import" };
    }
    case "CallExpression": {
      if (node.callee.type !== "Identifier" || node.callee.name !== "require") return null;
      const specifier = staticString(node.arguments[0]);
      return specifier === null ? null : { specifier, kind: "require" };
    }
    default:
      return null;
  }
}

/** Whether `value` is a node of the tree: an object whose `type` is a string. */
function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/**
 * One reading of `text`: its tree and its comments, with top-level `await` an operator when `awaitOperator` holds and
 * an identifier otherwise; or null when the parser cannot read it that way.
 */
function reading(text: string, awaitOperator: boolean): { program: AnyNode; comments: Comment[] } | null {
  const comments: Comment[] = [];
  try {
    const program = parse(text, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: awaitOperator,
      allowReturnOutsideFunction: true,
      allowHashBang: true,
      onComment: comments,
    });
    return { program, comments };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

/**
 * The imports `bytes` makes statically in every reading that parses, or null when they are not UTF-8 or the parser
 * reads them neither way: a syntax error, an HTML-like comment, `new.target` outside a function, or nesting past the
 * runtime's stack, which acorn reports as a syntax error.
 */
function scanned(bytes: Buffer): { specifier: string; kind: ImportKind }[] | null {
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
  const readings = [reading(text, true), reading(text, false)].filter((read) => read !== null);
  if (readings.length === 0) return null;
  if (
    readings.some((read) =>
      read.comments.some(
        (comment) =>
          comment.type === "Line" && (text.startsWith("<!--", comment.start) || text.startsWith("-->", comment.start)),
      ),
    )
  ) {
    return null;
  }
  const found: { specifier: string; kind: ImportKind }[] = [];
  const pending: AnyNode[] = readings.map((read) => read.program);
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const recorded = recordedImport(node);
    if (recorded !== null) found.push(recorded);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) pending.push(item);
      } else if (isNode(value)) {
        pending.push(value);
      }
    }
  }
  return found;
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
    const entries = sorted(fs.readdirSync(path.join(root, relative)));
    if (entries.length === 0) {
      refusals.push(`${PREFIX}: ${relative}: no version of the package`);
      return;
    }
    const versions: string[] = [];
    for (const entry of entries) {
      if (inForm(entry, PACKAGE_VERSION_FORM) && isDirectory(path.join(root, relative, entry))) versions.push(entry);
      else refusals.push(`${PREFIX}: ${path.join(relative, entry)}: not a version directory of the package`);
    }
    if (versions.length > 1) refusals.push(`${PREFIX}: ${relative}: two versions of one package`);
    if (versions.length === 1) packages.push({ name, version: versions[0] as string });
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
    const scope = sorted(fs.readdirSync(path.join(root, entry)));
    if (scope.length === 0) refusals.push(`${PREFIX}: ${entry}: a scope directory holding no package`);
    for (const scoped of scope) {
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
  if (!isDirectory(root)) {
    console.error(`${PREFIX}: ${directory}: the providers directory is not a directory`);
    console.error(`${PREFIX} wrote nothing`);
    return 1;
  }
  const { packages, refusals } = enumerate(root);
  if (packages.length > LOCK_ENTRY_CAP) {
    refusals.push(
      `${PREFIX}: the lock would hold ${packages.length} entries, more than the ${LOCK_ENTRY_CAP} Studio reads`,
    );
  }
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

export function main(argv: readonly string[]): number {
  const directory = directoryArgument(argv);
  if (directory === null) {
    console.error(USAGE);
    return 2;
  }
  return writeLock(directory);
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

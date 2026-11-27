#!/usr/bin/env bun
/**
 * Packs in-repository provider packages into artifacts a providers directory holds (docs/TOOLCHAIN.md, "The provider
 * pack step (`providers:pack`)"): for each package it runs the package's own `build` script, judges what the build
 * wrote with the lock command's artifact sequence and admission's own checks, and places the artifact as
 * `<out>/<name>/<version>/`. It writes no lock: the lock command (scripts/providers-lock.ts, C-91) locks what it
 * placed.
 * Studio holds no bundler configuration of any package and names no engine: what a build needs, a driver's optional
 * requires or its WebAssembly entry, stays in the package's `build` script.
 *
 * The packages are the directories named on the command line, or, when none is named, every provider package of the
 * repository (`providerPackageDirectories` in scripts/workspace-packages.mjs: `packages/provider-*` but the SDK).
 * Before any package, the output directory and the temporary directory must each exist, be a directory and lie
 * outside the repository's real path; each failure is one sentence, and nothing is built. Then, one package after
 * another, each failure a sentence on its own, the package's later steps skipped and a closing sentence that nothing
 * was written for it, while the other packages are still packed:
 *
 * 1. the package directory exists and is a directory;
 * 2. its package.json, read within the lock's byte cap, names a package name and version in the lock's forms, since
 *    they become path segments, and holds a non-empty string `scripts.build`;
 * 3. it holds `libredb-provider.json` as a regular file;
 * 4. its build runs as `bun run --shell=bun build -- --outdir <temporary>/artifact`, Bun's own shell on every platform,
 *    with the package's directory as its working directory, so it resolves its dependencies from the workspace's
 *    install, and an environment of the caller's `PATH`, `PATHEXT`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `TEMP`, `TMP`
 *    and `TMPDIR` alone (names compared in any letter case, kept as the caller spells them), with `HOME` and
 *    `USERPROFILE` an empty directory beside `--outdir`; `bun run` adds `NODE`, `PWD` and `npm_*` variables of its
 *    own. A build that exits other than 0 is refused with its exit code and everything it printed. A build has no
 *    deadline: a deadline on `bun run` ends `bun` and leaves the build's own children running, and ending a process
 *    tree differs on every platform, so a build that never ends holds the step, and a CI job's timeout bounds a run;
 * 5. the build wrote no `package.json` and no `libredb-provider.json` at the root of its output, since the step copies
 *    both from the package's directory next;
 * 6. the artifact passes the lock command's own sequence over one directory (`artifactEntry`), refused with the
 *    sentence the lock command prints;
 * 7. every finding of admission's checks before import, each named: an import its closure judges outside the package
 *    (`closureOutside`, Node.js's built-in list), a TypeScript file, a native addon, a manifest declaring
 *    `runtime.native`;
 * 8. no module file (`isModuleFile`), read by the lock's own parse (`parsedModule`) in each of its readings, makes a
 *    runtime load the lock's record cannot hold (C-114), each named by file, line and form: it names `createRequire`
 *    (an identifier in any position, or a string or a template without substitution equal to it, so a computed
 *    member is named too); it reads `require` other than as the callee of a call whose first argument is a string or
 *    a template without substitution, a declared binding named `require` included; it calls `require()` or `import()`
 *    with anything else; or it calls a member named `require`, such as `module.require(x)`. An identifier that is a
 *    name rather than a reference is not read: a non-computed member or key, a label, an imported or exported name,
 *    and the local name of a re-export with a source. Not refused: a member named `require` read without a call,
 *    `process.getBuiltinModule`, which loads built-ins only, and code built at run time by `new Function` or `eval`,
 *    which no rule over the source can follow; an admitted package is not sandboxed (C-102). The rule runs here only,
 *    never at admission. A line is 1 plus the count of line feeds before the node;
 * 9. `<out>/<name>/<version>` does not exist yet; the artifact is then copied there, and its digest printed.
 *
 * The build's output lives in a temporary directory under the temporary root, removed whatever happened, so nothing is
 * written into the repository or into a package's directory by the step itself; a build that writes into its own
 * package's directory breaks its contract, and the step does not look for it. A host defect, a filesystem error the
 * step did not expect among them, is thrown.
 *
 * The command prints every refusal on standard error, then `<name> <version> <digest>` per package placed on standard
 * output, in code-unit order of names, and answers 0 when nothing was refused, 1 when anything was; 2 for any
 * command line but `--out <absolute directory>` followed by absolute package directories. Paths must be absolute:
 * `bun run` runs the script from the repository root, so a relative path would not be the one typed.
 *
 * Run: bun run providers:pack -- --out <absolute directory> [<absolute package directory> ...]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { AnyNode } from "acorn";
import { declaresNativePackages, isNativeAddonFile, isTypeScriptFile } from "../src/lib/provider-host/admission";
import {
  decodeJson,
  MANIFEST_BYTE_CAP,
  MANIFEST_FILE_NAME,
  PACKAGE_JSON_BYTE_CAP,
  readBoundedFile,
  walkArtifact,
} from "../src/lib/provider-host/provider-artifact";
import { closureOutside } from "../src/lib/provider-host/provider-closure";
import {
  type LockEntry,
  PACKAGE_NAME_FORM,
  PACKAGE_VERSION_FORM,
  type StringForm,
} from "../src/lib/provider-host/providers-lock-format";
import { artifactEntry, isModuleFile, parsedModule } from "./providers-lock";
import { PACKAGES_DIRECTORY, providerPackageDirectories } from "./workspace-packages.mjs";

const USAGE = "Usage: bun run providers:pack -- --out <absolute directory> [<absolute package directory> ...]";
const PREFIX = "providers:pack";

/** The caller's variables a build sees, by name in lower case; `HOME` and `USERPROFILE` are set by the step. */
const PASSED_VARIABLES: ReadonlySet<string> = new Set([
  "path",
  "pathext",
  "systemroot",
  "windir",
  "comspec",
  "temp",
  "tmp",
  "tmpdir",
]);

/** What the pack step needs. */
export interface PackOptions {
  /** The repository's real path: its provider packages are the default set, and nothing is written inside it. */
  readonly repositoryRoot: string;
  /** An existing directory outside the repository, where each artifact is placed as `<name>/<version>/`. */
  readonly out: string;
  /** Absolute package directories; empty means every provider package of the repository. */
  readonly packageDirectories: readonly string[];
  /** An existing directory outside the repository, where each package's temporary directory is made. */
  readonly temporaryRoot: string;
  /** The caller's environment; a build sees only the variables `PASSED_VARIABLES` names. */
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/** One package placed. */
export interface PackedPackage {
  readonly name: string;
  readonly version: string;
  /** The artifact's digest, the one the lock command writes for it. */
  readonly digest: string;
  /** Where it was placed: `<out>/<name>/<version>`. */
  readonly directory: string;
}

/** What a pack did: the packages placed, and every refusal in order. */
export interface PackResult {
  readonly packed: PackedPackage[];
  readonly refusals: string[];
}

/** Whether `value` is a string of `form`. */
function inForm(value: unknown, form: StringForm): value is string {
  return typeof value === "string" && value.length <= form.maxLength && form.pattern.test(value);
}

/** Whether `value` is a JSON object: not null, not an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `inner` is `outer` or lies under it; both real paths. */
function liesInside(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The real path of `directory`, which must exist, be a directory and lie outside `repositoryRoot`; or the sentence of
 * its refusal, naming it by `role`.
 */
function outsideDirectory(directory: string, role: string, repositoryRoot: string): { real: string } | string {
  let real: string;
  try {
    real = fs.realpathSync.native(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return `${PREFIX}: ${directory}: the ${role} does not exist`;
  }
  if (!fs.statSync(real).isDirectory()) return `${PREFIX}: ${directory}: the ${role} is not a directory`;
  if (liesInside(real, repositoryRoot)) {
    return `${PREFIX}: ${directory}: the ${role} lies inside the repository ${repositoryRoot}`;
  }
  return { real };
}

/** The environment a build runs with: the passed variables of `environment`, and `HOME` and `USERPROFILE` at `home`. */
function buildEnvironment(environment: PackOptions["environment"], home: string): Record<string, string> {
  const passed: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && PASSED_VARIABLES.has(name.toLowerCase())) passed[name] = value;
  }
  return { ...passed, HOME: home, USERPROFILE: home };
}

/** A package's name and version, read from its package.json, which holds a build script; or the sentence of its refusal. */
function readPackageJson(directory: string): { name: string; version: string; bytes: Buffer } | string {
  const read = readBoundedFile(path.join(directory, "package.json"), PACKAGE_JSON_BYTE_CAP);
  const value = read.ok ? decodeJson(read.bytes)?.value : undefined;
  if (!read.ok || !isObject(value)) {
    return `${PREFIX}: ${directory}: its package.json is missing, over its byte limit, or not a JSON object`;
  }
  const { name, version, scripts } = value;
  if (!inForm(name, PACKAGE_NAME_FORM) || !inForm(version, PACKAGE_VERSION_FORM)) {
    return `${PREFIX}: ${directory}: its package.json names no package name and version in the lock's forms`;
  }
  const build = isObject(scripts) ? scripts.build : undefined;
  if (typeof build !== "string" || build === "") return `${PREFIX}: ${directory}: its package.json has no build script`;
  return { name, version, bytes: read.bytes };
}

/** A runtime load the pack step refuses, by the words its sentence says of the module (C-114). */
const RUNTIME_LOAD_FORMS = [
  "names createRequire",
  "reads require other than to call it with a string",
  "calls require() with something other than a string",
  "calls import() with something other than a string",
  "calls a member named require",
] as const;

type RuntimeLoadForm = (typeof RUNTIME_LOAD_FORMS)[number];

/** The string a node holds when it is a string literal or a template literal without substitution; else null. */
function staticString(node: AnyNode | null | undefined): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
  return null;
}

/** Whether `value` is a node of the tree: an object whose `type` is a string. */
function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** A node to visit, and how its parent holds it. */
interface Visit {
  readonly node: AnyNode;
  /** It is a name the parent gives, not a reference: a member, a key, a label, an imported or exported name. */
  readonly name: boolean;
  /** It is the callee of a call of `require`, judged at the call. */
  readonly requireCallee: boolean;
  /** It is a specifier of a re-export with a source, whose local name is the other module's. */
  readonly reExport: boolean;
}

/** Whether the child `key` of `parent` is a name rather than a reference. */
function isNamePosition(parent: AnyNode, key: string, reExport: boolean): boolean {
  switch (parent.type) {
    case "MemberExpression":
      return key === "property" && !parent.computed;
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition":
      return key === "key" && !parent.computed;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return key === "label";
    case "ImportSpecifier":
      return key === "imported";
    case "ExportSpecifier":
      return key === "exported" || reExport;
    case "ImportAttribute":
      return key === "key";
    case "MetaProperty":
      return true;
    default:
      return false;
  }
}

/** Whether `node` is the identifier `name`. */
function isIdentifier(node: AnyNode, name: string): boolean {
  return node.type === "Identifier" && node.name === name;
}

/** The runtime-load form `visit` makes, if any. */
function runtimeLoadForm({ node, name, requireCallee }: Visit): RuntimeLoadForm | null {
  switch (node.type) {
    case "Identifier":
      if (node.name === "createRequire") return "names createRequire";
      return node.name === "require" && !name && !requireCallee
        ? "reads require other than to call it with a string"
        : null;
    case "Literal":
    case "TemplateLiteral":
      return staticString(node) === "createRequire" ? "names createRequire" : null;
    case "CallExpression": {
      const { callee } = node;
      if (isIdentifier(callee, "require")) {
        return staticString(node.arguments[0]) === null ? "calls require() with something other than a string" : null;
      }
      if (callee.type !== "MemberExpression") return null;
      const named = callee.computed
        ? staticString(callee.property) === "require"
        : isIdentifier(callee.property, "require");
      return named ? "calls a member named require" : null;
    }
    case "ImportExpression":
      return staticString(node.source) === null ? "calls import() with something other than a string" : null;
    default:
      return null;
  }
}

/**
 * Every runtime load of the module file whose text is `text` and whose readings are `programs`, each by its line and
 * form, once, in order of line then form: one walk with an explicit stack over every reading, so only the parser's own
 * depth bounds a file. The line is 1 plus the count of line feeds before the node.
 */
function runtimeLoads(text: string, programs: readonly AnyNode[]): { line: number; form: RuntimeLoadForm }[] {
  const found = new Map<string, { line: number; form: RuntimeLoadForm }>();
  const pending: Visit[] = programs.map((node) => ({ node, name: false, requireCallee: false, reExport: false }));
  for (let visit = pending.pop(); visit !== undefined; visit = pending.pop()) {
    const { node } = visit;
    const form = runtimeLoadForm(visit);
    if (form !== null) {
      let line = 1;
      for (let at = text.indexOf("\n"); at !== -1 && at < node.start; at = text.indexOf("\n", at + 1)) line += 1;
      found.set(`${line} ${form}`, { line, form });
    }
    const reExport = node.type === "ExportNamedDeclaration" && node.source !== null && node.source !== undefined;
    const callsRequire = node.type === "CallExpression" && isIdentifier(node.callee, "require");
    for (const [key, value] of Object.entries(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (!isNode(child)) continue;
        pending.push({
          node: child,
          name: isNamePosition(node, key, visit.reExport),
          requireCallee: callsRequire && key === "callee",
          reExport: reExport && key === "specifiers",
        });
      }
    }
  }
  return [...found.values()].sort(
    (a, b) => a.line - b.line || RUNTIME_LOAD_FORMS.indexOf(a.form) - RUNTIME_LOAD_FORMS.indexOf(b.form),
  );
}

/**
 * Every finding of admission's checks before import over the built artifact at `artifact`, then every runtime load of
 * each of its module files, each one sentence.
 */
function admissionFindings(artifact: string, label: string, entry: LockEntry): string[] {
  const walked = walkArtifact(artifact);
  if (!walked.ok) throw new Error(`${PREFIX}: ${artifact}: the walk refused an artifact the lock's sequence admitted`);
  const findings: string[] = [];
  for (const imported of entry.imports) {
    if (closureOutside([imported])) {
      findings.push(
        `${PREFIX}: ${label}: ${imported.from} imports "${imported.specifier}", which is neither a relative path inside the package nor a Node.js built-in`,
      );
    }
  }
  for (const file of walked.files) {
    if (isTypeScriptFile(file.path)) {
      findings.push(
        `${PREFIX}: ${label}: ${file.path} is a TypeScript file, which a package of this contract does not hold`,
      );
    }
  }
  for (const file of walked.files) {
    if (isNativeAddonFile(file.path)) {
      findings.push(`${PREFIX}: ${label}: ${file.path} is a native addon, which this Studio does not admit yet`);
    }
  }
  const manifest = readBoundedFile(path.join(artifact, MANIFEST_FILE_NAME), MANIFEST_BYTE_CAP);
  const runtime = manifest.ok
    ? (decodeJson(manifest.bytes)?.value as { runtime?: unknown } | undefined)?.runtime
    : undefined;
  if (!isObject(runtime)) {
    throw new Error(`${PREFIX}: ${artifact}: the manifest changed after the lock's sequence read its runtime`);
  }
  if (declaresNativePackages(runtime)) {
    findings.push(`${PREFIX}: ${label}: its manifest declares runtime.native, which this Studio does not admit yet`);
  }
  for (const file of walked.files) {
    if (!isModuleFile(file.path)) continue;
    // The lock's sequence parsed every module file of this listing, so a null here is a host defect.
    const parsed = parsedModule(fs.readFileSync(path.join(artifact, ...file.path.split("/"))));
    if (parsed === null)
      throw new Error(`${PREFIX}: ${file.path}: the lock's parse refused a module file it read before`);
    for (const { line, form } of runtimeLoads(parsed.text, parsed.programs)) {
      findings.push(`${PREFIX}: ${label}: ${file.path} line ${line} ${form}`);
    }
  }
  return findings;
}

/** Packs the package at `directory`; its placed package, or its refusals. */
function packOne(
  directory: string,
  options: PackOptions,
  out: string,
  temporaryRoot: string,
): PackedPackage | string[] {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [`${PREFIX}: ${directory}: the package directory does not exist`];
  }
  if (!stats.isDirectory()) return [`${PREFIX}: ${directory}: the package directory is not a directory`];
  const pkg = readPackageJson(directory);
  if (typeof pkg === "string") return [pkg];
  const manifest = path.join(directory, MANIFEST_FILE_NAME);
  if (!fs.lstatSync(manifest, { throwIfNoEntry: false })?.isFile()) {
    return [`${PREFIX}: ${directory}: it holds no ${MANIFEST_FILE_NAME}`];
  }

  const temporary = fs.mkdtempSync(path.join(temporaryRoot, "libredb-providers-pack-"));
  try {
    const artifact = path.join(temporary, "artifact");
    const home = path.join(temporary, "home");
    fs.mkdirSync(artifact);
    fs.mkdirSync(home);
    const build = Bun.spawnSync({
      cmd: [process.execPath, "run", "--shell=bun", "build", "--", "--outdir", artifact],
      cwd: directory,
      env: buildEnvironment(options.environment, home),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (build.exitCode !== 0) {
      const ended = build.exitCode === null ? `ended by ${build.signalCode}` : `exited ${build.exitCode}`;
      const printed = `${build.stdout.toString()}${build.stderr.toString()}`.trimEnd();
      return [`${PREFIX}: ${directory}: its build ${ended}, and printed:\n${printed}`];
    }
    for (const file of ["package.json", MANIFEST_FILE_NAME]) {
      if (fs.lstatSync(path.join(artifact, file), { throwIfNoEntry: false }) !== undefined) {
        return [
          `${PREFIX}: ${directory}: its build wrote ${file}, which the pack step copies from the package's directory`,
        ];
      }
    }
    fs.writeFileSync(path.join(artifact, "package.json"), pkg.bytes);
    fs.copyFileSync(manifest, path.join(artifact, MANIFEST_FILE_NAME));

    const named = { name: pkg.name, version: pkg.version };
    const entry = artifactEntry(artifact, named, PREFIX);
    if (typeof entry === "string") return [entry];
    const findings = admissionFindings(artifact, `${pkg.name} ${pkg.version}`, entry);
    if (findings.length > 0) return findings;

    const target = path.join(out, ...pkg.name.split("/"), pkg.version);
    if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) return [`${PREFIX}: ${target} already exists`];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(artifact, target, { recursive: true, errorOnExist: true, force: false });
    return { ...named, digest: entry.digest, directory: target };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** Packs the packages `options` names into `options.out`; see the module's docblock. */
export function packProviders(options: PackOptions): PackResult {
  const repositoryRoot = options.repositoryRoot;
  const refusals: string[] = [];
  const out = outsideDirectory(options.out, "output directory", repositoryRoot);
  if (typeof out === "string") refusals.push(out);
  const temporaryRoot = outsideDirectory(options.temporaryRoot, "temporary directory", repositoryRoot);
  if (typeof temporaryRoot === "string") refusals.push(temporaryRoot);
  if (typeof out === "string" || typeof temporaryRoot === "string") return { packed: [], refusals };

  const directories =
    options.packageDirectories.length > 0
      ? options.packageDirectories
      : providerPackageDirectories(repositoryRoot).map((directory: string) =>
          path.join(repositoryRoot, ...directory.split("/")),
        );
  if (directories.length === 0) {
    const packages = path.join(repositoryRoot, PACKAGES_DIRECTORY);
    return { packed: [], refusals: [`${PREFIX}: ${packages} holds no provider package, and none was named`] };
  }
  const packed: PackedPackage[] = [];
  for (const directory of directories) {
    const result = packOne(directory, options, out.real, temporaryRoot.real);
    if (Array.isArray(result)) refusals.push(...result, `${PREFIX}: ${directory}: wrote nothing for this package`);
    else packed.push(result);
  }
  return { packed, refusals };
}

/** The output directory and package directories the arguments name, or null when the command line is not the usage. */
function commandLine(argv: readonly string[]): { out: string; packageDirectories: string[] } | null {
  const [flag, out, ...packageDirectories] = argv;
  if (flag !== "--out" || out === undefined) return null;
  if (![out, ...packageDirectories].every((value) => path.isAbsolute(value))) return null;
  return { out, packageDirectories };
}

export function main(argv: readonly string[]): number {
  const line = commandLine(argv);
  if (line === null) {
    console.error(USAGE);
    return 2;
  }
  const { packed, refusals } = packProviders({
    repositoryRoot: fs.realpathSync.native(path.resolve(import.meta.dir, "..")),
    out: line.out,
    packageDirectories: line.packageDirectories,
    temporaryRoot: fs.realpathSync.native(os.tmpdir()),
    environment: process.env,
  });
  for (const refusal of refusals) console.error(refusal);
  for (const pkg of [...packed].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    console.log(`${pkg.name} ${pkg.version} ${pkg.digest}`);
  }
  return refusals.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

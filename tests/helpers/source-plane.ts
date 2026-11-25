/**
 * The two rules of the source plane (packages/README.md, "Planes"), as functions over a root so
 * tests/unit/source-plane.test.ts can hold the repository to them and prove each on a planted root.
 *
 * Specifiers are read with the same TypeScript-parser walk as the packed library check
 * (`moduleSpecifiers` in scripts/check-lib-load.mjs), so text inside a string or a template literal is never taken
 * for an import. Paths are compared by `path.relative` segments, never by a string holding a separator.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { moduleSpecifiers, packageNameOf } from "../../scripts/check-lib-load.mjs";
import { workspacePackageManifests } from "../../scripts/workspace-packages.mjs";

/** The manifest fields that name a single entry point. */
const ENTRY_FIELDS = ["main", "module", "types"] as const;

/** A file whose module specifiers the parser reads. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** `dist` as a word of its own: a path segment named `dist` is bounded by a separator or a quote. */
const BUILT_SEGMENT = /\bdist\b/;

/** Every string leaf of an `exports` value, with the path of keys that reaches it; a `null` leaf is skipped. */
function exportLeaves(value: unknown, label: string): { label: string; target: string }[] {
  if (typeof value === "string") return [{ label, target: value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => exportLeaves(item, `${label}[${index}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => exportLeaves(item, `${label}[${JSON.stringify(key)}]`));
  }
  return [];
}

/** Whether a manifest path, normalized as the POSIX path the manifest format requires, sits under `src/`. */
function isUnderSource(target: string): boolean {
  return path.posix.normalize(target).startsWith("src/");
}

/** One sentence per workspace package entry point (`exports` leaf, `main`, `module`, `types`) outside its `src/`. */
export function entryPointFailures(root: string): string[] {
  const failures: string[] = [];
  for (const { directory, manifest } of workspacePackageManifests(root)) {
    const entries = [
      ...exportLeaves(manifest.exports, "exports"),
      ...ENTRY_FIELDS.filter((field) => typeof manifest[field] === "string").map((field) => ({
        label: field,
        target: manifest[field] as string,
      })),
    ];
    for (const { label, target } of entries) {
      if (isUnderSource(target)) continue;
      failures.push(
        `${directory} ${label} is "${target}", which is not under its src/: tests resolve a workspace package's source, never a build.`,
      );
    }
  }
  return failures;
}

/** Every code file under `directory`, as absolute paths, sorted; an absent directory has none. */
function codeFilesUnder(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && CODE_FILE.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

/** Whether a repository-relative path is the root's `dist/` or a workspace package's `packages/<name>/dist/`. */
function isBuiltPath(relative: string): boolean {
  const segments = relative.split(path.sep);
  return segments[0] === "dist" || (segments[0] === "packages" && segments[2] === "dist");
}

/**
 * One sentence per literal specifier, in a code file under `tests/` or `packages/<name>/tests/`, that resolves into
 * a built artifact: the root's or a package's `dist/`, the root package by name, or a workspace package's `dist/`
 * subpath.
 */
export function builtArtifactImports(root: string): string[] {
  const rootName = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name as string;
  const packages = workspacePackageManifests(root);
  const packageNames = new Set(packages.map(({ manifest }) => manifest.name as string));
  const files = [
    ...codeFilesUnder(path.join(root, "tests")),
    ...packages.flatMap(({ directory }) => codeFilesUnder(path.join(root, directory, "tests"))),
  ];
  const failures: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // A specifier that resolves into a built artifact has `dist` as a whole path segment or names the root package, so
    // a file whose text holds neither holds none, and only the files that could are parsed.
    if (!BUILT_SEGMENT.test(text) && !text.includes(rootName)) continue;
    const relativeFile = path.relative(root, file).split(path.sep).join("/");
    for (const specifier of moduleSpecifiers(text, file).specifiers) {
      const name = packageNameOf(specifier);
      const built = specifier.startsWith(".")
        ? isBuiltPath(path.relative(root, path.resolve(path.dirname(file), specifier)))
        : name === rootName || (packageNames.has(name) && specifier.slice(name.length).split("/").includes("dist"));
      if (!built) continue;
      failures.push(
        `${relativeFile} imports "${specifier}", a built artifact: a test resolves source, and the only checks of a build are bun run lib:load and the SDK's pack test, which builds what it reads.`,
      );
    }
  }
  return failures;
}

/**
 * The import closure of a provider package (docs/providers/CONTRACT.md, clause C-102): whether any import its lock
 * entry records leaves the package's directory. Admission (`./admission`) asks it before it imports the package; the
 * lock command records the imports and never judges them, so there is one judge, Studio's read.
 *
 * The check is pure: it reads the package's listing (the paths of its regular files) and its import record, never a
 * file, so it answers the same on every platform. Each recorded pair `(from, specifier)` is inside when, in this order:
 *
 * 1. the specifier is a built-in of the running runtime, `isBuiltin` of `node:module`, the runtime that imports the
 *    package and resolves the specifier to its own built-in (Bun answers true for a few names Node.js does not, such as
 *    `ws`; Studio's server runs under Node.js);
 * 2. it is relative (`.`, `..`, or starting with `./` or `../`), holds none of `%`, `?`, `#` or a backslash, and
 *    `path.posix` joins it to the importing file's directory without leaving the package. Node's ES module loader
 *    decodes a percent-encoded `..` segment and `require` does not, so refusing those characters makes both loaders'
 *    paths the posix path computed here;
 * 3. it is a bare package specifier, `name` or `@scope/name`, then a subpath with no `.` or `..` segment, and some
 *    directory from the importing file's own up to the package's root, not itself named `node_modules`, holds
 *    `node_modules/<name>` as a directory of the listing. Both Node.js loaders take the first such folder walking up from
 *    the importer, and every ancestor inside the package comes before any outside it, so one found inside resolves
 *    inside.
 *
 * Anything else is outside: an absolute path, a URL or another scheme, a subpath import (`#...`), a bare specifier
 * outside its form.
 *
 * The limits: a computed `import()` or `require()` is not recorded, so not checked; a package's `main` or `exports` is not
 * read (an `exports` target cannot leave its package, a `main` can); a package importing itself by its own name without
 * a `node_modules` folder of that name is outside; on a case-insensitive filesystem a specifier spelled in another case
 * than its folder is outside. The check keeps a package from depending on modules outside its directory, Studio's own
 * `node_modules` among them; it is not a sandbox, since an admitted package runs in Studio's process.
 */
import { isBuiltin } from "node:module";
import * as path from "node:path";
import type { ArtifactFile } from "./provider-artifact";
import type { ModuleImport } from "./providers-lock-format";

/** A bare package specifier: an optional scope, a name, then subpath names. */
const BARE_SPECIFIER = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9_~-][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._@+~-]+)*$/;

/** The characters a relative specifier may not hold. */
const UNRESOLVED_CHARACTERS = /[%?#\\]/;

/** Every directory of the listing, as a path relative to the package's root; the root itself is the empty string. */
function directoriesOf(files: readonly Pick<ArtifactFile, "path">[]): Set<string> {
  const directories = new Set<string>();
  for (const file of files) {
    for (let at = file.path.lastIndexOf("/"); at > 0; at = file.path.lastIndexOf("/", at - 1)) {
      directories.add(file.path.slice(0, at));
    }
  }
  return directories;
}

/** Whether `specifier` is relative: `.`, `..`, or a path starting with `./` or `../`. */
function isRelative(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

/** Whether the relative `specifier` of the module at `from` stays inside the package. */
function relativeInside(from: string, specifier: string): boolean {
  if (UNRESOLVED_CHARACTERS.test(specifier)) return false;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return target !== ".." && !target.startsWith("../");
}

/** Whether the bare `specifier` of the module at `from` names a package a `node_modules` directory inside holds. */
function packageInside(directories: ReadonlySet<string>, from: string, specifier: string): boolean {
  if (!BARE_SPECIFIER.test(specifier)) return false;
  const segments = specifier.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  const name = segments.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  for (let directory = path.posix.dirname(from); ; directory = path.posix.dirname(directory)) {
    const base = directory === "." ? "" : directory;
    if (path.posix.basename(base) !== "node_modules") {
      const folder = base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`;
      if (directories.has(folder)) return true;
    }
    if (base === "") return false;
  }
}

/** Whether any import of `imports` leaves the package whose listing is `files`. */
export function closureOutside(
  files: readonly Pick<ArtifactFile, "path">[],
  imports: readonly ModuleImport[],
): boolean {
  const directories = directoriesOf(files);
  return imports.some(({ from, specifier }) => {
    if (isBuiltin(specifier)) return false;
    if (isRelative(specifier)) return !relativeInside(from, specifier);
    return !packageInside(directories, from, specifier);
  });
}

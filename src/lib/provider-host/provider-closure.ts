/**
 * The import closure of a provider package (docs/providers/CONTRACT.md, clause C-102): whether any import its lock
 * entry records leaves the package's directory. Admission (`./admission`) asks it before it imports the package; the
 * lock command records the imports and never judges them, so there is one judge, Studio's read.
 *
 * The check is pure: it reads the package's import record, never a file, so it answers the same on every platform.
 * Each recorded pair `(from, specifier)` is inside when:
 *
 * 1. the specifier is a built-in of the running runtime, `isBuiltin` of `node:module`, the runtime that imports the
 *    package and resolves the specifier to its own built-in (Bun answers true for a few names Node.js does not, such as
 *    `ws`; Studio's server runs under Node.js); or
 * 2. it is relative (`.`, `..`, or starting with `./` or `../`), holds none of `%`, `?`, `#` or a backslash, and
 *    `path.posix` joins it to the importing file's directory without leaving the package. Node's ES module loader
 *    decodes a percent-encoded `..` segment and `require` does not, so refusing those characters makes both loaders'
 *    paths the posix path computed here.
 *
 * Anything else is outside: an absolute path, a URL or another scheme, a subpath import (`#...`), and every bare
 * specifier, whether an `import` or a `require` names it and whatever `node_modules` folder the package holds. A
 * package of this contract is a bundle whose static imports are relative paths inside it or built-ins. A vendored
 * `node_modules` folder does not keep a bare name inside: when the folder found first lacks the file, Node.js's
 * CommonJS resolver, Bun's, and Bun's ES module resolver move on to the next `node_modules` directory up, outside the
 * package. Bare specifiers are refused until a later milestone designs dependency resolution for packages. The kind of
 * each import stays in the record, as what the scanner saw, and no rule here reads it.
 *
 * The limits: a computed `import()` or `require()` is not recorded, so not checked; the `main` of a package.json,
 * which a `require` of a directory reads, is not read. The check keeps a package from depending on modules outside its
 * directory, Studio's own `node_modules` among them; it is not a sandbox, since an admitted package runs in Studio's
 * process.
 */
import { isBuiltin } from "node:module";
import * as path from "node:path";
import type { ModuleImport } from "./providers-lock-format";

/** The characters a relative specifier may not hold. */
const UNRESOLVED_CHARACTERS = /[%?#\\]/;

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

/** Whether any import of `imports`, a package's import record, leaves the package. */
export function closureOutside(imports: readonly ModuleImport[]): boolean {
  return imports.some(({ from, specifier }) => {
    if (isBuiltin(specifier)) return false;
    return !isRelative(specifier) || !relativeInside(from, specifier);
  });
}

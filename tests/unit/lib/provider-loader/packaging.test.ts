/**
 * How Studio installs and reaches the provider loader (docs/providers/CONTRACT.md, clause C-90; docs/TOOLCHAIN.md,
 * "The provider loader").
 *
 * Next.js bundles a package that bun links into node_modules from a workspace directory: measured on Next.js 16.4.6,
 * Turbopack followed the link, bundled one copy of the loader into instrumentation and another into a route, and
 * replaced its `import()` with a stub that throws. A `file:` dependency installs as a real directory under
 * node_modules, which Next.js leaves to Node's `require`, so a process holds one loader module. Bun hard-links or
 * copies that directory at install time, so an edit to the source reaches the installed copy only through
 * `bun install`, and this file fails until it does.
 *
 * Only the loader's own tests import its source path, which is how its lines are measured; any other path import would
 * be bundled. Specifiers are read with the scanner of `tests/unit/lib/db/provider-imports/scan.ts` (the TypeScript
 * compiler's `preProcessFile`), so a path in a comment or a string is never one, and only files whose text names
 * `provider-loader` are parsed.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as installed from "@libredb/provider-loader";
import * as source from "@/lib/provider-loader/index.cjs";
import { isSourcePath, moduleSpecifiers } from "../db/provider-imports/scan";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const NAME = "@libredb/provider-loader";
const SOURCE_DIR = path.join(ROOT, "src", "lib", "provider-loader");
const INSTALLED_DIR = path.join(ROOT, "node_modules", "@libredb", "provider-loader");
const REINSTALL = "the installed provider loader differs from src/lib/provider-loader: run bun install";
const LOADER_DIRECTORY = "src/lib/provider-loader";
/** The directories whose code could import the loader. */
const SCANNED_ROOTS = [
  "src",
  "bin",
  "scripts",
  "tests",
  "e2e",
  "vscode-extension/src",
  "vscode-extension/test",
  "packages",
];
/** The loader's own tests, which import its source path so that its lines are measured. */
const OWN_TESTS = "tests/unit/lib/provider-loader/";

interface SourceText {
  readonly path: string;
  readonly text: string;
}

/** Every source file under the scanned roots whose text names the loader, as repository-relative POSIX paths. */
function filesNamingTheLoader(): SourceText[] {
  return SCANNED_ROOTS.filter((root) => existsSync(path.join(ROOT, root)))
    .flatMap((root) => readdirSync(path.join(ROOT, root), { recursive: true, withFileTypes: true }))
    .filter((item) => item.isFile() && isSourcePath(item.name))
    .map((item) => path.relative(ROOT, path.join(item.parentPath, item.name)).split(path.sep).join("/"))
    .filter((file) => !file.split("/").includes("node_modules"))
    .map((file) => ({ path: file, text: readFileSync(path.join(ROOT, file), "utf8") }))
    .filter((file) => file.text.includes("provider-loader"));
}

/** Each import of the loader's source by path, outside the loader's own tests, named by file and specifier. */
function sourcePathImports(files: readonly SourceText[]): string[] {
  const failures: string[] = [];
  for (const file of files) {
    if (file.path.startsWith(OWN_TESTS)) continue;
    for (const specifier of moduleSpecifiers(file.text)) {
      let target: string;
      if (specifier.startsWith("@/")) target = path.posix.join("src", specifier.slice(2));
      else if (specifier.startsWith(".")) target = path.posix.join(path.posix.dirname(file.path), specifier);
      else continue;
      if (target === LOADER_DIRECTORY || target.startsWith(`${LOADER_DIRECTORY}/`)) {
        failures.push(`${file.path} imports "${specifier}", the loader's source: import "${NAME}" instead`);
      }
    }
  }
  return failures;
}

/** The files of a directory, as sorted paths relative to it. */
function filesOf(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile())
    .map((item) => path.relative(directory, path.join(item.parentPath, item.name)))
    .sort();
}

/** The export names of a module namespace, without the default an import of CommonJS adds. */
function exportNames(namespace: object): string[] {
  return Object.keys(namespace)
    .filter((name) => name !== "default")
    .sort();
}

describe("the provider loader is installed as a directory and reached by its name", () => {
  test("the root installs the loader as a file: dependency, a directory under node_modules and never a link, because Turbopack bundles a linked package", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(manifest.devDependencies[NAME]).toBe("file:./src/lib/provider-loader");

    const entry = lstatSync(INSTALLED_DIR);
    expect(entry.isSymbolicLink()).toBe(false);
    expect(entry.isDirectory()).toBe(true);
    expect((JSON.parse(readFileSync(path.join(INSTALLED_DIR, "package.json"), "utf8")) as { name: string }).name).toBe(
      NAME,
    );
  });

  test("the installed loader is its source, file for file and byte for byte", () => {
    const files = filesOf(SOURCE_DIR);
    expect(files.length).toBeGreaterThan(0);

    expect(filesOf(INSTALLED_DIR), REINSTALL).toEqual(files);
    for (const file of files) {
      const same = readFileSync(path.join(INSTALLED_DIR, file)).equals(readFileSync(path.join(SOURCE_DIR, file)));
      expect(same, `${file}: ${REINSTALL}`).toBe(true);
    }
    expect(exportNames(installed), REINSTALL).toEqual(exportNames(source));
  });

  test("the loader is listed in serverExternalPackages, so Next.js leaves it to Node's require and every bundle of a server shares one module", () => {
    const nextConfig = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
    const externals = /serverExternalPackages:\s*\[([^\]]*)\]/.exec(nextConfig)?.[1];

    expect(externals).toContain(`"${NAME}"`);
  });

  test("Studio reaches the loader only by its package name, and only the loader's own tests import its source", () => {
    const files = filesNamingTheLoader();
    expect(files.map((file) => file.path)).toContain(`${OWN_TESTS}load.test.ts`);

    expect(sourcePathImports(files)).toEqual([]);
  });

  test("the import scan names a planted file that imports the loader's source by path", () => {
    const planted: SourceText[] = [
      { path: "src/app/api/planted/route.ts", text: 'import { loadPackage } from "@/lib/provider-loader/index.cjs";' },
      { path: "src/lib/planted.ts", text: 'const loader = require("./provider-loader");' },
      { path: "src/instrumentation.ts", text: 'const loader = await import("./lib/provider-loader/index.cjs");' },
      { path: "src/lib/by-name.ts", text: `import { admitted } from "${NAME}";` },
      { path: "src/lib/comment.ts", text: '// "@/lib/provider-loader" is named in a comment, never imported.' },
      { path: "src/lib/other.ts", text: 'import { other } from "@/lib/provider-loader-notes";' },
      { path: `${OWN_TESTS}planted.test.ts`, text: 'import * as loader from "@/lib/provider-loader/index.cjs";' },
    ];

    expect(sourcePathImports(planted)).toEqual([
      `src/app/api/planted/route.ts imports "@/lib/provider-loader/index.cjs", the loader's source: import "${NAME}" instead`,
      `src/lib/planted.ts imports "./provider-loader", the loader's source: import "${NAME}" instead`,
      `src/instrumentation.ts imports "./lib/provider-loader/index.cjs", the loader's source: import "${NAME}" instead`,
    ]);
  });
});

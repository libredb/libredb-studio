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
 */
import { describe, expect, test } from "bun:test";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as installed from "@libredb/provider-loader";
import * as source from "@/lib/provider-loader/index.cjs";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const NAME = "@libredb/provider-loader";
const SOURCE_DIR = path.join(ROOT, "src", "lib", "provider-loader");
const INSTALLED_DIR = path.join(ROOT, "node_modules", "@libredb", "provider-loader");
const REINSTALL = "the installed provider loader differs from src/lib/provider-loader: run bun install";

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
});

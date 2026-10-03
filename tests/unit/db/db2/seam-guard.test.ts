/**
 * The Db2 driver seam (#786): `db2-node` is named by one file under `src/`, and loaded there only
 * through a dynamic import inside a function.
 *
 * The package carries eight prebuilt native addons, and a module-scope import would load one into
 * every process that touches the provider registry. It is also the one place a deployment without
 * the driver is told so, and the one place the package's own types are kept out of the provider:
 * `driver.ts` declares the narrow shape the rest of the provider reads, and leaves out the three
 * options db2-node 1.0.22 mishandles.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SRC = join(ROOT, "src");
const DRIVER_FILE = join(SRC, "lib", "db", "providers", "sql", "db2", "driver.ts");

/** Every TypeScript source under `src/`. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** An import, a require or a dynamic import of the package, as code rather than prose. */
const IMPORTS_DRIVER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']db2-node["']/;

describe("the db2-node seam", () => {
  test("only driver.ts imports db2-node anywhere under src/", () => {
    const importers = sources(SRC)
      .filter((file) => IMPORTS_DRIVER.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file).split(sep).join("/"));

    expect(importers).toEqual(["src/lib/db/providers/sql/db2/driver.ts"]);
  });

  test("the import is the default of the loader, never at module scope", () => {
    const source = readFileSync(DRIVER_FILE, "utf8");

    expect(source).toContain('= () => import("db2-node") as unknown as Promise<Db2Driver>');
    expect(source).not.toMatch(/^import[^;]*["']db2-node["']/m);
  });

  test("the detector sees every spelling of an import and ignores the name in prose", () => {
    expect(IMPORTS_DRIVER.test('import db2 from "db2-node";')).toBe(true);
    expect(IMPORTS_DRIVER.test("const m = await import('db2-node');")).toBe(true);
    expect(IMPORTS_DRIVER.test('require("db2-node")')).toBe(true);
    expect(IMPORTS_DRIVER.test("the db2-node driver is not installed")).toBe(false);
  });

  test("the client options type leaves out queryTimeout, currentSchema and securityMechanism (M4, M6, K11)", () => {
    const source = readFileSync(DRIVER_FILE, "utf8");
    const options = source.slice(
      source.indexOf("export interface Db2ClientOptions"),
      source.indexOf("export interface Db2Client {"),
    );

    expect(options).not.toMatch(/^\s+queryTimeout\??:/m);
    expect(options).not.toMatch(/^\s+currentSchema\??:/m);
    expect(options).not.toMatch(/^\s+securityMechanism\??:/m);
  });
});

describe("loadDb2Driver", () => {
  test("a resolution failure naming the package is reported as the driver's absence", async () => {
    const { loadDb2Driver } = await import("@/lib/db/providers/sql/db2/driver");
    const missing = Object.assign(new Error("Cannot find module 'db2-node' from '/app/server.js'"), {
      code: "MODULE_NOT_FOUND",
    });

    await expect(loadDb2Driver(async () => Promise.reject(missing))).rejects.toThrow(
      "Db2 is not available in this deployment: the db2-node driver is not installed. Install it, or use an image that ships it, to open Db2 connections.",
    );
  });

  test("any other failure is re-raised untouched", async () => {
    const { loadDb2Driver, describeDriverAbsence } = await import("@/lib/db/providers/sql/db2/driver");
    const corrupt = new Error("invalid ELF header");
    const otherModule = Object.assign(new Error("Cannot find module 'left-pad'"), { code: "MODULE_NOT_FOUND" });

    await expect(loadDb2Driver(async () => Promise.reject(corrupt))).rejects.toBe(corrupt);
    expect(describeDriverAbsence(otherModule)).toBeNull();
    expect(describeDriverAbsence("db2-node")).toBeNull();
    expect(
      describeDriverAbsence(Object.assign(new Error("db2-node"), { code: "ERR_MODULE_NOT_FOUND" })),
    ).not.toBeNull();
  });

  test("the real package loads and exposes a Client", async () => {
    const { loadDb2Driver } = await import("@/lib/db/providers/sql/db2/driver");
    const driver = await loadDb2Driver();

    expect(typeof driver.Client).toBe("function");
  });
});

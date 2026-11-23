/**
 * The host core's boundary (docs/ARCHITECTURE.md, "The provider host core"): every file under
 * `src/lib/provider-host/core/` imports only a public subpath of `@libredb/provider-sdk` other than `testing`, a `node:`
 * built-in, or a file of core itself, and declares no module state.
 *
 * The import rule keeps core free of every Studio module, so a later process-wide instance shared by two Next.js bundles
 * never constructs one bundle's class for the other. The state rule keeps every table core uses owned by whoever creates
 * it: a top-level `let` or `var`, or a top-level `Map`, `Set`, `WeakMap` or `WeakSet`, would be state of the module
 * copy each bundle loads.
 *
 * Specifiers are read with the scanner of `tests/unit/lib/db/provider-imports/scan.ts` (the TypeScript compiler's
 * `preProcessFile`), so a path in a comment or a string is never one. Paths are compared through `path.join` and
 * `path.relative`, so the rule reads the same on Windows.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { isSourcePath, moduleSpecifiers } from "../db/provider-imports/scan";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const CORE_DIRECTORY = path.join(REPOSITORY_ROOT, "src", "lib", "provider-host", "core");
const SDK_PREFIX = "@libredb/provider-sdk/";
/** The SDK's test entry, which no runtime file imports (docs/providers/CONTRACT.md, clause C-18). */
const SDK_TESTING = "@libredb/provider-sdk/testing";
/** The constructors whose instance at module scope would be a table every caller of the module copy shares. */
const TABLE_CONSTRUCTORS: ReadonlySet<string> = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

interface CoreFile {
  /** The absolute path. */
  readonly file: string;
  readonly text: string;
}

/** Every source file under `directory`, at any depth. */
function sourceFiles(directory: string): CoreFile[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter(isSourcePath)
    .map((name) => path.join(directory, name))
    .map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

/** Whether `specifier`, imported by `file`, stays in `core`: a relative path that resolves inside it. */
function staysInCore(core: string, file: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const relative = path.relative(core, path.join(path.dirname(file), specifier));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Whether core may import `specifier` from `file`. */
function allowedImport(core: string, file: string, specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  if (specifier.startsWith(SDK_PREFIX)) return specifier !== SDK_TESTING && !specifier.startsWith(`${SDK_TESTING}/`);
  return staysInCore(core, file, specifier);
}

/** One refusal per import core may not hold, naming the file relative to `root` and the specifier. */
function importRefusals(root: string, core: string, files: readonly CoreFile[]): string[] {
  return files.flatMap(({ file, text }) =>
    moduleSpecifiers(text)
      .filter((specifier) => !allowedImport(core, file, specifier))
      .map((specifier) => `${path.relative(root, file)} imports "${specifier}"`),
  );
}

/** Whether `node` creates one of the table constructors without entering a function body. */
function createsTable(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && TABLE_CONSTRUCTORS.has(node.expression.text)) {
    return true;
  }
  return ts.forEachChild(node, (child) => (createsTable(child) ? true : undefined)) === true;
}

/** One refusal per module-level `let`, `var` or table, naming the file relative to `root` and the declaration. */
function moduleStateRefusals(root: string, files: readonly CoreFile[]): string[] {
  return files.flatMap(({ file, text }) => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    return source.statements.flatMap((statement) => {
      if (!ts.isVariableStatement(statement)) return [];
      const list = statement.declarationList;
      const mutable = (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== ts.NodeFlags.Const;
      return list.declarations
        .filter(
          (declaration) => mutable || (declaration.initializer !== undefined && createsTable(declaration.initializer)),
        )
        .map(
          (declaration) => `${path.relative(root, file)} declares module state "${declaration.name.getText(source)}"`,
        );
    });
  });
}

const planted: string[] = [];
afterAll(() => {
  for (const directory of planted) rmSync(directory, { recursive: true, force: true });
});

/** A planted repository holding `core/<name>` with `text`, and the core directory and files it answers. */
function plantCore(name: string, text: string): { root: string; core: string; files: CoreFile[] } {
  const root = mkdtempSync(path.join(tmpdir(), "core-boundary-"));
  planted.push(root);
  const core = path.join(root, "core");
  mkdirSync(path.join(core, "nested"), { recursive: true });
  writeFileSync(path.join(core, name), text);
  return { root, core, files: sourceFiles(core) };
}

describe("the host core's boundary", () => {
  const files = sourceFiles(CORE_DIRECTORY);

  test("the host core imports only the SDK, Node built-ins and itself", () => {
    expect(files.map(({ file }) => path.relative(CORE_DIRECTORY, file)).sort()).toEqual([
      "console.ts",
      "open-once.ts",
      "teardown.ts",
      "turns.ts",
    ]);
    expect(importRefusals(REPOSITORY_ROOT, CORE_DIRECTORY, files)).toEqual([]);
  });

  test("a planted import outside the SDK, Node and core is refused naming the file", () => {
    const {
      root,
      core,
      files: plantedFiles,
    } = plantCore(
      path.join("nested", "planted.ts"),
      [
        'import { logger } from "@/lib/logger";',
        'import { within } from "../../factory";',
        'import { memoryTransport } from "@libredb/provider-sdk/testing";',
        'import { validate } from "@libredb/provider-sdk";',
        'import { awaitWithin } from "@libredb/provider-sdk/calls";',
        'import { setTimeout } from "node:timers/promises";',
        'import { sibling } from "../sibling";',
        'import { here } from "./here";',
        "// a comment naming import('@/lib/other') is never an import",
        "",
      ].join("\n"),
    );
    const named = path.join("core", "nested", "planted.ts");
    expect(importRefusals(root, core, plantedFiles)).toEqual([
      `${named} imports "@/lib/logger"`,
      `${named} imports "../../factory"`,
      `${named} imports "@libredb/provider-sdk/testing"`,
      `${named} imports "@libredb/provider-sdk"`,
    ]);
  });

  test("the host core keeps no module state", () => {
    expect(moduleStateRefusals(REPOSITORY_ROOT, files)).toEqual([]);
  });

  test("a planted module-level table in core is refused naming the file", () => {
    const { root, files: plantedFiles } = plantCore(
      "planted.ts",
      [
        "let opens = 0;",
        "var closes = 0;",
        "const flights = new Map<string, Promise<void>>();",
        "const seen = Object.freeze(new WeakSet<object>());",
        "const LIMIT = 5;",
        "const make = () => new Map<string, number>();",
        "export function table() { const local = new Set<string>(); let count = 0; return { local, count }; }",
        "",
      ].join("\n"),
    );
    const named = path.join("core", "planted.ts");
    expect(moduleStateRefusals(root, plantedFiles)).toEqual([
      `${named} declares module state "opens"`,
      `${named} declares module state "closes"`,
      `${named} declares module state "flights"`,
      `${named} declares module state "seen"`,
    ]);
  });
});

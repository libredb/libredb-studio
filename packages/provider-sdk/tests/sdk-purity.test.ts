/**
 * The SDK keeps no process-global state and reads nothing from the process (docs/providers/CONTRACT.md, clause M-19).
 *
 * The SDK is loaded into Studio's process once and shared by every provider, so a module-level variable, a
 * module-level collection or a read of `process` would be state one provider leaves for the next, or a setting no
 * manifest declares. The TypeScript compiler reads each of the SDK's own source files; nothing is run.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { compileManifestValidator } from "@libredb/provider-sdk/manifest";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..");

interface SourceText {
  readonly path: string;
  readonly text: string;
}

type ImpurityKind = "top-level let or var" | "top-level collection" | "top-level typed array" | "process reference";

interface Impurity {
  readonly file: string;
  readonly kind: ImpurityKind;
  /** The declared name, for a top-level typed array: each one is listed by file and name. */
  readonly name?: string;
}

const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

const TYPED_ARRAYS = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/** Whether `initializer` builds a typed array: `new Uint8Array(...)`, `Uint8Array.from(...)` or `Uint8Array.of(...)`. */
function buildsTypedArray(initializer: ts.Expression, source: ts.SourceFile): boolean {
  if (ts.isNewExpression(initializer)) return TYPED_ARRAYS.has(initializer.expression.getText(source));
  if (!ts.isCallExpression(initializer) || !ts.isPropertyAccessExpression(initializer.expression)) return false;
  const access = initializer.expression;
  return ["from", "of"].includes(access.name.text) && TYPED_ARRAYS.has(access.expression.getText(source));
}

/** Every `.ts` file under `directory`, as package-relative POSIX paths, sorted. */
function sourceFiles(directory: string): SourceText[] {
  return readdirSync(path.join(PACKAGE_ROOT, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.relative(PACKAGE_ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort()
    .map((file) => ({ path: file, text: readFileSync(path.join(PACKAGE_ROOT, file), "utf8") }));
}

/** Whether `node` reads the identifier `process` as a value, rather than naming a property or a member called that. */
function readsProcess(node: ts.Node): boolean {
  if (!ts.isIdentifier(node) || node.text !== "process") return false;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (
    (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return true;
}

/** The impurities of each file, in file order and then source order. */
function impurities(files: readonly SourceText[]): Impurity[] {
  const found: Impurity[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const flags = statement.declarationList.flags;
      if ((flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using)) === 0 || flags & ts.NodeFlags.Let) {
        found.push({ file: file.path, kind: "top-level let or var" });
      }
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (initializer && ts.isNewExpression(initializer) && COLLECTIONS.has(initializer.expression.getText(source))) {
          found.push({ file: file.path, kind: "top-level collection" });
        }
        if (initializer && buildsTypedArray(initializer, source)) {
          found.push({ file: file.path, kind: "top-level typed array", name: declaration.name.getText(source) });
        }
      }
    }
    const visit = (node: ts.Node): void => {
      if (readsProcess(node)) found.push({ file: file.path, kind: "process reference" });
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        if (["process", "node:process"].includes(node.moduleSpecifier.text)) {
          found.push({ file: file.path, kind: "process reference" });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe("the SDK keeps no process-global state", () => {
  const files = sourceFiles("src");

  test("the scan reads the SDK's source", () => {
    expect(files.map((file) => file.path)).toContain("src/manifest/validate.ts");
  });

  test("SDK source declares no top-level let or var", () => {
    expect(impurities(files).filter((item) => item.kind === "top-level let or var")).toEqual([]);
  });

  test("SDK source creates no top-level Map, Set, WeakMap or WeakSet", () => {
    expect(impurities(files).filter((item) => item.kind === "top-level collection")).toEqual([]);
  });

  test("SDK source's module-level typed arrays are the codec's lookup tables and its encode buffer", () => {
    // Each is listed by file and name, so a new one fails here by name. The two lookup tables are written once, at
    // load, and never again. The encode buffer is overwritten by every call before that call reads it, synchronously,
    // so no call reads what another left: it holds nothing between calls (clause M-19).
    expect(impurities(files).filter((item) => item.kind === "top-level typed array")).toEqual([
      { file: "src/values/codec.ts", kind: "top-level typed array", name: "BASE64_VALUES" },
      { file: "src/values/codec.ts", kind: "top-level typed array", name: "BASE64_CODES" },
      { file: "src/values/codec.ts", kind: "top-level typed array", name: "ASCII_CHUNK" },
    ]);
  });

  test("SDK source never reads process", () => {
    expect(impurities(files).filter((item) => item.kind === "process reference")).toEqual([]);
  });

  test("each impurity is reported by kind and file in planted source", () => {
    const planted: SourceText[] = [
      { path: "src/a.ts", text: "let count = 0;\nvar total = 1;\nexport const ok = 1;\n" },
      { path: "src/b.ts", text: "const cache = new Map<string, number>();\nexport const seen = new WeakSet();\n" },
      { path: "src/c.ts", text: "export const home = process.env.HOME;\n" },
      { path: "src/d.ts", text: 'import { env } from "node:process";\nexport const value = env;\n' },
      {
        path: "src/e.ts",
        text: "const cache = new Uint8Array(8);\nexport const table = Int8Array.from([1]);\nconst list = Array.from([1]);\n",
      },
      {
        path: "src/clean.ts",
        text: "export function make() {\n  let n = 0;\n  const m = new Map();\n  const b = new Uint8Array(1);\n  return { n, m, b, process: 1, a: holder.process };\n}\ndeclare const holder: { process: number };\n",
      },
    ];

    expect(impurities(planted)).toEqual([
      { file: "src/a.ts", kind: "top-level let or var" },
      { file: "src/a.ts", kind: "top-level let or var" },
      { file: "src/b.ts", kind: "top-level collection" },
      { file: "src/b.ts", kind: "top-level collection" },
      { file: "src/c.ts", kind: "process reference" },
      { file: "src/d.ts", kind: "process reference" },
      { file: "src/e.ts", kind: "top-level typed array", name: "cache" },
      { file: "src/e.ts", kind: "top-level typed array", name: "table" },
    ]);
  });

  test("two validators compiled from the same bytes are independent objects", () => {
    const bytes = readFileSync(path.join(PACKAGE_ROOT, "src/manifest/manifest.schema.json"));
    const first = compileManifestValidator(bytes);
    const second = compileManifestValidator(bytes);

    expect(first).not.toBe(second);
    expect(first.validate).not.toBe(second.validate);
  });
});

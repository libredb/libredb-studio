/**
 * Every policy and MCP claim record Studio keeps in core is read only by Studio's grant reader,
 * `src/lib/db/claim-grants.ts` (docs/providers/CONTRACT.md, clauses M-54 and M-82): every gate reads the grant, the
 * more restrictive of the engine's request and the record, so a gate that read a record again would read a claim no
 * grant covers once a loader admits a package's declaration.
 *
 * The scan parses every `.ts` and `.tsx` file under Studio's `src/` and the VS Code extension's `src/` with the
 * TypeScript compiler (a `.tsx` file as TSX) and finds each reference to a record: an import or re-export specifier
 * naming it from its module, an `export *` of its module, a property access or a string-literal element access naming
 * it on a namespace import of its module or on a dynamic import or require of it, a destructuring of such an import or
 * require, and, inside the record's own module, any use of its name but the declaration. A module specifier names a
 * record module when it resolves to it, written relative to the importing file or through the `@/` alias for `src/`.
 * An object literal key, a type member key, a property of another object and a string such as an error code are not
 * references, and a comment is trivia the parser attaches to no node, so the record's name in either is passed over.
 * `STUDIO_CLAIM_RECORDS`, the records as the grant reader hands them to `grantClaims`, is held the same way, so no
 * module reads the records through it either.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../../..");

/** The grant reader: the one module that may read a claim record. */
const GRANT_READER = "src/lib/db/claim-grants.ts";

/** Each module holding a policy or MCP claim record, without its extension, and the records it holds. */
const CLAIM_RECORD_MODULES: Readonly<Record<string, readonly string[]>> = {
  "src/lib/db/compatibility": [
    "WRITE_REACH",
    "READS_FILE_ACCESS_POSTURE",
    "REFUSES_DENIED_FILE_ACCESS",
    "SINGLE_WRITER_FILE",
    "READ_ROOTS_REQUIRED",
    "MASKING_EXEMPT_COLUMNS",
    "MCP_EXPOSABLE",
    "MCP_STATEMENT_READ",
    "MCP_METADATA_READ_CHANGES_STATE",
    "MCP_AGENT_CREDENTIAL_REQUIRED",
  ],
  "src/lib/db/connection-fields": ["AGENT_CREDENTIAL_FORM"],
  "src/lib/db/claim-grants": ["STUDIO_CLAIM_RECORDS"],
};

interface SourceText {
  readonly path: string;
  readonly text: string;
}

/** The repository path, without extension, that `specifier` written in `file` resolves to, or null for a package. */
function resolvedModule(file: string, specifier: string): string | null {
  const written = specifier.replace(/\.(c|m)?(t|j)sx?$/, "");
  if (written.startsWith("@/")) return `src/${written.slice(2)}`;
  if (written.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(file), written));
  return null;
}

/** The records the module `module` (a repository path without extension) holds, or none. */
function recordsOf(module: string | null): readonly string[] {
  return module !== null && Object.hasOwn(CLAIM_RECORD_MODULES, module) ? (CLAIM_RECORD_MODULES[module] ?? []) : [];
}

/** `node` seen through parentheses, `await`, `as` and non-null assertions. */
function unwrapped(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAwaitExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The records of the module a dynamic `import()` or `require()` call loads, or none for any other expression. */
function loadedRecords(file: string, node: ts.Expression): readonly string[] {
  const call = unwrapped(node);
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) return [];
  const loads =
    call.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(call.expression) && call.expression.text === "require");
  const argument = call.arguments[0];
  if (!loads || argument === undefined || !ts.isStringLiteralLike(argument)) return [];
  return recordsOf(resolvedModule(file, argument.text));
}

/** Whether `node`, an identifier, is a key or a member name rather than a reference to a binding. */
function isKeyOrMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent)) &&
      parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  );
}

/** Each reference `file` makes to a claim record, as `<file> reads <record>`. */
function recordReferences(file: SourceText): string[] {
  const source = ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const own = recordsOf(file.path.replace(/\.tsx?$/, ""));
  const namespaces = new Map<string, readonly string[]>();
  const found = new Set<string>();
  const read = (record: string) => found.add(`${file.path} reads ${record}`);
  const readNamed = (records: readonly string[], name: string) => {
    if (records.includes(name)) read(name);
  };

  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const records = recordsOf(resolvedModule(file.path, node.moduleSpecifier.text));
      const bindings = node.importClause?.namedBindings;
      if (records.length > 0 && bindings !== undefined) {
        if (ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, records);
        else for (const element of bindings.elements) readNamed(records, (element.propertyName ?? element.name).text);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const records = recordsOf(resolvedModule(file.path, node.moduleSpecifier.text));
      if (node.exportClause === undefined) for (const record of records) read(record);
      else if (ts.isNamespaceExport(node.exportClause)) for (const record of records) read(record);
      else
        for (const element of node.exportClause.elements)
          readNamed(records, (element.propertyName ?? element.name).text);
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const records = loadedRecords(file.path, node.initializer);
      if (records.length > 0 && ts.isIdentifier(node.name)) namespaces.set(node.name.text, records);
      if (records.length > 0 && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (ts.isIdentifier(key) || ts.isStringLiteral(key)) readNamed(records, key.text);
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  /** The records of the namespace or loaded module `expression` names, or none. */
  const namespaceRecords = (expression: ts.Expression): readonly string[] => {
    const target = unwrapped(expression);
    if (ts.isIdentifier(target)) return namespaces.get(target.text) ?? [];
    return loadedRecords(file.path, target);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      readNamed(namespaceRecords(node.expression), node.name.text);
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      readNamed(namespaceRecords(node.expression), node.argumentExpression.text);
    } else if (ts.isIdentifier(node) && own.includes(node.text) && !isKeyOrMemberName(node)) {
      const declared = ts.isVariableDeclaration(node.parent) && node.parent.name === node;
      if (!declared) read(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found];
}

/** Every `.ts` and `.tsx` file under `directory`, a repository path, read as text. */
function sourceFiles(directory: string): SourceText[] {
  return readdirSync(path.join(ROOT, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort()
    .map((file) => ({ path: file, text: readFileSync(path.join(ROOT, file), "utf8") }));
}

/** Each reference to a claim record in `files` that the grant reader does not make. */
function recordReaders(files: readonly SourceText[]): string[] {
  return files.filter((file) => file.path !== GRANT_READER).flatMap(recordReferences);
}

describe("the claim record readers", () => {
  test("every policy and MCP claim record is read only by the grant reader", () => {
    const files = [...sourceFiles("src"), ...sourceFiles("vscode-extension/src")];

    expect(recordReaders(files)).toEqual([]);
    // Vacuity: the scan reads both trees, and finds the grant reader's own reads of every record, its own
    // STUDIO_CLAIM_RECORDS among them.
    expect(files.some((file) => file.path.startsWith("vscode-extension/src/"))).toBe(true);
    const grantReader = files.find((file) => file.path === GRANT_READER);
    if (grantReader === undefined) throw new Error(`${GRANT_READER} is not in the source read`);
    expect(recordReferences(grantReader).sort()).toEqual(
      [...(CLAIM_RECORD_MODULES["src/lib/db/compatibility"] ?? []), "AGENT_CREDENTIAL_FORM", "STUDIO_CLAIM_RECORDS"]
        .map((record) => `${GRANT_READER} reads ${record}`)
        .sort(),
    );
  }, 60_000);

  test("the scan finds each way a module could reference a claim record, and passes over an error code and an object key of the same name", () => {
    const planted = (file: string, text: string) => recordReaders([{ path: file, text }]);

    expect(planted("src/lib/a.ts", 'import { WRITE_REACH } from "@/lib/db/compatibility";')).toEqual([
      "src/lib/a.ts reads WRITE_REACH",
    ]);
    expect(planted("src/lib/db/a.ts", 'import { SINGLE_WRITER_FILE as single } from "./compatibility";')).toEqual([
      "src/lib/db/a.ts reads SINGLE_WRITER_FILE",
    ]);
    expect(planted("src/lib/mcp/a.ts", 'export { MCP_EXPOSABLE } from "../db/compatibility.ts";')).toEqual([
      "src/lib/mcp/a.ts reads MCP_EXPOSABLE",
    ]);
    expect(planted("src/lib/a.ts", 'export * from "@/lib/db/connection-fields";')).toEqual([
      "src/lib/a.ts reads AGENT_CREDENTIAL_FORM",
    ]);
    expect(
      planted("src/lib/a.ts", 'import * as records from "@/lib/db/compatibility";\nrecords.READ_ROOTS_REQUIRED.opcua;'),
    ).toEqual(["src/lib/a.ts reads READ_ROOTS_REQUIRED"]);
    expect(
      planted("src/lib/a.tsx", 'import * as records from "@/lib/db/compatibility";\nrecords["MCP_STATEMENT_READ"];'),
    ).toEqual(["src/lib/a.tsx reads MCP_STATEMENT_READ"]);
    expect(planted("src/lib/a.ts", 'const reach = (await import("@/lib/db/compatibility")).WRITE_REACH;')).toEqual([
      "src/lib/a.ts reads WRITE_REACH",
    ]);
    expect(
      planted("src/lib/a.ts", 'const records = await import("@/lib/db/compatibility");\nrecords.WRITE_REACH;'),
    ).toEqual(["src/lib/a.ts reads WRITE_REACH"]);
    expect(planted("src/lib/db/a.ts", 'const { MASKING_EXEMPT_COLUMNS: m } = require("./compatibility");')).toEqual([
      "src/lib/db/a.ts reads MASKING_EXEMPT_COLUMNS",
    ]);
    expect(
      planted(
        "vscode-extension/src/backend/a.ts",
        'import { MCP_METADATA_READ_CHANGES_STATE } from "@/lib/db/compatibility";',
      ),
    ).toEqual(["vscode-extension/src/backend/a.ts reads MCP_METADATA_READ_CHANGES_STATE"]);
    expect(planted("src/lib/a.ts", 'import { STUDIO_CLAIM_RECORDS } from "@/lib/db/claim-grants";')).toEqual([
      "src/lib/a.ts reads STUDIO_CLAIM_RECORDS",
    ]);
    expect(
      planted(
        "src/lib/db/compatibility.ts",
        "export const WRITE_REACH = Object.freeze({});\nexport const OPEN = Object.keys(WRITE_REACH);",
      ),
    ).toEqual(["src/lib/db/compatibility.ts reads WRITE_REACH"]);

    // Not references: the record's own declaration, an error code, an object key, a type member key, a property of
    // another object, a comment, another name of the record module, and the grant reader itself.
    expect(planted("src/lib/db/compatibility.ts", "export const WRITE_REACH = Object.freeze({});")).toEqual([]);
    expect(
      planted(
        "src/lib/db/error-record.ts",
        [
          'throw new ExecutionProfileError(sentence, "READ_ROOTS_REQUIRED");',
          "const codes = { READ_ROOTS_REQUIRED: true };",
          "type Codes = { READ_ROOTS_REQUIRED: boolean };",
          "codes.READ_ROOTS_REQUIRED;",
          "// WRITE_REACH, read from compatibility.ts",
          'import { OPENS_LOCAL_FILE } from "@/lib/db/compatibility";',
          'import { WRITE_REACH } from "@/lib/db/write-reach-elsewhere";',
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(planted(GRANT_READER, 'import { WRITE_REACH } from "./compatibility";')).toEqual([]);
  });
});

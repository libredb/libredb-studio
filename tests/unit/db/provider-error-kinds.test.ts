/**
 * A provider raises only the kinds a provider may raise, and never marks an error not-sent itself
 * (docs/providers/CONTRACT.md, clauses E-1 and E-5).
 *
 * `PROVIDER_ERROR_KINDS` and `CORE_ERROR_KINDS` in `@libredb/provider-sdk/errors` partition the record's kinds. Every
 * error class `src/lib/db/errors.ts` exports takes a kind of one of them, so a class of a core kind is one only core
 * constructs. Provider code, `src/lib/db/providers/` and every `packages/provider-*\/src/`, constructs and extends none
 * of those classes, through an import alias or a namespace import included, and assigns no property named `outcome`:
 * a provider claims not-sent only by raising `refused-before-send`, whose constructor writes it.
 *
 * The scans read the TypeScript syntax tree, so a comment naming a class is never a finding, and a finding names its
 * file and innermost named declaration, never a line. Only the files whose text names what a scan looks for are parsed.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CORE_ERROR_KINDS, type ErrorKind, PROVIDER_ERROR_KINDS } from "@libredb/provider-sdk/errors";
import { errorKind } from "@/lib/db/error-record";
import * as errorClasses from "@/lib/db/errors";

const ROOT = path.resolve(import.meta.dir, "../../..");

interface SourceText {
  readonly path: string;
  readonly text: string;
}

interface Finding {
  readonly file: string;
  readonly declaration: string;
  readonly what: string;
}

/** Every class `src/lib/db/errors.ts` exports, by name, with the kind an instance of it takes. */
function declaredClasses(): { readonly name: string; readonly kind: ErrorKind }[] {
  const exported: Record<string, unknown> = errorClasses;
  return Object.entries(exported).flatMap(([name, value]) =>
    typeof value === "function" && value.prototype instanceof Error
      ? [{ name, kind: errorKind(Object.create(value.prototype as object)) }]
      : [],
  );
}

/** Every `.ts` file under `directory`, as repository-relative POSIX paths, sorted. */
function tsFiles(directory: string): string[] {
  return readdirSync(path.join(ROOT, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

/** Provider code: the legacy provider tree and the source of every provider package. */
function providerFiles(): string[] {
  const packages = readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("provider-"))
    .map((entry) => `packages/${entry.name}/src`);
  return [path.join("src", "lib", "db", "providers"), ...packages].flatMap(tsFiles);
}

/** The provider files whose text holds any of `words`, read once each. */
function providerSources(words: readonly string[]): SourceText[] {
  return providerFiles()
    .map((file) => ({ path: file, text: readFileSync(path.join(ROOT, file), "utf8") }))
    .filter((file) => words.some((word) => file.text.includes(word)));
}

/** The name of the innermost named declaration around `node`, or `<module>`. */
function enclosingDeclaration(node: ts.Node): string {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isClassDeclaration(current) ||
        ts.isVariableDeclaration(current) ||
        ts.isPropertyDeclaration(current)) &&
      current.name !== undefined
    ) {
      return current.name.getText();
    }
    if (ts.isConstructorDeclaration(current)) return "constructor";
  }
  return "<module>";
}

function parse(file: SourceText): ts.SourceFile {
  // The script kind the extension names, so a `.ts` file's `<T>` reads as a type and never as a JSX tag.
  const kind = file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, kind);
}

/**
 * Every `new C(...)` and `extends C` in `files` whose `C` is one of `classes`: by its own name, by a local name an
 * import gives it (`import { C as D }`), or as a member of a namespace import (`errors.C`).
 */
function constructionsOf(files: readonly SourceText[], classes: readonly string[]): Finding[] {
  const found: Finding[] = [];
  for (const file of files) {
    const source = parse(file);
    const local = new Map<string, string>(classes.map((name) => [name, name]));
    for (const statement of source.statements) {
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (classes.includes(imported)) local.set(element.name.text, imported);
      }
    }
    const named = (expression: ts.Expression): string | undefined => {
      if (ts.isIdentifier(expression)) return local.get(expression.text);
      if (ts.isPropertyAccessExpression(expression) && classes.includes(expression.name.text)) {
        return expression.name.text;
      }
      return undefined;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        const name = named(node.expression);
        if (name !== undefined)
          found.push({ file: file.path, declaration: enclosingDeclaration(node), what: `new ${name}` });
      }
      if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const type of node.types) {
          const name = named(type.expression);
          if (name !== undefined) {
            found.push({ file: file.path, declaration: enclosingDeclaration(node), what: `extends ${name}` });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
]);

/** Every assignment in `files` to a property named `outcome`: `x.outcome = ...` or `x["outcome"] = ...`. */
function outcomeWrites(files: readonly SourceText[]): Finding[] {
  const found: Finding[] = [];
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind)) {
        const target = node.left;
        const writesOutcome =
          (ts.isPropertyAccessExpression(target) && target.name.text === "outcome") ||
          (ts.isElementAccessExpression(target) &&
            ts.isStringLiteralLike(target.argumentExpression) &&
            target.argumentExpression.text === "outcome");
        if (writesOutcome) {
          found.push({ file: file.path, declaration: enclosingDeclaration(node), what: target.getText() });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
  }
  return found;
}

describe("the kinds a provider may raise", () => {
  const classes = declaredClasses();
  const coreKinds: readonly string[] = CORE_ERROR_KINDS;
  const providerKinds: readonly string[] = PROVIDER_ERROR_KINDS;
  const coreClasses = classes.filter((item) => coreKinds.includes(item.kind)).map((item) => item.name);

  test("every error class Studio declares has a kind the contract places", () => {
    expect(classes.length).toBeGreaterThan(0);
    expect(classes.filter((item) => !providerKinds.includes(item.kind) && !coreKinds.includes(item.kind))).toEqual([]);
    expect(classes.filter((item) => item.kind === "internal")).toEqual([]);
    const classKinds = new Set(classes.map((item) => item.kind));
    expect(PROVIDER_ERROR_KINDS.filter((kind) => !classKinds.has(kind))).toEqual([]);
  });

  test("provider code constructs and extends only classes of the kinds a provider may raise", () => {
    expect(coreClasses).toContain("StudioTimeoutRefusal");
    expect(constructionsOf(providerSources(coreClasses), coreClasses)).toEqual([]);
    // The scan reads provider code: a class a provider does raise is found there.
    expect(constructionsOf(providerSources(["TimeoutError"]), ["TimeoutError"]).length).toBeGreaterThan(0);
  });

  test("the scan finds a construction and a subclass through an alias, and not a comment naming one", () => {
    const planted: SourceText[] = [
      {
        path: "src/lib/db/providers/sql/planted.ts",
        text: [
          'import { StudioTimeoutRefusal as Late, QueryError } from "@/lib/db/errors";',
          'import * as errors from "@/lib/db/errors";',
          "// new StudioTimeoutRefusal() is named here only in a comment, as is extends FacetNotOfferedError.",
          "export function read(): never {",
          '  throw new Late("slow", "postgres");',
          "}",
          "export class NotHere extends FacetNotOfferedError {}",
          "export class Shaped extends errors.UnknownProviderError {}",
          'export const fine = new QueryError("bad", "postgres");',
        ].join("\n"),
      },
    ];

    expect(constructionsOf(planted, coreClasses)).toEqual([
      { file: "src/lib/db/providers/sql/planted.ts", declaration: "read", what: "new StudioTimeoutRefusal" },
      { file: "src/lib/db/providers/sql/planted.ts", declaration: "NotHere", what: "extends FacetNotOfferedError" },
      { file: "src/lib/db/providers/sql/planted.ts", declaration: "Shaped", what: "extends UnknownProviderError" },
    ]);
  });
});

describe("who marks an error not-sent", () => {
  test("provider code never writes an error's outcome", () => {
    expect(outcomeWrites(providerSources(["outcome"]))).toEqual([]);
  });

  test("the outcome scan finds an assignment to an outcome, and not a read, a declaration or a comment", () => {
    const planted: SourceText[] = [
      {
        path: "packages/provider-planted/src/connect.ts",
        text: [
          "// error.outcome = 'not-sent' is named here only in a comment.",
          "export function connect(error: { outcome?: string }, other: Record<string, string>): string | undefined {",
          '  error.outcome = "not-sent";',
          '  other["outcome"] ??= "not-sent";',
          "  const outcome = error.outcome;",
          "  const record = { outcome };",
          "  return record.outcome;",
          "}",
        ].join("\n"),
      },
    ];

    expect(outcomeWrites(planted)).toEqual([
      { file: "packages/provider-planted/src/connect.ts", declaration: "connect", what: "error.outcome" },
      { file: "packages/provider-planted/src/connect.ts", declaration: "connect", what: 'other["outcome"]' },
    ]);
  });
});

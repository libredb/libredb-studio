/**
 * The seam around the execution UI registry: its index reads each engine's row from the generated execution UI record
 * (`src/lib/db/engine-catalog/editor.generated.ts`) and imports no provider module, so no engine's code can reach
 * another engine's commit keyword or consent deadline. `shared.ts` reads at most `types`, `explain-request.ts` reads
 * only the default connection type, a leaf that loads nothing at run time, and each module loads in a fresh process on
 * its own.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const REGISTRY = join(ROOT, "src/lib/db/execution-ui");

const TYPES = "@/lib/db/execution-ui/types";

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

interface ImportFact {
  specifier: string;
  typeOnly: boolean;
}

/** Every import, re-export and dynamic import of `source`, each marked whether it loads nothing at run time. */
function importFacts(path: string, source: string): ImportFact[] {
  const file = parse(path, source);
  const found: ImportFact[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    let typeOnly: boolean;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      typeOnly =
        clause?.isTypeOnly === true ||
        (clause !== undefined &&
          clause.name === undefined &&
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly));
    } else {
      typeOnly = statement.isTypeOnly;
    }
    found.push({ specifier: specifier.text, typeOnly });
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push({ specifier: node.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("the execution UI registry", () => {
  test("the index imports no provider module, and reads its rows from the generated execution UI record", () => {
    const path = join(REGISTRY, "index.ts");
    const facts = importFacts(path, readFileSync(path, "utf8"));
    expect(facts.filter(({ specifier }) => specifier.startsWith("@/lib/db/providers/"))).toEqual([]);
    expect(facts).toContainEqual({ specifier: "@/lib/db/engine-catalog/editor.generated", typeOnly: false });
    const generated = join(ROOT, "src/lib/db/engine-catalog/editor.generated.ts");
    expect(importFacts(generated, readFileSync(generated, "utf8")).every(({ typeOnly }) => typeOnly)).toBe(true);
  });

  test("shared.ts imports only the registry's types, or nothing", () => {
    const path = join(REGISTRY, "shared.ts");
    const specifiers = importFacts(path, readFileSync(path, "utf8")).map(({ specifier }) => specifier);
    expect(specifiers.filter((specifier) => specifier !== "./types" && specifier !== TYPES)).toEqual([]);
  });

  test("explain-request.ts imports only the default connection type, which loads nothing at run time", () => {
    const path = join(REGISTRY, "explain-request.ts");
    expect(importFacts(path, readFileSync(path, "utf8"))).toEqual([
      { specifier: "@/lib/db/default-connection-type", typeOnly: false },
    ]);
    const leaf = join(ROOT, "src/lib/db/default-connection-type.ts");
    expect(importFacts(leaf, readFileSync(leaf, "utf8")).every(({ typeOnly }) => typeOnly)).toBe(true);
  });
});

describe("a fresh process loads each module on its own", () => {
  const paths = [join(REGISTRY, "index.ts"), join(REGISTRY, "explain-request.ts")];
  test.each(paths.map((path) => [relative(ROOT, path), path] as const))("%s", (_, path) => {
    const run = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(path)})`], { cwd: ROOT });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });
});

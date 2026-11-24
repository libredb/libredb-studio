/**
 * No module of Studio's source reads an engine declaration (docs/providers/CONTRACT.md, clauses M-52 and M-54).
 *
 * A declaration's `policy` and `mcp` members are claims: requests Studio grants only through its review record of each
 * claim, the table of `src/lib/db/compatibility.ts` every gate reads. A module that read a declaration could hand a
 * request to a gate as if it were granted, so the first change that makes Studio read one meets this test, and with it
 * the rule M-54 states for how a host grants a claim.
 *
 * The scan parses every `.ts` and `.tsx` file under `src/` with the TypeScript compiler (a `.tsx` file as TSX) and
 * fails on each file whose syntax tree holds `engine-declarations`, the directory every import, dynamic import, require
 * or file path a module could read a declaration by names, in a string literal, a template literal with no
 * substitution, or the head, a middle or the tail of a template literal with substitutions. A comment is trivia the
 * parser attaches to no node, so a path written in a comment is passed over whatever its quoting.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../../..");

interface SourceText {
  readonly path: string;
  readonly text: string;
}

/** The declarations' directory name, which every path a module could read a declaration by holds. */
const DECLARATION_DIRECTORY = "engine-declarations";

/** Whether `node` is a string or a template literal part whose text holds the declarations' directory name. */
function namesTheDirectory(node: ts.Node): boolean {
  return (
    (ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)) &&
    node.text.includes(DECLARATION_DIRECTORY)
  );
}

/** Whether the syntax tree of `file` holds a string or a template literal part naming the declarations' directory. */
function readsADeclaration(file: SourceText): boolean {
  const kind = file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false, kind);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (namesTheDirectory(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every `.ts` and `.tsx` file under `src/`, as repository-relative POSIX paths with their text. */
function sourceFiles(): SourceText[] {
  return readdirSync(path.join(ROOT, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort()
    .map((file) => ({ path: file, text: readFileSync(path.join(ROOT, file), "utf8") }));
}

/** Each file of `files` whose code names the declarations' directory, with what that breaks. */
function declarationReaders(files: readonly SourceText[]): string[] {
  return files
    .filter((file) => readsADeclaration(file))
    .map(
      (file) =>
        `${file.path} reads an engine declaration, but a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)`,
    );
}

describe("engine declaration readers", () => {
  // Parsing every file under src/ takes seconds on a CI runner under coverage, past bun's 5 s default, so this test
  // takes the 60 s bound the other whole-tree scans take (tests/unit/lib/agent/language-boundary.test.ts).
  test("no module of Studio's source reads an engine declaration, so a claim reaches a gate only through Studio's review record", () => {
    const files = sourceFiles();

    expect(files.length).toBeGreaterThan(100);
    expect(declarationReaders(files)).toEqual([]);
  }, 60_000);

  test("the scan finds each way a module could read a declaration, and passes over a backticked path in a comment", () => {
    const planted: SourceText[] = [
      { path: "src/lib/static.ts", text: 'import kafka from "@/lib/db/engine-declarations/kafka.json";\n' },
      { path: "src/lib/dynamic.ts", text: "const kafka = await import('./engine-declarations/kafka.json');\n" },
      { path: "src/lib/required.ts", text: 'const kafka = require("../db/engine-declarations/kafka.json");\n' },
      {
        path: "src/lib/read.ts",
        text: 'const kafka = readFileSync(path.join(root, "src/lib/db/engine-declarations", "kafka.json"), "utf8");\n',
      },
      {
        path: "src/lib/commented.ts",
        text: "// The facts are in `src/lib/db/engine-declarations/<type-id>.json`, which no gate reads.\nexport const X = 1;\n",
      },
      {
        path: "src/lib/templated.ts",
        text: "const declaration = await import(`@/lib/db/engine-declarations/${type}.json`);\n",
      },
      {
        path: "src/lib/untemplated.ts",
        text: 'const kafka = readFileSync(`src/lib/db/engine-declarations/kafka.json`, "utf8");\n',
      },
      { path: "src/lib/joined.ts", text: "const directory = path.join(root, `${base}/engine-declarations`);\n" },
      {
        path: "src/lib/apostrophes.ts",
        text: "// Studio's engine-declarations aren't read by any gate.\nexport const X = 1;\n",
      },
      { path: "src/lib/blocked.tsx", text: '/* "src/lib/db/engine-declarations" */\nexport const X = <div />;\n' },
    ];

    expect(declarationReaders(planted)).toEqual([
      "src/lib/static.ts reads an engine declaration, but a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)",
      "src/lib/dynamic.ts reads an engine declaration, but a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)",
      "src/lib/required.ts reads an engine declaration, but a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)",
      "src/lib/read.ts reads an engine declaration, but a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)",
      "src/lib/templated.ts reads an engine declaration, but a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)",
      "src/lib/untemplated.ts reads an engine declaration, but a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)",
      "src/lib/joined.ts reads an engine declaration, but a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)",
    ]);
  });
});

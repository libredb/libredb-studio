/**
 * Golden files are never rewritten silently or under CI (docs/TOOLCHAIN.md, "Golden files").
 *
 * `UPDATE_GOLDEN=1` makes a golden test write its files from the current tree, and the test
 * then throws, so a rewrite is never a silent pass and a CI run with the variable set fails.
 * This file holds both halves: every file that reads `UPDATE_GOLDEN` does so only in the
 * condition of an `if` whose then-branch always ends in a throw and cannot leave early, and
 * no file under `.github/` and no root package.json script names the variable.
 *
 * The reads are parsed, not grepped, as the environment scans are
 * (`tests/unit/lib/db/provider-environment-scan.test.ts`), so comments and sentences that name
 * the variable are not reads. Candidate files are found with `git grep`, git's own search, so no
 * grep binary is needed on Windows. A dynamic name (`process.env[name]`) cannot be seen by a
 * static guard; the `.github/` and package-script scan is the second line for that.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { REPOSITORY_ROOT } from "../helpers/planted-package";

const VARIABLE = "UPDATE_GOLDEN";
const FIX = 'write it as `if (process.env.UPDATE_GOLDEN === "1") { write; throw }`';

function scriptKind(fileName: string): ts.ScriptKind {
  // The script kind follows the extension: parsed as TSX, a generic arrow or an angle-bracket
  // assertion in a .ts file opens a JSX element, and a read after it would never be visited.
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function namesTheVariable(name: ts.Node): boolean {
  return (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === VARIABLE;
}

/** The if statement whose condition holds `node`, or undefined when no condition does. */
function enclosingIfCondition(node: ts.Node): ts.IfStatement | undefined {
  let child = node;
  for (let parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent)) return parent.expression === child ? parent : undefined;
    if (ts.isStatement(parent) || ts.isFunctionLike(parent) || ts.isClassLike(parent)) return undefined;
  }
  return undefined;
}

/** The const declaration whose initializer holds `node` and whose name is an identifier, if any. */
function enclosingConstAlias(node: ts.Node): ts.VariableDeclaration | undefined {
  let child = node;
  for (let parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isVariableDeclaration(parent)) {
      const isConst = (ts.getCombinedNodeFlags(parent) & ts.NodeFlags.Const) !== 0;
      return parent.initializer === child && isConst && ts.isIdentifier(parent.name) ? parent : undefined;
    }
    if (ts.isStatement(parent) || ts.isFunctionLike(parent) || ts.isClassLike(parent)) return undefined;
  }
  return undefined;
}

/** Whether `node` holds a return, break or continue outside a nested function or class. */
function canLeaveEarly(node: ts.Node): boolean {
  if (ts.isReturnStatement(node) || ts.isBreakStatement(node) || ts.isContinueStatement(node)) return true;
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false;
  return ts.forEachChild(node, canLeaveEarly) ?? false;
}

/** Why the then-branch of a writing if breaks the rule, or undefined when it always ends in a throw. */
function writingBranchFault(statement: ts.IfStatement): string | undefined {
  const branch = statement.thenStatement;
  if (ts.isThrowStatement(branch)) return undefined;
  const last = ts.isBlock(branch) ? branch.statements.at(-1) : undefined;
  if (last === undefined || !ts.isThrowStatement(last)) {
    return `the branch that reads ${VARIABLE} does not always end in a throw`;
  }
  if (canLeaveEarly(branch)) return `the branch that reads ${VARIABLE} can leave before its throw`;
  return undefined;
}

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
}

/** Every property or element access that reads UPDATE_GOLDEN in a parsed file. */
function updateGoldenReads(file: ts.SourceFile): ts.Node[] {
  const reads: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === VARIABLE) reads.push(node);
    else if (ts.isElementAccessExpression(node) && namesTheVariable(node.argumentExpression)) reads.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return reads;
}

/**
 * The violations in one source file, each naming the file, the line and the rule broken,
 * empty when the file reads UPDATE_GOLDEN only in the condition of an if (directly or
 * through a const alias used only in if conditions) whose then-branch always ends in a
 * throw and cannot leave early. Exporting such an alias, destructuring the variable or
 * setting it in an object literal (a child process's environment) is always a violation.
 */
function goldenWriteViolations(source: string, fileName: string): string[] {
  const file = parse(source, fileName);
  const violations = new Set<string>();
  const report = (node: ts.Node, fault: string): void => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    violations.add(`${fileName}:${line}: ${fault}: ${FIX}`);
  };
  const checkCondition = (node: ts.Node, outside: string): void => {
    const statement = enclosingIfCondition(node);
    if (statement === undefined) {
      report(node, outside);
      return;
    }
    const fault = writingBranchFault(statement);
    if (fault !== undefined) report(statement, fault);
  };
  const checkRead = (read: ts.Node): void => {
    const alias = enclosingConstAlias(read);
    if (alias === undefined) {
      checkCondition(read, `${VARIABLE} is read outside the condition of an if`);
      return;
    }
    const aliasName = alias.name as ts.Identifier;
    // A file that imports the alias never names UPDATE_GOLDEN, so git grep never checks it.
    if ((ts.getCombinedModifierFlags(alias) & ts.ModifierFlags.Export) !== 0) {
      report(alias, `${aliasName.text}, which holds ${VARIABLE}, is exported`);
    }
    const visitAlias = (node: ts.Node): void => {
      const isReference =
        ts.isIdentifier(node) &&
        node !== aliasName &&
        node.text === aliasName.text &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node);
      if (isReference)
        checkCondition(node, `${aliasName.text}, which holds ${VARIABLE}, is read outside the condition of an if`);
      ts.forEachChild(node, visitAlias);
    };
    visitAlias(file);
  };
  for (const read of updateGoldenReads(file)) checkRead(read);
  const visit = (node: ts.Node): void => {
    if (ts.isBindingElement(node) && namesTheVariable(node.propertyName ?? node.name)) {
      report(node, `${VARIABLE} is destructured`);
    } else if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      namesTheVariable(node.name)
    ) {
      report(node, `${VARIABLE} is set for a child process`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...violations];
}

/** The names of the entries whose text names UPDATE_GOLDEN. */
function ciFilesNamingUpdateGolden(entries: readonly { name: string; text: string }[]): string[] {
  return entries.filter((entry) => entry.text.includes(VARIABLE)).map((entry) => entry.name);
}

const CONNECTION_STRING_SHAPE = [
  'import { writeFileSync } from "node:fs";',
  "export function check(file: string, rendered: string): void {",
  '  if (process.env.UPDATE_GOLDEN === "1") {',
  "    writeFileSync(file, rendered);",
  '    throw new Error("golden files written, commit them");',
  "  }",
  "  compare(file, rendered);",
  "}",
  "",
].join("\n");

const SQL_GRAMMAR_SHAPE = [
  'import { mkdirSync, writeFileSync } from "node:fs";',
  'const UPDATE = process.env.UPDATE_GOLDEN === "1";',
  "export function check(dir: string, file: string, actual: string): void {",
  "  if (UPDATE) {",
  "    mkdirSync(dir, { recursive: true });",
  "    writeFileSync(file, actual);",
  '    throw new Error("golden files written, commit them");',
  "  }",
  "  compare(file, actual);",
  "}",
  "",
].join("\n");

function trackedFilesNaming(text: string): string[] {
  const result = Bun.spawnSync(["git", "grep", "-l", "-F", "-e", text], { cwd: REPOSITORY_ROOT });
  // git grep exits 1 when nothing matches; any other non-zero status is an error.
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) throw new Error(`git grep failed: ${result.stderr.toString()}`);
  return result.stdout.toString().split("\n").filter(Boolean);
}

function codeFilesNamingUpdateGolden(): string[] {
  return trackedFilesNaming("UPDATE_GOLDEN").filter((name) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name));
}

const SIX_GOLDENS = [
  "tests/unit/db/connection-form/golden.test.tsx",
  "tests/unit/db/connection-string/golden.test.ts",
  "tests/unit/db/execution-ui/golden.test.tsx",
  "tests/unit/db/migration-ddl/golden.test.ts",
  "tests/unit/db/sql-grammar/golden.test.ts",
  "tests/unit/db/sql-writing/golden.test.ts",
];

describe("golden files are never rewritten silently or under CI", () => {
  test("the two shapes the golden tests use pass", () => {
    expect(goldenWriteViolations(CONNECTION_STRING_SHAPE, "connection-string.test.ts")).toEqual([]);
    expect(goldenWriteViolations(SQL_GRAMMAR_SHAPE, "sql-grammar.test.ts")).toEqual([]);
  });

  test("a planted golden whose writing branch does not throw is named", () => {
    const source = [
      'if (process.env.UPDATE_GOLDEN === "1") {',
      "  writeFileSync(file, rendered);",
      "}",
      "compare(file, rendered);",
      "",
    ].join("\n");
    expect(goldenWriteViolations(source, "planted.test.ts")).toEqual([
      'planted.test.ts:1: the branch that reads UPDATE_GOLDEN does not always end in a throw: write it as `if (process.env.UPDATE_GOLDEN === "1") { write; throw }`',
    ]);
  });

  test("a planted golden whose writing branch can return before its throw is named", () => {
    const source = [
      "export function check(): void {",
      '  if (process.env.UPDATE_GOLDEN === "1") {',
      "    writeFileSync(file, rendered);",
      "    if (unchanged) return;",
      '    throw new Error("golden files written, commit them");',
      "  }",
      "}",
      "",
    ].join("\n");
    expect(goldenWriteViolations(source, "planted.test.ts")).toEqual([
      'planted.test.ts:2: the branch that reads UPDATE_GOLDEN can leave before its throw: write it as `if (process.env.UPDATE_GOLDEN === "1") { write; throw }`',
    ]);
  });

  test("a planted golden that reads UPDATE_GOLDEN outside an if condition is named", () => {
    const source = 'process.env.UPDATE_GOLDEN === "1" && writeFileSync(file, rendered);\n';
    expect(goldenWriteViolations(source, "planted.test.ts")).toEqual([
      'planted.test.ts:1: UPDATE_GOLDEN is read outside the condition of an if: write it as `if (process.env.UPDATE_GOLDEN === "1") { write; throw }`',
    ]);
  });

  test("a planted golden that branches on an alias outside an if condition is named", () => {
    const source = [
      'const UPDATE = process.env.UPDATE_GOLDEN === "1";',
      "UPDATE ? writeFileSync(file, rendered) : compare();",
      "",
    ].join("\n");
    expect(goldenWriteViolations(source, "planted.test.ts")).toEqual([
      'planted.test.ts:2: UPDATE, which holds UPDATE_GOLDEN, is read outside the condition of an if: write it as `if (process.env.UPDATE_GOLDEN === "1") { write; throw }`',
    ]);
  });

  test("a planted golden that exports its alias is named", () => {
    // An importer of the alias never names UPDATE_GOLDEN, so git grep would never check it.
    const source = 'export const UPDATE = process.env.UPDATE_GOLDEN === "1";\n';
    expect(goldenWriteViolations(source, "planted.ts")).toEqual([
      'planted.ts:1: UPDATE, which holds UPDATE_GOLDEN, is exported: write it as `if (process.env.UPDATE_GOLDEN === "1") { write; throw }`',
    ]);
  });

  test("a planted golden whose then-branch is the comparing branch is named", () => {
    const source = [
      'if (process.env.UPDATE_GOLDEN !== "1") {',
      "  compare();",
      "} else {",
      "  writeFileSync(file, rendered);",
      "}",
      "",
    ].join("\n");
    expect(goldenWriteViolations(source, "planted.test.ts")).toEqual([
      'planted.test.ts:1: the branch that reads UPDATE_GOLDEN does not always end in a throw: write it as `if (process.env.UPDATE_GOLDEN === "1") { write; throw }`',
    ]);
  });

  test("a planted file that destructures or sets UPDATE_GOLDEN is named", () => {
    const fix = 'write it as `if (process.env.UPDATE_GOLDEN === "1") { write; throw }`';
    expect(goldenWriteViolations("const { UPDATE_GOLDEN } = process.env;\n", "destructures.test.ts")).toEqual([
      `destructures.test.ts:1: UPDATE_GOLDEN is destructured: ${fix}`,
    ]);
    expect(
      goldenWriteViolations('spawnSync(cmd, { env: { UPDATE_GOLDEN: "1" } });\n', "child-environment.test.ts"),
    ).toEqual([`child-environment.test.ts:1: UPDATE_GOLDEN is set for a child process: ${fix}`]);
    expect(goldenWriteViolations('process.env.UPDATE_GOLDEN = "1";\n', "assigns.test.ts")).toEqual([
      `assigns.test.ts:1: UPDATE_GOLDEN is read outside the condition of an if: ${fix}`,
    ]);
  });

  test("comments and sentences that name UPDATE_GOLDEN are not reads", () => {
    const source = [
      "/**",
      " * `UPDATE_GOLDEN=1` writes the files instead and fails.",
      " */",
      "// process.env.UPDATE_GOLDEN",
      'const HINT = "run with UPDATE_GOLDEN=1 to rewrite the golden files";',
      "",
    ].join("\n");
    expect(goldenWriteViolations(source, "sentences.test.ts")).toEqual([]);
  });

  test("a .tsx golden is parsed as TSX", () => {
    const source = [
      "const identity = <T,>(value: T): T => value;",
      "export function check(): void {",
      '  if (process.env.UPDATE_GOLDEN === "1") {',
      "    writeFileSync(file, identity(<div>rendered</div>));",
      '    throw new Error("golden files written, commit them");',
      "  }",
      "}",
      "",
    ].join("\n");
    expect(goldenWriteViolations(source, "planted.test.tsx")).toEqual([]);
  });

  test("every file that reads UPDATE_GOLDEN throws in its writing branch, the six golden tests among them", () => {
    const sources = codeFilesNamingUpdateGolden().map((name) => ({
      name,
      source: readFileSync(path.join(REPOSITORY_ROOT, name), "utf8"),
    }));
    // A superset, not an exact list: a seventh golden is held to the same rule.
    const readers = sources.filter(({ name, source }) => updateGoldenReads(parse(source, name)).length > 0);
    expect(readers.map(({ name }) => name)).toEqual(expect.arrayContaining(SIX_GOLDENS));
    expect(sources.flatMap(({ name, source }) => goldenWriteViolations(source, name))).toEqual([]);
  });

  test("a planted workflow or package script that names UPDATE_GOLDEN is named", () => {
    expect(
      ciFilesNamingUpdateGolden([
        { name: ".github/workflows/planted.yml", text: 'env:\n  UPDATE_GOLDEN: "1"\n' },
        { name: "package.json scripts.test", text: "UPDATE_GOLDEN=1 bun tests/run-tests.ts" },
        { name: ".github/workflows/clean.yml", text: "run: bun run test\n" },
      ]),
    ).toEqual([".github/workflows/planted.yml", "package.json scripts.test"]);
  });

  test("no file under .github/ and no root package.json script names UPDATE_GOLDEN", () => {
    const listed = Bun.spawnSync(["git", "ls-files", "--", ".github"], { cwd: REPOSITORY_ROOT });
    if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
    const githubFiles = listed.stdout.toString().split("\n").filter(Boolean);
    expect(githubFiles.length).toBeGreaterThan(0);
    const scripts: Record<string, string> = JSON.parse(
      readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
    ).scripts;
    const entries = [
      ...githubFiles.map((name) => ({ name, text: readFileSync(path.join(REPOSITORY_ROOT, name), "utf8") })),
      ...Object.entries(scripts).map(([name, text]) => ({ name: `package.json scripts.${name}`, text })),
    ];
    expect(ciFilesNamingUpdateGolden(entries)).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import * as mssqlReadOnlyRefusals from "@/lib/sql/mssql-read-only-refusals";
import * as readOnlyBudget from "@/lib/db/read-only-budget";

/**
 * A provider's own budget refusal is constructed as the class of its budget, held by the syntax tree.
 *
 * A provider refuses a read whose answer or wait passed the row, byte or time field of the `ReadOnlyStatementBudget`
 * it was handed in one of the sentences src/lib/db/read-only-budget.ts and
 * src/lib/sql/mssql-read-only-refusals.ts build, and raises it as the class of that budget
 * (`RowBudgetRefusal`, `ByteBudgetRefusal`, `TimeBudgetRefusal`, `CutValueRefusal`, `SerialisedResultRefusal` in
 * src/lib/db/errors.ts), so its error record answers a kind of its own. A refusal it raises before anything was sent
 * stays a `RefusedBeforeSendError`, and one it raises as a timeout a `TimeoutError`: the same refusal, which every
 * reader already decides by that class.
 *
 * The scan reads every file under src/lib/db/providers. A construction `new C(first, ...)` holds a
 * budget when its first argument references one of `BUDGET_IDENTIFIERS`, directly, through a `const` of an enclosing
 * function or of the file initialised from one, or through a property of an object literal declared at the file's top
 * level (read as `TABLE.prop`, or through `const F = TABLE`) whose initialiser holds one. Such a construction must
 * reference exactly one budget, must not be a conditional with a branch that holds none (one construction, one class),
 * and must construct that budget's class, a `RefusedBeforeSendError` or a `TimeoutError`. A class declared in the same
 * file is read as the class it extends, through every same-file class between them, as `errorKind` reads an error by
 * its nearest class: Modbus's `class ModbusAgentRefusal extends RefusedBeforeSendError` is a refusal before send, and a
 * same-file `class LocalError extends QueryError` constructing a budget sentence is refused by its own name.
 *
 * What escapes it: a sentence that reaches a construction through a function's return value, a parameter of a
 * same-file wrapper (`fail(sentence)`), a `let`, another file's table or a computed property
 * (`FAILURES[error.category]`), and a budget refusal worded without these identifiers
 * (MySQL's and MongoDB's "exceeded the statement deadline", SQL Server's "could not hold this query plan"). The tests
 * that provoke each such refusal in its provider's own test file assert its kind, and hold those.
 *
 * Every reader decides a budget refusal by its class, never by its words, so this census is what turns a provider's
 * budget sentence into its answer: a budget sentence raised as a plain `QueryError` would be answered as the engine's
 * error. It is complete over the sentences: every export of those two modules whose name ends in `_PREFIX` or
 * `BudgetSentence` is one of `BUDGET_IDENTIFIERS`, or is named in `NON_BUDGET_EXPORTS` with the reason it is none.
 *
 * A finding names its file and innermost declaration, never a line.
 */

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDERS = join("src", "lib", "db", "providers");

/** The budgets a provider refuses a read by. */
type BudgetKind = "rows" | "bytes" | "time" | "cut-value" | "serialised";

/** The class each budget kind is raised as. Typed by the kind, so a kind added to `BudgetKind` fails typecheck here. */
const CLASS_OF_KIND: Readonly<Record<BudgetKind, string>> = {
  rows: "RowBudgetRefusal",
  bytes: "ByteBudgetRefusal",
  time: "TimeBudgetRefusal",
  "cut-value": "CutValueRefusal",
  serialised: "SerialisedResultRefusal",
};

/** The classes a budget refusal may also keep: the same refusal raised before sending, or raised as a timeout. */
const KEPT_CLASSES: ReadonlySet<string> = new Set(["RefusedBeforeSendError", "TimeoutError"]);

/** Every identifier a budget sentence is built from, and the kind of its budget. */
const BUDGET_IDENTIFIERS: Readonly<Record<string, { readonly kind: BudgetKind }>> = {
  rowBudgetSentence: { kind: "rows" },
  ROW_BUDGET_PREFIX: { kind: "rows" },
  byteBudgetSentence: { kind: "bytes" },
  BYTE_BUDGET_PREFIX: { kind: "bytes" },
  TIME_BUDGET_PREFIX: { kind: "time" },
  MSSQL_TIME_BUDGET_PREFIX: { kind: "time" },
  MSSQL_CUT_VALUE_PREFIX: { kind: "cut-value" },
  MSSQL_SERIALISED_PREFIX: { kind: "serialised" },
};

/**
 * The exports of the two sentence modules whose name reads as a budget sentence's and which build none, each with the
 * reason. None today.
 */
const NON_BUDGET_EXPORTS: Readonly<Record<string, string>> = {};

/** The exports of `modules` named as a budget sentence's (`_PREFIX`, `BudgetSentence`) that this census does not list. */
function unlistedBudgetExports(modules: readonly Readonly<Record<string, unknown>>[]): string[] {
  return modules
    .flatMap((module) => Object.keys(module))
    .filter((name) => /(_PREFIX|BudgetSentence)$/.test(name))
    .filter((name) => !Object.hasOwn(BUDGET_IDENTIFIERS, name) && !Object.hasOwn(NON_BUDGET_EXPORTS, name))
    .sort();
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory))) {
    const path = join(directory, entry);
    if (statSync(join(ROOT, path)).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

/** The name of the innermost named function, method or class around `node`, or the file's top level. */
function enclosingDeclaration(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (
      (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isClassDeclaration(at)) &&
      at.name !== undefined &&
      ts.isIdentifier(at.name)
    ) {
      return at.name.text;
    }
    if (
      (ts.isVariableDeclaration(at) || ts.isPropertyAssignment(at)) &&
      ts.isIdentifier(at.name) &&
      at.initializer !== undefined &&
      (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer))
    ) {
      return at.name.text;
    }
  }
  return "(top level)";
}

/** `expression` without the `as`, `satisfies`, non-null, parenthesis and `Object.freeze(...)` wrappers around it. */
function unwrapped(expression: ts.Expression): ts.Expression {
  let at = expression;
  for (;;) {
    if (
      ts.isAsExpression(at) ||
      ts.isSatisfiesExpression(at) ||
      ts.isParenthesizedExpression(at) ||
      ts.isNonNullExpression(at)
    ) {
      at = at.expression;
    } else if (ts.isCallExpression(at) && at.expression.getText() === "Object.freeze" && at.arguments.length === 1) {
      at = at.arguments[0];
    } else {
      return at;
    }
  }
}

/** The `const` declarations with a plain name in `scope`, not descending into nested functions or classes. */
function constsIn(scope: ts.Node): Map<string, ts.Expression> {
  const found = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.Const) !== 0 &&
      node.declarations.every((declaration) => declaration.initializer !== undefined)
    ) {
      for (const declaration of node.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          found.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (node !== scope && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/** The functions and the file around `node`, innermost first. */
function scopesAround(node: ts.Node): ts.Node[] {
  const scopes: ts.Node[] = [];
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isFunctionLike(at) || ts.isSourceFile(at)) scopes.push(at);
  }
  return scopes;
}

/** What one expression holds: the budget kinds it references, and whether it is a conditional with a branch of none. */
type Holding = { readonly kinds: Set<BudgetKind>; mixed: boolean };

/**
 * A construction of `className` whose first argument holds `holding`, in the declaration it was found in; `readAs` is
 * the class it is read as, `className` itself or, for a class declared in the same file, the class it extends.
 */
type BudgetConstruction = {
  readonly className: string;
  readonly readAs: string;
  readonly where: string;
  readonly holding: Holding;
};

function scan(file: string, text: string): BudgetConstruction[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const fileConsts = constsIn(source);
  /** The top-level object literal tables of the file, by name, with each property's initialiser. */
  const tables = new Map<string, Map<string, ts.Node>>();
  for (const [name, initializer] of fileConsts) {
    const literal = unwrapped(initializer);
    if (!ts.isObjectLiteralExpression(literal)) continue;
    const properties = new Map<string, ts.Node>();
    for (const property of literal.properties) {
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        properties.set(property.name.text, property.initializer);
      }
      if (ts.isMethodDeclaration(property) && ts.isIdentifier(property.name))
        properties.set(property.name.text, property);
    }
    tables.set(name, properties);
  }
  /** The table an identifier names: a table itself, or a `const` of an enclosing scope initialised to one. */
  const tableNamed = (name: string, at: ts.Node): Map<string, ts.Node> | undefined => {
    for (const scope of scopesAround(at)) {
      const initializer = (scope === source ? fileConsts : constsIn(scope)).get(name);
      if (initializer === undefined) continue;
      const value = unwrapped(initializer);
      if (ts.isIdentifier(value) && tables.has(value.text)) return tables.get(value.text);
      return tables.get(name);
    }
    return undefined;
  };
  const constNamed = (name: string, at: ts.Node): ts.Expression | undefined => {
    for (const scope of scopesAround(at)) {
      const initializer = (scope === source ? fileConsts : constsIn(scope)).get(name);
      if (initializer !== undefined) return initializer;
    }
    return undefined;
  };

  /** What `expression` holds; `reading` is the path of initialisers being read, so a cycle ends. */
  const holdingOf = (expression: ts.Node, reading: ReadonlySet<ts.Node>): Holding => {
    const holding: Holding = { kinds: new Set(), mixed: false };
    if (reading.has(expression)) return holding;
    const seen = new Set(reading).add(expression);
    const add = (inner: Holding) => {
      for (const kind of inner.kinds) holding.kinds.add(kind);
      if (inner.mixed) holding.mixed = true;
    };
    const visit = (node: ts.Node) => {
      // A function given as the argument (a `Promise` executor, a callback) is not the sentence; a table's function
      // property is, when it is the expression being read.
      if (node !== expression && ts.isFunctionLike(node)) return;
      if (ts.isConditionalExpression(node)) {
        const branches = [holdingOf(node.whenTrue, seen), holdingOf(node.whenFalse, seen)];
        for (const branch of branches) add(branch);
        if (branches.some((branch) => branch.kinds.size > 0) && branches.some((branch) => branch.kinds.size === 0)) {
          holding.mixed = true;
        }
        ts.forEachChild(node.condition, visit);
        return;
      }
      if (ts.isPropertyAccessExpression(node)) {
        const property = ts.isIdentifier(node.expression)
          ? tableNamed(node.expression.text, node)?.get(node.name.text)
          : undefined;
        if (property !== undefined) add(holdingOf(property, seen));
        else if (!ts.isIdentifier(node.expression)) visit(node.expression);
        return;
      }
      if (ts.isIdentifier(node)) {
        if (Object.hasOwn(BUDGET_IDENTIFIERS, node.text)) holding.kinds.add(BUDGET_IDENTIFIERS[node.text].kind);
        else {
          const initializer = constNamed(node.text, node);
          if (initializer !== undefined && !ts.isObjectLiteralExpression(unwrapped(initializer))) {
            add(holdingOf(initializer, seen));
          }
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(expression);
    return holding;
  };

  /** Each class declared in the file that extends a class named by an identifier, and the class it extends. */
  const parentOf = new Map<string, string>();
  const collectClasses = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const parent = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
        ?.expression;
      if (parent !== undefined && ts.isIdentifier(parent)) parentOf.set(node.name.text, parent.text);
    }
    ts.forEachChild(node, collectClasses);
  };
  collectClasses(source);
  /** The class `className` is read as: the nearest class outside the file it extends, through same-file classes. */
  const readAs = (className: string): string => {
    let at = className;
    const passed = new Set<string>();
    for (let parent = parentOf.get(at); parent !== undefined && !passed.has(at); parent = parentOf.get(at)) {
      passed.add(at);
      at = parent;
    }
    return at;
  };

  const constructions: BudgetConstruction[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.arguments?.[0] !== undefined) {
      const holding = holdingOf(node.arguments[0], new Set());
      if (holding.kinds.size > 0) {
        constructions.push({
          className: node.expression.text,
          readAs: readAs(node.expression.text),
          where: `${file}: ${enclosingDeclaration(node)}`,
          holding,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return constructions;
}

/** Why a budget construction is refused, or undefined when it constructs its budget's class. */
function fault({ className, readAs, holding }: BudgetConstruction): string | undefined {
  const kinds = [...holding.kinds].sort();
  if (kinds.length > 1) return `references ${kinds.join(" and ")}, more than one budget`;
  if (holding.mixed) return `is a conditional with a branch that holds no ${kinds[0]} budget sentence`;
  const expected = CLASS_OF_KIND[kinds[0]];
  if (readAs === expected || KEPT_CLASSES.has(readAs)) return undefined;
  return `constructs ${className} for a ${kinds[0]} budget refusal, not ${expected}`;
}

const CONSTRUCTIONS = sourceFiles(PROVIDERS).flatMap((file) => scan(file, readFileSync(join(ROOT, file), "utf8")));

describe("a provider's budget refusal is constructed as its budget's class", () => {
  test("the scan finds a budget construction through an alias, a table, a conditional and a same-file subclass, and not a comment", () => {
    const planted = [
      "// throw new QueryError(rowBudgetSentence(1, 0));",
      "/** new QueryError(BYTE_BUDGET_PREFIX) */",
      "const SENTENCES = Object.freeze({ over: (n: number) => byteBudgetSentence(n, 1), other: 'not a budget' });",
      "function direct() { throw new RowBudgetRefusal(rowBudgetSentence(2, 1)); }",
      "function aliased() { const sentence = `${TIME_BUDGET_PREFIX} of 5 ms`; throw new QueryError(sentence); }",
      "function tabled() { const F = SENTENCES; throw new ByteBudgetRefusal(F.over(3)); }",
      "function untabled() { throw new QueryError(SENTENCES.other); }",
      "function mixed(cap: boolean) { throw new RowBudgetRefusal(cap ? 'a cap' : rowBudgetSentence(2, 1)); }",
      "function both(rows: boolean) { throw new QueryError(rows ? rowBudgetSentence(2, 1) : byteBudgetSentence(2, 1)); }",
      "function kept() { throw new RefusedBeforeSendError(rowBudgetSentence(2, 1)); }",
      "function twice(c: boolean) { const w = `${TIME_BUDGET_PREFIX}: 5 ms`; throw new TimeBudgetRefusal(c ? w : `${w}; x`); }",
      "class LocalRefusal extends RefusedBeforeSendError {}",
      "class DeeperRefusal extends LocalRefusal {}",
      "class LocalError extends QueryError {}",
      "function localKept() { throw new DeeperRefusal(rowBudgetSentence(2, 1)); }",
      "function localWrong() { throw new LocalError(rowBudgetSentence(2, 1)); }",
    ].join("\n");
    const found = scan("planted.ts", planted).map((construction) => [
      construction.where,
      construction.className,
      fault(construction),
    ]);
    expect(found).toEqual([
      ["planted.ts: direct", "RowBudgetRefusal", undefined],
      ["planted.ts: aliased", "QueryError", "constructs QueryError for a time budget refusal, not TimeBudgetRefusal"],
      ["planted.ts: tabled", "ByteBudgetRefusal", undefined],
      ["planted.ts: mixed", "RowBudgetRefusal", "is a conditional with a branch that holds no rows budget sentence"],
      ["planted.ts: both", "QueryError", "references bytes and rows, more than one budget"],
      ["planted.ts: kept", "RefusedBeforeSendError", undefined],
      ["planted.ts: twice", "TimeBudgetRefusal", undefined],
      ["planted.ts: localKept", "DeeperRefusal", undefined],
      ["planted.ts: localWrong", "LocalError", "constructs LocalError for a rows budget refusal, not RowBudgetRefusal"],
    ]);
  });

  test("every budget sentence export is a budget identifier", () => {
    // The self-test: a sentence export the census does not list is named.
    expect(unlistedBudgetExports([{ ...readOnlyBudget, NEW_BUDGET_PREFIX: "Read-only execution exceeded" }])).toEqual([
      "NEW_BUDGET_PREFIX",
    ]);
    expect(unlistedBudgetExports([{ ...mssqlReadOnlyRefusals, otherBudgetSentence: () => "" }])).toEqual([
      "otherBudgetSentence",
    ]);
    expect(unlistedBudgetExports([readOnlyBudget, mssqlReadOnlyRefusals])).toEqual([]);
  });

  test("every budget construction in provider code names one budget and constructs its class, a refusal before send or a timeout", () => {
    const findings = CONSTRUCTIONS.flatMap((construction) => {
      const why = fault(construction);
      return why === undefined ? [] : [`${construction.where}: new ${construction.className} ${why}`];
    });
    expect(findings).toEqual([]);
  });
});

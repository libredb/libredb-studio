/**
 * Every clause of `docs/providers/CONTRACT.md` has a stable id and says whether it is normative, and every normative
 * clause names what enforces it: a test, by its file and exact title, or a location in the manifest schema, by a JSON
 * Pointer. So the contract never states a rule nothing checks, and renaming a test or moving a schema member fails
 * here by clause id rather than leaving the contract pointing at nothing.
 *
 * A clause is a level-three heading `### <id> (normative|informative): <title>`, and its enforcers are the list items
 * under it that read ``- test `<file>` "<title>"`` or ``- schema `<pointer>` ``.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const CONTRACT_FILE = "docs/providers/CONTRACT.md";
const SCHEMA_FILE = "packages/provider-sdk/src/manifest/manifest.schema.json";
const TYPES_FILE = "packages/provider-sdk/src/manifest/manifest-types.generated.ts";

type Enforcer =
  | { readonly kind: "test"; readonly file: string; readonly title: string }
  | { readonly kind: "schema"; readonly pointer: string };

interface Clause {
  readonly id: string;
  readonly status: string;
  readonly enforcers: readonly Enforcer[];
}

const CLAUSE_HEADING = /^### (\S+) \((\w+)\): \S/;
const CLAUSE_ID = /^[A-Z]{1,3}-[1-9][0-9]*$/;
const TEST_ENFORCER = /^- test `([^`]+)` "(.+)"$/;
const SCHEMA_ENFORCER = /^- schema `([^`]*)`$/;

/** The clauses of a contract document, in document order. */
function clauses(document: string): Clause[] {
  const found: Clause[] = [];
  let current: { id: string; status: string; enforcers: Enforcer[] } | undefined;
  for (const line of document.split("\n")) {
    const heading = CLAUSE_HEADING.exec(line);
    if (heading) {
      current = { id: heading[1] as string, status: heading[2] as string, enforcers: [] };
      found.push(current);
      continue;
    }
    if (line.startsWith("### ")) {
      found.push({ id: line, status: "unparsed", enforcers: [] });
      current = undefined;
      continue;
    }
    if (line.startsWith("#")) {
      current = undefined;
      continue;
    }
    if (current === undefined) continue;
    const testEnforcer = TEST_ENFORCER.exec(line);
    if (testEnforcer)
      current.enforcers.push({ kind: "test", file: testEnforcer[1] as string, title: testEnforcer[2] as string });
    const schemaEnforcer = SCHEMA_ENFORCER.exec(line);
    if (schemaEnforcer) current.enforcers.push({ kind: "schema", pointer: schemaEnforcer[1] as string });
  }
  return found;
}

/** The value a JSON Pointer names in `document`, or undefined where it names nothing. */
function resolvePointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return undefined;
  let node: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, token)) return undefined;
    node = (node as Record<string, unknown>)[token];
  }
  return node;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `source` declares a `test`, `it` or `describe` (`.each` included) titled exactly `title`. */
function declaresTitle(source: string, title: string): boolean {
  const pattern = new RegExp(`\\b(?:test|it|describe)(?:\\.each\\([^)]*\\))?\\(\\s*(["'\`])${escapeRegExp(title)}\\1`);
  return pattern.test(source);
}

interface Reader {
  readonly exists: (file: string) => boolean;
  readonly read: (file: string) => string;
}

/** Every failure of the clause rules, each naming its clause. */
function clauseFailures(document: string, schema: unknown, reader: Reader): string[] {
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const clause of clauses(document)) {
    if (clause.status === "unparsed") {
      failures.push(`"${clause.id}" is a level-three heading that is not a clause`);
      continue;
    }
    if (!CLAUSE_ID.test(clause.id)) failures.push(`${clause.id}: not a clause id`);
    if (seen.has(clause.id)) failures.push(`${clause.id}: the id is used twice`);
    seen.add(clause.id);
    if (clause.status !== "normative" && clause.status !== "informative") {
      failures.push(`${clause.id}: "${clause.status}" is neither normative nor informative`);
    }
    if (clause.status === "normative" && clause.enforcers.length === 0) {
      failures.push(`${clause.id}: a normative clause names no enforcer`);
    }
    for (const enforcer of clause.enforcers) {
      if (enforcer.kind === "schema") {
        if (resolvePointer(schema, enforcer.pointer) === undefined) {
          failures.push(`${clause.id}: the schema has nothing at ${enforcer.pointer}`);
        }
      } else if (!reader.exists(enforcer.file)) {
        failures.push(`${clause.id}: ${enforcer.file} does not exist`);
      } else if (!declaresTitle(reader.read(enforcer.file), enforcer.title)) {
        failures.push(`${clause.id}: ${enforcer.file} has no test titled "${enforcer.title}"`);
      }
    }
  }
  return failures;
}

/** Every enum of more than three members in the schema, by pointer. */
function largeEnums(node: unknown, pointer: string, found: [string, unknown[]][] = []): [string, unknown[]][] {
  if (typeof node !== "object" || node === null) return found;
  for (const [key, value] of Object.entries(node)) {
    const child = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (key === "enum" && Array.isArray(value) && value.length > 3) found.push([child, value]);
    else largeEnums(value, child, found);
  }
  return found;
}

/** The pointers of the schema enums of more than three members that the document lists whole, each as `member`. */
function vocabulariesListed(document: string, schema: unknown): string[] {
  return largeEnums(schema, "")
    .filter(([, members]) => members.every((member) => document.includes(`\`${String(member)}\``)))
    .map(([pointer]) => pointer);
}

const repositoryReader: Reader = {
  exists: (file) => existsSync(path.join(ROOT, file)),
  read: (file) => readFileSync(path.join(ROOT, file), "utf8"),
};

describe("docs/providers/CONTRACT.md", () => {
  const document = readFileSync(path.join(ROOT, CONTRACT_FILE), "utf8");
  const schema = JSON.parse(readFileSync(path.join(ROOT, SCHEMA_FILE), "utf8")) as unknown;

  test("every clause has a unique id, a status, and every enforcer it names exists", () => {
    expect(clauseFailures(document, schema, repositoryReader)).toEqual([]);
  });

  test("the document states normative clauses, each with an enforcer", () => {
    const normative = clauses(document).filter((clause) => clause.status === "normative");

    expect(normative.length).toBeGreaterThan(10);
    expect(normative.filter((clause) => clause.enforcers.length === 0)).toEqual([]);
  });

  test("the document links the schema file and the generated types", () => {
    expect(document).toContain(`(../../${SCHEMA_FILE})`);
    expect(document).toContain(`(../../${TYPES_FILE})`);
  });

  test("the document lists no vocabulary of the schema by hand", () => {
    expect(vocabulariesListed(document, schema)).toEqual([]);
  });

  test("the document names no internal change number or ledger path", () => {
    expect(document).not.toMatch(/\bPR ?\d|\.team\//);
  });
});

describe("the clause rules on planted documents", () => {
  const schema = { properties: { contract: { const: "0.1" }, "a/b": { enum: ["w", "x", "y", "z"] } } };
  const reader: Reader = {
    exists: (file) => file === "tests/a.test.ts",
    read: () =>
      'describe("the group", () => {\n  test("the rule holds", () => {});\n  it.each([1])(\'each %d\', () => {});\n});\n',
  };

  test("a well-formed document passes", () => {
    const document = [
      "## Manifest",
      "### M-1 (normative): One rule",
      "Text.",
      '- test `tests/a.test.ts` "the rule holds"',
      '- test `tests/a.test.ts` "the group"',
      '- test `tests/a.test.ts` "each %d"',
      "### M-2 (normative): Another",
      "- schema `/properties/a~1b/enum`",
      "### M-3 (informative): A limit",
      "No enforcer.",
      "## Change notes",
      "- schema `/not/a/clause/enforcer`",
    ].join("\n");

    expect(clauseFailures(document, schema, reader)).toEqual([]);
  });

  test("each failure is named by its clause", () => {
    const document = [
      "### M-1 (normative): No enforcer",
      "### M-1 (informative): Repeated id",
      "### m1 (normative): Bad id",
      '- test `tests/a.test.ts` "the rule holds"',
      "### M-4 (advisory): Unknown status",
      "### M-5 (normative): Missing file",
      '- test `tests/missing.test.ts` "anything"',
      "### M-6 (normative): Missing title",
      '- test `tests/a.test.ts` "a title nobody wrote"',
      "### M-7 (normative): Unresolved pointer",
      "- schema `/properties/runtime`",
      "### Not a clause",
    ].join("\n");

    expect(clauseFailures(document, schema, reader)).toEqual([
      "M-1: a normative clause names no enforcer",
      "M-1: the id is used twice",
      "m1: not a clause id",
      'M-4: "advisory" is neither normative nor informative',
      "M-5: tests/missing.test.ts does not exist",
      'M-6: tests/a.test.ts has no test titled "a title nobody wrote"',
      "M-7: the schema has nothing at /properties/runtime",
      '"### Not a clause" is a level-three heading that is not a clause',
    ]);
  });

  test("a vocabulary listed whole is found, and one listed in part is not", () => {
    expect(vocabulariesListed("`w`, `x`, `y` and `z`", schema)).toEqual(["/properties/a~1b/enum"]);
    expect(vocabulariesListed("`w`, `x` and `y`", schema)).toEqual([]);
  });

  test("a pointer that does not start with a slash names nothing, and the empty pointer names the document", () => {
    expect(resolvePointer(schema, "properties")).toBeUndefined();
    expect(resolvePointer(schema, "")).toBe(schema);
  });
});

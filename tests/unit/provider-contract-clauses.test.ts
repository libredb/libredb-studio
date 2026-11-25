/**
 * Every clause of `docs/providers/CONTRACT.md` has a stable id and says whether it is normative, and every normative
 * clause names what enforces it: a test, by its file and exact title, or a location in the manifest schema, by a JSON
 * Pointer. So the contract never states a rule nothing checks, and renaming a test or moving a schema member fails
 * here by clause id rather than leaving the contract pointing at nothing.
 *
 * A clause is a level-three heading `### <id> (normative|informative): <title>`. Its enforcers are not in the
 * document: they are its entry in `CLAUSE_ENFORCERS` (tests/unit/provider-contract-enforcers.ts), so the document
 * states the rule and the map names what checks it. The check runs both ways: every map id is a clause of the
 * document, and an enforcer-shaped line left in the document, ``- test `<file>` "<title>"`` or
 * ``- schema `<pointer>` ``, is named, so the two can never hold different lists.
 *
 * A clause body states its rule in at most three sentences, one per physical line; list items and table rows are not
 * counted, so an enumeration the rule cannot be read without stays a list. The rationale lives beside the code.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { trackedFiles } from "../helpers/repo-text-scope";
import { CLAUSE_ENFORCERS, type ClauseEnforcers, REMOVED_CLAUSES } from "./provider-contract-enforcers";

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
}

/** A line of the document that reads as an enforcer, and the clause it stands under, if any. */
interface ListedEnforcer {
  readonly clause: string | undefined;
  readonly line: string;
}

const CLAUSE_HEADING = /^### (\S+) \((\w+)\): \S/;
const CLAUSE_ID = /^[A-Z]{1,3}-[1-9][0-9]*$/;
const TEST_ENFORCER = /^- test `([^`]+)` "(.+)"$/;
const SCHEMA_ENFORCER = /^- schema `([^`]*)`$/;

/** The clauses of a contract document, in document order, and every line of it that reads as an enforcer. */
function clauses(document: string): { clauses: Clause[]; listed: ListedEnforcer[] } {
  const found: Clause[] = [];
  const listed: ListedEnforcer[] = [];
  let current: string | undefined;
  for (const line of document.split("\n")) {
    const heading = CLAUSE_HEADING.exec(line);
    if (heading) {
      current = heading[1] as string;
      found.push({ id: current, status: heading[2] as string });
      continue;
    }
    if (line.startsWith("### ")) {
      found.push({ id: line, status: "unparsed" });
      current = undefined;
      continue;
    }
    if (line.startsWith("#")) {
      current = undefined;
      continue;
    }
    if (TEST_ENFORCER.test(line) || SCHEMA_ENFORCER.test(line)) listed.push({ clause: current, line });
  }
  return { clauses: found, listed };
}

/** A clause's enforcers as the map lists them, tests first, each file's titles in the map's order. */
function enforcersOf(entry: ClauseEnforcers | undefined): Enforcer[] {
  if (entry === undefined) return [];
  const tests = Object.entries(entry.tests ?? {}).flatMap(([file, titles]) =>
    titles.map((title): Enforcer => ({ kind: "test", file, title })),
  );
  const schema = (entry.schema ?? []).map((pointer): Enforcer => ({ kind: "schema", pointer }));
  return [...tests, ...schema];
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
function clauseFailures(
  document: string,
  enforcers: Readonly<Record<string, ClauseEnforcers>>,
  schema: unknown,
  reader: Reader,
): string[] {
  const failures: string[] = [];
  const seen = new Set<string>();
  const parsed = clauses(document);
  for (const clause of parsed.clauses) {
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
    const listed = Object.hasOwn(enforcers, clause.id) ? enforcersOf(enforcers[clause.id]) : [];
    if (clause.status === "normative" && listed.length === 0) {
      failures.push(`${clause.id}: a normative clause names no enforcer`);
    }
    for (const enforcer of listed) {
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
  for (const id of Object.keys(enforcers)) {
    if (!seen.has(id)) failures.push(`${id}: the enforcer map names a clause the document does not have`);
  }
  for (const { clause, line } of parsed.listed) {
    failures.push(`${clause ?? "the document"}: an enforcer is listed in the document, not in the map: ${line}`);
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

/** The most sentences a clause body states, one per physical line; list items and table rows are not counted. */
const MOST_SENTENCES = 3;

/** Every clause whose body states more than three sentences, each named with its count. */
function longClauses(document: string): string[] {
  const failures: string[] = [];
  let current: { id: string; sentences: number } | undefined;
  const close = () => {
    if (current !== undefined && current.sentences > MOST_SENTENCES) {
      failures.push(`${current.id}: states ${current.sentences} sentences, more than ${MOST_SENTENCES}`);
    }
  };
  for (const line of document.split("\n")) {
    if (line.startsWith("#")) {
      close();
      const heading = CLAUSE_HEADING.exec(line);
      current = heading ? { id: heading[1] as string, sentences: 0 } : undefined;
      continue;
    }
    if (current === undefined || line.trim() === "") continue;
    if (line.startsWith("- ") || line.startsWith(" ") || line.startsWith("|")) continue;
    current.sentences += 1;
  }
  close();
  return failures;
}

/** A token that reads as a clause id wherever it stands in a file's text. */
const CLAUSE_CITATION = /\b[CMSEV]-[1-9][0-9]*\b/g;
/** The text files a clause citation can stand in: code, docs, configuration and scripts. */
const CITING_FILE = /\.(?:ts|tsx|js|mjs|cjs|md|json|yml|yaml|sh|go)$/;
/** This file's planted documents and maps name made-up clause ids on purpose, so it is left out of the scan. */
const THIS_FILE = "tests/unit/provider-contract-clauses.test.ts";

/** Every failure of the removed ids: an id back in the document, an id with no home, an id still enforced. */
function removedFailures(
  document: string,
  enforcers: Readonly<Record<string, ClauseEnforcers>>,
  removed: Readonly<Record<string, string>>,
  exists: (file: string) => boolean,
): string[] {
  const inDocument = new Set(clauses(document).clauses.map((clause) => clause.id));
  const failures: string[] = [];
  for (const [id, home] of Object.entries(removed)) {
    if (inDocument.has(id)) failures.push(`${id}: a removed id is a clause of the document again`);
    if (!exists(home)) failures.push(`${id}: ${home} does not exist`);
    if (Object.hasOwn(enforcers, id)) failures.push(`${id}: listed both as a clause's enforcers and as removed`);
  }
  return failures;
}

/** Every clause id a file cites that is neither a clause of the document nor a removed id, once per file and id. */
function citationFailures(
  files: readonly string[],
  read: (file: string) => string,
  known: ReadonlySet<string>,
): string[] {
  return files.flatMap((file) =>
    [...new Set(read(file).match(CLAUSE_CITATION) ?? [])]
      .filter((id) => !known.has(id))
      .map((id) => `${file} names ${id}, which is neither a clause of the document nor a removed id`),
  );
}

const repositoryReader: Reader = {
  exists: (file) => existsSync(path.join(ROOT, file)),
  read: (file) => readFileSync(path.join(ROOT, file), "utf8"),
};

describe("docs/providers/CONTRACT.md", () => {
  const document = readFileSync(path.join(ROOT, CONTRACT_FILE), "utf8");
  const schema = JSON.parse(readFileSync(path.join(ROOT, SCHEMA_FILE), "utf8")) as unknown;

  test("every clause has a unique id, a status, and every enforcer it names exists", () => {
    expect(clauseFailures(document, CLAUSE_ENFORCERS, schema, repositoryReader)).toEqual([]);
  });

  test("the document states normative clauses, each with an enforcer", () => {
    const normative = clauses(document).clauses.filter((clause) => clause.status === "normative");

    expect(normative.length).toBeGreaterThan(10);
    expect(normative.filter((clause) => enforcersOf(CLAUSE_ENFORCERS[clause.id]).length === 0)).toEqual([]);
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

  test("every clause states its rule in at most three sentences", () => {
    expect(longClauses(document)).toEqual([]);
  });

  test("every removed id is gone from the document, has a home, and has no enforcers", () => {
    expect(removedFailures(document, CLAUSE_ENFORCERS, REMOVED_CLAUSES, repositoryReader.exists)).toEqual([]);
  });

  test("every clause id a tracked file cites is a clause of the document or a removed id", () => {
    const known = new Set([...clauses(document).clauses.map((clause) => clause.id), ...Object.keys(REMOVED_CLAUSES)]);
    const files = trackedFiles(ROOT).filter((file) => file !== THIS_FILE && CITING_FILE.test(file));

    expect(citationFailures(files, repositoryReader.read, known)).toEqual([]);
  }, 120_000);
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
      "### M-2 (normative): Another",
      "### M-3 (informative): A limit",
      "No enforcer.",
      "### M-4 (informative): A limit with a check",
      "## Change notes",
    ].join("\n");
    const enforcers = {
      "M-1": { tests: { "tests/a.test.ts": ["the rule holds", "the group", "each %d"] } },
      "M-2": { schema: ["/properties/a~1b/enum"] },
      "M-4": { tests: { "tests/a.test.ts": ["the rule holds"] }, schema: [""] },
    };

    expect(clauseFailures(document, enforcers, schema, reader)).toEqual([]);
  });

  test("each failure is named by its clause", () => {
    const document = [
      "### M-1 (normative): No enforcer",
      "### M-1 (informative): Repeated id",
      "### m1 (normative): Bad id",
      "### M-4 (advisory): Unknown status",
      "### M-5 (normative): Missing file",
      "### M-6 (normative): Missing title",
      "### M-7 (normative): Unresolved pointer",
      "### M-8 (informative): Unresolved pointer on an informative clause",
      "### Not a clause",
    ].join("\n");
    const enforcers = {
      m1: { tests: { "tests/a.test.ts": ["the rule holds"] } },
      "M-5": { tests: { "tests/missing.test.ts": ["anything"] } },
      "M-6": { tests: { "tests/a.test.ts": ["a title nobody wrote"] } },
      "M-7": { schema: ["/properties/runtime"] },
      "M-8": { schema: ["/properties/vendor"] },
    };

    expect(clauseFailures(document, enforcers, schema, reader)).toEqual([
      "M-1: a normative clause names no enforcer",
      "M-1: the id is used twice",
      "m1: not a clause id",
      'M-4: "advisory" is neither normative nor informative',
      "M-5: tests/missing.test.ts does not exist",
      'M-6: tests/a.test.ts has no test titled "a title nobody wrote"',
      "M-7: the schema has nothing at /properties/runtime",
      "M-8: the schema has nothing at /properties/vendor",
      '"### Not a clause" is a level-three heading that is not a clause',
    ]);
  });

  test("a map id the document has no clause for is named", () => {
    const document = "### M-1 (normative): One rule";
    const enforcers = { "M-1": { schema: [""] }, "M-999": { schema: [""] } };

    expect(clauseFailures(document, enforcers, schema, reader)).toEqual([
      "M-999: the enforcer map names a clause the document does not have",
    ]);
  });

  test("a normative clause whose map entry is missing or empty is named", () => {
    const document = [
      "### M-1 (normative): No entry",
      "### M-2 (normative): An empty entry",
      "### M-3 (normative): Empty lists",
      "### M-4 (normative): A file with no titles",
    ].join("\n");
    const enforcers = { "M-2": {}, "M-3": { tests: {}, schema: [] }, "M-4": { tests: { "tests/a.test.ts": [] } } };

    expect(clauseFailures(document, enforcers, schema, reader)).toEqual([
      "M-1: a normative clause names no enforcer",
      "M-2: a normative clause names no enforcer",
      "M-3: a normative clause names no enforcer",
      "M-4: a normative clause names no enforcer",
    ]);
  });

  test("an enforcer line left in the document is named", () => {
    const document = [
      '- test `tests/a.test.ts` "the rule holds"',
      "### M-1 (normative): One rule",
      '- test `tests/a.test.ts` "the rule holds"',
      "## Change notes",
      "- schema `/properties/contract`",
    ].join("\n");
    const enforcers = { "M-1": { tests: { "tests/a.test.ts": ["the rule holds"] } } };

    expect(clauseFailures(document, enforcers, schema, reader)).toEqual([
      'the document: an enforcer is listed in the document, not in the map: - test `tests/a.test.ts` "the rule holds"',
      'M-1: an enforcer is listed in the document, not in the map: - test `tests/a.test.ts` "the rule holds"',
      "the document: an enforcer is listed in the document, not in the map: - schema `/properties/contract`",
    ]);
  });

  test("a removed id that is a clause again, a removed id with no home, and an id both removed and enforced are each named", () => {
    const document = ["### M-1 (normative): Back again", "### M-2 (normative): Kept"].join("\n");
    const enforcers = { "M-1": { schema: [""] }, "M-2": { schema: [""] }, "M-4": { schema: [""] } };
    const removed = { "M-1": "tests/a.test.ts", "M-3": "src/gone.ts", "M-4": "tests/a.test.ts" };

    expect(removedFailures(document, enforcers, removed, reader.exists)).toEqual([
      "M-1: a removed id is a clause of the document again",
      "M-1: listed both as a clause's enforcers and as removed",
      "M-3: src/gone.ts does not exist",
      "M-4: listed both as a clause's enforcers and as removed",
    ]);
  });

  test("a tracked file that cites an id that is neither a clause nor removed is named, and one citing a clause or a removed id is not", () => {
    const texts: Record<string, string> = {
      "src/a.ts": "// clause M-1, clauses C-2 to C-3",
      "src/b.ts": "// clauses M-9 and E-12, then M-9 again; SHA-256 and XM-7 are no clause",
      "docs/c.md": "C-3 (removed) and V-40.",
    };
    const known = new Set(["M-1", "C-2", "C-3"]);

    expect(citationFailures(Object.keys(texts), (file) => texts[file] as string, known)).toEqual([
      "src/b.ts names M-9, which is neither a clause of the document nor a removed id",
      "src/b.ts names E-12, which is neither a clause of the document nor a removed id",
      "docs/c.md names V-40, which is neither a clause of the document nor a removed id",
    ]);
  });

  test("a clause body of more than three sentences is named, and list items and table rows are not counted", () => {
    const document = [
      "## Calls",
      "One.",
      "Two.",
      "Three.",
      "Four, a section intro, which is no clause.",
      "### C-1 (normative): Three and a list",
      "",
      "One.",
      "Two:",
      "",
      "- an item,",
      "  its continuation,",
      "- and another.",
      "",
      "| a | b |",
      "|---|---|",
      "Three.",
      "### C-2 (informative): Four",
      "One.",
      "Two.",
      "Three.",
      "Four.",
      "## Not yet in this contract",
      "### C-3 (normative): Five, the last",
      "1.",
      "2.",
      "3.",
      "4.",
      "5.",
    ].join("\n");

    expect(longClauses(document)).toEqual([
      "C-2: states 4 sentences, more than 3",
      "C-3: states 5 sentences, more than 3",
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

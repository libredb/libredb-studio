/**
 * The paste leg of the connection string registry. Each engine's row declares which pasted texts it claims, which it
 * names for `detectConnectionStringType`, and how it parses them; the parser only walks the rows in the one declared
 * order. These tests hold the rows to that contract: every text the parser tests paste is claimed by exactly one row,
 * so a new row that claims another engine's text fails here by name, and the parser itself names no engine and no
 * scheme.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { detectConnectionStringType, parseConnectionString, pasteText } from "@/lib/connection-string-parser";
import {
  CONNECTION_STRING,
  CONNECTION_STRING_PASTE_ORDER,
  CONNECTION_STRING_PASTES,
  pasteRows,
} from "@/lib/db/connection-string";
import type { ConnectionStringPaste } from "@/lib/db/connection-string/types";
import type { DatabaseType } from "@/lib/types";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PARSER = "src/lib/connection-string-parser.ts";
const IDS = Object.keys(CONNECTION_STRING) as DatabaseType[];

/** The source files whose `parseConnectionString(...)` and `detectConnectionStringType(...)` texts are the fixtures. */
const FIXTURE_FILES = [
  "tests/unit/lib/connection-string-parser.test.ts",
  "tests/unit/db/connection-string/fixtures.ts",
  "tests/components/LoginPage.test.tsx",
  "tests/components/ConnectionSignature.test.tsx",
  "tests/hooks/use-connection-form.test.ts",
  "tests/unit/db/databend/provider-doc.test.ts",
];

function sourceOf(path: string, text: string): ts.SourceFile {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

/** Every string literal passed as the first argument of a call to `callee` in `path`. */
function literalArguments(path: string, callee: string): string[] {
  const file = sourceOf(path, readFileSync(join(ROOT, path), "utf8"));
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
      const [first] = node.arguments;
      if (first !== undefined && ts.isStringLiteralLike(first)) found.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const PARSE_FIXTURES = [...new Set(FIXTURE_FILES.flatMap((path) => literalArguments(path, "parseConnectionString")))];
const DETECT_FIXTURES = [
  ...new Set(FIXTURE_FILES.flatMap((path) => literalArguments(path, "detectConnectionStringType"))),
];

type Row = { readonly type: DatabaseType; readonly paste: ConnectionStringPaste };

/**
 * The rows that take `text` under the precedence rule: the rows claiming it as their own spelling, or, when none
 * does, the catch-all rows claiming it. One answer is the contract; two is a row taking another engine's text.
 */
function claimants(rows: readonly Row[], text: string, pick: "claims" | "names"): DatabaseType[] {
  const taking = rows.filter(({ paste }) => paste[pick](text));
  const own = taking.filter(({ paste }) => !paste.catchAll);
  return (own.length > 0 ? own : taking).map(({ type }) => type);
}

describe("the paste order", () => {
  test("lists every row that reads a paste exactly once, and no other row", () => {
    expect(new Set(CONNECTION_STRING_PASTE_ORDER).size).toBe(CONNECTION_STRING_PASTE_ORDER.length);
    expect([...CONNECTION_STRING_PASTE_ORDER].sort()).toEqual(
      IDS.filter((id) => CONNECTION_STRING[id].paste !== null).sort(),
    );
  });

  test("the rows the parser walks are the rows' own pastes, in that order", () => {
    expect(CONNECTION_STRING_PASTES.map(({ type }) => type)).toEqual([...CONNECTION_STRING_PASTE_ORDER]);
    for (const { type, paste } of CONNECTION_STRING_PASTES)
      expect(paste).toBe(CONNECTION_STRING[type].paste as ConnectionStringPaste);
  });

  test("a listed row that reads no paste is refused by name", () => {
    expect(() => pasteRows(["kafka"], CONNECTION_STRING)).toThrow(
      "the paste order lists kafka, whose row reads no paste",
    );
  });

  test("a catch-all row comes after every row that claims its own spellings", () => {
    const flags = CONNECTION_STRING_PASTES.map(({ paste }) => paste.catchAll);
    expect(flags.indexOf(true)).toBeGreaterThan(-1);
    expect(flags.slice(flags.indexOf(true)).every(Boolean)).toBe(true);
  });

  test("order decides a text two rows claim as their own, and nothing else", () => {
    // A bare Snowflake host and an ADO.NET or shell line can be one text; the order has always given the Snowflake
    // reading to the ADO.NET one and the Databend refusal to the shell line, and still does.
    expect(parseConnectionString("Server=x.snowflakecomputing.com")?.type).toBe("snowflake");
    expect(detectConnectionStringType("Server=x.snowflakecomputing.com")).toBe("snowflake");
    expect(parseConnectionString("BENDSQL_DSN=x.snowflakecomputing.com")?.type).toBe("databend");
  });
});

describe("each fixture text is claimed by exactly one row", () => {
  test("the fixtures were read", () => {
    expect(PARSE_FIXTURES.length).toBeGreaterThan(200);
    expect(DETECT_FIXTURES.length).toBeGreaterThan(30);
  });

  test("every pasted fixture has at most one claimant, and a parsed one is the engine it parsed as", () => {
    const wrong: string[] = [];
    for (const input of PARSE_FIXTURES) {
      const text = pasteText(input);
      const taking = claimants(CONNECTION_STRING_PASTES, text, "claims");
      const parsed = parseConnectionString(input);
      if (taking.length > 1 || (parsed !== null && taking[0] !== parsed.type)) {
        wrong.push(`${JSON.stringify(input)} => ${taking.join(", ") || "none"} (parsed ${parsed?.type ?? "null"})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("every detected fixture has at most one namer, and it is the type detected", () => {
    const wrong: string[] = [];
    for (const input of DETECT_FIXTURES) {
      const naming = claimants(CONNECTION_STRING_PASTES, input.trim().toLowerCase(), "names");
      const detected = detectConnectionStringType(input);
      if (naming.length > 1 || (naming[0] ?? null) !== detected) {
        wrong.push(`${JSON.stringify(input)} => ${naming.join(", ") || "none"} (detected ${detected ?? "null"})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("a planted row that claims another engine's scheme fails by name", () => {
    const thief: Row = {
      type: "trino",
      paste: { catchAll: false, claims: (text) => text.startsWith("postgres"), names: () => false, parse: () => null },
    };
    expect(claimants([...CONNECTION_STRING_PASTES, thief], "postgres://h/d", "claims")).toEqual(["postgres", "trino"]);
  });

  test("a planted catch-all yields to an own claim but not to another catch-all", () => {
    const own: Row = {
      type: "trino",
      paste: { catchAll: false, claims: (text) => text.startsWith("https://"), names: () => false, parse: () => null },
    };
    const wide: Row = { type: "druid", paste: { ...own.paste, catchAll: true } };
    expect(claimants([...CONNECTION_STRING_PASTES, own], "https://h", "claims")).toEqual(["trino"]);
    expect(claimants([...CONNECTION_STRING_PASTES, wide], "https://h", "claims")).toEqual(["clickhouse", "druid"]);
  });
});

/** The type ids and schemes a source text spells as a string literal, import and export specifiers aside. */
function engineLiterals(path: string, text: string): string[] {
  const ids = new Set<string>(IDS);
  const file = sourceOf(path, text);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const specifier =
      (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
      node.parent.moduleSpecifier === node;
    if (!specifier && (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node))) {
      const value = node.text;
      if (ids.has(value) || /[a-z][a-z0-9+.-]*:\/\//i.test(value)) found.push(value);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

describe("the parser names no engine", () => {
  test(`${PARSER} spells no type id and no scheme as a literal`, () => {
    expect(engineLiterals(PARSER, readFileSync(join(ROOT, PARSER), "utf8"))).toEqual([]);
  });

  test("the scan finds a type id, a scheme and a template scheme in planted text, and skips module specifiers", () => {
    const planted = [
      'import { x } from "@/lib/db/providers/sql/postgres-connection-string";',
      'const a = "mysql";',
      'if (text.startsWith("rediss://")) return null;',
      "const b = `jdbc:sc://${host}`;",
      'const c = "keypair";',
    ].join("\n");
    expect(engineLiterals("planted.ts", planted)).toEqual(["mysql", "rediss://", "jdbc:sc://"]);
  });
});

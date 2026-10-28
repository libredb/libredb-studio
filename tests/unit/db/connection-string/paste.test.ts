/**
 * The paste leg of the connection string registry. Each engine's row declares which pasted texts it claims, which it
 * names for `detectConnectionStringType`, and how it parses them; the parser only walks the rows in the one declared
 * order. These tests hold the rows to that contract: every text the parser tests paste is claimed by exactly one row,
 * or by a pair of rows the registry declares may overlap, so a new row that claims another engine's text fails here
 * by name; and the parser itself names no engine and no scheme, and imports no engine module.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { PASTE_FORMATS_TEXT } from "@/lib/connection-paste-formats";
import { detectConnectionStringType, parseConnectionString, pasteText } from "@/lib/connection-string-parser";
import { CONNECTION_PICKER_ORDER } from "@/lib/db/connection-form";
import {
  CONNECTION_STRING,
  CONNECTION_STRING_PASTE_ORDER,
  CONNECTION_STRING_PASTE_OVERLAPS,
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

const DECLARED = new Set(CONNECTION_STRING_PASTE_OVERLAPS.map(({ first, second }) => `${first}, ${second}`));

/**
 * The rows that claim `text`, in the order they are walked, and each pair of them the registry does not declare as an
 * overlap. A catch-all is held to this too: a row that claims ClickHouse's `http://` is a pair nobody declared.
 */
function claimants(
  rows: readonly Row[],
  text: string,
  pick: "claims" | "names",
): { taking: DatabaseType[]; undeclared: string[] } {
  const taking = rows.filter(({ paste }) => paste[pick](text)).map(({ type }) => type);
  const undeclared = taking.flatMap((first, i) =>
    taking.slice(i + 1).flatMap((then) => (DECLARED.has(`${first}, ${then}`) ? [] : [`${first}, ${then}`])),
  );
  return { taking, undeclared };
}

/** Each pasted fixture that `rows` claim through an undeclared pair, or whose first claimant is not what it parsed as. */
function pasteFaults(rows: readonly Row[]): string[] {
  const wrong: string[] = [];
  for (const input of PARSE_FIXTURES) {
    const { taking, undeclared } = claimants(rows, pasteText(input), "claims");
    const parsed = parseConnectionString(input);
    if (undeclared.length > 0 || (parsed !== null && taking[0] !== parsed.type)) {
      wrong.push(`${JSON.stringify(input)} => ${taking.join(", ") || "none"} (parsed ${parsed?.type ?? "null"})`);
    }
  }
  return wrong;
}

/** A planted row of `type` that claims and names every text `claims` matches. */
function planted(type: DatabaseType, catchAll: boolean, claims: (text: string) => boolean): Row {
  return { type, paste: { catchAll, claims, names: claims, parse: () => null, formats: ["planted://"] } };
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

  test("each declared overlap names two rows in the order, the first walked first, and its text is claimed by both", () => {
    for (const { first, second, text } of CONNECTION_STRING_PASTE_OVERLAPS) {
      expect(CONNECTION_STRING_PASTE_ORDER.indexOf(first)).toBeGreaterThan(-1);
      expect(CONNECTION_STRING_PASTE_ORDER.indexOf(second)).toBeGreaterThan(
        CONNECTION_STRING_PASTE_ORDER.indexOf(first),
      );
      expect(claimants(CONNECTION_STRING_PASTES, pasteText(text), "claims")).toEqual({
        taking: [first, second],
        undeclared: [],
      });
      expect(parseConnectionString(text)?.type).toBe(first);
    }
    expect(DECLARED.size).toBe(CONNECTION_STRING_PASTE_OVERLAPS.length);
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

  test("every pasted fixture has one claimant or a declared pair, and the first is the engine it parsed as", () => {
    expect(pasteFaults(CONNECTION_STRING_PASTES)).toEqual([]);
  });

  test("every detected fixture has one namer or a declared pair, and the first is the type detected", () => {
    const wrong: string[] = [];
    for (const input of DETECT_FIXTURES) {
      const { taking, undeclared } = claimants(CONNECTION_STRING_PASTES, input.trim().toLowerCase(), "names");
      const detected = detectConnectionStringType(input);
      if (undeclared.length > 0 || (taking[0] ?? null) !== detected) {
        wrong.push(`${JSON.stringify(input)} => ${taking.join(", ") || "none"} (detected ${detected ?? "null"})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("a planted row that claims another engine's scheme fails by name", () => {
    const thief = planted("trino", false, (text) => text.startsWith("postgres"));
    expect(claimants([...CONNECTION_STRING_PASTES, thief], "postgres://h/d", "claims").undeclared).toEqual([
      "postgres, trino",
    ]);
  });

  test("a planted row walked before ClickHouse that claims its http:// texts fails by name", () => {
    const thief = planted("trino", false, (text) => text.startsWith("http://"));
    const rows = [...CONNECTION_STRING_PASTES.slice(0, -1), thief, ...CONNECTION_STRING_PASTES.slice(-1)];
    expect(rows.at(-1)?.type).toBe("clickhouse");
    const faults = pasteFaults(rows);
    expect(faults.length).toBeGreaterThan(0);
    expect(faults.every((fault) => fault.includes("=> trino, clickhouse"))).toBe(true);
  });

  test("a planted catch-all after ClickHouse fails by name too", () => {
    const wide = planted("druid", true, (text) => text.startsWith("https://"));
    expect(claimants([...CONNECTION_STRING_PASTES, wide], "https://h", "claims").undeclared).toEqual([
      "clickhouse, druid",
    ]);
  });
});

describe("the Paste URL box's formats", () => {
  test("every row that reads a paste names at least one format", () => {
    expect(CONNECTION_STRING_PASTES.filter(({ paste }) => paste.formats.length === 0).map(({ type }) => type)).toEqual(
      [],
    );
  });

  test("the box's list is the rows' formats in the order the engine picker lists them, and nothing else", () => {
    const listed = CONNECTION_PICKER_ORDER.flatMap((type) => CONNECTION_STRING[type].paste?.formats ?? []);
    expect(PASTE_FORMATS_TEXT).toBe(listed.join(", "));
    expect(listed.toSorted()).toEqual(CONNECTION_STRING_PASTES.flatMap(({ paste }) => paste.formats).toSorted());
    expect(PASTE_FORMATS_TEXT.startsWith("postgres://, mysql://")).toBe(true);
  });
});

/**
 * The type ids and schemes a source text spells as a string literal, import and export specifiers aside, and each type
 * id it spells as a name, such as a registry row read as `CONNECTION_STRING.snowflake`.
 */
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
    } else if (ts.isIdentifier(node) && ids.has(node.text)) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

/** The modules the parser may import from: the registry it walks, and the types it names. */
const PARSER_IMPORTS: ReadonlySet<string> = new Set([
  "@/lib/db/connection-string",
  "@/lib/db/connection-string/types",
  "@/lib/types",
]);

/**
 * The names the parser may re-export, by module. The engine modules here hold the sentences the form shows and the
 * parser tests import from the parser; a re-export binds no local name, so it cannot steer a paste.
 */
const PARSER_REEXPORTS: Readonly<Record<string, readonly string[]>> = {
  "@/lib/db/connection-string": ["ENGINE_URI_SCHEMES"],
  "@/lib/db/connection-string/types": ["ParsedConnection"],
  "@/lib/db/providers/sql/databend/paste": [
    "DATABEND_DSN_CAUTIONS",
    "DATABEND_DSN_REFUSALS",
    "DATABEND_SSLMODE_NOTICES",
    "databendNotAppliedNotice",
  ],
  "@/lib/db/providers/sql/snowflake/paste": ["SNOWFLAKE_PASTE_SENTENCES"],
};

/** Each import or re-export in a source text outside the closed lists above, and each `import()` or `require()`. */
function moduleFaults(path: string, text: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!PARSER_IMPORTS.has(node.moduleSpecifier.text)) found.push(`import ${node.moduleSpecifier.text}`);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const allowed = PARSER_REEXPORTS[node.moduleSpecifier.text] ?? [];
      const names =
        node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((element) => (element.propertyName ?? element.name).text)
          : ["*"];
      for (const name of names)
        if (!allowed.includes(name)) found.push(`export ${name} from ${node.moduleSpecifier.text}`);
    } else if (ts.isImportEqualsDeclaration(node)) {
      found.push(`import ${node.name.text} =`);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      found.push(`${node.expression.getText()}()`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(path, text));
  return found;
}

describe("the parser names no engine", () => {
  test(`${PARSER} spells no type id and no scheme as a literal, and no type id as a name`, () => {
    expect(engineLiterals(PARSER, readFileSync(join(ROOT, PARSER), "utf8"))).toEqual([]);
  });

  test(`${PARSER} imports only the registry and its types, and re-exports only the listed names`, () => {
    expect(moduleFaults(PARSER, readFileSync(join(ROOT, PARSER), "utf8"))).toEqual([]);
  });

  test("the module scan finds an engine import, an unlisted re-export, a dynamic import and a require", () => {
    const plantedText = [
      'import { isSnowflakePaste } from "@/lib/db/providers/sql/snowflake/paste";',
      'import type { DatabaseType } from "@/lib/types";',
      'export { parseSnowflakeURL } from "@/lib/db/providers/sql/snowflake/paste";',
      'export { SNOWFLAKE_PASTE_SENTENCES } from "@/lib/db/providers/sql/snowflake/paste";',
      'export * from "@/lib/db/connection-string";',
      'const m = await import("@/lib/db/providers/sql/databend/paste");',
      'const r = require("@/lib/db/providers/sql/databend/paste");',
    ].join("\n");
    expect(moduleFaults("planted.ts", plantedText)).toEqual([
      "import @/lib/db/providers/sql/snowflake/paste",
      "export parseSnowflakeURL from @/lib/db/providers/sql/snowflake/paste",
      "export * from @/lib/db/connection-string",
      "import()",
      "require()",
    ]);
  });

  test("the scan finds a type id, a scheme, a template scheme and a registry row read by name, and skips module specifiers", () => {
    const planted = [
      'import { x } from "@/lib/db/providers/sql/postgres-connection-string";',
      'const a = "mysql";',
      'if (text.startsWith("rediss://")) return null;',
      "const b = `jdbc:sc://${host}`;",
      'const c = "keypair";',
      "if (CONNECTION_STRING.snowflake.paste.claims(text)) return null;",
      "const { databend } = CONNECTION_STRING;",
    ].join("\n");
    expect(engineLiterals("planted.ts", planted)).toEqual([
      "mysql",
      "rediss://",
      "jdbc:sc://",
      "snowflake",
      "databend",
    ]);
  });
});

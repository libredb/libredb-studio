import { beforeAll, describe, expect, test } from "bun:test";
import { statementRefusal, vocabularyTypedConfirmation } from "@/lib/db/destructive-commands";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { ProviderCapabilities, TypedConfirmationAsk } from "@/lib/db/types";
import {
  analyzeStatement,
  type OffsetRange,
  runsAsScript,
  type StatementAnalysis,
  type StatementAnalysisInput,
  type StatementRoute,
  TYPED_NAME_MISSING_REFUSAL,
  type TypedConfirmation,
  typedConfirmationExpected,
} from "@/lib/editor/statement-analysis";
import { editorLanguageOf } from "@/lib/editor/tab-language";
import { hasUnreadableRun, isDangerousQuery } from "@/lib/sql/dangerous-query";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { cursorTarget, selectionTarget } from "@/lib/sql/run-target";
import { countCodeStatements } from "@/lib/sql/statement-splitter";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * One row per acceptance case of #2204, section 5 (the HTTP rows aside), with its expected answer as the issue states
 * it. Offsets are UTF-16 code units; a case with no `name` runs on a connection named "census".
 */
interface Case {
  readonly id: string;
  readonly type: DatabaseType;
  readonly text: string;
  readonly selection: OffsetRange;
  readonly cursor: number;
  readonly name?: string;
  readonly expected: StatementAnalysis;
}

/** A caret at `cursor` with no selection. */
const at = (cursor: number) => ({ selection: { start: cursor, end: cursor }, cursor });
/** A selection of `[start, end)` with the caret at its end. */
const selected = (start: number, end: number) => ({ selection: { start, end }, cursor: end });

const NOTHING: StatementAnalysis = { decision: "nothing" };
const run = (statement: string, start: number, end: number, route: StatementRoute = "query"): StatementAnalysis => ({
  decision: "run",
  statement,
  range: { start, end },
  route,
});
const confirm = (
  statement: string,
  start: number,
  end: number,
  more: { route?: StatementRoute; unreadable?: boolean; typedConfirmation?: TypedConfirmation } = {},
): StatementAnalysis => ({
  decision: "confirm",
  statement,
  range: { start, end },
  route: more.route ?? "query",
  unreadable: more.unreadable ?? false,
  typedConfirmation: more.typedConfirmation ?? null,
});
const refuse = (statement: string, start: number, end: number, refusal: string): StatementAnalysis => ({
  decision: "refuse",
  statement,
  range: { start, end },
  refusal,
});

const TWO = "SELECT 1;\nDELETE FROM t;";
const NESTED = "/* a /* b */ ; DROP TABLE users; -- */ SELECT 1";
const NOTE = "SELECT 1;\n-- note";
const REDIS_TWO = "GET a\nDEL b";
const ETCD_EVERY_KEY = "del '' --prefix";
const ORDERS_ETCD = "orders-etcd";
const REDIS_SECOND_COMMAND =
  'Line 2 holds a second command, which begins with "DEL": each line is one Redis command, and Studio runs one command per run. Select the line to run it, and the editor sends the selection. A command continues onto the next line only inside a quoted argument or an unfinished JSON command.';
const KUBECTL_DELETE =
  "kubectl delete is refused: it is not read-only, and this console only reads the cluster. Nothing was sent.";

const CASES: readonly Case[] = [
  // 5.1 Run target and routing.
  { id: "RT1", type: "postgres", text: TWO, ...at(19), expected: confirm("DELETE FROM t", 10, 23) },
  { id: "RT2", type: "postgres", text: TWO, ...at(3), expected: run("SELECT 1", 0, 8) },
  { id: "RT3", type: "postgres", text: TWO, ...at(9), expected: run("SELECT 1", 0, 8) },
  { id: "RT4", type: "postgres", text: `  ${TWO}`, ...at(0), expected: run("SELECT 1", 2, 10) },
  {
    id: "RT5",
    type: "postgres",
    text: TWO,
    ...selected(0, 24),
    expected: confirm(TWO, 0, 24, { route: "multi-query" }),
  },
  {
    id: "RT6",
    type: "postgres",
    text: "SELECT 1;  \nDELETE FROM t;",
    selection: { start: 9, end: 11 },
    cursor: 11,
    expected: run("SELECT 1", 0, 8),
  },
  { id: "RT7", type: "postgres", text: "SELECT 1;\n\nSELECT 2;", ...at(10), expected: run("SELECT 1", 0, 8) },
  {
    id: "RT8",
    type: "postgres",
    text: "SELECT '😀';\nDELETE FROM t;",
    ...at(22),
    expected: confirm("DELETE FROM t", 13, 26),
  },
  {
    id: "RT9",
    type: "postgres",
    text: "SELECT $$a;b$$;\nSELECT 2;",
    ...at(11),
    expected: run("SELECT $$a;b$$", 0, 14),
  },
  {
    id: "RT10",
    type: "postgres",
    text: "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;",
    ...at(64),
    expected: run("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$", 0, 63),
  },
  {
    id: "RT11",
    type: "mssql",
    text: "CREATE PROCEDURE p AS BEGIN SELECT 1; DELETE FROM t; END\nGO\nSELECT 2",
    ...at(47),
    expected: confirm("CREATE PROCEDURE p AS BEGIN SELECT 1; DELETE FROM t; END", 0, 56, { route: "multi-query" }),
  },
  {
    id: "RT12",
    type: "mssql",
    text: "SELECT 1; DELETE FROM t\nGO\nSELECT 2",
    ...at(3),
    expected: run("SELECT 1", 0, 8),
  },
  { id: "RT13", type: "mssql", text: "SELECT 1\nGO", ...at(7), expected: run("SELECT 1", 0, 8) },
  {
    id: "RT14",
    type: "mssql",
    text: "SELECT 1\nGO",
    ...selected(0, 11),
    expected: run("SELECT 1\nGO", 0, 11, "multi-query"),
  },
  {
    id: "RT15",
    type: "mssql",
    text: "MERGE INTO t USING s ON 1 = 1 WHEN MATCHED THEN DELETE;",
    ...at(55),
    expected: confirm("MERGE INTO t USING s ON 1 = 1 WHEN MATCHED THEN DELETE;", 0, 55),
  },
  { id: "RT16", type: "oracle", text: "SELECT 1 FROM dual;", ...at(16), expected: run("SELECT 1 FROM dual", 0, 18) },
  {
    id: "RT17",
    type: "oracle",
    text: "SELECT 1 FROM dual;",
    ...selected(0, 19),
    expected: run("SELECT 1 FROM dual", 0, 19),
  },
  {
    id: "RT18",
    type: "oracle",
    text: "SELECT 1 FROM dual;\nSELECT 2 FROM dual;",
    ...selected(0, 39),
    expected: run("SELECT 1 FROM dual;\nSELECT 2 FROM dual;", 0, 39, "multi-query"),
  },
  {
    id: "RT19",
    type: "oracle",
    text: "BEGIN\n  DELETE FROM t;\nEND;\n/\nSELECT 1 FROM dual",
    ...at(22),
    expected: confirm("BEGIN\n  DELETE FROM t;\nEND;", 0, 27),
  },
  { id: "RT20", type: "trino", text: "SELECT 1;", ...selected(0, 9), expected: run("SELECT 1", 0, 9) },
  {
    id: "RT21",
    type: "mysql",
    text: "DELIMITER //\nCREATE PROCEDURE p() BEGIN DELETE FROM t; END //\nDELIMITER ;\nCALL p();",
    ...at(79),
    expected: run("CALL p()", 74, 82),
  },
  {
    id: "RT22",
    type: "mysql",
    text: "DELIMITER //\nCREATE PROCEDURE p() BEGIN DELETE FROM t; END //\nDELIMITER ;",
    ...selected(0, 73),
    expected: run("DELIMITER //\nCREATE PROCEDURE p() BEGIN DELETE FROM t; END //\nDELIMITER ;", 0, 73, "multi-query"),
  },
  { id: "RT23", type: "mysql", text: NESTED, ...at(46), expected: NOTHING },
  {
    id: "RT24",
    type: "mysql",
    text: NESTED,
    ...selected(0, 47),
    expected: confirm(NESTED, 0, 47, { route: "multi-query" }),
  },
  { id: "RT25", type: "postgres", text: NESTED, ...at(46), expected: run(NESTED, 0, 47) },

  // 5.2 Nothing to run.
  { id: "N1", type: "postgres", text: NOTE, ...at(17), expected: NOTHING },
  { id: "N2", type: "postgres", text: "SELECT 1; -- note", ...at(17), expected: NOTHING },
  { id: "N3", type: "postgres", text: NOTE, ...selected(10, 17), expected: NOTHING },
  { id: "N4", type: "postgres", text: "", ...at(0), expected: NOTHING },
  { id: "N5", type: "postgres", text: "    ", ...at(2), expected: NOTHING },
  { id: "N6", type: "postgres", text: NOTE, ...selected(0, 17), expected: run(NOTE, 0, 17, "multi-query") },
  { id: "N7", type: "redis", text: "# note", ...at(6), expected: run("# note", 0, 6) },

  // 5.3 Write detection.
  {
    id: "W1",
    type: "postgres",
    text: "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
    ...at(52),
    expected: confirm("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", 0, 53),
  },
  {
    id: "W2",
    type: "postgres",
    text: "EXPLAIN ANALYZE DELETE FROM t",
    ...at(28),
    expected: confirm("EXPLAIN ANALYZE DELETE FROM t", 0, 29),
  },
  {
    id: "W3",
    type: "postgres",
    text: "EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1",
    ...at(44),
    expected: confirm("EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1", 0, 45),
  },
  {
    id: "W4",
    type: "postgres",
    text: "EXPLAIN DELETE FROM t",
    ...at(20),
    expected: run("EXPLAIN DELETE FROM t", 0, 21),
  },
  {
    id: "W5",
    type: "postgres",
    text: "WITH d AS (SELECT 1) SELECT * FROM d",
    ...at(35),
    expected: run("WITH d AS (SELECT 1) SELECT * FROM d", 0, 36),
  },
  {
    id: "W6",
    type: "postgres",
    text: "INSERT INTO t VALUES (1)",
    ...at(22),
    expected: run("INSERT INTO t VALUES (1)", 0, 24),
  },
  {
    id: "W7",
    type: "postgres",
    text: "CREATE TABLE x (a int)",
    ...at(13),
    expected: run("CREATE TABLE x (a int)", 0, 22),
  },
  { id: "W8", type: "postgres", text: "UPDATE t SET a = 1", ...at(17), expected: confirm("UPDATE t SET a = 1", 0, 18) },
  {
    id: "W9",
    type: "postgres",
    text: "SELECT * FROM t FOR UPDATE",
    ...at(26),
    expected: run("SELECT * FROM t FOR UPDATE", 0, 26),
  },
  {
    id: "W10",
    type: "postgres",
    text: "DO $$ BEGIN DELETE FROM t; END $$;\nSELECT 1;",
    ...at(34),
    expected: confirm("DO $$ BEGIN DELETE FROM t; END $$", 0, 33),
  },
  {
    id: "W11",
    type: "postgres",
    text: "SELECT 1 -- note\rDELETE FROM t",
    ...at(30),
    expected: confirm("SELECT 1 -- note\rDELETE FROM t", 0, 30, { unreadable: true }),
  },
  {
    id: "W12",
    type: "postgres",
    text: "SELECT 'abc",
    ...at(11),
    expected: confirm("SELECT 'abc", 0, 11, { unreadable: true }),
  },
  {
    id: "W13",
    type: "postgres",
    text: "SELECT 1; DROP TABLE x",
    ...selected(0, 22),
    expected: confirm("SELECT 1; DROP TABLE x", 0, 22, { route: "multi-query" }),
  },
  {
    id: "W14",
    type: "mysql",
    text: "SELECT 1 # DELETE FROM t\n",
    ...at(25),
    expected: run("SELECT 1 # DELETE FROM t", 0, 24),
  },
  {
    id: "W15",
    type: "sqlite",
    text: "CREATE TRIGGER tr AFTER INSERT ON t BEGIN DELETE FROM u; END;",
    ...at(61),
    expected: run("CREATE TRIGGER tr AFTER INSERT ON t BEGIN DELETE FROM u; END", 0, 60),
  },

  // 5.4 Engines whose text is not SQL.
  { id: "C1", type: "redis", text: "SET k 'a;b'", ...at(6), expected: confirm("SET k 'a;b'", 0, 11) },
  { id: "C2", type: "redis", text: "GET a", ...at(4), expected: run("GET a", 0, 5) },
  { id: "C3", type: "redis", text: REDIS_TWO, ...at(10), expected: refuse(REDIS_TWO, 0, 11, REDIS_SECOND_COMMAND) },
  { id: "C4", type: "redis", text: REDIS_TWO, ...selected(6, 11), expected: confirm("DEL b", 6, 11) },
  {
    id: "C5",
    type: "kubernetes",
    text: "kubectl delete pod web-1",
    ...at(24),
    expected: refuse("kubectl delete pod web-1", 0, 24, KUBECTL_DELETE),
  },
  {
    id: "C6",
    type: "mongodb",
    text: '{"collection":"users","operation":"deleteMany","filter":{}}',
    ...at(59),
    expected: confirm('{"collection":"users","operation":"deleteMany","filter":{}}', 0, 59),
  },
  {
    id: "C7",
    type: "mongodb",
    text: '{"collection":"users","operation":"find","filter":{}}',
    ...at(53),
    expected: run('{"collection":"users","operation":"find","filter":{}}', 0, 53),
  },
  {
    id: "C8",
    type: "etcd",
    text: "del /App/ --prefix",
    ...at(18),
    name: ORDERS_ETCD,
    expected: confirm("del /App/ --prefix", 0, 18, { typedConfirmation: { type: "text", expected: "/App/" } }),
  },
  {
    id: "C9",
    type: "etcd",
    text: ETCD_EVERY_KEY,
    ...at(15),
    name: ORDERS_ETCD,
    expected: confirm(ETCD_EVERY_KEY, 0, 15, {
      typedConfirmation: { type: "connection-name", expected: ORDERS_ETCD, targets: ["every key"] },
    }),
  },
  {
    id: "C10",
    type: "etcd",
    text: "lease revoke 694d8147df1dc4c8",
    ...at(29),
    name: ORDERS_ETCD,
    expected: confirm("lease revoke 694d8147df1dc4c8", 0, 29, {
      typedConfirmation: { type: "text", expected: "694d8147df1dc4c8" },
    }),
  },
  {
    id: "C11",
    type: "etcd",
    text: "txn\n\ndel /app/ --prefix\ndel /cfg/ --prefix\n\n",
    ...at(44),
    name: ORDERS_ETCD,
    expected: confirm("txn\n\ndel /app/ --prefix\ndel /cfg/ --prefix\n\n", 0, 44, {
      typedConfirmation: {
        type: "connection-name",
        expected: ORDERS_ETCD,
        targets: ["/app/ (prefix)", "/cfg/ (prefix)"],
      },
    }),
  },
  { id: "C12", type: "etcd", text: "del /app/a", ...at(10), name: ORDERS_ETCD, expected: confirm("del /app/a", 0, 10) },
  { id: "C13", type: "etcd", text: "get /app/a", ...at(10), name: ORDERS_ETCD, expected: run("get /app/a", 0, 10) },
  {
    id: "C14",
    type: "etcd",
    text: ETCD_EVERY_KEY,
    ...at(15),
    name: "",
    expected: refuse(ETCD_EVERY_KEY, 0, 15, TYPED_NAME_MISSING_REFUSAL),
  },
  {
    id: "C15",
    type: "libredb",
    text: "SELECT 1; DELETE FROM t",
    ...at(22),
    expected: confirm("SELECT 1; DELETE FROM t", 0, 23),
  },
];

/**
 * The cases whose target holds no code: the web editor sends it, where `analyzeStatement` answers nothing to run, the
 * divergence `docs/BACKLOG.md` U200 records.
 */
const NO_CODE_TARGETS: readonly string[] = ["RT23", "N1", "N2", "N3", "N4", "N5"];

/**
 * Each engine's capabilities from its real provider, built without connecting as `POST /api/db/provider-meta` builds
 * it, so no fixture here can drift from a shipped declaration.
 */
const capabilitiesOf = new Map<DatabaseType, ProviderCapabilities>();
beforeAll(async () => {
  const types = [...new Set(CASES.map((c) => c.type))];
  const providers = await Promise.all(types.map((type) => createDatabaseProvider(CENSUS_CONNECTION[type])));
  types.forEach((type, index) => capabilitiesOf.set(type, providers[index].getCapabilities()));
});

function inputOf(c: Case): StatementAnalysisInput {
  const capabilities = capabilitiesOf.get(c.type);
  if (capabilities === undefined) throw new Error(`no capabilities were read for ${c.type}`);
  return {
    text: c.text,
    selection: c.selection,
    cursor: c.cursor,
    databaseType: c.type,
    capabilities,
    connectionName: c.name ?? "census",
  };
}

describe("analyzeStatement", () => {
  test("the table holds the 62 cases of section 5 that are not about HTTP, each id once", () => {
    expect(CASES.length).toBe(62);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(62);
  });

  test.each(CASES.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    expect(analyzeStatement(inputOf(c))).toStrictEqual(c.expected);
  });

  test("a name-typed confirmation on a connection with no name is refused with its own sentence", () => {
    expect(TYPED_NAME_MISSING_REFUSAL).toBe(
      "This statement is confirmed by typing the connection's name, and this connection has no name, so it cannot run.",
    );
    const c9 = CASES.find((c) => c.id === "C9") as Case;
    expect(analyzeStatement({ ...inputOf(c9), connectionName: undefined })).toStrictEqual(
      refuse(ETCD_EVERY_KEY, 0, 15, TYPED_NAME_MISSING_REFUSAL),
    );
  });

  test("throws the run target's RangeError, with its sentence, on offsets it cannot honour", () => {
    const rt1 = inputOf(CASES[0]);
    expect(() => analyzeStatement({ ...rt1, selection: { start: 5, end: 2 } })).toThrow(RangeError);
    expect(() => analyzeStatement({ ...rt1, selection: { start: 5, end: 2 } })).toThrow(
      "run target: selection [5, 2) is not within a text of length 24",
    );
    expect(() => analyzeStatement({ ...rt1, selection: { start: 0, end: 0 }, cursor: 99 })).toThrow(
      "run target: cursor 99 is not within a text of length 24",
    );
  });
});

/**
 * What the web editor decides for the same input, composed from the exported parts the way it calls them: the target
 * as `QueryEditor.tsx`'s `getEffectiveQuery` picks it (a non-blank selection through `selectionTarget`, then the
 * caret's statement through `cursorTarget`, then the whole text); the refusal, then the confirmation gate, as
 * `use-query-execution.ts` asks them of that text; its route; and the typed value and the unreadable notice as
 * `QuerySafetyDialog` reads them. A typed ask with nothing to type is the dialog's refusal in place of the field, which
 * keeps Proceed disabled. Nothing here decides "nothing": the web editor has no such step.
 */
function webDecision(c: Case, capabilities: ProviderCapabilities): StatementAnalysis {
  const rule = {
    editorLanguage: editorLanguageOf(capabilities),
    statementTerminator: capabilities.statementTerminator,
    grammar: resolveSqlGrammar(c.type),
  };
  let statement = c.text;
  let range: OffsetRange = { start: 0, end: c.text.length };
  const selection = selectionTarget(c.text.slice(c.selection.start, c.selection.end), rule);
  const current = selection === null ? cursorTarget(c.text, c.cursor, rule) : null;
  if (selection !== null) {
    statement = selection;
    range = { start: c.selection.start, end: c.selection.end };
  } else if (current !== null) {
    statement = current.sql;
    range = { start: current.start, end: current.end };
  }
  const refusal = statementRefusal(statement, c.type);
  if (refusal !== undefined) return { decision: "refuse", statement, range, refusal };
  const route = runsAsScript(statement, c.type, capabilities.queryLanguage) ? "multi-query" : "query";
  if (!isDangerousQuery(statement, c.type)) return { decision: "run", statement, range, route };
  const ask: TypedConfirmationAsk | undefined = vocabularyTypedConfirmation(c.type, statement);
  let typedConfirmation: TypedConfirmation | null = null;
  if (ask !== undefined) {
    const expected = typedConfirmationExpected(ask, c.name ?? "census");
    if (expected === undefined) return { decision: "refuse", statement, range, refusal: TYPED_NAME_MISSING_REFUSAL };
    typedConfirmation =
      ask.type === "text"
        ? { type: "text", expected }
        : { type: "connection-name", expected, targets: [...ask.targets] };
  }
  return {
    decision: "confirm",
    statement,
    range,
    route,
    unreadable: hasUnreadableRun(statement, c.type),
    typedConfirmation,
  };
}

describe("analyzeStatement and the web editor's own composition", () => {
  test("the cases that answer nothing to run are exactly the ones whose target holds no code", () => {
    expect(CASES.filter((c) => c.expected.decision === "nothing").map((c) => c.id)).toEqual([...NO_CODE_TARGETS]);
  });

  test.each(CASES.map((c) => [c.id, c] as const))("%s decides as the web editor does", (id, c) => {
    const input = inputOf(c);
    const web = webDecision(c, input.capabilities);
    if (!NO_CODE_TARGETS.includes(id)) {
      expect(analyzeStatement(input)).toStrictEqual(web);
      return;
    }
    // The recorded divergence: the web editor sends a target that holds no code without asking.
    expect(analyzeStatement(input)).toStrictEqual(NOTHING);
    expect(web.decision).toBe("run");
    const sent = web.decision === "run" ? web.statement : undefined;
    expect(sent).toBeDefined();
    expect(countCodeStatements(sent as string, resolveSqlGrammar(c.type))).toBe(0);
  });
});

describe("runsAsScript", () => {
  test("a text of more than one statement runs as a script", () => {
    expect(runsAsScript("SELECT 1; SELECT 2", "postgres", "sql")).toBe(true);
  });

  test("one statement written with a separator line runs as a script, which strips the line", () => {
    expect(runsAsScript("SELECT 1\nGO", "mssql", "sql")).toBe(true);
  });

  test("one statement runs on the single-statement route", () => {
    expect(runsAsScript("SELECT 1", "postgres", "sql")).toBe(false);
    expect(runsAsScript("SELECT 1;", "postgres", "sql")).toBe(false);
  });

  test("a type whose vocabulary bounds its console text never runs as a script, whatever language is passed", () => {
    // The web passes "sql" while the provider's metadata is still loading, and the bound is static.
    expect(runsAsScript("SELECT 1; SELECT 2", "kubernetes", "sql")).toBe(false);
  });

  test("a text in a query language other than SQL never runs as a script", () => {
    expect(runsAsScript("SELECT 1; SELECT 2", "mongodb", "json")).toBe(false);
    expect(runsAsScript("SELECT 1; SELECT 2", "postgres", "json")).toBe(false);
  });
});

describe("typedConfirmationExpected", () => {
  const NAME_ASK: TypedConfirmationAsk = { type: "connection-name", targets: ["every key"] };

  test("a text ask expects its own text, whatever the connection is called", () => {
    expect(typedConfirmationExpected({ type: "text", text: "/App/" }, "orders-etcd")).toBe("/App/");
    expect(typedConfirmationExpected({ type: "text", text: "/App/" }, undefined)).toBe("/App/");
  });

  test("a name ask expects the connection's name, exactly as it is written", () => {
    expect(typedConfirmationExpected(NAME_ASK, "orders-etcd")).toBe("orders-etcd");
    expect(typedConfirmationExpected(NAME_ASK, " Orders ")).toBe(" Orders ");
  });

  test("a name ask with an empty name or no name expects nothing, so no field can confirm it", () => {
    expect(typedConfirmationExpected(NAME_ASK, "")).toBeUndefined();
    expect(typedConfirmationExpected(NAME_ASK, undefined)).toBeUndefined();
  });
});

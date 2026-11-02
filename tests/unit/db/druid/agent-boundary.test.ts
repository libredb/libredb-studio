/**
 * The agent read-only profile's proof that the Druid endpoint runs the native engine, and the statement fence in front
 * of every agent statement, against the answers a live Apache Druid 37.0.0 gave, as
 * `tests/fixtures/druid/37.0.0/agent-boundary/` records them. The probe statement is pinned by its full text, and each
 * refusal by its code and its words.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError } from "@/lib/db/errors";
import {
  druidAgentExplainStatement,
  druidAgentPlanMessage,
  druidAgentProbeStatement,
  druidAgentReachRefusal,
  druidAgentStatementRefusal,
  verifyDruidAgentEngine,
} from "@/lib/db/providers/sql/druid/agent-boundary";
import {
  DRUID_TRANSPORT_FAILURE,
  type DruidQueryResult,
  DruidTransportError,
} from "@/lib/db/providers/sql/druid/transport";

const NONCE = "0123456789abcdef01234567";

/** The native engine's refusal of an INSERT, as captures 01 and 06 record it. */
const NATIVE_REFUSAL = new DruidTransportError(
  "INSERT operations are not supported by requested SQL engine [native], consider using MSQ.",
  "INVALID_INPUT",
  "invalidInput",
  "USER",
);

const ANSWERED: DruidQueryResult = {
  rows: [],
  fieldNames: [],
  sqlTypes: {},
  nativeTypes: {},
  executionTimeMs: 1,
  unavailableSegments: null,
};

function prober(answer: DruidQueryResult | Error = NATIVE_REFUSAL) {
  const sent: string[] = [];
  return {
    sent,
    probe: async (sql: string) => {
      sent.push(sql);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

async function refusal(answer: DruidQueryResult | Error): Promise<ExecutionProfileError> {
  try {
    await verifyDruidAgentEngine(prober(answer).probe, NONCE);
  } catch (error) {
    if (error instanceof ExecutionProfileError) return error;
    throw error;
  }
  throw new Error("the check admitted the server");
}

describe("the engine check", () => {
  test("the probe is an INSERT into one freshly named datasource", () => {
    expect(druidAgentProbeStatement(NONCE)).toBe(
      "INSERT INTO \"libredb_agent_probe_0123456789abcdef01234567\" SELECT TIME_PARSE('2026-01-01') AS __time PARTITIONED BY ALL",
    );
  });

  test("admits a server that refuses the probe with the native engine's own refusal", async () => {
    const recorded = prober();
    await verifyDruidAgentEngine(recorded.probe, NONCE);
    expect(recorded.sent).toEqual([druidAgentProbeStatement(NONCE)]);
  });

  test("refuses a server that ran the INSERT as one that does not enforce the native engine", async () => {
    const error = await refusal(ANSWERED);
    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(
      "The agent read-only execution profile needs the Druid SQL endpoint's native engine, which refuses every INSERT; this server ran one, so it does not enforce it, and the connection is refused.",
    );
  });

  test.each([
    [
      "another engine's refusal",
      new DruidTransportError("Unsupported engine[msq-task]", "INVALID_INPUT", "invalidInput"),
    ],
    [
      "the same words under another category",
      new DruidTransportError(NATIVE_REFUSAL.message, "UNCATEGORIZED", "general"),
    ],
    ["a refusal of the user's permission", new DruidTransportError("Unauthorized", "FORBIDDEN", "general")],
    [
      "the refusal with more words after it",
      new DruidTransportError(`${NATIVE_REFUSAL.message} Or not.`, "INVALID_INPUT", "invalidInput"),
    ],
  ])("refuses %s as an answer it cannot read", async (_name, answer) => {
    const error = await refusal(answer);
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toBe(
      `The agent read-only execution profile needs the Druid SQL endpoint's native engine, which refuses every INSERT; this server answered the probe with "${answer.message}", which is not that refusal, so its enforcement is unmeasured, and the connection is refused.`,
    );
  });

  test("lets a failure to reach the server leave as it came", async () => {
    const unreachable = new DruidTransportError("Druid request failed: refused", DRUID_TRANSPORT_FAILURE);
    await expect(verifyDruidAgentEngine(prober(unreachable).probe, NONCE)).rejects.toBe(unreachable);
    const other = new Error("boom");
    await expect(verifyDruidAgentEngine(prober(other).probe, NONCE)).rejects.toBe(other);
  });
});

const FENCE =
  "The agent read-only execution profile sends one Druid SQL statement, a SELECT (a WITH before it is fine), and nothing else";

describe("the statement fence", () => {
  test.each([
    ['SELECT COUNT(*) AS n FROM "libredb_agent_data"'],
    ["select 1 as a"],
    ["SeLeCt 1 AS a"],
    ["  \n\tSELECT 1 AS a"],
    ["-- lead\nSELECT 1 AS a"],
    ["// lead\nSELECT 1 AS a"],
    ["-- lead\r\nSELECT 1 AS a"],
    ["/* lead */ SELECT 1 AS a"],
    ["/* a /* b */ SELECT 1 AS a"],
    ["SELECT 1 AS a;"],
    ["SELECT 1 AS a; -- trailing"],
    ["SELECT 1 AS a; /* trailing */ \n"],
    ["SELECT 1 AS a // note\n, 2 AS b"],
    ["SELECT 'a;b' AS a, \"c;d\" AS b"],
    ["SELECT /*+ h(';') */ 1 AS a"],
    ["SELECT ARRAY_LENGTH(ARRAY[1, 2]) AS a"],
    ["SELECT 1 AS a UNION ALL SELECT 2 AS a"],
    ["WITH t AS (SELECT 1 AS a) SELECT a FROM t"],
    ["SELECT 1 AS $t$"],
    ["SELECT U&'\\0041' AS a"],
  ])("admits %j", (sql) => {
    expect(druidAgentStatementRefusal(sql)).toBeNull();
  });

  const NOT_SELECT = `${FENCE}; this statement does not begin with SELECT or WITH, so it was not sent. A SET before a statement changes the request's own context, the engine and the query id among them, so only a SELECT reaches the server.`;

  test.each([
    ["SET engine = 'msq-task'; INSERT INTO t SELECT 1 AS a PARTITIONED BY ALL"],
    ["SET sqlQueryId = 'x'; SELECT 1 AS a"],
    ["set engine='MSQ-TASK'; SELECT 1 AS a"],
    ["/* note */ SET engine = 'msq-task'; SELECT 1 AS a"],
    ["RESET engine; SELECT 1 AS a"],
    ["ALTER SESSION SET engine = 'msq-task'"],
    ["INSERT INTO t SELECT 1 AS a PARTITIONED BY ALL"],
    ["REPLACE INTO t OVERWRITE ALL SELECT 1 AS a PARTITIONED BY ALL"],
    ["UPSERT INTO t SELECT 1 AS a PARTITIONED BY ALL"],
    ["EXPLAIN PLAN FOR SELECT 1 AS a"],
    ["VALUES (1)"],
    ["(SELECT 1 AS a)"],
    ['"select" FROM x'],
    ["SELECTED"],
    ["WITHIN"],
    [" SELECT 1 AS a"],
    ["﻿SELECT 1 AS a"],
    ["# SELECT 1"],
    ["-- SELECT 1\nSET engine = 'msq-task'; SELECT 1 AS a"],
    ["// SELECT 1\nSET engine = 'msq-task'; SELECT 1 AS a"],
    ["/* SELECT 1 */ SET engine = 'msq-task'; SELECT 1 AS a"],
  ])("refuses %j as no SELECT", (sql) => {
    expect(druidAgentStatementRefusal(sql)).toBe(NOT_SELECT);
  });

  test.each([
    ["SELECT 1 AS a; SET engine = 'msq-task'"],
    ["SELECT 1 AS a;;"],
    ["SELECT 1 AS a; SELECT 2 AS b"],
    ["SELECT ARRAY[1;2] AS a"],
    ["SELECT /*+ h(1); */ 1 AS a"],
    ["SELECT 1 AS a; 'x'"],
  ])("refuses %j as more than one statement", (sql) => {
    expect(druidAgentStatementRefusal(sql)).toBe(
      `${FENCE}; this text goes on after its first statement's semicolon, so it was not sent. Send one SELECT at a time.`,
    );
  });

  test.each([
    ["SELECT 1 AS a /* x"],
    ["SELECT 'x AS a"],
    ['SELECT "x AS a'],
    ["SELECT 'a\\' AS a"],
    ["SELECT E'it\\'s' AS a"],
  ])("refuses %j, which ends inside a comment, a string or a name as the reader reads it", (sql) => {
    expect(druidAgentStatementRefusal(sql)).toBe(
      `${FENCE}; this text ends inside a comment, a string or a quoted name, so where it ends cannot be read, and it was not sent.`,
    );
  });

  test.each([["SELECT $$x$$ AS a"], ["SELECT 1 AS a, $$ -- $$ AS b"]])(
    "refuses %j, a dollar run Druid reads as a name",
    (sql) => {
      expect(druidAgentStatementRefusal(sql)).toBe(
        `${FENCE}; this text holds a dollar-quoted run ($$ ... $$), which Druid reads as part of a name rather than as a string, so where its comments end cannot be read, and it was not sent.`,
      );
    },
  );

  test.each([
    ["-- x\rSET engine = 'msq-task'; SELECT 1 AS a"],
    ["SELECT 1 AS a -- x\r, 2 AS b"],
    ["SELECT 1 AS a // x\r, 2 AS b"],
    ["SELECT 1 AS a -- x\r\r; SET engine = 'msq-task'"],
  ])("refuses %j, a carriage return inside a line comment with more text after it", (sql) => {
    expect(druidAgentStatementRefusal(sql)).toBe(
      `${FENCE}; this text holds a carriage return inside a -- or // comment with more text after it, and the server ends the comment at that carriage return, so a reader that does not could read another statement, and it was not sent. End a comment with a line feed.`,
    );
  });

  const OUTSIDE_DATASOURCES = `${FENCE}; this statement reads the sys, lookup or view schema or calls LOOKUP, which answer the cluster's own servers, segments, tasks, supervisors, lookups or views rather than a datasource's rows, so it was not sent. Read the datasources themselves.`;

  test.each([
    ["SELECT * FROM sys.segments"],
    ["SELECT COUNT(*) AS n FROM sys.tasks"],
    ["SELECT spec FROM sys.supervisors"],
    ["SELECT * FROM sys.server_segments"],
    ["SELECT * FROM sys.servers"],
    ["SELECT * FROM sys.server_properties"],
    ['SELECT * FROM "sys"."segments"'],
    ["SELECT * FROM SYS.segments"],
    ['SELECT * FROM "SyS".segments'],
    ["SELECT * FROM sys /* c */ . segments"],
    ["SELECT * FROM sys -- c\n.segments"],
    ["SELECT * FROM druid.sys.segments"],
    ["SELECT * FROM lookup.libredb_country_names"],
    ['SELECT k FROM "lookup"."libredb_country_names"'],
    ["SELECT d.x FROM libredb_agent_data d JOIN lookup.l ON d.s = l.k"],
    ["SELECT * FROM view.v"],
    ["SELECT LOOKUP('US', 'libredb_country_names') AS a"],
    ["SELECT lookup (s, 'l') AS a FROM t"],
    ["SELECT \"LOOKUP\"(s, 'l') AS a FROM t"],
    ["WITH t AS (SELECT * FROM sys.segments) SELECT COUNT(*) FROM t"],
    ["SELECT ARRAY[(SELECT COUNT(*) FROM sys.tasks)] AS a"],
  ])("refuses %j, which reads beyond the datasources", (sql) => {
    expect(druidAgentStatementRefusal(sql)).toBe(OUTSIDE_DATASOURCES);
  });

  test.each([
    ["SELECT sys FROM t"],
    ['SELECT "sys" FROM t'],
    ["SELECT t.sys FROM t"],
    ["SELECT lookup FROM t"],
    ["SELECT 'sys.segments' AS a"],
    ["SELECT 1 AS a -- sys.segments"],
    ["SELECT 1 AS a /* LOOKUP(x) */"],
    ["SELECT systems.x FROM systems"],
    ["SELECT * FROM my_sys.t"],
    ["SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'druid'"],
  ])("admits %j, which names no schema beyond the datasources", (sql) => {
    expect(druidAgentStatementRefusal(sql)).toBeNull();
  });

  test.each([
    ['SELECT COUNT(*) AS n FROM U&"\\0073ys".segments'],
    ['SELECT COUNT(*) AS n FROM u&"\\006cookup".libredb_country_names'],
    ["SELECT U&\"!0073ys\" UESCAPE '!' FROM t"],
  ])("refuses %j, a name spelled with Unicode escapes, which the reader cannot compare", (sql) => {
    expect(druidAgentStatementRefusal(sql)).toBe(
      `${FENCE}; this statement spells a quoted name with Unicode escapes (U&"..."), which the server reads as another name, so it was not sent. Write the name itself.`,
    );
  });

  test("admits a Unicode-escaped string literal, which is a value and not a name", () => {
    expect(druidAgentStatementRefusal("SELECT U&'\\0073ys' AS a")).toBeNull();
  });

  test("refuses text that holds no statement", () => {
    for (const sql of ["", "   ", "-- only a comment", "// only a comment", "/* only */", ";"]) {
      expect(druidAgentStatementRefusal(sql)).not.toBeNull();
    }
    expect(druidAgentStatementRefusal("-- only a comment")).toBe(
      `${FENCE}; this text holds no statement, so nothing was sent.`,
    );
  });
});

/** One EXPLAIN PLAN FOR answer, as the transport hands it back: a row of three JSON-text columns. */
function explained(plan: unknown, resources: unknown = []): DruidQueryResult {
  return {
    ...ANSWERED,
    fieldNames: ["PLAN", "RESOURCES", "ATTRIBUTES"],
    rows: [
      {
        PLAN: typeof plan === "string" ? plan : JSON.stringify(plan),
        RESOURCES: typeof resources === "string" ? resources : JSON.stringify(resources),
        ATTRIBUTES: '{"statementType":"SELECT"}',
      },
    ],
  };
}

/** A native plan of one query over `dataSource`, as Druid 37.0.0 answers it (capture 08), with `extra` merged in. */
const native = (dataSource: unknown, extra: Record<string, unknown> = {}) => [
  { query: { queryType: "scan", dataSource, columns: ["x"], ...extra }, signature: [], columnMappings: [] },
];
const DATA = { type: "table", name: "libredb_agent_data" };
const DATA_RESOURCE = [{ name: "libredb_agent_data", type: "DATASOURCE" }];

/**
 * The second layer: what the planner says a statement reads, asked with EXPLAIN PLAN FOR before the statement is sent,
 * and held to datasources. Every plan shape below is one Druid 37.0.0 answered (capture 08).
 */
describe("the planner check", () => {
  test("asks the planner for the statement as it will be sent, on a line of its own", () => {
    expect(druidAgentExplainStatement("SELECT x FROM t LIMIT 3")).toBe("EXPLAIN PLAN FOR\nSELECT x FROM t LIMIT 3");
  });

  // Measured on 37.0.0: `SELECT nope` answers column 8 of line 1 sent raw, and line 2, column 8 asked of the planner on
  // a line of its own; `SELECT 1,\n  nope` answers line 2, column 3 raw, and line 3, column 3 asked of the planner.
  test.each([
    [
      "Column 'nope' not found in any table (line [2], column [8])",
      "Column 'nope' not found in any table (line [1], column [8])",
    ],
    [
      "Column 'nope' not found in any table (line [3], column [3])",
      "Column 'nope' not found in any table (line [2], column [3])",
    ],
    [
      'Received an unexpected token [1] (line [2], column [10]), acceptable options: [<EOF>, "ORDER"]',
      'Received an unexpected token [1] (line [1], column [10]), acceptable options: [<EOF>, "ORDER"]',
    ],
    // A position on the planner's own first line is not one in the statement, so it is left as the server wrote it.
    [
      "Received an unexpected token [x] (line [1], column [5])",
      "Received an unexpected token [x] (line [1], column [5])",
    ],
    ["Object 'nope' not found", "Object 'nope' not found"],
  ])("moves the planner's position %j back onto the statement's own line", (message, statements) => {
    expect(druidAgentPlanMessage(message)).toBe(statements);
  });

  test.each([
    ["a scan of a datasource", native(DATA), DATA_RESOURCE],
    ["inline rows", native({ type: "inline", columnNames: ["a"], columnTypes: ["LONG"], rows: [[1]] }), []],
    ["a union of datasources", native({ type: "union", dataSources: [DATA, DATA] }), DATA_RESOURCE],
    [
      "an unnest over a datasource",
      native({
        type: "unnest",
        base: DATA,
        virtualColumn: { type: "expression", name: "j0.unnest", expression: '"s"' },
      }),
      DATA_RESOURCE,
    ],
    [
      "a join of a datasource and a subquery over it",
      native({
        type: "join",
        left: DATA,
        right: { type: "query", query: { queryType: "groupBy", dataSource: DATA } },
        joinType: "INNER",
      }),
      DATA_RESOURCE,
    ],
    [
      "a join of a datasource and inline rows",
      native({ type: "join", left: DATA, right: { type: "inline", rows: [[1]] }, joinType: "INNER" }),
      DATA_RESOURCE,
    ],
    [
      "a read of INFORMATION_SCHEMA, which plans as Calcite's own scan",
      "BindableProject(TABLE_NAME=[$2])\n  BindableFilter(condition=[=($1, 'druid')])\n    BindableTableScan(table=[[INFORMATION_SCHEMA, TABLES]])\n",
      [],
    ],
    [
      "a join of two INFORMATION_SCHEMA tables",
      "BindableJoin(condition=[=($0, $1)], joinType=[inner])\n  BindableTableScan(table=[[INFORMATION_SCHEMA, TABLES]])\n  BindableTableScan(table=[[INFORMATION_SCHEMA, COLUMNS]], projects=[[1]])\n",
      [],
    ],
    // A statement whose filter the planner proves empty, the agent's relation read among them, reads no table at all.
    ["a Calcite plan that reads no table", "BindableValues(tuples=[[]])\n", []],
  ])("admits %s", (_name, plan, resources) => {
    expect(druidAgentReachRefusal(explained(plan, resources))).toBeNull();
  });

  const reads = (what: string) =>
    `${FENCE}; the planner says this statement reads ${what}, which is not a datasource, so it was not sent. Read the datasources themselves.`;

  test.each([
    [
      "a system table",
      "BindableAggregate(group=[{}], n=[COUNT()])\n  BindableTableScan(table=[[sys, segments]])\n",
      [],
      "the table sys.segments",
    ],
    [
      "a system table joined to INFORMATION_SCHEMA",
      "BindableProject(TABLE_NAME=[$0])\n  BindableJoin(condition=[=($0, $1)], joinType=[inner])\n    BindableProject(TABLE_NAME=[$2])\n      BindableTableScan(table=[[INFORMATION_SCHEMA, TABLES]])\n    BindableTableScan(table=[[sys, segments]], projects=[[1]])\n",
      [],
      "the table sys.segments",
    ],
    ["a lookup", native({ type: "lookup", lookup: "libredb_country_names" }), [], "the lookup libredb_country_names"],
    [
      "a datasource joined to a lookup",
      native({ type: "join", left: DATA, right: { type: "lookup", lookup: "libredb_country_names" } }),
      DATA_RESOURCE,
      "the lookup libredb_country_names",
    ],
    [
      "a lookup in a subquery",
      native({ type: "query", query: { queryType: "groupBy", dataSource: { type: "lookup", lookup: "l" } } }),
      [],
      "the lookup l",
    ],
    [
      "the lookup function over a column",
      native(DATA, {
        virtualColumns: [{ type: "expression", name: "v0", expression: "lookup(\"s\",'libredb_country_names')" }],
      }),
      DATA_RESOURCE,
      "a lookup, through the lookup function",
    ],
    [
      "a registered lookup in a dimension",
      native(DATA, {
        dimensions: [{ type: "extraction", dimension: "s", extractionFn: { type: "registeredLookup", lookup: "l" } }],
      }),
      DATA_RESOURCE,
      "a lookup, through the lookup function",
    ],
    ["external data", native({ type: "external", inputSource: { type: "http" } }), [], "a dataSource of type external"],
    [
      "a dataSource of a type it does not know",
      native({ type: "restrict", base: DATA }),
      DATA_RESOURCE,
      "a dataSource of type restrict",
    ],
    [
      "a datasource the planner does not list as one the statement reads",
      native({ type: "table", name: "libredb_agent_other" }),
      DATA_RESOURCE,
      "the table libredb_agent_other, which it does not list among the datasources the statement reads",
    ],
    [
      "a union with a member the planner does not list as one the statement reads",
      native({ type: "union", dataSources: [DATA, { type: "table", name: "libredb_agent_other" }] }),
      DATA_RESOURCE,
      "the table libredb_agent_other, which it does not list among the datasources the statement reads",
    ],
    [
      "a union with a lookup member",
      native({ type: "union", dataSources: [DATA, { type: "lookup", lookup: "l" }] }),
      DATA_RESOURCE,
      "the lookup l",
    ],
    [
      "an unnest over a datasource the planner does not list as one the statement reads",
      native({ type: "unnest", base: { type: "table", name: "libredb_agent_other" } }),
      DATA_RESOURCE,
      "the table libredb_agent_other, which it does not list among the datasources the statement reads",
    ],
    ["an unnest over a lookup", native({ type: "unnest", base: { type: "lookup", lookup: "l" } }), [], "the lookup l"],
    [
      "a resource that is not a datasource",
      native(DATA),
      [...DATA_RESOURCE, { name: "v", type: "VIEW" }],
      "the VIEW v",
    ],
  ])("refuses %s", (_name, plan, resources, what) => {
    expect(druidAgentReachRefusal(explained(plan, resources))).toBe(reads(what));
  });

  const UNREADABLE = `${FENCE}; the planner's account of what this statement reads could not be read, so it was not sent.`;

  test.each([
    ["no row", { ...ANSWERED, rows: [] }],
    [
      "two rows, each a plan it would admit",
      (() => {
        const answer = explained(native(DATA), DATA_RESOURCE);
        return { ...answer, rows: [answer.rows[0], answer.rows[0]] };
      })(),
    ],
    ["no PLAN", { ...ANSWERED, rows: [{ RESOURCES: "[]" }] }],
    ["a PLAN that is not text", { ...ANSWERED, rows: [{ PLAN: 1, RESOURCES: "[]" }] }],
    ["RESOURCES that are not JSON", explained(native(DATA), "not json")],
    ["RESOURCES that are not a list", explained(native(DATA), "{}")],
    ["a resource with no type", explained(native(DATA), [{ name: "x" }])],
    ["a native plan with no query", explained([{ signature: [] }], [])],
    ["an empty native plan", explained([], [])],
    ["a query with no dataSource", explained([{ query: { queryType: "scan" } }], [])],
    ["a join with no right side", explained(native({ type: "join", left: DATA }), DATA_RESOURCE)],
    ["a union with no list", explained(native({ type: "union" }), DATA_RESOURCE)],
    ["a table with no name", explained(native({ type: "table" }), DATA_RESOURCE)],
    ["a lookup with no name", explained(native({ type: "lookup" }), [])],
    ["text that is no plan", explained("SELECT 1", [])],
    [
      "a Calcite plan with a line it does not know",
      explained("BindableTableScan(table=[[INFORMATION_SCHEMA, TABLES]])\nDruidQueryRel(x)\n", []),
    ],
    // A scan is read only in the shape Calcite writes it, `table=[[schema, table]]`; any other scan line is unreadable.
    ["a scan with no space after the schema", explained("BindableTableScan(table=[[sys,segments]])\n", [])],
    ["a scan that names its table another way", explained("BindableTableScan(name=[sys.segments])\n", [])],
    ["a scan of another kind", explained("BindableTableFunctionScan(invocation=[segments()])\n", [])],
    [
      "a scan line among readable ones",
      explained(
        "BindableJoin(condition=[=($0, $1)], joinType=[inner])\n  BindableTableScan(table=[[INFORMATION_SCHEMA, TABLES]])\n  BindableTableScan(table=[[sys,segments]])\n",
        [],
      ),
    ],
    ["a nesting past any real plan", explained(native(nested(40)), [])],
  ])("refuses %s as unreadable", (_name, answer) => {
    expect(druidAgentReachRefusal(answer as DruidQueryResult)).toBe(UNREADABLE);
  });
});

/** A dataSource nested `depth` subqueries deep over inline rows. */
function nested(depth: number): unknown {
  let dataSource: unknown = { type: "inline", rows: [[1]] };
  for (let level = 0; level < depth; level++) dataSource = { type: "query", query: { queryType: "scan", dataSource } };
  return dataSource;
}

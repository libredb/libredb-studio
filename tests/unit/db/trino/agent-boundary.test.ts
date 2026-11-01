/**
 * The Trino agent boundary: the proof that the operator's access control refuses every catalog's table functions and
 * catalog management, and the fence in front of every agent statement. Every refusal replayed below is the server's own
 * answer, word for word, from `tests/fixtures/trino/476/agent-boundary/` (captures 00 to 02): the read-only access
 * control's and the file rules' PERMISSION_DENIED, the default's argument errors and CATALOG_NOT_FOUND, and every
 * control's FUNCTION_NOT_FOUND for a name a catalog does not have.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError } from "@/lib/db/errors";
import {
  proveTrinoAgentBoundary,
  readTrinoCatalogs,
  TRINO_CATALOG_LIST_STATEMENT,
  trinoAgentStatementRefusal,
  trinoCatalogManagementProbe,
  trinoFunctionListStatement,
  trinoTableFunctionProbe,
} from "@/lib/db/providers/sql/trino/agent-boundary";
import { type TrinoQueryResult, type TrinoRow, TrinoTransportError } from "@/lib/db/providers/sql/trino/transport";
import { resolveSqlGrammar } from "@/lib/sql/grammar";

const NONCE = "0123456789abcdef01234567";

const FUNCTION_COLUMNS = ["Function", "Return Type", "Argument Types", "Function Type", "Deterministic", "Description"];

function result(fieldNames: string[], rows: unknown[][]): TrinoQueryResult {
  return {
    rows: rows.map((row) => Object.fromEntries(fieldNames.map((name, at) => [name, row[at]])) as TrinoRow),
    fieldNames,
    columnTypes: null,
    queryId: "20261101_000000_00001_libre",
    operation: null,
    affectedRows: null,
    warnings: [],
    stats: {
      state: "FINISHED",
      elapsedMs: null,
      cpuMs: null,
      queuedMs: null,
      processedRows: null,
      processedBytes: null,
      peakMemoryBytes: null,
    },
    endedTransaction: false,
  };
}

/** The server's refusal, as the transport carries it: the category the fault name maps to, and the name. */
function answered(code: string, message: string): TrinoTransportError {
  const category = code === "PERMISSION_DENIED" ? "auth" : code.endsWith("_NOT_FOUND") ? "unknown-object" : "engine";
  return new TrinoTransportError(category, message, code);
}

const denied = (catalog: string, fn: string) =>
  answered("PERMISSION_DENIED", `Access Denied: Cannot execute function ${catalog}.system.${fn}`);
const notRegistered = (catalog: string, fn: string) =>
  answered("FUNCTION_NOT_FOUND", `line 1:21: Table function '${catalog}.system.${fn}' not registered`);
const DROP_DENIED = answered("PERMISSION_DENIED", `Access Denied: Cannot drop catalog libredb_agent_probe_${NONCE}`);

type Answer = TrinoQueryResult | Error;

/** The read-only access control's answers on the capture's four catalogs (captures 00 and 01, read-only). */
function readOnlyServer(): Map<string, Answer> {
  const functions = result(FUNCTION_COLUMNS, [["query", "unknown", "varchar", "table", false, ""]]);
  const none = result(FUNCTION_COLUMNS, []);
  return new Map<string, Answer>([
    [TRINO_CATALOG_LIST_STATEMENT, result(["Catalog"], [["memory"], ["pg"], ["pg2"], ["system"]])],
    [trinoFunctionListStatement("memory"), none],
    [trinoFunctionListStatement("pg"), functions],
    [trinoFunctionListStatement("pg2"), functions],
    [trinoFunctionListStatement("system"), none],
    [trinoTableFunctionProbe("memory", "query"), notRegistered("memory", "query")],
    [trinoTableFunctionProbe("memory", "raw_query"), notRegistered("memory", "raw_query")],
    [trinoTableFunctionProbe("pg", "query"), denied("pg", "query")],
    [trinoTableFunctionProbe("pg", "raw_query"), notRegistered("pg", "raw_query")],
    [trinoTableFunctionProbe("pg2", "query"), denied("pg2", "query")],
    [trinoTableFunctionProbe("pg2", "raw_query"), notRegistered("pg2", "raw_query")],
    [trinoTableFunctionProbe("system", "query"), notRegistered("system", "query")],
    [trinoTableFunctionProbe("system", "raw_query"), notRegistered("system", "raw_query")],
    [trinoCatalogManagementProbe(NONCE), DROP_DENIED],
  ]);
}

function server(answers: Map<string, Answer>) {
  const sent: string[] = [];
  return {
    sent,
    run: async (sql: string): Promise<TrinoQueryResult> => {
      sent.push(sql);
      const answer = answers.get(sql);
      if (answer === undefined) throw new Error(`the check sent a statement the test does not answer: ${sql}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

async function refusal(answers: Map<string, Answer>): Promise<ExecutionProfileError> {
  try {
    await proveTrinoAgentBoundary(server(answers).run, NONCE);
  } catch (error) {
    if (error instanceof ExecutionProfileError) return error;
    throw error;
  }
  throw new Error("the check admitted the server");
}

const NEEDS =
  "The agent read-only execution profile needs a Trino server whose access control refuses this connection's user every catalog's table functions, and catalog management must be refused: set access-control.name=read-only, or file-based access control that grants no function";

describe("the statements the check sends", () => {
  test("lists catalogs, then each catalog's functions in its system schema", () => {
    expect(TRINO_CATALOG_LIST_STATEMENT).toBe("SHOW CATALOGS");
    expect(trinoFunctionListStatement("pg")).toBe('SHOW FUNCTIONS FROM "pg"."system"');
  });

  test("calls a table function with an argument name no function declares, which runs nothing", () => {
    expect(trinoTableFunctionProbe("pg", "query")).toBe(
      'SELECT * FROM TABLE("pg"."system"."query"(libredb_no_such_argument => 1))',
    );
  });

  test("quotes a catalog and a function as names, a double quote doubled", () => {
    expect(trinoFunctionListStatement('we"ird')).toBe('SHOW FUNCTIONS FROM "we""ird"."system"');
    expect(trinoTableFunctionProbe('we"ird', 'q"x')).toBe(
      'SELECT * FROM TABLE("we""ird"."system"."q""x"(libredb_no_such_argument => 1))',
    );
  });

  test("removes a catalog whose name carries a fresh suffix, which no one holds", () => {
    expect(trinoCatalogManagementProbe(NONCE)).toBe('DROP CATALOG "libredb_agent_probe_0123456789abcdef01234567"');
  });
});

describe("the access control check", () => {
  test("admits the read-only access control and answers the catalogs it proved", async () => {
    const recorded = server(readOnlyServer());

    const catalogs = await proveTrinoAgentBoundary(recorded.run, NONCE);

    expect(catalogs).toEqual(["memory", "pg", "pg2", "system"]);
    expect(recorded.sent).toEqual([
      "SHOW CATALOGS",
      'SHOW FUNCTIONS FROM "memory"."system"',
      'SELECT * FROM TABLE("memory"."system"."query"(libredb_no_such_argument => 1))',
      'SELECT * FROM TABLE("memory"."system"."raw_query"(libredb_no_such_argument => 1))',
      'SHOW FUNCTIONS FROM "pg"."system"',
      'SELECT * FROM TABLE("pg"."system"."query"(libredb_no_such_argument => 1))',
      'SELECT * FROM TABLE("pg"."system"."raw_query"(libredb_no_such_argument => 1))',
      'SHOW FUNCTIONS FROM "pg2"."system"',
      'SELECT * FROM TABLE("pg2"."system"."query"(libredb_no_such_argument => 1))',
      'SELECT * FROM TABLE("pg2"."system"."raw_query"(libredb_no_such_argument => 1))',
      'SHOW FUNCTIONS FROM "system"."system"',
      'SELECT * FROM TABLE("system"."system"."query"(libredb_no_such_argument => 1))',
      'SELECT * FROM TABLE("system"."system"."raw_query"(libredb_no_such_argument => 1))',
      'DROP CATALOG "libredb_agent_probe_0123456789abcdef01234567"',
    ]);
  });

  test("calls every table function a catalog lists, under any name, once, and skips its other functions", async () => {
    const answers = readOnlyServer();
    answers.set(
      trinoFunctionListStatement("memory"),
      result(FUNCTION_COLUMNS, [
        ["passthrough", "unknown", "varchar", "table", false, ""],
        ["passthrough", "unknown", "varchar, bigint", "table", false, ""],
        ["lower", "varchar", "varchar", "scalar", true, ""],
      ]),
    );
    answers.set(trinoTableFunctionProbe("memory", "passthrough"), denied("memory", "passthrough"));
    const recorded = server(answers);

    await proveTrinoAgentBoundary(recorded.run, NONCE);

    expect(recorded.sent.filter((sql) => sql.includes('"memory"."system"."'))).toEqual([
      'SELECT * FROM TABLE("memory"."system"."passthrough"(libredb_no_such_argument => 1))',
      'SELECT * FROM TABLE("memory"."system"."query"(libredb_no_such_argument => 1))',
      'SELECT * FROM TABLE("memory"."system"."raw_query"(libredb_no_such_argument => 1))',
    ]);
  });

  test("refuses a catalog whose pass-through function the server lets the user call", async () => {
    const answers = readOnlyServer();
    // The default access control's answer (capture 01, allow-all).
    answers.set(
      trinoTableFunctionProbe("pg2", "query"),
      answered("INVALID_FUNCTION_ARGUMENT", "line 1:44: Unexpected argument name: LIBREDB_NO_SUCH_ARGUMENT"),
    );

    const error = await refusal(answers);

    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(
      `${NEEDS}. This server lets it call the table function pg2.system.query, which can send its text to the catalog's source under the catalog's own credential, so the connection is refused. The check ran nothing.`,
    );
  });

  test("refuses a table function the server answered with a missing argument, which it lets the user call", async () => {
    const answers = readOnlyServer();
    answers.set(
      trinoTableFunctionProbe("pg", "query"),
      answered("MISSING_ARGUMENT", "line 1:21: Missing argument: QUERY"),
    );

    expect((await refusal(answers)).reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
  });

  test("refuses a table function the check's call ran", async () => {
    const answers = readOnlyServer();
    answers.set(trinoTableFunctionProbe("pg", "query"), result(["one"], [[1]]));

    const error = await refusal(answers);

    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toContain("This server lets it call the table function pg.system.query");
  });

  test("refuses a listed table function the server then says is not registered", async () => {
    const answers = readOnlyServer();
    answers.set(trinoTableFunctionProbe("pg", "query"), notRegistered("pg", "query"));

    const error = await refusal(answers);

    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toBe(
      `${NEEDS}. This server answered the check of the table function pg.system.query with FUNCTION_NOT_FOUND ("line 1:21: Table function 'pg.system.query' not registered"), which is not a permission refusal, so whether it refuses the function is unmeasured and the connection is refused. The check ran nothing.`,
    );
  });

  test("accepts a not-registered answer only for a known pass-through name the catalog does not list", async () => {
    const answers = readOnlyServer();
    answers.set(
      trinoFunctionListStatement("memory"),
      result(FUNCTION_COLUMNS, [["raw_query", "unknown", "varchar", "table", false, ""]]),
    );

    const error = await refusal(answers);

    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toContain("the table function memory.system.raw_query with FUNCTION_NOT_FOUND");
  });

  test.each([
    ["a generic engine error", answered("GENERIC_INTERNAL_ERROR", "boom")],
    ["a syntax error", answered("SYNTAX_ERROR", "line 1:1: mismatched input")],
    ["a refused catalog", answered("CATALOG_NOT_FOUND", "line 1:21: Catalog 'pg' not found")],
  ])("refuses %s as an answer it cannot read", async (_name, answer) => {
    const answers = readOnlyServer();
    answers.set(trinoTableFunctionProbe("pg", "query"), answer);

    expect((await refusal(answers)).reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
  });

  test("refuses a server that lets the user manage catalogs", async () => {
    const answers = readOnlyServer();
    // The default access control's answer (capture 01, allow-all): the name was looked up, so the user may manage it.
    answers.set(
      trinoCatalogManagementProbe(NONCE),
      answered("CATALOG_NOT_FOUND", `Catalog 'libredb_agent_probe_${NONCE}' not found`),
    );

    const error = await refusal(answers);

    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(
      `${NEEDS}. This server answered DROP CATALOG of a catalog that does not exist with CATALOG_NOT_FOUND ("Catalog 'libredb_agent_probe_${NONCE}' not found") rather than a permission refusal, so catalog management is not refused and the connection is refused. The check ran nothing.`,
    );
  });

  test("refuses a server that ran the catalog removal", async () => {
    const answers = readOnlyServer();
    answers.set(trinoCatalogManagementProbe(NONCE), result([], []));

    const error = await refusal(answers);

    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toContain("This server ran DROP CATALOG of a catalog that does not exist");
  });

  test("refuses a catalog list or a function list it cannot read", async () => {
    const wrongColumn = readOnlyServer();
    wrongColumn.set(TRINO_CATALOG_LIST_STATEMENT, result(["name"], [["pg"]]));
    expect((await refusal(wrongColumn)).message).toBe(
      `${NEEDS}. This server's answer to SHOW CATALOGS could not be read as a list of catalog names, so the connection is refused. The check ran nothing.`,
    );

    const notText = readOnlyServer();
    notText.set(TRINO_CATALOG_LIST_STATEMENT, result(["Catalog"], [[1]]));
    expect((await refusal(notText)).reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");

    const functions = readOnlyServer();
    functions.set(trinoFunctionListStatement("pg"), result(["Function"], [["query"]]));
    expect((await refusal(functions)).message).toBe(
      `${NEEDS}. This server's answer to SHOW FUNCTIONS FROM "pg"."system" could not be read as a list of functions and their types, so the connection is refused. The check ran nothing.`,
    );
  });

  test("refuses a server that refuses its catalog list", async () => {
    const answers = readOnlyServer();
    answers.set(TRINO_CATALOG_LIST_STATEMENT, answered("PERMISSION_DENIED", "Access Denied: Cannot show catalogs"));

    const error = await refusal(answers);

    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toBe(
      `${NEEDS}. This server refused SHOW CATALOGS with PERMISSION_DENIED ("Access Denied: Cannot show catalogs"), so its catalogs cannot be checked and the connection is refused. The check ran nothing.`,
    );
  });

  test("refuses a catalog whose function list the server refused", async () => {
    const answers = readOnlyServer();
    answers.set(trinoFunctionListStatement("pg"), answered("GENERIC_INTERNAL_ERROR", "connector failed"));

    const error = await refusal(answers);

    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toBe(
      `${NEEDS}. This server refused SHOW FUNCTIONS FROM "pg"."system" with GENERIC_INTERNAL_ERROR ("connector failed"), so the table functions of catalog pg cannot be checked and the connection is refused. The check ran nothing.`,
    );
  });

  test("lets a failure that is no answer of the server's leave as it came", async () => {
    for (const failure of [
      new TrinoTransportError("unreachable", "Trino could not be reached: refused"),
      new TrinoTransportError("timeout", "Trino did not answer before the deadline"),
      new Error("boom"),
    ]) {
      const answers = readOnlyServer();
      answers.set(trinoTableFunctionProbe("pg", "query"), failure);
      let caught: unknown;
      try {
        await proveTrinoAgentBoundary(server(answers).run, NONCE);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
    }
  });

  test("reads the catalog list as the names it holds", () => {
    expect(readTrinoCatalogs(result(["Catalog"], [["pg"], ["system"]]))).toEqual(["pg", "system"]);
    expect(readTrinoCatalogs(result(["Catalog"], [[null]]))).toBeNull();
    expect(readTrinoCatalogs(result([], []))).toBeNull();
  });
});

const FENCE =
  "The agent read-only execution profile sends one Trino statement, a SELECT (a WITH before it is fine), and nothing else";

describe("the statement fence", () => {
  test.each([
    ["SELECT * FROM pg.public.rp_t"],
    ["select 1 as a"],
    ["  \n\tSELECT 1 AS a"],
    ["-- lead\nSELECT 1 AS a"],
    ["-- lead\r\nSELECT 1 AS a"],
    ["/* lead */ SELECT 1 AS a"],
    ["WITH x AS (SELECT 1 AS a) SELECT a FROM x"],
    ["SELECT 1 AS a;"],
    ["SELECT 1 AS a; -- trailing"],
    ["SELECT 'a;b' AS a, \"c;d\" AS b"],
    ["SELECT ARRAY[1, 2][1] AS a"],
    ["SELECT * FROM TABLE(pg.system.query(query => 'SELECT 1; SELECT 2'))"],
  ])("admits %j", (sql) => {
    expect(trinoAgentStatementRefusal(sql)).toBeNull();
  });

  test.each([
    ["COMMIT"],
    ["ROLLBACK"],
    ["START TRANSACTION"],
    ["START TRANSACTION READ WRITE"],
    ["SET SESSION query_max_run_time = '1s'"],
    ["SET SESSION AUTHORIZATION 'admin'"],
    ["RESET SESSION query_max_run_time"],
    ["CALL pg.system.execute(query => 'DELETE FROM t')"],
    ["EXECUTE p"],
    ["EXECUTE IMMEDIATE 'SELECT 1'"],
    ["PREPARE p FROM SELECT 1"],
    ["USE pg.public"],
    ["INSERT INTO pg.public.rp_t VALUES (1)"],
    ["CREATE TABLE memory.default.t AS SELECT 1 AS a"],
    ["DROP CATALOG pg"],
    ["CREATE CATALOG x USING memory"],
    ["EXPLAIN ANALYZE SELECT 1"],
    ["EXPLAIN SELECT 1"],
    ["SHOW CATALOGS"],
    ["VALUES 1"],
    ["selected"],
    ["(SELECT 1)"],
  ])("refuses %j as no SELECT", (sql) => {
    expect(trinoAgentStatementRefusal(sql)).toBe(
      `${FENCE}; this statement does not begin with SELECT or WITH, so it was not sent. A statement that ends, nests or leaves the read-only transaction, changes the session or calls a procedure is never sent, so only a SELECT reaches the server.`,
    );
  });

  test.each([
    ["SELECT 1 AS a; COMMIT"],
    ["SELECT 1 AS a; SELECT 2 AS b"],
    ["SELECT 1 AS a;; "],
    ["SELECT 1 AS a; -- c\nROLLBACK"],
  ])("refuses %j as a second statement", (sql) => {
    expect(trinoAgentStatementRefusal(sql)).toBe(
      `${FENCE}; this text goes on after its first statement's semicolon, so it was not sent. Send one SELECT at a time.`,
    );
  });

  test("refuses a carriage return inside a line comment with text after it", () => {
    expect(trinoAgentStatementRefusal("SELECT 1 AS a -- note\rCOMMIT")).toBe(
      `${FENCE}; this text holds a carriage return inside a -- comment with more text after it, which a reader may end the comment at or not, so where the statement ends cannot be read, and it was not sent. End a comment with a line feed.`,
    );
  });

  test("refuses a dollar-quoted run, which Trino does not read as a string", () => {
    expect(trinoAgentStatementRefusal("SELECT $$ ; COMMIT $$ AS a")).toBe(
      `${FENCE}; this text holds a dollar-quoted run ($$ ... $$), which Trino does not read as a string, so where its statement ends cannot be read, and it was not sent.`,
    );
  });

  test.each([["SELECT 'open"], ['SELECT "open'], ["SELECT 1 /* open"]])(
    "refuses %j, which ends inside a span",
    (sql) => {
      expect(trinoAgentStatementRefusal(sql)).toBe(
        `${FENCE}; this text ends inside a comment, a string or a quoted name, so where it ends cannot be read, and it was not sent.`,
      );
    },
  );

  test("refuses text that holds no statement", () => {
    expect(trinoAgentStatementRefusal("  -- only a comment\n")).toBe(
      `${FENCE}; this text holds no statement, so nothing was sent.`,
    );
  });

  test("reads with Trino's own grammar row, where a hash and two slashes are code", () => {
    // Under the shared default a # opens a comment and would hide what follows it.
    expect(resolveSqlGrammar("trino").hash).toBe("code");
    expect(trinoAgentStatementRefusal("SELECT 1 AS a # ; COMMIT")).toBe(
      `${FENCE}; this text goes on after its first statement's semicolon, so it was not sent. Send one SELECT at a time.`,
    );
  });
});

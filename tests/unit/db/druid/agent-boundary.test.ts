/**
 * The agent read-only profile's proof that the Druid endpoint runs the native engine, and the statement fence in front
 * of every agent statement, against the answers a live Apache Druid 37.0.0 gave, as
 * `tests/fixtures/druid/37.0.0/agent-boundary/` records them. The probe statement is pinned by its full text, and each
 * refusal by its code and its words.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError } from "@/lib/db/errors";
import {
  druidAgentProbeStatement,
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

  test("refuses text that holds no statement", () => {
    for (const sql of ["", "   ", "-- only a comment", "// only a comment", "/* only */", ";"]) {
      expect(druidAgentStatementRefusal(sql)).not.toBeNull();
    }
    expect(druidAgentStatementRefusal("-- only a comment")).toBe(
      `${FENCE}; this text holds no statement, so nothing was sent.`,
    );
  });
});

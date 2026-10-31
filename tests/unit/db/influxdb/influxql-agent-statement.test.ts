/**
 * The agent's reader of one InfluxQL statement: the editor's read policy, then what an agent read does not take on top
 * of it, each refusal named. The SHOW forms it refuses are the ones the captures under
 * tests/fixtures/influxdb/1.13.1/agent-boundary/ show disclosing what other principals hold or ran, or reading the
 * server's internals; the comment and carriage return refusals are the forms the same captures show the server reading
 * a second statement past.
 */
import { describe, expect, test } from "bun:test";
import {
  INFLUXQL_AGENT_SENTENCES,
  INFLUXQL_AGENT_SHOW_KINDS,
  readInfluxqlAgentStatement,
} from "@/lib/db/providers/timeseries/influxdb/influxql-agent-statement";
import { INFLUXQL_POLICY_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/influxql-policy";
import { loadInfluxCapture } from "../../../helpers/influxdb-fixtures";

describe("readInfluxqlAgentStatement", () => {
  test.each([
    ["SELECT mean(temp) FROM home WHERE time > now() - 1h GROUP BY time(10m)", "SELECT"],
    ['SELECT * FROM "home"."autogen"."home" LIMIT 5', "SELECT"],
    ["SELECT * FROM (SELECT max(temp) AS t FROM home GROUP BY room)", "SELECT"],
    ["select count(temp) from home;", "SELECT"],
    ["SHOW DATABASES", "SHOW"],
    ["SHOW RETENTION POLICIES", "SHOW"],
    ["SHOW MEASUREMENTS", "SHOW"],
    ["show measurements with measurement =~ /ho/", "SHOW"],
    ["SHOW SERIES", "SHOW"],
    ["SHOW TAG KEYS FROM home", "SHOW"],
    ['SHOW TAG VALUES WITH KEY = "room"', "SHOW"],
    ["SHOW FIELD KEYS", "SHOW"],
    ["SHOW SERIES CARDINALITY", "SHOW"],
    ["SHOW SERIES EXACT CARDINALITY", "SHOW"],
    ["SHOW MEASUREMENT CARDINALITY", "SHOW"],
    ["SHOW MEASUREMENT EXACT CARDINALITY", "SHOW"],
    ["SHOW TAG KEY CARDINALITY", "SHOW"],
    ['SHOW TAG VALUES CARDINALITY WITH KEY = "room"', "SHOW"],
    ["SHOW FIELD KEY EXACT CARDINALITY", "SHOW"],
    ["EXPLAIN SELECT * FROM home", "EXPLAIN"],
    ["EXPLAIN ANALYZE SELECT * FROM home", "EXPLAIN"],
    ["EXPLAIN ANALYZE VERBOSE SELECT * FROM home", "EXPLAIN"],
    ["SELECT *\nFROM home", "SELECT"],
  ] as const)("admits %p as a %s", (text, statement) => {
    expect(readInfluxqlAgentStatement(text)).toEqual({ ok: true, statement });
  });

  test("the SHOW kinds an agent reads are the catalog's own, and no form that reads users, grants or queries", () => {
    expect([...INFLUXQL_AGENT_SHOW_KINDS].sort()).toEqual([
      "DATABASES",
      "FIELD",
      "MEASUREMENT",
      "MEASUREMENTS",
      "RETENTION",
      "SERIES",
      "TAG",
    ]);
  });

  test.each([
    ["SHOW QUERIES", "QUERIES"],
    ["SHOW CONTINUOUS QUERIES", "CONTINUOUS"],
    ["SHOW USERS", "USERS"],
    ["SHOW GRANTS FOR reader", "GRANTS"],
    ["SHOW STATS", "STATS"],
    ["SHOW STATS FOR 'httpd'", "STATS"],
    ["SHOW DIAGNOSTICS", "DIAGNOSTICS"],
    ["SHOW SHARDS", "SHARDS"],
    ["SHOW SHARD GROUPS", "SHARD"],
    ["SHOW SUBSCRIPTIONS", "SUBSCRIPTIONS"],
    ['SHOW "MEASUREMENTS"', "a quoted name"],
    ["SHOW everything", "a name"],
    ["SHOW (", "a symbol"],
    ["SHOW", "nothing"],
    ["SHOW ;", "nothing"],
  ])("refuses %p by its kind", (text, word) => {
    expect(readInfluxqlAgentStatement(text)).toEqual({
      ok: false,
      code: "show-kind",
      message: INFLUXQL_AGENT_SENTENCES.showKind(word),
    });
  });

  test("SHOW QUERIES is refused because a reader with a database sees another principal's running statement", () => {
    const seen = loadInfluxCapture("1.13.1", "agent-boundary/show-queries-during-admin-read-reader");
    expect(seen.status).toBe(200);
    expect(seen.body).toContain('"admin"]');
    expect(seen.body).toContain("SELECT count(v) FROM big");
    const cq = loadInfluxCapture("1.13.1", "agent-boundary/show-continuous-queries-reader");
    expect(cq.status).toBe(200);
    expect(cq.body).toContain("CREATE CONTINUOUS QUERY cq_hourly");
    for (const text of ["SHOW QUERIES", "SHOW CONTINUOUS QUERIES"]) {
      expect(readInfluxqlAgentStatement(text).ok).toBe(false);
    }
  });

  test.each([
    ["EXPLAIN SHOW MEASUREMENTS", "SHOW"],
    ["EXPLAIN ANALYZE SHOW DATABASES", "SHOW"],
  ])("refuses %p: an agent EXPLAIN explains a SELECT only", (text, word) => {
    expect(readInfluxqlAgentStatement(text)).toEqual({
      ok: false,
      code: "explain-target",
      message: INFLUXQL_AGENT_SENTENCES.explainTarget(word),
    });
  });

  test.each([
    "SHOW MEASUREMENTS -- c",
    "SHOW MEASUREMENTS /* c */",
    "/* c */ SELECT * FROM home",
    "SELECT * FROM home -- note\nWHERE time > 0",
  ])("refuses %p: an agent read holds no comment", (text) => {
    expect(readInfluxqlAgentStatement(text)).toEqual({
      ok: false,
      code: "comment",
      message: INFLUXQL_AGENT_SENTENCES.comment,
    });
  });

  test.each([
    "SHOW\rMEASUREMENTS",
    "SELECT * FROM home\r\n",
    "SELECT 'a\rb' FROM home",
    "SHOW MEASUREMENTS -- c\r; SHOW USERS",
  ])("refuses %p: an agent read holds no carriage return, wherever it stands", (text) => {
    expect(readInfluxqlAgentStatement(text)).toEqual({
      ok: false,
      code: "carriage-return",
      message: INFLUXQL_AGENT_SENTENCES.carriageReturn,
    });
  });

  test("the comment and carriage return forms are the ones the servers read a second statement past", () => {
    for (const version of ["1.13.1", "2.9.1"] as const) {
      for (const form of ["line-comment-lone-cr", "line-comment-crlf", "block-comment", "block-comment-holding-cr"]) {
        const seen = loadInfluxCapture(version, `agent-boundary/fence-${form}`);
        // 1.13.1 answers the reader's refusal of the second statement, 2.9.1 answers it as statement 1.
        expect(seen.body.includes("SHOW USERS") || seen.body.includes('"statement_id":1')).toBe(true);
        expect(readInfluxqlAgentStatement(seen.request.form?.q as string).ok).toBe(false);
      }
      const between = loadInfluxCapture(version, "agent-boundary/fence-lone-cr-between-tokens");
      expect(between.status).toBe(200);
      expect(readInfluxqlAgentStatement(between.request.form?.q as string).ok).toBe(false);
    }
  });

  test.each([
    ['SELECT * INTO "other".."m" FROM home', INFLUXQL_POLICY_SENTENCES.into],
    ['SELECT * FROM (SELECT * INTO "other".."m" FROM home)', INFLUXQL_POLICY_SENTENCES.into],
    ["EXPLAIN ANALYZE SELECT * INTO m FROM home", INFLUXQL_POLICY_SENTENCES.into],
    ["select * into m from home", INFLUXQL_POLICY_SENTENCES.into],
    ['DELETE FROM "libredb_agent_probe" WHERE time < 0', INFLUXQL_POLICY_SENTENCES.notARead("DELETE")],
    ["KILL QUERY 1", INFLUXQL_POLICY_SENTENCES.notARead("KILL")],
    ["SHOW MEASUREMENTS; SHOW USERS", INFLUXQL_POLICY_SENTENCES.multipleStatements(1, 18)],
    ["", INFLUXQL_POLICY_SENTENCES.empty],
  ])("refuses %p with the read policy's own sentence", (text, message) => {
    expect(readInfluxqlAgentStatement(text)).toEqual({ ok: false, code: "policy", message });
  });
});

/**
 * The Neo4j agent statement reader: the editor's read policy, then no carriage return and no comment, since the
 * captures show a lone carriage return ends a `//` comment on 5.26.31 and a reader that runs the comment on would see
 * one column where the server reads two.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readNeo4jAgentStatement } from "@/lib/db/providers/graph/neo4j/agent-statement";
import { NEO4J_FIXTURES, neo4jCapture } from "../../../helpers/neo4j-fixtures";

const AGENT = join(NEO4J_FIXTURES, "agent-boundary", "agent");

describe("readNeo4jAgentStatement", () => {
  test("admits a read, an allowed SHOW and an allowlisted procedure call, with the policy's verdict", () => {
    const read = readNeo4jAgentStatement("MATCH (n:Person) RETURN n.name AS name ORDER BY name");
    expect(read).toMatchObject({ ok: true, verdict: { allowed: true, isShow: false, callsProcedure: false } });
    expect(readNeo4jAgentStatement("SHOW INDEXES")).toMatchObject({ ok: true, verdict: { isShow: true } });
    expect(readNeo4jAgentStatement("CALL db.labels()")).toMatchObject({ ok: true, verdict: { callsProcedure: true } });
  });

  test.each([
    ["fence-line-comment-lone-cr"],
    ["fence-line-comment-crlf"],
    ["fence-block-comment-holding-cr"],
    ["fence-lone-cr-between-tokens"],
  ])("refuses the carriage return of %s before anything is sent", (name) => {
    const { statement } = neo4jCapture(name, AGENT);
    const reading = readNeo4jAgentStatement(statement as string);
    expect(reading).toEqual({
      ok: false,
      code: "agent-carriage-return",
      message:
        "An agent statement has no carriage return: Neo4j ends a // comment at one, so the text could read as another statement than the one written. Write it on one line or with line feeds. Nothing was sent.",
    });
  });

  test.each([
    ["fence-line-comment-lf"],
    ["fence-line-comment-u2028"],
    ["fence-line-comment-u0085"],
    ["fence-block-comment"],
    ["fence-block-comment-nested"],
  ])("refuses the comment of %s before anything is sent", (name) => {
    const { statement } = neo4jCapture(name, AGENT);
    expect(readNeo4jAgentStatement(statement as string)).toEqual({
      ok: false,
      code: "agent-comment",
      message: "An agent statement has no comment: remove it and send the statement alone. Nothing was sent.",
    });
  });

  test("a comment after the statement is refused too, though the policy drops it from the statement", () => {
    expect(readNeo4jAgentStatement("RETURN 1 // why")).toMatchObject({ ok: false, code: "agent-comment" });
  });

  test.each([
    ["LOAD CSV FROM 'file:///probe.csv' AS row RETURN row", "denied-word"],
    ["load csv from 'file:///probe.csv' as row return row", "denied-word"],
    ["CALL { LOAD CSV FROM 'file:///probe.csv' AS row RETURN row } RETURN row", "denied-word"],
    ["WITH 'file:///probe.csv' AS url LOAD CSV FROM url AS row RETURN row", "denied-word"],
    ["USE other MATCH (n) RETURN count(n) AS n", "denied-word"],
    ["CREATE (:LibredbProbe {at: 1})", "denied-word"],
    ["CALL db.checkpoint()", "denied-procedure"],
    ["CALL libredbtest.touch()", "denied-procedure"],
    ["RETURN libredbtest.touchFn() AS path", "denied-function"],
    ["RETURN apoc.version()", "denied-namespace"],
    ["EXPLAIN MATCH (n) RETURN n", "denied-prefix"],
    ["SHOW TRANSACTIONS", "denied-show"],
    ["MATCH (n) RETURN n; MATCH (m) RETURN m", "multiple-statements"],
    ["MATCH (n) WHERE n.x = $x RETURN n", "parameters-unsupported"],
    ["", "empty"],
  ])("refuses %s with the read policy's own code", (statement, code) => {
    const reading = readNeo4jAgentStatement(statement);
    expect(reading).toMatchObject({ ok: false, code });
    if (!reading.ok) expect(reading.message.endsWith("Nothing was sent.")).toBe(true);
  });
});

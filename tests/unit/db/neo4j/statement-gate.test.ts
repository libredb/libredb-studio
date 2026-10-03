/**
 * The Neo4j statement gate (spec 5.4; revision SR10) over the EXPLAIN answers 5.26.31 gave: the EXPLAIN text
 * it sends is the captured one, `r` runs, `s` runs only for an allowlisted procedure call, everything else
 * and an unclassified answer refuse. Every allowlisted procedure call and SHOW form is admitted by policy plus
 * gate, the gate skipped for a SHOW form as `GraphBaseProvider` skips it.
 */
import { describe, expect, test } from "bun:test";
import { GraphClientError, type GraphRunOptions, type GraphRunResult } from "@/lib/db/graph/bolt/client";
import { type CypherReadVerdict, checkCypherRead } from "@/lib/db/graph/cypher/read-policy";
import type { GraphPolicyProfile } from "@/lib/db/graph/profile";
import { NEO4J_POLICY_PROFILE } from "@/lib/db/providers/graph/neo4j/profile";
import { neo4jStatementGate } from "@/lib/db/providers/graph/neo4j/statement-gate";
import { neo4jCapture, recordedGraphClient } from "../../../helpers/neo4j-fixtures";

const OPTIONS: GraphRunOptions = { database: "neo4j", timeoutMs: 5000, maxRows: 500, metadata: { app: "test" } };

/** A profile that refuses nothing, so the gate can be handed statements the Neo4j policy stops first. */
const OPEN_PROFILE: GraphPolicyProfile = {
  engineLabel: "Neo4j",
  readPolicy: {
    deniedWords: [],
    deniedNamespaces: [],
    allowedProcedures: [],
    allowedQualifiedFunctions: [],
    allowedShowForms: [["DATABASES"]],
    refusedPrefixes: [],
  },
  dialect: { supportsVersionPrefix: true, offsetKeyword: "SKIP" },
};

function allowed(text: string, profile: GraphPolicyProfile = NEO4J_POLICY_PROFILE) {
  const verdict = checkCypherRead(text, profile);
  if (!verdict.allowed) throw new Error(`${text}: ${verdict.refusal.message}`);
  return verdict;
}

/** A client answering every run with one queryType, or none. */
function classifying(queryType: GraphRunResult["queryType"]) {
  return {
    async run(): Promise<GraphRunResult> {
      return { fields: [], rows: [], truncated: false, ...(queryType === undefined ? {} : { queryType }) };
    },
  };
}

/** Policy, then the gate unless the statement is a SHOW form: what GraphBaseProvider runs. */
async function admitted(text: string): Promise<boolean> {
  const verdict = checkCypherRead(text, NEO4J_POLICY_PROFILE);
  if (!verdict.allowed) return false;
  if (verdict.isShow) return true;
  return (await neo4jStatementGate(recordedGraphClient(), verdict, OPTIONS)) === undefined;
}

describe("neo4jStatementGate", () => {
  test("lets a read run, after one EXPLAIN with no rows on the same database and signal", async () => {
    const client = recordedGraphClient();
    const signal = new AbortController().signal;
    const options = { ...OPTIONS, signal };
    expect(await neo4jStatementGate(client, allowed("MATCH (n) RETURN n"), options)).toBeUndefined();
    expect(client.calls).toEqual([
      { statement: neo4jCapture("explain-read").statement as string, options: { ...options, maxRows: 0 } },
    ]);
  });

  test("keeps a version prefix in front of EXPLAIN, as the captured statement", async () => {
    const client = recordedGraphClient();
    expect(await neo4jStatementGate(client, allowed("CYPHER 5   MATCH (n) RETURN n"), OPTIONS)).toBeUndefined();
    expect(client.calls[0].statement).toBe("CYPHER 5 EXPLAIN MATCH (n) RETURN n");
    expect(client.calls[0].statement).toBe(neo4jCapture("explain-version-prefix-first").statement as string);
  });

  test("sends a bare version prefix as CYPHER <n> EXPLAIN", async () => {
    const sent: string[] = [];
    const client = {
      async run(statement: string): Promise<GraphRunResult> {
        sent.push(statement);
        return { fields: [], rows: [], truncated: false, queryType: "r" };
      },
    };
    await neo4jStatementGate(client, allowed("CYPHER 5"), OPTIONS);
    expect(sent).toEqual(["CYPHER 5 EXPLAIN"]);
  });

  test.each([
    // 5.26.31 rejects `CYPHER 5 EXPLAIN runtime=slotted ...` ("Invalid input 'runtime'") and parses each form
    // below, EXPLAIN after the whole option block (measured 2026-10-03).
    ["CYPHER 5 runtime=slotted MATCH (n) RETURN n", "CYPHER 5 runtime=slotted EXPLAIN MATCH (n) RETURN n"],
    ["CYPHER runtime=slotted MATCH (n) RETURN n", "CYPHER runtime=slotted EXPLAIN MATCH (n) RETURN n"],
    [
      "CYPHER 5 planner=cost  runtime = slotted MATCH (n) RETURN n",
      "CYPHER 5 planner=cost  runtime = slotted EXPLAIN MATCH (n) RETURN n",
    ],
    ["CYPHER runtime=slotted", "CYPHER runtime=slotted EXPLAIN"],
  ])("puts EXPLAIN after the whole CYPHER option block: %s", async (text, expected) => {
    const sent: string[] = [];
    const client = {
      async run(statement: string): Promise<GraphRunResult> {
        sent.push(statement);
        return { fields: [], rows: [], truncated: false, queryType: "r" };
      },
    };
    await neo4jStatementGate(client, allowed(text), OPTIONS);
    expect(sent).toEqual([expected]);
  });

  test("refuses a write the server classifies as w", async () => {
    const refusal = await neo4jStatementGate(recordedGraphClient(), allowed("CREATE (n)", OPEN_PROFILE), OPTIONS);
    expect(refusal).toEqual({
      code: "server-classification",
      subject: "w",
      message: "The server classifies this statement as write, and a read-only Neo4j connection runs only reads.",
    });
  });

  test("refuses rw", async () => {
    const refusal = await neo4jStatementGate(classifying("rw"), allowed("RETURN 1"), OPTIONS);
    expect(refusal?.subject).toBe("rw");
    expect(refusal?.message).toBe(
      "The server classifies this statement as read and write, and a read-only Neo4j connection runs only reads.",
    );
  });

  test("refuses s unless the statement calls an allowlisted procedure", async () => {
    const show = await neo4jStatementGate(recordedGraphClient(), allowed("SHOW DATABASES", OPEN_PROFILE), OPTIONS);
    expect(show).toEqual({
      code: "server-classification",
      subject: "s",
      message:
        "The server classifies this statement as a schema or administration statement, and a read-only Neo4j connection runs only reads.",
    });
    expect(await neo4jStatementGate(recordedGraphClient(), allowed("CALL dbms.components()"), OPTIONS)).toBeUndefined();
  });

  test("refuses a statement the server did not classify", async () => {
    expect(await neo4jStatementGate(classifying(undefined), allowed("RETURN 1"), OPTIONS)).toEqual({
      code: "server-classification",
      subject: "unclassified",
      message: "The server did not classify this statement, so it was not run.",
    });
  });

  test("lets a failed EXPLAIN reach the caller, which refuses the statement", async () => {
    const failing = {
      async run(): Promise<GraphRunResult> {
        throw new GraphClientError("syntax", "Invalid input", "Neo.ClientError.Statement.SyntaxError");
      },
    };
    await expect(neo4jStatementGate(failing, allowed("RETURN 1"), OPTIONS)).rejects.toThrow("Invalid input");
  });

  test("the classifications the server gave for LOAD CSV and TERMINATE are r: the policy is what stops them", () => {
    for (const name of ["explain-load-csv", "explain-terminate"]) {
      const capture = neo4jCapture(name);
      expect(capture.result?.queryType).toBe("r");
      const verdict: CypherReadVerdict = checkCypherRead(
        (capture.statement as string).replace(/^EXPLAIN /, ""),
        NEO4J_POLICY_PROFILE,
      );
      expect(verdict.allowed).toBe(false);
    }
  });

  test("admits every allowlisted procedure call, through policy and gate", async () => {
    for (const procedure of NEO4J_POLICY_PROFILE.readPolicy.allowedProcedures) {
      // oxlint-disable-next-line no-await-in-loop -- one statement at a time, so a failure names it.
      expect(await admitted(`CALL ${procedure}()`)).toBe(true);
    }
  });

  test("admits every allowed SHOW form; only the database forms would meet the gate's s refusal", async () => {
    const classifiedS: string[] = [];
    for (const form of NEO4J_POLICY_PROFILE.readPolicy.allowedShowForms) {
      const text = `SHOW ${form.map((word) => (word === "*" ? "neo4j" : word)).join(" ")}`;
      // oxlint-disable-next-line no-await-in-loop -- one form at a time, so a failure names it.
      expect(await admitted(text)).toBe(true);
      // oxlint-disable-next-line no-await-in-loop -- the same form, read before the next.
      const refusal = await neo4jStatementGate(recordedGraphClient(), allowed(text), OPTIONS);
      if (refusal !== undefined) classifiedS.push(`${form.join(" ")} ${refusal.subject}`);
    }
    expect(classifiedS).toEqual(["DATABASES s", "DATABASE * s", "DEFAULT DATABASE s", "HOME DATABASE s"]);
  });
});

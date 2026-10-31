/**
 * The Neo4j provider's agent read-only path over the 5.26.31 agent boundary captures: the open proves the principal
 * only under the agent read-only profile, and `queryReadOnly` answers only on such a handle, reads the statement
 * before anything is sent, proves the principal again on every call, and refuses a result past its budget.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExecutionProfileError, QueryError, RefusedBeforeSendError, TimeoutError } from "@/lib/db/errors";
import {
  type GraphClient,
  GraphClientError,
  type GraphRunOptions,
  type GraphRunResult,
} from "@/lib/db/graph/bolt/client";
import { NEO4J_AGENT_PROOF_STATEMENTS } from "@/lib/db/providers/graph/neo4j/agent-boundary";
import { Neo4jProvider } from "@/lib/db/providers/graph/neo4j/index";
import type { DatabaseConnection, ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import { NEO4J_FIXTURES, neo4jCapture, recordedGraphClient } from "../../../helpers/neo4j-fixtures";

const BOUNDARY = join(NEO4J_FIXTURES, "agent-boundary");
const PROOF = Object.values(NEO4J_AGENT_PROOF_STATEMENTS);
const AGENT_PROFILE: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5000, maxResultRows: 10, maxResultBytes: 100_000 };
const READ = "MATCH (n:Person) RETURN n.name AS name ORDER BY name";
const EXPLAIN_READ = `EXPLAIN ${READ}`;

const CONNECTION: DatabaseConnection = {
  id: "c1",
  name: "graph",
  type: "neo4j",
  host: "127.0.0.1",
  user: "agent",
  password: "not-a-real-password",
  database: "neo4j",
  createdAt: new Date(0),
};

/** The statement's EXPLAIN as the gate sends it: classified a read, as the editor's captures show for a MATCH. */
const EXPLAINED: GraphRunResult = { fields: ["name"], rows: [], truncated: false, queryType: "r" };

interface Recording {
  readonly calls: { statement: string; options: GraphRunOptions }[];
  closed: number;
  /** Which principal's captures answer from now on. */
  principal: string;
  /** A statement left unanswered until its signal aborts, then failed as the client fails a timeout. */
  hang?: string;
}

/** A client over one principal's captures, switchable mid-test, with the test's own answers first. */
function factory(principal: string, answers: Readonly<Record<string, GraphRunResult | Error>> = {}) {
  const recording: Recording = { calls: [], closed: 0, principal };
  const create = (): GraphClient => ({
    async verify() {
      return recordedGraphClient(join(BOUNDARY, recording.principal)).verify();
    },
    async run(statement, options) {
      recording.calls.push({ statement, options });
      if (statement === recording.hang) {
        await new Promise((resolve) => options.signal?.addEventListener("abort", resolve, { once: true }));
        throw new GraphClientError("timeout", "The query did not finish in time");
      }
      const answer = answers[statement];
      if (answer instanceof Error) throw answer;
      if (answer !== undefined) return answer;
      return recordedGraphClient(join(BOUNDARY, recording.principal)).run(statement, options);
    },
    async close() {
      recording.closed++;
    },
  });
  return { create, recording };
}

async function opened(
  principal = "agent",
  execution: ProviderExecutionContext = AGENT_PROFILE,
  answers: Readonly<Record<string, GraphRunResult | Error>> = { [EXPLAIN_READ]: EXPLAINED },
) {
  const { create, recording } = factory(principal, answers);
  const provider = new Neo4jProvider(CONNECTION, {}, execution, create);
  await provider.connect();
  return { provider, recording };
}

const statementsOf = (recording: Recording) => recording.calls.map((call) => call.statement);

describe("the open under the agent read-only profile", () => {
  test("proves the principal after the version read, on the connection's database", async () => {
    const { recording } = await opened();
    expect(statementsOf(recording)).toEqual([NEO4J_AGENT_PROOF_STATEMENTS.components, ...PROOF]);
    expect(recording.calls.every((call) => call.options.database === "neo4j")).toBe(true);
  });

  test.each([
    ["community", "Neo4j Community Edition"],
    ["reader_stock", "through the role PUBLIC"],
    ["loader", "through the role csv_loader"],
    ["ext_agent", "the procedure libredbtest.touch"],
    ["editor", "write on NODE(*)"],
  ])("refuses %s, closing the client and leaving the provider disconnected", async (principal, words) => {
    const { create, recording } = factory(principal);
    const provider = new Neo4jProvider(CONNECTION, {}, AGENT_PROFILE, create);
    const error = await provider.connect().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as Error).message).toContain(words);
    expect(provider.isConnected()).toBe(false);
    expect((provider as unknown as { state: { lastError?: Error } }).state.lastError).toBe(error as Error);
    expect(recording.closed).toBe(1);
  });

  test.each([
    ["the editor", {}],
    ["the operations profile", { readOnly: true, sendsStatements: false }],
    ["a read-only editor handle", { readOnly: true }],
  ] as const)("is not run for %s, which opens a principal that can write", async (_label, execution) => {
    const { recording } = await opened("editor", execution);
    expect(statementsOf(recording)).toEqual([NEO4J_AGENT_PROOF_STATEMENTS.components]);
  });
});

describe("queryReadOnly", () => {
  test("refuses a handle not opened under the agent read-only profile, sending nothing", async () => {
    const { provider, recording } = await opened("editor", {});
    const before = recording.calls.length;
    const error = await provider.queryReadOnly(READ, BUDGET).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect((error as Error).message).toBe(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
    expect(recording.calls.length).toBe(before);
  });

  test("refuses on a provider that is not connected", async () => {
    const provider = new Neo4jProvider(CONNECTION, {}, AGENT_PROFILE, factory("agent").create);
    await expect(provider.queryReadOnly(READ, BUDGET)).rejects.toThrow();
  });

  test("proves the principal again, then the gate, then one run, with the budget's bounds and nothing the caller chose", async () => {
    const { provider, recording } = await opened();
    const before = recording.calls.length;
    const result = await provider.queryReadOnly(READ, BUDGET);
    expect(result).toMatchObject({ fields: ["name"], rows: [{ name: "Ada" }, { name: "Bob" }], rowCount: 2 });
    expect(result.pagination).toBeUndefined();
    const sent = recording.calls.slice(before);
    expect(sent.map((call) => call.statement)).toEqual([...PROOF, EXPLAIN_READ, READ]);
    const run = sent.at(-1)?.options as GraphRunOptions;
    expect(run).toMatchObject({ database: "neo4j", timeoutMs: 5000, maxRows: 10, metadata: { app: "libredb-studio" } });
    expect(run.signal).toBeInstanceOf(AbortSignal);
    expect(sent.every((call) => call.options.signal === run.signal)).toBe(true);
  });

  test("proves on every call, keeping no verdict: privileges widened after the open refuse the next call", async () => {
    const read = neo4jCapture("read", join(BOUNDARY, "agent")).result as GraphRunResult;
    const { provider, recording } = await opened("widened-before", AGENT_PROFILE, {
      [EXPLAIN_READ]: EXPLAINED,
      [READ]: read,
    });
    await provider.queryReadOnly(READ, BUDGET);
    recording.principal = "widened-after";
    const before = recording.calls.length;
    const error = await provider.queryReadOnly(READ, BUDGET).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as Error).message).toContain("holds LOAD on ALL DATA through the role csv_loader");
    expect(statementsOf(recording).slice(before)).toEqual(PROOF.slice(0, 3));
  });

  test.each([
    ["LOAD CSV FROM 'file:///probe.csv' AS row RETURN row", "denied-word"],
    ["CALL { LOAD CSV FROM 'file:///probe.csv' AS row RETURN row } RETURN row", "denied-word"],
    ["CREATE (:LibredbProbe {at: 1})", "denied-word"],
    ["RETURN 1 AS x // c\r, 2 AS y", "carriage return"],
    ["RETURN 1 AS x /* c */, 2 AS y", "no comment"],
  ])("refuses %s before anything is sent", async (statement, words) => {
    const { provider, recording } = await opened();
    const before = recording.calls.length;
    const error = await provider.queryReadOnly(statement, BUDGET).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    if (words !== "denied-word") expect((error as Error).message).toContain(words);
    expect(recording.calls.length).toBe(before);
  });

  test("refuses an estimating plan, and a bad budget, before anything is sent", async () => {
    const { provider, recording } = await opened();
    const before = recording.calls.length;
    await expect(provider.queryReadOnly(READ, BUDGET, "estimate-plan")).rejects.toThrow(
      "Neo4j composes no estimating plan for the agent",
    );
    await expect(provider.queryReadOnly(READ, { ...BUDGET, maxResultRows: 0 })).rejects.toThrow(
      "Read-only execution budget field maxResultRows",
    );
    expect(recording.calls.length).toBe(before);
  });

  test("a statement the server classifies as a write is refused by the gate, never run", async () => {
    const { provider, recording } = await opened("agent", AGENT_PROFILE, {
      [EXPLAIN_READ]: { ...EXPLAINED, queryType: "w" },
    });
    await expect(provider.queryReadOnly(READ, BUDGET)).rejects.toThrow("classifies this statement as write");
    await Bun.sleep(0);
    expect(statementsOf(recording)).not.toContain(READ);
  });

  test("a result past the row budget is refused, never cut", async () => {
    const { provider } = await opened();
    const error = await provider
      .queryReadOnly(READ, { ...BUDGET, maxResultRows: 1 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      "Read-only execution exceeded the row budget: 2 rows > 1 allowed; the read stops one row past the budget, so at least 2 rows match and the total is not known: narrow the statement",
    );
  });

  test("a result past the byte budget is refused", async () => {
    const { provider } = await opened();
    const error = await provider
      .queryReadOnly(READ, { ...BUDGET, maxResultBytes: 10 })
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("Read-only execution exceeded the byte budget: 31 bytes > 10 allowed");
  });

  test("a transport failure of the statement or of a proof read during a cancel goes through the error table", async () => {
    const cancelled = new GraphClientError("cancelled", "The query was cancelled");
    const { provider } = await opened("agent", AGENT_PROFILE, { [EXPLAIN_READ]: EXPLAINED, [READ]: cancelled });
    await expect(provider.queryReadOnly(READ, BUDGET)).rejects.toThrow("The query was cancelled.");
  });

  test("a proof read ended by the deadline is the deadline's error, mapped, not a refusal of the principal", async () => {
    const { provider, recording } = await opened();
    recording.hang = NEO4J_AGENT_PROOF_STATEMENTS.privileges;
    const error = await provider
      .queryReadOnly(READ, { ...BUDGET, statementTimeoutMs: 5 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(statementsOf(recording)).not.toContain(READ);
  });
});

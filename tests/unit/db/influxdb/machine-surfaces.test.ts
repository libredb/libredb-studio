/**
 * What a model or an MCP client is handed about an InfluxDB connection (InfluxDB spec E13, 6.5): plan mode's inventory
 * (`readObjectInventoryForGrounding`) and MCP `inspect_schema` both read the object surface alone, so they see exactly
 * what the tree shows. On a 3.x server, through either type, that is never `_internal`, whose tables hold the server's
 * token table: it is not listed, and no request names it. On 1.x it is the operator's own monitoring database, listed
 * and read like any other. Neither provider has a read-only statement path, so agent execution and the MCP read tool
 * refuse both types.
 *
 * Every answer is a committed capture of the pinned servers, or a listing built in a capture's shape for a database the
 * captures hold no listing of, served by the statement the provider sends, through the real client and a recording
 * transport.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { type AgentToolContext, readObjectInventoryForGrounding } from "@/lib/agent/tools";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { createInfluxClient, type InfluxClientFactory } from "@/lib/db/providers/timeseries/influxdb/client";
import { InfluxDB3Provider, InfluxDBProvider } from "@/lib/db/providers/timeseries/influxdb/index";
import type { DatabaseConnection, DatabaseProvider, QueryResult } from "@/lib/db/types";
import { McpConnectionContext } from "@/lib/mcp/context";
import { InspectSchemaInputSchema, inspectSchema } from "@/lib/mcp/tools/inspect-schema";
import type { ManagedConnection } from "@/lib/seed/types";
import { type InfluxCapture, type InfluxFixtureVersion, loadInfluxCapture } from "../../../helpers/influxdb-fixtures";
import { type RecordedInfluxRequest, recordingInfluxTransport } from "../../../helpers/influxdb-transport";
import { pinMcpTestEnvironment, resetMcpTestState } from "../../../helpers/mcp-fixtures";

pinMcpTestEnvironment();

const INTERNAL = "_internal";

type Line = "1.13.1" | "3.12.0-core";

const INFLUXQL_CONNECTION: DatabaseConnection = {
  id: "influxdb-machine",
  name: "influxdb machine",
  type: "influxdb",
  host: "127.0.0.1",
  port: 8086,
  user: "admin",
  password: "admin-password",
  createdAt: new Date(0),
};

const SQL_CONNECTION: DatabaseConnection = {
  id: "influxdb3-machine",
  name: "influxdb3 machine",
  type: "influxdb3",
  host: "127.0.0.1",
  port: 8181,
  password: "token-secret",
  database: "home",
  createdAt: new Date(0),
};

/** A capture of this line with another body: the shape of the line's answers, for a listing no capture holds. */
function reshaped(version: InfluxFixtureVersion, name: string, body: string): InfluxCapture {
  return { ...loadInfluxCapture(version, name), name: "built", body };
}

/** A one-series InfluxQL answer in the `/query` shape the captures show. */
function influxqlSeries(version: Line, name: string, column: string, values: readonly string[]): InfluxCapture {
  const series = values.length === 0 ? [] : [{ name, columns: [column], values: values.map((value) => [value]) }];
  return reshaped(
    version,
    "show-databases-admin",
    `${JSON.stringify({ results: [{ statement_id: 0, ...(series.length === 0 ? {} : { series }) }] })}\n`,
  );
}

/** The statements each recorded `/query` or `/api/v3/query_sql` request sent, with the database it was sent to. */
function sentStatements(requests: readonly RecordedInfluxRequest[]): { db: string | undefined; q: string }[] {
  return requests.flatMap((request) => {
    if (request.form !== undefined) return [{ db: request.form.db, q: request.form.q ?? "" }];
    if (request.body !== undefined) {
      const body = JSON.parse(request.body) as { db?: string; q?: string };
      return [{ db: body.db, q: body.q ?? "" }];
    }
    return [];
  });
}

/**
 * The `/query` answers of a seeded server of this line, by statement: `SHOW DATABASES` is the line's capture, `home`'s
 * measurements and keys are its captures, and every other database lists one measurement named after it, so a walk
 * that reached a database shows it in the inventory. Any other statement fails the test.
 */
function influxqlServer(version: Line): (request: RecordedInfluxRequest) => InfluxCapture {
  return (request) => {
    const q = request.form?.q ?? "";
    const db = request.form?.db;
    if (q === "SHOW DATABASES") return loadInfluxCapture(version, "show-databases-admin");
    const measurements = /^SHOW MEASUREMENTS ON "([^"]+)"/.exec(q);
    if (measurements !== null) {
      return measurements[1] === "home"
        ? loadInfluxCapture(version, "show-measurements-home")
        : influxqlSeries(version, "measurements", "name", [`probe_${measurements[1]}`]);
    }
    if (q.startsWith("SHOW TAG KEYS")) {
      return db === "home" && q.includes('FROM "home"')
        ? loadInfluxCapture(version, "show-tag-keys-home")
        : influxqlSeries(version, "x", "tagKey", []);
    }
    if (q.startsWith("SHOW FIELD KEYS")) {
      return db === "home" && q.includes('FROM "home"')
        ? loadInfluxCapture(version, "show-field-keys-home")
        : influxqlSeries(version, "x", "fieldKey", []);
    }
    throw new Error(`no answer scripted for ${JSON.stringify(q)} on ${String(db)}`);
  };
}

/**
 * The `/api/v3/query_sql` answers of the seeded 3.12.0-core server, by statement: the table listing is the iox rows
 * of the `sql-tables` capture, answered only to a listing whose text carries the `table_schema = 'iox'` filter (one
 * without it throws), `home`'s schema is its capture, and every other table's schema is empty.
 */
function sqlServer(request: RecordedInfluxRequest): InfluxCapture {
  const { q } = JSON.parse(request.body ?? "{}") as { q?: string };
  const listing = loadInfluxCapture("3.12.0-core", "sql-tables");
  if (q?.startsWith("SELECT table_name FROM information_schema.tables") === true) {
    // The fake answers the iox rows only to a listing that asks for them, so the filter under test is the provider's.
    if (!q.includes("table_schema = 'iox'")) throw new Error(`the table listing must filter to iox: ${q}`);
    const iox = listing.body
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { table_schema: string; table_name: string })
      .filter((row) => row.table_schema === "iox")
      .map((row) => `${JSON.stringify({ table_name: row.table_name })}\n`)
      .join("");
    return { ...listing, name: "built", body: iox };
  }
  if (q?.startsWith("SELECT key, data_type FROM system.influxdb_schema") === true) {
    return q.endsWith("measurement = 'home'")
      ? loadInfluxCapture("3.12.0-core", "sql-schema-home")
      : { ...listing, name: "built", body: "" };
  }
  throw new Error(`no answer scripted for ${JSON.stringify(q)}`);
}

/** As many answers as any walk below sends; the recording transport throws past the script, never silently. */
const repeat = <T>(answer: T): T[] => Array.from({ length: 64 }, () => answer);

interface Connected {
  readonly provider: DatabaseProvider;
  readonly connection: DatabaseConnection;
  readonly requests: RecordedInfluxRequest[];
}

const providers: DatabaseProvider[] = [];

async function connectedInfluxql(version: Line): Promise<Connected> {
  const connect =
    version === "1.13.1"
      ? [
          loadInfluxCapture(version, "ping-anon"),
          loadInfluxCapture(version, "health-anon"),
          loadInfluxCapture(version, "show-databases-admin"),
        ]
      : [loadInfluxCapture(version, "ping-auth"), loadInfluxCapture(version, "show-databases-admin")];
  const wire = recordingInfluxTransport([...connect, ...repeat(influxqlServer(version))]);
  const factory: InfluxClientFactory = (options, routes) => createInfluxClient(options, routes, wire.factory);
  const provider = new InfluxDBProvider(INFLUXQL_CONNECTION, {}, factory);
  await provider.connect();
  providers.push(provider);
  wire.requests.length = 0;
  return { provider, connection: INFLUXQL_CONNECTION, requests: wire.requests };
}

async function connectedSql(): Promise<Connected> {
  const wire = recordingInfluxTransport([
    loadInfluxCapture("3.12.0-core", "ping-auth"),
    loadInfluxCapture("3.12.0-core", "sql-databases"),
    ...repeat(sqlServer),
  ]);
  const factory: InfluxClientFactory = (options, routes) => createInfluxClient(options, routes, wire.factory);
  const provider = new InfluxDB3Provider(SQL_CONNECTION, {}, factory);
  await provider.connect();
  providers.push(provider);
  wire.requests.length = 0;
  return { provider, connection: SQL_CONNECTION, requests: wire.requests };
}

/** What plan mode's grounding is handed: the context-snapshot suite's harness with the provider behind it. */
function agentContext({ provider, connection }: Connected): AgentToolContext {
  const clock = () => 1_000;
  return {
    runId: `run-${connection.type}`,
    modelId: "unmeasured-model-for-tests",
    mode: "planning",
    workflowType: "investigation",
    actor: { sessionId: "session-1", role: "user" },
    connection,
    capabilities: provider.getCapabilities(),
    labels: provider.getLabels(),
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection.id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, clock),
    repairs: new AgentRepairLedger(),
    acquireProvider: async () => provider,
    clock,
  };
}

/** The object paths plan mode's inventory holds. */
async function inventoryPaths(connected: Connected): Promise<readonly (readonly string[])[]> {
  const read = await readObjectInventoryForGrounding(agentContext(connected));
  if (read.kind !== "completed") throw new Error(`the inventory read did not complete: ${read.kind}`);
  return read.inventory.objects.map((object) => {
    if (object.path === undefined) throw new Error(`the inventory object ${object.name} carries no path`);
    return object.path;
  });
}

/** MCP `inspect_schema` over the provider, as an admin on a managed connection the seed exposes to MCP. */
async function inspected(
  { provider, connection }: Connected,
  schema?: string,
): Promise<{ readonly isError: boolean; readonly text: string }> {
  const context = new McpConnectionContext({ username: "alice", role: "admin" });
  const managed: ManagedConnection = {
    ...connection,
    managed: true,
    roles: ["admin"],
    seedId: connection.id,
    mcp: true,
  };
  spyOn(context, "resolve").mockResolvedValue(managed);
  const acquire = spyOn(context, "acquire").mockResolvedValue(provider);
  const result = await inspectSchema(
    InspectSchemaInputSchema.parse({
      connection_id: `seed:${connection.id}`,
      include_columns: true,
      ...(schema === undefined ? {} : { schema }),
    }),
    { context, signal: new AbortController().signal },
  );
  expect(acquire).toHaveBeenCalledWith(managed, "agent-operations");
  return { isError: result.isError === true, text: JSON.stringify(result) };
}

/** Whether any request named `_internal`: as the database it was sent to, or anywhere in its statement. */
const namedInternal = (requests: readonly RecordedInfluxRequest[]): boolean =>
  sentStatements(requests).some(({ db, q }) => db === INTERNAL || q.includes(INTERNAL));

afterEach(async () => {
  // oxlint-disable-next-line no-await-in-loop -- each provider closes its own client, one after another.
  for (const provider of providers.splice(0)) await provider.disconnect();
  await resetMcpTestState();
});

describe("plan mode's inventory (InfluxDB spec 6.5, E13)", () => {
  test("InfluxDB (InfluxQL) on 3.12.0-core: the measurements of every database but _internal, which no request names", async () => {
    const connected = await connectedInfluxql("3.12.0-core");
    const paths = await inventoryPaths(connected);
    expect(paths).toContainEqual(["home", "home"]);
    expect(paths).toContainEqual(["home", 'we"ird name;x']);
    expect(paths).toContainEqual(["edge", "probe_edge"]);
    expect(paths).toContainEqual(["bench", "probe_bench"]);
    expect(paths.some((path) => path.includes(INTERNAL) || path.includes(`probe_${INTERNAL}`))).toBe(false);
    expect(namedInternal(connected.requests)).toBe(false);
  });

  test("InfluxDB (InfluxQL) on 1.13.1: _internal is the operator's monitoring database, listed and read", async () => {
    const connected = await connectedInfluxql("1.13.1");
    const paths = await inventoryPaths(connected);
    expect(paths).toContainEqual([INTERNAL, `probe_${INTERNAL}`]);
    expect(paths).toContainEqual(["home", "home"]);
    expect(namedInternal(connected.requests)).toBe(true);
  });

  test("InfluxDB 3 (SQL): the session database's tables at the top level, no system table, and no _internal", async () => {
    const connected = await connectedSql();
    const paths = await inventoryPaths(connected);
    expect(paths).toEqual([["edge"], ["edge cases,m"], ["home"], ["numbers"], ["sparse"], ['we"ird name;x']]);
    // Every statement ran on the session database, `home`, and none named `_internal`.
    const sent = sentStatements(connected.requests);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every(({ db }) => db === "home")).toBe(true);
    expect(namedInternal(connected.requests)).toBe(false);
  });
});

describe("MCP inspect_schema (InfluxDB spec 6.5, E13)", () => {
  test("InfluxDB (InfluxQL) on 3.12.0-core reads home by default, answers no _internal, and sends no request naming it", async () => {
    const connected = await connectedInfluxql("3.12.0-core");
    const { isError, text } = await inspected(connected);
    expect(isError).toBe(false);
    expect(text).toContain('"schema":"home"');
    expect(text).toContain("temp");
    expect(text).not.toContain(INTERNAL);
    expect(namedInternal(connected.requests)).toBe(false);
  });

  test("InfluxDB (InfluxQL) on 3.12.0-core has no schema named _internal, and sends no request naming it", async () => {
    const connected = await connectedInfluxql("3.12.0-core");
    const { isError, text } = await inspected(connected, INTERNAL);
    expect(isError).toBe(true);
    expect(text).toContain("This connection has no schema of that name.");
    expect(text).not.toContain(`probe_${INTERNAL}`);
    expect(namedInternal(connected.requests)).toBe(false);
  });

  test("InfluxDB (InfluxQL) on 1.13.1 reads _internal when it is named, as any other database", async () => {
    const connected = await connectedInfluxql("1.13.1");
    const { isError, text } = await inspected(connected, INTERNAL);
    expect(isError).toBe(false);
    expect(text).toContain(`"schema":"${INTERNAL}"`);
    expect(text).toContain(`probe_${INTERNAL}`);
  });

  test("InfluxDB 3 (SQL) answers the session database's tables and columns at its root, and no _internal", async () => {
    const connected = await connectedSql();
    const { isError, text } = await inspected(connected);
    expect(isError).toBe(false);
    expect(text).toContain("edge cases,m");
    expect(text).toContain("temp");
    expect(text).not.toContain(INTERNAL);
    expect(text).not.toContain("influxdb_schema");
    expect(namedInternal(connected.requests)).toBe(false);

    // A named schema is refused at a root with no container level, `_internal` included, before any request.
    const before = connected.requests.length;
    expect((await inspected(connected, INTERNAL)).isError).toBe(true);
    expect(connected.requests.length).toBe(before);
  });
});

describe("no statement of the model's runs against InfluxDB (InfluxDB spec 6.5)", () => {
  test("neither provider has a read-only statement path, and neither type is an agent execution engine", async () => {
    const engines: readonly string[] = AGENT_EXECUTION_ENGINES;
    for (const connected of [await connectedInfluxql("3.12.0-core"), await connectedSql()]) {
      expect("queryReadOnly" in connected.provider).toBe(false);
      expect(engines).not.toContain(connected.connection.type);
    }
  });
});

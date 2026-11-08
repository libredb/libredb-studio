/**
 * InfluxDB 3 (SQL) provider, end to end over the captures (InfluxDB spec 5.2, 6.2, 6.6, 7; SPEC-delivery D gates 1
 * and 3).
 *
 * The real route-table client (`client.ts`), the real connect sequence, object surface, query pipeline, results
 * shaping and error table all run; only the server is fake. The fake is the recording transport of
 * `tests/helpers/influxdb-transport.ts`, handed to `createInfluxClient` through the provider constructor's client
 * factory, so every request goes through the client's route table and the shared transport's seam and is answered
 * from what the seeded server answered. `mock.module()` is not used.
 *
 * The answers were captured on 2026-10-04 (`tests/fixtures/influxdb/manifest.json`) by tests/live/influxdb-evidence.ts
 * from the `influxdb3` service of `database-compose.yml` seeded by docker/influxdb/seed.sh:
 * influxdb:3.12.0-core@sha256:624d69bca6bf6fb174aca5a974e1d96e5c5486994e6ae35bc9b4fe02b9520076.
 *
 * A request is answered by what it asks, not by its position, because the conformance helper decides its own reads.
 * What is BUILT rather than captured: the table listing, which `sql-tables` read with no `WHERE` (its six `iox` rows,
 * the ones `table_schema = 'iox'` keeps, are what the provider's listing answers), and the column listings of the
 * tables other than `home` and the hostile one, answered with `home`'s.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_STATEMENT_READ } from "@/lib/db/compatibility";
import { QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { executionContextFor, type ExecutionProfile } from "@/lib/db/factory";
import { TransportError } from "@/lib/db/http/node-transport";
import { readQueryFormsOf } from "@/lib/db/providers/sql/read-query-forms";
import { createInfluxClient, type InfluxClientFactory } from "@/lib/db/providers/timeseries/influxdb/client";
import { buildInfluxConnectionOptions } from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { SQL_ROUTES } from "@/lib/db/providers/timeseries/influxdb/routes";
import { INFLUX_ERROR_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/errors";
import { evaluateInfluxSql } from "@/lib/db/providers/timeseries/influxdb/sql-policy";
import { InfluxDB3Provider } from "@/lib/db/providers/timeseries/influxdb/sql-provider";
import type { DatabaseConnection, ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_ENGINE_ERROR_PREFIX, MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import { generateTableQuery } from "@/lib/query-generators";
import type { ManagedConnection } from "@/lib/seed";
import {
  type InfluxCapture,
  loadInfluxCapture,
  loadInfluxManifest,
  loadWriteRefusalCaptures,
} from "../../helpers/influxdb-fixtures";
import { type RecordedInfluxRequest, recordingInfluxTransport } from "../../helpers/influxdb-transport";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import { RUN_READ_QUERY_ENGINES, RunReadQueryInputSchema, runReadQuery } from "../../helpers/run-read-query";

const S = INFLUX_ERROR_SENTENCES as unknown as Record<string, string & ((...parts: string[]) => string)>;

const CONNECTION: DatabaseConnection = {
  id: "influxdb3-integration",
  name: "InfluxDB 3",
  type: "influxdb3",
  host: "127.0.0.1",
  port: 8181,
  password: "admin-token",
  database: "home",
  createdAt: new Date(0),
};

const capture = (name: string): InfluxCapture => loadInfluxCapture("3.12.0-core", name);

const LISTING_Q =
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'iox' ORDER BY table_name LIMIT 2001";
const SCHEMA_PREFIX = "SELECT key, data_type FROM system.influxdb_schema WHERE measurement = ";

/** The `iox` rows of `sql-tables`, as the listing's `WHERE table_schema = 'iox'` answers them. */
function ioxListing(): InfluxCapture {
  const tables = capture("sql-tables");
  const rows = tables.body
    .split("\n")
    .filter((line) => line.includes('"table_schema":"iox"'))
    .map((line) => `${JSON.stringify({ table_name: JSON.parse(line).table_name })}\n`);
  return { ...tables, name: "built", body: rows.join("") };
}

const IOX_TABLES = ["edge", "edge cases,m", "home", "numbers", "sparse", 'we"ird name;x'];

/**
 * The seeded server: each request answered by the capture of what it asks, `/ping` by `ping`. A statement `hold`
 * matches is never answered: its request waits until its signal fires, then fails as the shared transport fails a
 * request past its deadline, and `onClose` hears it.
 */
function recordedServer(
  extra: Readonly<Record<string, InfluxCapture>> = {},
  execution: ProviderExecutionContext = {},
  ping: InfluxCapture = capture("ping-auth"),
  hold: { readonly matches: (q: string) => boolean; readonly onClose: () => void } | null = null,
) {
  const answer = (request: RecordedInfluxRequest): InfluxCapture => {
    const path = new URL(request.url).pathname;
    if (path === "/ping") return ping;
    if (path === "/api/v3/configure/database") return capture("sql-databases");
    const { q } = JSON.parse(request.body as string) as { q: string };
    if (Object.hasOwn(extra, q)) return extra[q];
    if (q === LISTING_Q) return ioxListing();
    if (q === (capture("sql-schema-hostile").request.body as { q: string }).q) return capture("sql-schema-hostile");
    if (q.startsWith(SCHEMA_PREFIX)) return { ...capture("sql-schema-home"), name: "built" };
    throw new Error(`no capture answers ${q}`);
  };
  const wire = recordingInfluxTransport(Array.from({ length: 200 }, () => answer));
  const held: typeof wire.factory = (options) => {
    const inner = wire.factory(options);
    return {
      request: (request) =>
        hold !== null && request.body !== undefined && hold.matches((JSON.parse(request.body) as { q: string }).q)
          ? new Promise((_resolve, reject) =>
              request.signal.addEventListener(
                "abort",
                () => {
                  hold.onClose();
                  reject(new TransportError("timeout", "The request did not finish within its time limit"));
                },
                { once: true },
              ),
            )
          : inner.request(request),
      close: () => inner.close(),
    };
  };
  const factory: InfluxClientFactory = (options, routes) => createInfluxClient(options, routes, held);
  return { provider: new InfluxDB3Provider(CONNECTION, {}, execution, factory), wire };
}

const body = (request: RecordedInfluxRequest): { db: string; q: string; format: string } =>
  JSON.parse(request.body as string);

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

test("the header names the image and the date the manifest records", () => {
  expect(
    loadInfluxManifest()
      .versions.filter((entry) => entry.version === "3.12.0-core")
      .map((entry) => `${entry.image} ${entry.capturedAt}`),
  ).toEqual([
    "influxdb:3.12.0-core@sha256:624d69bca6bf6fb174aca5a974e1d96e5c5486994e6ae35bc9b4fe02b9520076 2026-10-04",
  ]);
});

describe("InfluxDB 3.12.0 Core, replayed", () => {
  test("connect reads /ping and the listing; the object surface meets the fleet's contract", async () => {
    const { provider, wire } = recordedServer();
    await provider.connect();
    expect(wire.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/ping",
      "/api/v3/configure/database",
    ]);
    await assertObjectSurface(provider, {
      containers: [],
      kinds: { table: IOX_TABLES.length },
      sampleObject: { path: ["home"], kind: "table" },
      noAbstainingKinds: true,
    });
    const sent = wire.requests.filter((request) => request.body !== undefined).map(body);
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(request.db).toBe("home");
      expect(evaluateInfluxSql(request.q).allowed).toBe(true);
    }
    expect((await provider.getOverview()).version).toBe("InfluxDB 3 Core 3.12.0, database home");
    await provider.disconnect();
  });

  test("the generated preview of home, with the limiter's LIMIT, is the text the capture ran", async () => {
    const preview = capture("sql-preview-home");
    const { provider, wire } = recordedServer({ [(preview.request.body as { q: string }).q]: preview });
    await provider.connect();
    const prepared = provider.prepareQuery(generateTableQuery(["home"], provider.getCapabilities()), { limit: 50 });
    expect(prepared.query).toBe((preview.request.body as { q: string }).q);
    const result = await provider.query(prepared.query);
    expect(body(wire.requests.at(-1) as RecordedInfluxRequest)).toEqual(
      preview.request.body as { db: string; q: string; format: string },
    );
    expect(result.fields).toEqual(["co", "hum", "room", "temp", "time"]);
    expect(result.rows.length).toBeGreaterThan(0);
    await provider.disconnect();
  });

  test("the hostile table describes through its quoted literal", async () => {
    const { provider } = recordedServer();
    await provider.connect();
    const detail = await provider.describeObject(['we"ird name;x'], "table");
    expect(detail.columns.map((column) => column.name)).toEqual(["time", "room", "v"]);
    await provider.disconnect();
  });

  test("sql-edge: integers beyond 2^53 are exact strings, timestamps keep their nanoseconds", async () => {
    const edge = capture("sql-edge");
    const q = (edge.request.body as { q: string }).q;
    const { provider } = recordedServer({ [q]: edge });
    await provider.connect();
    const result = await provider.query(q);
    const byKind = (kind: string) => result.rows.filter((row) => row.kind === kind)[0];
    expect(byKind("int64-max").v).toBe("9223372036854775807");
    expect(byKind("above-2-53").v).toBe("9007199254740993");
    expect(byKind("above-2-53").time).toBe("2022-01-01T08:00:00.000000003");
    await provider.disconnect();
  });

  test("sql-sparse: the columns are the ordered union of the keys, and a missing key is null", async () => {
    const sparse = capture("sql-sparse");
    const q = (sparse.request.body as { q: string }).q;
    const { provider } = recordedServer({ [q]: sparse });
    await provider.connect();
    const result = await provider.query(q);
    expect(result.fields).toEqual(["a", "b", "id", "time", "c"]);
    expect(result.rows[1]).toEqual({ a: 3, b: null, id: "r2", time: "2022-01-01T08:00:01", c: null });
    await provider.disconnect();
  });

  test("an empty column name reaches the grid as (No column name)", async () => {
    // The body is what 3.12 Core answered on 2026-10-07 for `SELECT 1 AS ""`, put behind a captured statement.
    const sparse = capture("sql-sparse");
    const q = (sparse.request.body as { q: string }).q;
    const { provider } = recordedServer({ [q]: { ...sparse, name: "built", body: '{"":1}\n' } });
    await provider.connect();
    const result = await provider.query(q);
    expect(result.fields).toEqual(["(No column name)"]);
    expect(result.rows).toEqual([{ "(No column name)": 1 }]);
    await provider.disconnect();
  });

  test("a line naming a column twice is refused with the column's name, never shown a column short", async () => {
    // The body is what 3.12 Core answered on 2026-10-07 for `SELECT c1.usage, c2.usage FROM cpu c1 CROSS JOIN cpu
    // c2`, put behind a captured statement so the request the provider builds is one the fake answers.
    const sparse = capture("sql-sparse");
    const q = (sparse.request.body as { q: string }).q;
    const { provider } = recordedServer({ [q]: { ...sparse, name: "built", body: '{"usage":1.5,"usage":1.5}\n' } });
    await provider.connect();
    const error = await rejection(provider.query(q));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(S.repeatedColumn("usage"));
    await provider.disconnect();
  });

  test("the error captures are worded by the error table, never shown as rows", async () => {
    const cases: readonly [string, string][] = [
      ["sql-parse-error", S.sqlParse('SQL error: ParserError("Expected: an expression, found: EOF")')],
      ["sql-planning-error", S.sqlPlan("Error during planning: table 'public.iox.nope' not found")],
      ["sql-cross-database", S.crossDatabase("edge.iox.numbers", "home")],
      [
        "sql-schema-error",
        S.sqlRefused(
          "Schema error: No field named nope. Valid fields are home.co, home.hum, home.room, home.temp, home.time.",
        ),
      ],
      ["filelimit-sql", S.fileLimit],
    ];
    const extra = Object.fromEntries(
      cases.map(([name]) => [(capture(name).request.body as { q: string }).q, capture(name)]),
    );
    const { provider } = recordedServer(extra);
    await provider.connect();
    for (const [name, message] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- each capture is replayed in turn.
      const error = await rejection(provider.query((capture(name).request.body as { q: string }).q));
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe(message);
    }
    await provider.disconnect();
  });

  test.each(["sql-truncated", "sql-truncated-mid-line", "sql-truncated-zero"])(
    "E11: %s is the truncation sentence, never a partial result",
    async (name) => {
      const cut = capture(name);
      const q = (cut.request.body as { q: string }).q;
      const { provider } = recordedServer({ [q]: cut });
      await provider.connect();
      const error = await rejection(provider.query(q));
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe(S.truncated);
      await provider.disconnect();
    },
  );
});

/**
 * The agent read-only profile's boundary, replayed: what 3.12.0 Core answered each write, DDL, COPY, SET, PREPARE and
 * transaction statement sent raw to `query_sql` (tests/live/influxdb3-write-refusals.ts, 2026-10-29). The read policy
 * refuses every one of these texts before sending, so the boundary claim rests on the server's answers: each request
 * is the one Studio's client builds for that text, each answer is a planner refusal, and each one reaches an agent
 * read as a statement refusal, never as rows.
 */
describe("InfluxDB 3.12.0 Core's write refusals, replayed", () => {
  const PROFILE: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
  const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 100, maxResultBytes: 65_536 };
  const STATEMENTS = loadWriteRefusalCaptures().filter((entry) => !entry.name.startsWith("write-refusal/token-"));
  const REFUSAL = /^(Error during planning: (DML|DDL|Statement) not supported: |This feature is not implemented: )/;
  const textOf = (entry: InfluxCapture): string => (entry.request.body as { q: string }).q;

  test("43 statements were captured, every one refused by the planner with a 400 or a 405 and no rows", () => {
    expect(STATEMENTS).toHaveLength(43);
    for (const entry of STATEMENTS) {
      expect([400, 405]).toContain(entry.status);
      expect(entry.contentType).toBeNull();
      expect(entry.body).toMatch(REFUSAL);
    }
  });

  test("the captures cover every write and DDL verb the boundary names", () => {
    const verbs = new Set(STATEMENTS.map((entry) => textOf(entry).split(" ")[0]));
    for (const verb of ["INSERT", "CREATE", "DROP", "DELETE", "UPDATE", "COPY", "ALTER", "TRUNCATE", "MERGE", "SET"]) {
      expect(verbs).toContain(verb);
    }
    expect(STATEMENTS.map(textOf)).toContain(
      "CREATE EXTERNAL TABLE libredb_wr_x STORED AS CSV LOCATION '/tmp/libredb-wr.csv'",
    );
  });

  test.each(STATEMENTS.map((entry) => [entry.name, entry] as const))(
    "%s: the request is the one Studio's client builds, and the planner's answer is a statement refusal",
    async (_name, entry) => {
      // The client sends what the capture sent: the policy is the provider's, not the client's.
      const wire = recordingInfluxTransport([entry]);
      const options = buildInfluxConnectionOptions(CONNECTION, { type: "influxdb3", queryTimeout: 30_000 });
      const client = createInfluxClient(options, SQL_ROUTES, wire.factory);
      const answer = await client.send(
        { route: "query", values: { db: "home", q: textOf(entry) } },
        AbortSignal.timeout(5_000),
      );
      client.close();
      expect(body(wire.requests[0])).toEqual(entry.request.body as { db: string; q: string; format: string });
      expect(answer.status).toBe(entry.status);

      // The provider refuses the text itself before sending it.
      expect(evaluateInfluxSql(textOf(entry)).allowed).toBe(false);

      // And an agent read the planner answers this way is refused in the server's own words.
      const { provider } = recordedServer({ "SELECT 1": entry }, PROFILE);
      await provider.connect();
      const error = await rejection(provider.queryReadOnly("SELECT 1", BUDGET));
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toContain(entry.body.replace(REFUSAL, "").slice(0, 40));
      await provider.disconnect();
    },
  );

  test("a Core token is an admin token: the token table holds *:*:*, and no route mints a scoped one", () => {
    const tokens = capture("write-refusal/token-permissions");
    expect(tokens.request.body).toEqual({
      db: "_internal",
      q: "SELECT name, permissions FROM system.tokens ORDER BY name",
      format: "jsonl",
    });
    expect(tokens.body).toBe('{"name":"_admin","permissions":"*:*:*"}\n');
    const scoped = capture("write-refusal/token-resource-route");
    expect([scoped.request.path, scoped.status, scoped.body]).toEqual([
      "/api/v3/enterprise/configure/token",
      404,
      "Not found",
    ]);
  });

  test("system.queries is refused with nothing sent, and system.influxdb_schema is read", async () => {
    const schema = capture("sql-schema-home");
    const { provider, wire } = recordedServer({ "SELECT * FROM system.influxdb_schema": schema }, PROFILE);
    await provider.connect();
    const sent = wire.requests.length;
    const error = await rejection(provider.queryReadOnly("SELECT * FROM system.queries", BUDGET));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toContain("system.influxdb_schema");
    expect(wire.requests.length).toBe(sent);
    const result = await provider.queryReadOnly("SELECT * FROM system.influxdb_schema", BUDGET);
    expect(result.rows.length).toBeGreaterThan(0);
    await provider.disconnect();
  });

  test("a statement the read policy refuses is refused before it is sent, in the policy's words", async () => {
    const { provider, wire } = recordedServer({}, PROFILE);
    await provider.connect();
    const sent = wire.requests.length;
    const statement = "DELETE FROM home";
    const verdict = evaluateInfluxSql(statement);
    expect(verdict.allowed).toBe(false);
    const error = await rejection(provider.queryReadOnly(statement, BUDGET));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe(verdict.allowed ? "" : verdict.message);
    expect(wire.requests.length).toBe(sent);
    await provider.disconnect();
  });

  test("a row-cut overflow and a cell-budget overflow of a captured answer are each refused, never truncated", async () => {
    const preview = capture("sql-tables");
    const q = (preview.request.body as { q: string }).q;
    const { provider } = recordedServer({ [q]: preview }, PROFILE);
    await provider.connect();
    const rows = preview.body.split("\n").filter((line) => line.trim() !== "").length;
    const cut = await rejection(provider.queryReadOnly(q, { ...BUDGET, maxResultRows: rows - 1 }));
    expect(cut.message).toBe(`Read-only execution exceeded the row budget: ${rows} rows > ${rows - 1} allowed`);
    await provider.disconnect();

    const wide = `{${Array.from({ length: 125_001 }, (_, column) => `"c${column}":1`).join(",")}}\n`;
    const cells = recordedServer({ [q]: { ...preview, name: "built", body: wide + wide } }, PROFILE);
    await cells.provider.connect();
    const overflow = await rejection(cells.provider.queryReadOnly(q, { ...BUDGET, maxResultBytes: 50_000_000 }));
    expect(overflow.message).toBe("Read-only execution exceeded the row budget: 2 rows > 1 allowed");
    await cells.provider.disconnect();
  });
});

// ============================================================================
// MCP run_read_query on InfluxDB 3
// ============================================================================

/**
 * MCP's `run_read_query` serves InfluxDB 3 (SQL) through the acquisition and `queryReadOnly` agent mode uses: the
 * connection is taken under `agent-read-only`, whose open checks the server is the 3.12 Core line whose planner's
 * write refusals were captured, and every statement runs through the read policy and the `system` schema fence before
 * it is sent. The MCP fence refuses a write-shaped statement before anything is acquired; a read of a `system` table
 * passes that fence and is refused by the provider's own, after the open and before anything is sent.
 */
describe("MCP run_read_query on an InfluxDB 3 connection", () => {
  const SEED = {
    id: "seed:metrics",
    name: "metrics",
    type: "influxdb3",
    seedId: "metrics",
    managed: true,
    mcp: true,
    roles: ["*"],
    host: "127.0.0.1",
    port: 8181,
    password: "not-a-real-token",
    database: "home",
    createdAt: new Date(0),
  } as ManagedConnection;

  let acquired: ExecutionProfile[] = [];
  let requests: RecordedInfluxRequest[][] = [];
  let answers: Record<string, InfluxCapture> = {};
  let ping: InfluxCapture = capture("ping-auth");
  let hold: Parameters<typeof recordedServer>[3] = null;

  /** A context over the one seed, opening each acquisition by its profile, as the factory does. */
  const context = {
    caller: { username: "alice", role: "admin" },
    visibleConnections: async () => [SEED],
    resolve: async () => SEED,
    acquire: async (_connection: ManagedConnection, profile: ExecutionProfile) => {
      acquired.push(profile);
      const { provider, wire } = recordedServer(answers, executionContextFor(profile), ping, hold);
      requests.push(wire.requests);
      await provider.connect();
      return provider;
    },
  } as unknown as McpConnectionContext;

  /** Every statement sent to `query_sql`, the open's included. */
  const statementsSent = (): string[] =>
    requests
      .flat()
      .filter((request) => new URL(request.url).pathname === "/api/v3/query_sql")
      .map((request) => body(request).q);

  function call(args: Record<string, unknown>) {
    const parsed = RunReadQueryInputSchema.parse({ connection_id: SEED.id, ...args }) as McpStatementInput;
    return runReadQuery(parsed, { context, signal: new AbortController().signal });
  }

  /** The same tool with its statement fence removed, so a statement reaches the boundary under test. */
  const UNFENCED: McpStatementArm = { ...mcpStatementArm("run_read_query"), fence: () => null };

  function unfenced(args: Record<string, unknown>) {
    const parsed = UNFENCED.inputSchema.parse({ connection_id: SEED.id, ...args }) as McpStatementInput;
    return runStatement(UNFENCED, parsed, { context, signal: new AbortController().signal });
  }

  /** A jsonl answer of `rows`, as `query_sql` gives one. */
  const jsonl = (rows: readonly Record<string, unknown>[]): InfluxCapture => ({
    ...capture("sql-keyword-select"),
    name: "built",
    body: rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
  });

  const rooms = (count: number) => jsonl(Array.from({ length: count }, (_, index) => ({ room: `r${index + 1}` })));

  beforeEach(() => {
    acquired = [];
    answers = {};
    ping = capture("ping-auth");
    hold = null;
    requests = [];
  });

  test("the provider doc says MCP read is open here and names the statements it runs, from their records", () => {
    const doc = readFileSync(join(import.meta.dir, "../../../docs/providers/influxdb3.md"), "utf8");

    expect(MCP_STATEMENT_READ.influxdb3).toBe(true);
    expect(MCP_STATEMENT_READ.influxdb).toBe(false);
    expect(doc).toContain("`MCP_STATEMENT_READ.influxdb3` is true");
    expect(doc).not.toContain("MCP's statement read stays closed");
    expect(doc).not.toContain("No MCP `run_read_query`");
    expect(doc.replaceAll("`", "")).toContain(`It runs ${readQueryFormsOf("influxdb3").statements}:`);
  });

  test("reads rows under the agent profile after the open's server check, paged one row past max_rows", async () => {
    answers = { "SELECT room FROM home ORDER BY time LIMIT 3": rooms(3) };

    const result = await call({ sql: "SELECT room FROM home ORDER BY time", max_rows: 2 });

    expect(result.isError).toBeUndefined();
    expect(acquired).toEqual(["agent-read-only"]);
    expect(statementsSent().at(-1)).toBe("SELECT room FROM home ORDER BY time LIMIT 3");
    expect(result.structuredContent).toMatchObject({
      connection_id: SEED.id,
      columns: [{ name: "room" }],
      rows: [{ room: "r1" }, { room: "r2" }],
      row_count: 2,
      truncated: true,
      truncated_by: "max_rows",
      pagination: { offset: 0, limit: 2, hasMore: true, nextOffset: 2, wasLimited: true },
      hint: "Call again with offset 2 for the next page.",
    });
    expect((result.content as { text: string }[])[0]?.text).toBe(MCP_UNTRUSTED_NOTICE);
  });

  test("pages with DataFusion's own LIMIT n OFFSET m", async () => {
    answers = { "SELECT room FROM home ORDER BY time LIMIT 3 OFFSET 2": rooms(1) };

    const result = await call({ sql: "SELECT room FROM home ORDER BY time", max_rows: 2, offset: 2 });

    expect(statementsSent().at(-1)).toBe("SELECT room FROM home ORDER BY time LIMIT 3 OFFSET 2");
    expect(result.structuredContent).toMatchObject({
      rows: [{ room: "r1" }],
      pagination: { offset: 2, limit: 2, hasMore: false, nextOffset: null, wasLimited: true },
    });
  });

  test.each([
    ["VALUES (1), (2), (3)", "This statement's result cannot be paged. Call again without offset."],
    ["EXPLAIN SELECT count(*) FROM home", "This statement's result cannot be paged. Call again without offset."],
    [
      "SELECT room FROM home LIMIT 5",
      "This query has its own LIMIT or TOP, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: LIMIT n OFFSET m.",
    ],
  ])("an offset on %p is refused before the statement is sent", async (sql, text) => {
    const result = await call({ sql, offset: 1 });

    expect(result).toEqual({ content: [{ type: "text", text }], isError: true });
    expect(statementsSent()).toEqual([]);
  });

  const fenced = (code: string) =>
    `The statement was refused before it reached the database (${code}). On this engine run_read_query runs one read-only statement: a SELECT (a WITH is fine), VALUES, or EXPLAIN without ANALYZE.`;

  test.each([
    ["INSERT INTO home (room, temp, time) VALUES ('Probe', 1.0, now())", "NON_READ_STATEMENT"],
    ["INSERT INTO system.queries SELECT * FROM system.queries", "NON_READ_STATEMENT"],
    ["DELETE FROM home WHERE room = 'Kitchen'", "NON_READ_STATEMENT"],
    ["UPDATE home SET temp = 0", "NON_READ_STATEMENT"],
    ["DROP TABLE home", "NON_READ_STATEMENT"],
    ["CREATE TABLE libredb_t AS SELECT 1 AS a", "NON_READ_STATEMENT"],
    ["CREATE EXTERNAL TABLE libredb_x STORED AS CSV LOCATION '/tmp/not-a-real-file.csv'", "NON_READ_STATEMENT"],
    ["COPY home TO '/tmp/not-a-real-copy.csv'", "NON_READ_STATEMENT"],
    ["TRUNCATE TABLE home", "NON_READ_STATEMENT"],
    ["SET datafusion.execution.batch_size = 1", "NON_READ_STATEMENT"],
    ["PREPARE libredb_p AS SELECT 1", "NON_READ_STATEMENT"],
    ["BEGIN", "NON_READ_STATEMENT"],
    ["SHOW TABLES", "NON_READ_STATEMENT"],
    ["SELECT 1; DROP TABLE home", "MULTIPLE_STATEMENTS"],
    ["WITH x AS (SELECT 1) INSERT INTO home SELECT * FROM home", "NON_READ_STATEMENT"],
    ["EXPLAIN ANALYZE SELECT count(*) FROM home", "SIDE_EFFECT_KEYWORD"],
    ["EXPLAIN INSERT INTO home (room, temp, time) VALUES ('Probe', 1.0, now())", "SIDE_EFFECT_KEYWORD"],
  ])("%p is refused at admission, before anything is acquired or sent", async (sql, code) => {
    const result = await call({ sql });

    expect(result).toEqual({ content: [{ type: "text", text: fenced(code) }], isError: true });
    expect(acquired).toEqual([]);
  });

  const SYSTEM_REFUSAL =
    "The statement was refused before it reached the database: The agent reads no table of InfluxDB 3's system schema but system.influxdb_schema: the others hold other queries' text, files and engine logs.";

  test.each([
    "SELECT * FROM system.queries",
    "SELECT * FROM system.parquet_files",
    "SELECT * FROM system.processing_engine_logs",
    'SELECT query_text FROM "SYSTEM"."queries"',
    "SELECT * FROM public.system.queries",
  ])("%p passes the MCP fence and is refused by the provider's system fence before it is sent", async (sql) => {
    const result = await call({ sql });

    expect(result).toEqual({ content: [{ type: "text", text: SYSTEM_REFUSAL }], isError: true });
    expect(acquired).toEqual(["agent-read-only"]);
    expect(statementsSent().filter((q) => q.includes("system"))).toEqual([]);
  });

  const STRING_QUALIFIER_REFUSAL =
    "The statement was refused before it reached the database: The agent reads no name written as a string before a `.`, since InfluxDB 3 reads it as a schema or table name and the system schema fence reads only names: write the name bare or in double quotes.";

  // The server answers each of these with rows of system.queries, so the provider's fence is what keeps them out.
  test.each([
    "SELECT query_text FROM 'system'.queries",
    "SELECT query_text FROM 'system'.'queries'",
    "SELECT query_text FROM public.'system'.queries",
    "SELECT query_text FROM 'public'.'system'.'queries'",
    `SELECT query_text FROM 'system'."queries"`,
  ])(
    "%p, a string before a `.`, passes the MCP fence and is refused by the provider before it is sent",
    async (sql) => {
      const result = await call({ sql });

      expect(result).toEqual({ content: [{ type: "text", text: STRING_QUALIFIER_REFUSAL }], isError: true });
      expect(acquired).toEqual(["agent-read-only"]);
      expect(statementsSent().filter((q) => q.includes("system"))).toEqual([]);
    },
  );

  test("system.influxdb_schema, the one system table the agent reads, is read", async () => {
    answers = { "SELECT * FROM system.influxdb_schema LIMIT 101": capture("sql-schema-home") };

    const result = await call({ sql: "SELECT * FROM system.influxdb_schema" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.row_count).toBeGreaterThan(0);
  });

  test("a write the MCP fence would refuse, the fence removed, is refused by the provider's read policy unsent", async () => {
    const result = await unfenced({ sql: "DELETE FROM home WHERE room = 'Kitchen'" });

    expect(acquired).toEqual(["agent-read-only"]);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `The statement was refused before it reached the database: ${(evaluateInfluxSql("DELETE FROM home WHERE room = 'Kitchen'") as { message: string }).message}`,
        },
      ],
      isError: true,
    });
    expect(statementsSent()).toEqual([]);
  });

  test("a planner refusal that reaches the server is answered as the database's own refusal", async () => {
    const refusal = capture("write-refusal/insert-values");
    answers = { "SELECT 1 LIMIT 101": refusal };

    const result = await call({ sql: "SELECT 1" });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[]).map((part) => part.text);
    expect(text[0]).toBe(MCP_UNTRUSTED_NOTICE);
    expect(text[1]).toStartWith(MCP_ENGINE_ERROR_PREFIX);
    expect(text[1]).toContain("DML not supported: Insert Into");
  });

  const refusedAtOpen = (sentence: string) => ({
    content: [
      {
        type: "text" as const,
        text: `run_read_query cannot run on this connection: ${sentence}. It runs on ${RUN_READ_QUERY_ENGINES}.`,
      },
    ],
    isError: true as const,
  });

  test.each([
    [
      "an Enterprise server",
      "InfluxDB 3 Enterprise",
      "3.12.0",
      "The agent read-only profile is checked on InfluxDB 3 Core 3.12, and this server is InfluxDB 3 Enterprise 3.12.0: its write refusals have not been captured, so it is refused",
    ],
    [
      "a Core server outside the checked line",
      "InfluxDB 3 Core",
      "3.13.0",
      "The agent read-only profile is checked on InfluxDB 3 Core 3.12, and this server is InfluxDB 3 Core 3.13.0: its write refusals have not been captured, so it is refused",
    ],
  ])(
    "%s is refused at open, in the tool's sentence, before the statement is sent",
    async (_label, product, version, sentence) => {
      const base = capture("ping-auth");
      ping = {
        ...base,
        name: "built",
        body: JSON.stringify({ ...JSON.parse(base.body), product_name: product, version }),
      };

      const result = await call({ sql: "SELECT room FROM home" });

      expect(acquired).toEqual(["agent-read-only"]);
      expect(result).toEqual(refusedAtOpen(sentence));
      expect(statementsSent()).toEqual([]);
    },
  );

  test("a server that names no version and build is refused at open, in the tool's sentence, before the statement is sent", async () => {
    ping = capture("ping-forbidden-synthetic");

    const result = await call({ sql: "SELECT room FROM home" });

    expect(acquired).toEqual(["agent-read-only"]);
    expect(result).toEqual(
      refusedAtOpen(
        "The agent read-only profile is checked on InfluxDB 3 Core 3.12, and this server reports no version and build, so it is refused",
      ),
    );
    expect(statementsSent()).toEqual([]);
  });

  test("a result past the 1000-row provider budget is refused, never cut", async () => {
    answers = { "SELECT room FROM home LIMIT 2000": rooms(1_001) };

    const result = await call({ sql: "SELECT room FROM home LIMIT 2000" });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "The result has more than 1000 rows, the most this server reads for one call. Add a LIMIT of 1000 or less, or remove your own LIMIT and page with offset.",
        },
      ],
      isError: true,
    });
  });

  test("a result past the 1 MiB provider budget is refused, never cut", async () => {
    answers = { "SELECT room FROM home LIMIT 101": jsonl([{ room: "x".repeat(1_048_577) }]) };

    const result = await call({ sql: "SELECT room FROM home" });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "The result is larger than 1 MiB, the most this server reads for one call. Select fewer or narrower columns, or add a smaller LIMIT.",
        },
      ],
      isError: true,
    });
  });

  test("a statement past timeout_ms is answered as the timeout, and its request is closed at the deadline", async () => {
    let closed = false;
    hold = { matches: (q) => q.startsWith("SELECT count(*)"), onClose: () => (closed = true) };

    const result = await call({ sql: "SELECT count(*) FROM generate_series(1, 2000000000)", timeout_ms: 500 });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "The statement did not finish within timeout_ms (500 ms). Narrow it, or raise timeout_ms up to 30000.",
        },
      ],
      isError: true,
    });
    await Bun.sleep(50);
    expect(closed).toBe(true);
  });
});

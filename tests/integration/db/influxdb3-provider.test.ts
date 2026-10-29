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
import { describe, expect, test } from "bun:test";
import { QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { createInfluxClient, type InfluxClientFactory } from "@/lib/db/providers/timeseries/influxdb/client";
import { buildInfluxConnectionOptions } from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { SQL_ROUTES } from "@/lib/db/providers/timeseries/influxdb/routes";
import { INFLUX_ERROR_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/errors";
import { evaluateInfluxSql } from "@/lib/db/providers/timeseries/influxdb/sql-policy";
import { InfluxDB3Provider } from "@/lib/db/providers/timeseries/influxdb/sql-provider";
import type { DatabaseConnection, ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import { generateTableQuery } from "@/lib/query-generators";
import {
  type InfluxCapture,
  loadInfluxCapture,
  loadInfluxManifest,
  loadWriteRefusalCaptures,
} from "../../helpers/influxdb-fixtures";
import { type RecordedInfluxRequest, recordingInfluxTransport } from "../../helpers/influxdb-transport";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

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

/** The seeded server: each request answered by the capture of what it asks. */
function recordedServer(extra: Readonly<Record<string, InfluxCapture>> = {}, execution: ProviderExecutionContext = {}) {
  const answer = (request: RecordedInfluxRequest): InfluxCapture => {
    const path = new URL(request.url).pathname;
    if (path === "/ping") return capture("ping-auth");
    if (path === "/api/v3/configure/database") return capture("sql-databases");
    const { q } = JSON.parse(request.body as string) as { q: string };
    if (Object.hasOwn(extra, q)) return extra[q];
    if (q === LISTING_Q) return ioxListing();
    if (q === (capture("sql-schema-hostile").request.body as { q: string }).q) return capture("sql-schema-hostile");
    if (q.startsWith(SCHEMA_PREFIX)) return { ...capture("sql-schema-home"), name: "built" };
    throw new Error(`no capture answers ${q}`);
  };
  const wire = recordingInfluxTransport(Array.from({ length: 200 }, () => answer));
  const factory: InfluxClientFactory = (options, routes) => createInfluxClient(options, routes, wire.factory);
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

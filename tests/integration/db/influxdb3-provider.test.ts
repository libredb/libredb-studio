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
import { QueryError } from "@/lib/db/errors";
import { createInfluxClient, type InfluxClientFactory } from "@/lib/db/providers/timeseries/influxdb/client";
import { INFLUX_ERROR_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/errors";
import { evaluateInfluxSql } from "@/lib/db/providers/timeseries/influxdb/sql-policy";
import { InfluxDB3Provider } from "@/lib/db/providers/timeseries/influxdb/sql-provider";
import type { DatabaseConnection } from "@/lib/db/types";
import { generateTableQuery } from "@/lib/query-generators";
import { type InfluxCapture, loadInfluxCapture, loadInfluxManifest } from "../../helpers/influxdb-fixtures";
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
function recordedServer(extra: Readonly<Record<string, InfluxCapture>> = {}) {
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
  return { provider: new InfluxDB3Provider(CONNECTION, {}, factory), wire };
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

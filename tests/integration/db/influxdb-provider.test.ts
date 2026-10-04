/**
 * InfluxDB (InfluxQL) provider, end to end over the captures (InfluxDB spec 5.1, 6.2, 7; SPEC-delivery D gates 1
 * and 3).
 *
 * The real route-table client (`client.ts`), the real connect sequence, object surface, query pipeline, results
 * shaping and error table all run; only the server is fake. The fake is the recording transport of
 * `tests/helpers/influxdb-transport.ts`, handed to `createInfluxClient` through the provider constructor's client
 * factory, so every request goes through the client's route table and the shared transport's seam and is answered
 * from what the seeded server answered. `mock.module()` is not used.
 *
 * The answers were captured on 2026-10-04 (`tests/fixtures/influxdb/manifest.json`) by tests/live/influxdb-evidence.ts
 * from the services of `database-compose.yml` seeded by docker/influxdb/seed.sh:
 * - influxdb:1.13.1@sha256:3e3913d3b7512d1749922c8183bbf2a76973dd9f98e1a1e3249c652ec1576fc0
 * - influxdb:2.9.1@sha256:db0bdab1e5ad5ee899c127b8c13d9c986a3ced78cd9200dd80a1064bf1533b6e
 * - influxdb:3.12.0-core@sha256:624d69bca6bf6fb174aca5a974e1d96e5c5486994e6ae35bc9b4fe02b9520076
 *
 * A request is answered by what it asks, not by its position, because the conformance helper decides its own reads.
 * What is BUILT rather than captured: the tag and field key listings of the measurements other than `home` (an empty
 * result, as a measurement with no key of that kind answers), and the `/query` cut, which no pinned line produced
 * (R39): `preview-home` with `cut` set, named `synthetic` below. The catalog captures were taken without the
 * provider's `LIMIT 2001` (each line lists six measurements, under the limit), and the hostile-names capture reads
 * the hostile measurement with the generated source text rather than the windowed preview, whose hour holds none of
 * its 2022 points; the windowed preview's answer is built empty. A recapture with the provider's exact texts is T08's.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { createInfluxClient, type InfluxClientFactory } from "@/lib/db/providers/timeseries/influxdb/client";
import { INFLUX_ERROR_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/errors";
import { influxqlTableQuery } from "@/lib/db/providers/timeseries/influxdb/influxql-generators";
import { evaluateInfluxql } from "@/lib/db/providers/timeseries/influxdb/influxql-policy";
import { InfluxDBProvider } from "@/lib/db/providers/timeseries/influxdb/influxql-provider";
import { influxqlSource } from "@/lib/db/providers/timeseries/influxdb/influxql-quote";
import type { DatabaseConnection } from "@/lib/db/types";
import {
  INFLUX_FIXTURE_VERSIONS,
  type InfluxCapture,
  type InfluxFixtureVersion,
  loadInfluxCapture,
  loadInfluxManifest,
} from "../../helpers/influxdb-fixtures";
import { type RecordedInfluxRequest, recordingInfluxTransport } from "../../helpers/influxdb-transport";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

const S = INFLUX_ERROR_SENTENCES as unknown as Record<string, string & ((...parts: string[]) => string)>;

const CONNECTION: DatabaseConnection = {
  id: "influxdb-integration",
  name: "InfluxDB",
  type: "influxdb",
  host: "127.0.0.1",
  port: 8086,
  user: "admin",
  password: "admin-password",
  createdAt: new Date(0),
};

/** What `SHOW DATABASES` lists to the admin principal on each line, `_internal` already hidden on 3.x. */
const CONTAINERS: Readonly<Record<InfluxFixtureVersion, readonly string[]>> = {
  "1.13.1": ["home", "edge", "_internal", "bench"],
  "2.9.1": ["_monitoring", "_tasks", "bench", "edge", "home"],
  "3.12.0-core": ["home", "edge", "bench"],
};

const EMPTY_RESULT = '{"results":[{"statement_id":0}]}\n';

/** An answer for one text: a capture, or one chosen by the rest of the request. */
type ExtraAnswer = InfluxCapture | ((request: RecordedInfluxRequest) => InfluxCapture);

/** The seeded server of one line: each request answered by the capture of what it asks. */
function recordedServer(version: InfluxFixtureVersion, extra: Readonly<Record<string, ExtraAnswer>> = {}) {
  const capture = (name: string) => loadInfluxCapture(version, name);
  const answer = (request: RecordedInfluxRequest): InfluxCapture => {
    const path = new URL(request.url).pathname;
    if (path === "/ping") return capture(version === "3.12.0-core" ? "ping-auth" : "ping-anon");
    if (path === "/health") return capture("health-anon");
    const q = request.form?.q ?? "";
    if (Object.hasOwn(extra, q)) {
      const scripted = extra[q];
      return typeof scripted === "function" ? scripted(request) : scripted;
    }
    if (q === "SHOW DATABASES") return capture("show-databases-admin");
    // The capture was taken as `SHOW MEASUREMENTS ON "home"`; its six names are under the provider's LIMIT 2001.
    if (q === 'SHOW MEASUREMENTS ON "home" LIMIT 2001') return capture("show-measurements-home");
    if (q === 'SHOW TAG KEYS ON "home" FROM "home"') return capture("show-tag-keys-home");
    if (q === 'SHOW FIELD KEYS ON "home" FROM "home"') return capture("show-field-keys-home");
    if (q.startsWith("SHOW TAG KEYS") || q.startsWith("SHOW FIELD KEYS")) {
      return { ...capture("show-tag-keys-home"), name: "built", body: EMPTY_RESULT };
    }
    throw new Error(`no capture answers ${q}`);
  };
  const wire = recordingInfluxTransport(Array.from({ length: 200 }, () => answer));
  const factory: InfluxClientFactory = (options, routes) => createInfluxClient(options, routes, wire.factory);
  const config = version === "1.13.1" ? CONNECTION : { ...CONNECTION, user: "" };
  return { provider: new InfluxDBProvider(config, {}, factory), wire, capture };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

test("the header names the images and the date the manifest records", () => {
  expect(loadInfluxManifest().versions.map((entry) => `${entry.image} ${entry.capturedAt}`)).toEqual([
    "influxdb:1.13.1@sha256:3e3913d3b7512d1749922c8183bbf2a76973dd9f98e1a1e3249c652ec1576fc0 2026-10-04",
    "influxdb:2.9.1@sha256:db0bdab1e5ad5ee899c127b8c13d9c986a3ced78cd9200dd80a1064bf1533b6e 2026-10-04",
    "influxdb:3.12.0-core@sha256:624d69bca6bf6fb174aca5a974e1d96e5c5486994e6ae35bc9b4fe02b9520076 2026-10-04",
  ]);
});

describe.each([...INFLUX_FIXTURE_VERSIONS])("InfluxDB %s, replayed", (version) => {
  test("connect reads the version and the listing; the object surface meets the fleet's contract", async () => {
    const { provider, wire } = recordedServer(version);
    await provider.connect();
    expect(wire.requests.map((request) => new URL(request.url).pathname)).toEqual(
      version === "3.12.0-core" ? ["/ping", "/query"] : ["/ping", "/health", "/query"],
    );
    await assertObjectSurface(provider, {
      containers: CONTAINERS[version].map((name) => [name]),
      container: ["home"],
      kinds: { measurement: 6 },
      sampleObject: { path: ["home", "home"], kind: "measurement" },
      noAbstainingKinds: true,
    });
    for (const request of wire.requests.filter((sent) => sent.form !== undefined)) {
      expect(evaluateInfluxql(request.form?.q as string).allowed).toBe(true);
    }
    await provider.disconnect();
  });

  test("the preview of home has rows, and the preview of edge, whose points are from 2022, has none", async () => {
    const home = loadInfluxCapture(version, "preview-home");
    const edge = loadInfluxCapture(version, "preview-edge-empty");
    const { provider, wire } = recordedServer(version, {
      [influxqlTableQuery(["home", "home"])]: home,
      [influxqlTableQuery(["home", "edge"])]: edge,
    });
    await provider.connect();
    // The generated text is the text the capture was taken with.
    expect(influxqlTableQuery(["home", "home"])).toBe(home.request.form?.q as string);
    expect(influxqlTableQuery(["home", "edge"])).toBe(edge.request.form?.q as string);
    const rows = await provider.query(influxqlTableQuery(["home", "home"]));
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.fields).toEqual(["time", "co", "hum", "room", "temp"]);
    const empty = await provider.query(influxqlTableQuery(["home", "edge"]));
    expect(empty.rows).toEqual([]);
    expect(wire.requests.slice(-2).map((request) => request.form?.db)).toEqual(["home", "home"]);
    await provider.disconnect();
  });

  test("edge-values: integers beyond 2^53 are exact strings, times keep their nanoseconds", async () => {
    const edge = loadInfluxCapture(version, "edge-values");
    const q = edge.request.form?.q as string;
    const { provider } = recordedServer(version, { [q]: edge });
    await provider.connect();
    const result = await provider.query(q);
    const byKind = (kind: string) => result.rows.filter((row) => row.kind === kind);
    expect(byKind("int64-max")[0].v).toBe("9223372036854775807");
    expect(byKind("int64-min")[0].v).toBe("-9223372036854775808");
    expect(byKind("above-2-53")[0].v).toBe("9007199254740993");
    expect(result.rows[0].time).toBe("2022-01-01T08:00:00.000000001Z");
    expect(byKind("nanoseconds")[0].time).toBe("2022-01-01T08:00:00.123456789Z");
    await provider.disconnect();
  });

  test("hostile-names: the generated source of the hostile measurement is what was replayed", async () => {
    const hostile = loadInfluxCapture(version, "hostile-names");
    const q = hostile.request.form?.q as string;
    expect(q).toContain(influxqlSource("home", 'we"ird name;x'));
    const { provider, wire } = recordedServer(version, { [q]: hostile });
    await provider.connect();
    const result = await provider.query(q);
    expect(wire.requests.at(-1)?.form?.db).toBe("home");
    expect(result.rows.map((row) => row.measurement)).toEqual(["edge cases,m", 'we"ird name;x']);
    await provider.disconnect();
  });

  test("hostile-names: T14's generated preview of the hostile measurement is allowed and sent with db=home", async () => {
    const preview = influxqlTableQuery(["home", 'we"ird name;x']);
    // The same source text the hostile-names capture read, so the server parsed this name as one measurement.
    expect(preview).toContain(influxqlSource("home", 'we"ird name;x'));
    expect(evaluateInfluxql(preview).allowed).toBe(true);
    // Built, not captured: the windowed hour holds none of the measurement's 2022 points, as preview-edge-empty shows.
    const empty: InfluxCapture = { ...loadInfluxCapture(version, "preview-edge-empty"), name: "built" };
    const { provider, wire } = recordedServer(version, { [preview]: empty });
    await provider.connect();
    const result = await provider.query(preview);
    expect(wire.requests.at(-1)?.form).toMatchObject({ q: preview, db: "home" });
    expect(result.rows).toEqual([]);
    await provider.disconnect();
  });

  test("the error captures are worded by the error table, never shown as rows", async () => {
    const parse = loadInfluxCapture(version, "parse-error");
    const missing = loadInfluxCapture(version, "db-not-found");
    const { provider } = recordedServer(version, {
      [parse.request.form?.q as string]: parse,
      'SELECT count(temp) FROM "nope".."home"': missing,
    });
    await provider.connect();
    const parsed = await rejection(provider.query(parse.request.form?.q as string));
    expect(parsed).toBeInstanceOf(QueryError);
    expect(parsed.message).toContain(version === "3.12.0-core" ? "parsing error" : "found EOF");
    const notFound = await rejection(provider.query('SELECT count(temp) FROM "nope".."home"'));
    expect(notFound).toBeInstanceOf(QueryError);
    expect(notFound.message).toContain("database not found: nope");
    await provider.disconnect();
  });

  test("E11: a /query answer the server ended early is the truncation sentence", async () => {
    const home = loadInfluxCapture(version, "preview-home");
    const synthetic: InfluxCapture = {
      ...home,
      cut: "mid-line",
      bytes: Math.floor(home.body.length / 2),
      synthetic: "preview-home with cut set: no /query truncation reproduces on 3.12.0 (R39, T08)",
    };
    const { provider } = recordedServer(version, { [home.request.form?.q as string]: synthetic });
    await provider.connect();
    const error = await rejection(provider.query(home.request.form?.q as string));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(S.truncated);
    await provider.disconnect();
  });

  test("R53: SHOW TAG KEYS and SHOW TAG VALUES over every measurement show their rows, sent unchunked", async () => {
    // Each text is answered as the line answered it: chunked when the request asks for chunks, whole otherwise. The
    // captures name their database with db=home; the texts here name it with ON, as the connection names none.
    const shows = [
      ['SHOW TAG KEYS ON "home"', "show-tag-keys-all"],
      ['SHOW TAG VALUES ON "home" WITH KEY = "room"', "show-tag-values-room"],
    ] as const;
    const { provider, wire } = recordedServer(
      version,
      Object.fromEntries(
        shows.map(([q, name]) => [
          q,
          (request: RecordedInfluxRequest) =>
            loadInfluxCapture(version, request.form?.chunked === "true" ? `${name}-chunked` : name),
        ]),
      ),
    );
    await provider.connect();
    for (const [q, name] of shows) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time on one provider.
      const result = await provider.query(q);
      expect(wire.requests.at(-1)?.form).toEqual({ db: "home", q });
      const whole = JSON.parse(loadInfluxCapture(version, name).body) as {
        results: { series: { values: unknown[] }[] }[];
      };
      expect(result.rowCount).toBe(whole.results[0].series.reduce((sum, entry) => sum + entry.values.length, 0));
      expect(result.rowCount).toBeGreaterThan(1);
    }
    await provider.disconnect();
  });
});

describe.each(["1.13.1", "3.12.0-core"] as const)("InfluxDB %s, R31", (version) => {
  test("segment-after-dot: the provider sends db=home for a source with whitespace after its dots", async () => {
    const segment = loadInfluxCapture(version, "segment-after-dot");
    const q = segment.request.form?.q as string;
    const { provider, wire } = recordedServer(version, { [q]: segment });
    await provider.connect();
    const result = await provider.query(q);
    expect(wire.requests.at(-1)?.form?.db).toBe("home");
    expect(result.rows).toEqual([{ time: "1970-01-01T00:00:00Z", count: 26 }]);
    await provider.disconnect();
  });
});

test("C5: the 3.12.0 multi-statement answer is the lexer-disagreement error", async () => {
  const two = loadInfluxCapture("3.12.0-core", "differential/two-statements");
  const { provider } = recordedServer("3.12.0-core", { "SHOW DATABASES ": two });
  await provider.connect();
  const error = await rejection(provider.query("SHOW DATABASES "));
  expect(error).toBeInstanceOf(QueryError);
  expect(error.message).toBe(S.lexerDisagreement);
  await provider.disconnect();
});

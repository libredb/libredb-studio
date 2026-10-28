import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { NodeRequest, NodeTransportOptions } from "@/lib/db/http/node-transport";

type Answer = { status: number; text: string } | Promise<{ status: number; text: string }>;
type Built = { opts: NodeTransportOptions; requests: NodeRequest[]; closed: number; fail: ((e: Error) => void)[] };

const realNode = { ...(await import("@/lib/db/http/node-transport")) };
const { TransportError } = realNode;

const built: Built[] = [];
let api: (req: NodeRequest) => Answer;
let tokenCount = 0;
// expires_in under a minute: every call fetches a new token, so each call can rotate the lane.
let tokenTtl = 3600;

// Like the real transport: close() and the request's signal abort what is in flight.
mock.module("@/lib/db/http/node-transport", () => ({
  ...realNode,
  createNodeTransport: (opts: NodeTransportOptions) => {
    const entry: Built = { opts, requests: [], closed: 0, fail: [] };
    built.push(entry);
    return {
      async request(req: NodeRequest) {
        entry.requests.push(req);
        const answer = await new Promise<{ status: number; text: string }>((resolve, reject) => {
          entry.fail.push(reject);
          req.signal?.addEventListener("abort", () => reject(new TransportError("aborted", "cancelled")));
          Promise.resolve(
            new URL(req.url).pathname.startsWith("/bigquery/v2/")
              ? api(req)
              : { status: 200, text: JSON.stringify({ access_token: `t${++tokenCount}`, expires_in: tokenTtl }) },
          ).then(resolve, reject);
        });
        return { ...answer, contentType: "application/json", retryAfter: null };
      },
      close() {
        entry.closed += 1;
        for (const fail of entry.fail) fail(new TransportError("aborted", "closed"));
      },
    };
  },
}));

const { BigQueryApiError, apiOrigin, createBigQueryTransport, decodeCell } = await import(
  "@/lib/db/providers/sql/bigquery/transport"
);

const creds = { type: "authorized_user", client_id: "id", client_secret: "s", refresh_token: "r" } as const;
const signal = new AbortController().signal;
const json = (body: unknown, status = 200) => ({ status, text: JSON.stringify(body) });
const apiCalls = () => built.filter((b) => b.opts.origin.host === "bigquery.googleapis.com").flatMap((b) => b.requests);
const opts = { jobTimeoutMs: 1000, maxRows: 100, signal };
const never = () => new Promise<{ status: number; text: string }>(() => {});

beforeEach(() => {
  built.length = 0;
  tokenCount = 0;
  tokenTtl = 3600;
});

describe("bigquery transport wiring", () => {
  test("oauth lane is https to the token endpoint; metadata lane is http with the flavor header", () => {
    createBigQueryTransport("p", creds);
    expect(built[0].opts).toMatchObject({
      origin: { scheme: "https", host: "oauth2.googleapis.com", port: 443 },
      tls: { rejectUnauthorized: true, identity: "oauth2.googleapis.com" },
      headers: {},
    });
    createBigQueryTransport("p", { type: "metadata", host: "meta" });
    expect(built[1].opts).toMatchObject({
      origin: { scheme: "http", host: "meta", port: 80 },
      tls: null,
      headers: { "metadata-flavor": "Google" },
    });
  });
});

describe("BIGQUERY_EMULATOR_HOST", () => {
  test("unset or blank, the API is Google's over https", () => {
    for (const env of [{}, { BIGQUERY_EMULATOR_HOST: "  " }]) {
      expect(apiOrigin(env)).toEqual({ scheme: "https", host: "bigquery.googleapis.com", port: 443 });
    }
  });

  test("host:port is plain http, and a URL keeps its scheme and default port", () => {
    expect(apiOrigin({ BIGQUERY_EMULATOR_HOST: "localhost:9050" })).toEqual({
      scheme: "http",
      host: "localhost",
      port: 9050,
    });
    expect(apiOrigin({ BIGQUERY_EMULATOR_HOST: "emulator" })).toEqual({ scheme: "http", host: "emulator", port: 80 });
    expect(apiOrigin({ BIGQUERY_EMULATOR_HOST: "https://bq.test" })).toEqual({
      scheme: "https",
      host: "bq.test",
      port: 443,
    });
  });

  test("routes every API request to the emulator without TLS", async () => {
    api = () => json({ datasets: [] });
    const bq = createBigQueryTransport(
      "p",
      { type: "access_token", token: "t" },
      { BIGQUERY_EMULATOR_HOST: "127.0.0.1:9050" },
    );
    await bq.listDatasets(signal);
    const lane = built.find((b) => b.opts.origin.port === 9050);
    expect(lane?.opts).toMatchObject({ origin: { scheme: "http", host: "127.0.0.1", port: 9050 }, tls: null });
    expect(lane?.requests[0].url).toStartWith("http://127.0.0.1:9050/bigquery/v2/projects/p/datasets?");
  });

  test("sends no credential: no token request and no authorization header, a key JSON notwithstanding", async () => {
    api = () => json({ jobComplete: true, jobReference: { jobId: "j" } });
    const key = {
      type: "service_account",
      client_email: "sa@p.iam.gserviceaccount.com",
      private_key: "not a key",
    } as const;
    const bq = createBigQueryTransport("p", key, { BIGQUERY_EMULATOR_HOST: "127.0.0.1:9050" });
    await bq.listDatasets(signal);
    await bq.query("SELECT 1", opts);
    expect(built.some((b) => b.opts.origin.host === "oauth2.googleapis.com")).toBe(false);
    expect(tokenCount).toBe(0);
    const lanes = built.filter((b) => b.opts.origin.port === 9050);
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) expect(lane.opts.headers ?? {}).not.toHaveProperty("authorization");
    bq.close();
  });
});

describe("bigquery query", () => {
  test("posts jobs.query with location, defaultDataset and dryRun, decoding rows and totals", async () => {
    api = () =>
      json({
        jobComplete: true,
        schema: {
          fields: [
            { name: "n", type: "INTEGER" },
            { name: "f", type: "FLOAT64" },
          ],
        },
        rows: [{ f: [{ v: "1" }, { v: "2.5" }] }],
        totalBytesProcessed: "1024",
        totalBytesBilled: "2048",
        cacheHit: true,
        numDmlAffectedRows: "3",
      });
    const bq = createBigQueryTransport("my-proj", creds);
    const result = await bq.query("SELECT 1", { ...opts, location: "EU", defaultDataset: "ds", dryRun: true });
    expect(result).toMatchObject({
      fields: [{ name: "n" }, { name: "f" }],
      rows: [{ n: "1", f: 2.5 }],
      totalBytesProcessed: 1024,
      totalBytesBilled: 2048,
      cacheHit: true,
      affectedRows: 3,
    });
    const [req] = apiCalls();
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://bigquery.googleapis.com/bigquery/v2/projects/my-proj/queries");
    expect(JSON.parse(req.body ?? "")).toEqual({
      query: "SELECT 1",
      location: "EU",
      useLegacySql: false,
      dryRun: true,
      maxResults: 100,
      timeoutMs: 1000,
      jobTimeoutMs: "1000",
      formatOptions: { useInt64Timestamp: true },
      defaultDataset: { projectId: "my-proj", datasetId: "ds" },
    });
    const lane = built.find((b) => b.opts.origin.host === "bigquery.googleapis.com");
    expect(lane?.opts.headers).toEqual({ authorization: "Bearer t1" });
  });

  test("a bare answer has no rows, no schema and null totals", async () => {
    api = () => json({ rows: "nope", totalBytesProcessed: "x" });
    const result = await createBigQueryTransport("p", creds).query("SELECT 1", opts);
    expect(result).toMatchObject({
      fields: [],
      rows: [],
      totalBytesProcessed: null,
      totalBytesBilled: null,
      cacheHit: false,
      affectedRows: null,
    });
    expect(JSON.parse(apiCalls()[0].body ?? "")).not.toHaveProperty("location");
  });

  test("polls an incomplete job, then follows pageToken up to maxRows", async () => {
    const field = [{ name: "n", type: "INTEGER" }];
    const pages = [
      json({ jobComplete: false, jobReference: { jobId: "j/1", location: "EU" } }),
      json({
        jobComplete: true,
        schema: { fields: field },
        rows: [{ f: [{ v: "1" }] }, { f: [{ v: "2" }] }],
        pageToken: "p2",
      }),
      json({
        jobComplete: true,
        rows: [{ f: [{ v: "3" }] }, { f: [{ v: "4" }] }],
        pageToken: "p3",
        totalBytesProcessed: "9",
      }),
    ];
    api = () => pages.shift() ?? json({});
    const result = await createBigQueryTransport("p", creds).query("SELECT n", { ...opts, maxRows: 3 });
    expect(result.rows).toEqual([{ n: "1" }, { n: "2" }, { n: "3" }]);
    expect(result.totalBytesProcessed).toBe(9);
    const urls = apiCalls().map((r) => new URL(r.url));
    expect(urls).toHaveLength(3);
    expect(urls[1].pathname).toBe("/bigquery/v2/projects/p/queries/j%2F1");
    expect(Object.fromEntries(urls[1].searchParams)).toEqual({
      maxResults: "3",
      timeoutMs: "1000",
      "formatOptions.useInt64Timestamp": "true",
      location: "EU",
    });
    expect(urls[2].searchParams.get("pageToken")).toBe("p2");
    expect(urls[2].searchParams.get("maxResults")).toBe("1");
  });

  test("a pageToken without a job reference is not followed", async () => {
    api = () => json({ pageToken: "p2", jobReference: {}, rows: [] });
    await createBigQueryTransport("p", creds).query("SELECT 1", opts);
    expect(apiCalls()).toHaveLength(1);
  });

  test("an error envelope becomes BigQueryApiError with status, reason and message", async () => {
    api = () => json({ error: { message: "Not found: Table x", errors: [{ reason: "notFound" }] } }, 404);
    const err = await createBigQueryTransport("p", creds)
      .query("SELECT 1", opts)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BigQueryApiError);
    expect(err).toMatchObject({
      name: "BigQueryApiError",
      status: 404,
      reason: "notFound",
      message: "Not found: Table x",
    });
  });

  test("a non-JSON error is reported by status", async () => {
    api = () => ({ status: 502, text: "<html>bad gateway</html>" });
    const err = await createBigQueryTransport("p", creds)
      .query("SELECT 1", opts)
      .catch((e) => e);
    expect(err).toMatchObject({ status: 502, reason: null, message: "BigQuery answered HTTP 502" });
  });

  test("a non-JSON success reads as an empty answer", async () => {
    api = () => ({ status: 200, text: "ok" });
    expect((await createBigQueryTransport("p", creds).query("SELECT 1", opts)).rows).toEqual([]);
  });
});

describe("bigquery job cancel", () => {
  const failing = (location?: string) => {
    api = (req) =>
      req.method === "POST" && req.url.includes("/cancel")
        ? json({}, 500)
        : req.url.includes("/queries/")
          ? json({ error: { message: "boom" } }, 500)
          : json({ jobComplete: false, jobReference: { jobId: "j/1", ...(location ? { location } : {}) } });
  };
  const cancels = () => apiCalls().filter((r) => r.url.includes("/cancel"));

  test("a failure while polling cancels the job with its location, swallowing a failed cancel, and rethrows", async () => {
    failing("EU");
    const err = await createBigQueryTransport("p", creds)
      .query("SELECT 1", opts)
      .catch((e) => e);
    expect(err).toMatchObject({ message: "boom" });
    const [cancel] = cancels();
    expect(cancel.method).toBe("POST");
    expect(cancel.url).toBe("https://bigquery.googleapis.com/bigquery/v2/projects/p/jobs/j%2F1/cancel?location=EU");
    expect(cancel.signal).not.toBe(signal);
  });

  test("a cancel that never reaches the API is swallowed, and the poll's own error is what surfaces", async () => {
    api = (req) =>
      req.method === "POST" && req.url.includes("/cancel")
        ? Promise.reject(new TransportError("network", "connection reset"))
        : req.url.includes("/queries/")
          ? json({ error: { message: "boom" } }, 500)
          : json({ jobComplete: false, jobReference: { jobId: "j/1" } });
    const err = await createBigQueryTransport("p", creds)
      .query("SELECT 1", opts)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BigQueryApiError);
    expect(err).toMatchObject({ message: "boom" });
    expect(cancels()).toHaveLength(1);
  });

  test("a job without a location cancels without the parameter", async () => {
    failing();
    await createBigQueryTransport("p", creds)
      .query("SELECT 1", opts)
      .catch(() => {});
    expect(cancels()[0].url).toEndWith("/jobs/j%2F1/cancel");
  });

  test("success and a failed first response cancel nothing", async () => {
    api = () => json({ jobComplete: true, jobReference: { jobId: "j" } });
    await createBigQueryTransport("p", creds).query("SELECT 1", opts);
    api = () => json({ error: { message: "bad" } }, 400);
    await createBigQueryTransport("p", creds)
      .query("SELECT 1", opts)
      .catch(() => {});
    expect(cancels()).toHaveLength(0);
  });
});

describe("bigquery project id", () => {
  test.each(["..", ".", "a/b", "", "1abc", "a b", "a?b"])("rejects %p", (project) => {
    expect(() => createBigQueryTransport(project, creds)).toThrow("not a valid project id");
  });

  test.each(["my-proj-123", "example.com:my-proj"])("accepts %p", (project) => {
    expect(() => createBigQueryTransport(project, creds)).not.toThrow();
  });
});

describe("bigquery token lanes", () => {
  test("a new token opens a new lane; the old one closes once its in-flight request ends", async () => {
    tokenTtl = 30;
    let release: (value: { status: number; text: string }) => void = () => {};
    const held = new Promise<{ status: number; text: string }>((resolve) => {
      release = resolve;
    });
    let first = true;
    api = () => {
      if (first) {
        first = false;
        return held;
      }
      return json({ datasets: [] });
    };
    const bq = createBigQueryTransport("p", creds);
    const slow = bq.listDatasets(signal);
    await Bun.sleep(0);
    await bq.listDatasets(signal);
    const lanes = built.filter((b) => b.opts.origin.host === "bigquery.googleapis.com");
    expect(lanes.map((l) => l.opts.headers.authorization)).toEqual(["Bearer t1", "Bearer t2"]);
    expect(lanes[0].closed).toBe(0);
    release(json({ datasets: [] }));
    await slow;
    expect(lanes[0].closed).toBe(1);
    expect(lanes[1].closed).toBe(0);

    // A third token retires the idle second lane at once.
    await bq.listDatasets(signal);
    expect(lanes[1].closed).toBe(1);
  });

  test("the same token reuses its lane, and close() closes every lane and the oauth transport", async () => {
    api = () => json({ datasets: [] });
    const bq = createBigQueryTransport("p", creds);
    await bq.listDatasets(signal);
    await bq.listDatasets(signal);
    const lanes = built.filter((b) => b.opts.origin.host === "bigquery.googleapis.com");
    expect(lanes).toHaveLength(1);
    bq.close();
    expect(lanes[0].closed).toBe(1);
    expect(built[0].closed).toBe(1);
  });
});

describe("bigquery catalog", () => {
  test("listDatasets follows nextPageToken", async () => {
    const pages = [
      json({ datasets: [{ datasetReference: { datasetId: "a" }, location: "US" }], nextPageToken: "n2" }),
      json({ datasets: [{ datasetReference: { datasetId: "b" }, location: "EU" }] }),
    ];
    api = () => pages.shift() ?? json({});
    expect(await createBigQueryTransport("p", creds).listDatasets(signal)).toEqual([
      { id: "a", location: "US" },
      { id: "b", location: "EU" },
    ]);
    const urls = apiCalls().map((r) => new URL(r.url));
    expect(urls[0].search).toBe("?maxResults=1000");
    expect(urls[1].searchParams.get("pageToken")).toBe("n2");
  });

  test("listTables follows nextPageToken and tolerates an empty page", async () => {
    const pages = [
      json({ tables: [{ tableReference: { tableId: "t1" }, type: "TABLE" }], nextPageToken: "n2" }),
      json({}),
    ];
    api = () => pages.shift() ?? json({});
    expect(await createBigQueryTransport("p", creds).listTables("d s", signal)).toEqual([{ id: "t1", type: "TABLE" }]);
    const urls = apiCalls().map((r) => new URL(r.url));
    expect(urls[0].pathname).toBe("/bigquery/v2/projects/p/datasets/d%20s/tables");
    expect(urls[1].searchParams.get("pageToken")).toBe("n2");
  });

  test("getTable returns the schema, empty when absent", async () => {
    api = () => json({ schema: { fields: [{ name: "a", type: "STRING" }] } });
    const bq = createBigQueryTransport("p", creds);
    expect(await bq.getTable("d", "t/1", signal)).toEqual({
      fields: [{ name: "a", type: "STRING" }],
    });
    expect(new URL(apiCalls()[0].url).pathname).toBe("/bigquery/v2/projects/p/datasets/d/tables/t%2F1");
    api = () => json({});
    expect(await bq.getTable("d", "t", signal)).toEqual({ fields: [] });
  });
});

describe("bigquery close and abort", () => {
  const cancels = () => apiCalls().filter((r) => r.url.includes("/cancel"));

  test("a request after close() is refused without opening a lane", async () => {
    api = () => json({ datasets: [] });
    const bq = createBigQueryTransport("p", creds);
    bq.close();
    const err = await bq.listDatasets(signal).catch((e) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({ kind: "aborted", message: "The BigQuery connection is closed" });
    expect(apiCalls()).toHaveLength(0);
  });

  test("close() during a poll aborts it, and the cancel still goes out on a transport closed after it", async () => {
    api = (req) =>
      req.url.includes("/cancel")
        ? json({})
        : req.method === "POST"
          ? json({ jobComplete: false, jobReference: { jobId: "j1" } })
          : never();
    const bq = createBigQueryTransport("p", creds);
    const run = bq.query("SELECT 1", opts).catch((e) => e);
    while (!apiCalls().some((r) => r.method === "GET")) await Bun.sleep(0);
    bq.close();
    expect(await run).toMatchObject({ kind: "aborted" });
    expect(cancels()).toHaveLength(1);
    const cancelLane = built.find((b) => b.requests.some((r) => r.url.includes("/cancel")));
    expect(cancelLane?.closed).toBe(1);
  });

  test("an abort while the first POST is in flight has no job id to cancel", async () => {
    api = never;
    const controller = new AbortController();
    const run = createBigQueryTransport("p", creds)
      .query("SELECT 1", { ...opts, signal: controller.signal })
      .catch((e) => e);
    while (apiCalls().length === 0) await Bun.sleep(0);
    controller.abort();
    expect(await run).toMatchObject({ kind: "aborted" });
    expect(cancels()).toHaveLength(0);
  });

  test("a first page that fails to decode after naming the job cancels it", async () => {
    api = (req) =>
      req.url.includes("/cancel")
        ? json({})
        : json({
            jobComplete: true,
            jobReference: { jobId: "j1", location: 7 },
            schema: { fields: [null] },
            rows: [{ f: [] }],
          });
    expect(
      await createBigQueryTransport("p", creds)
        .query("SELECT 1", opts)
        .catch((e) => e),
    ).toBeInstanceOf(TypeError);
    expect(cancels().map((r) => r.url)).toEqual([
      "https://bigquery.googleapis.com/bigquery/v2/projects/p/jobs/j1/cancel",
    ]);
  });
});

describe("bigquery malformed wire answers", () => {
  test("decodeCell turns a malformed REPEATED, STRUCT or TIMESTAMP cell into null", () => {
    const repeated = { name: "r", type: "STRING", mode: "REPEATED" as const };
    expect(decodeCell(repeated, "x")).toBeNull();
    expect(decodeCell(repeated, ["bare", null, { v: "a" }])).toEqual([null, null, "a"]);
    const struct = { name: "s", type: "STRUCT", fields: [{ name: "a", type: "STRING" }] };
    expect(decodeCell(struct, "x")).toBeNull();
    expect(decodeCell(struct, { f: "x" })).toBeNull();
    expect(decodeCell(struct, { f: [null] })).toEqual({ a: null });
    expect(decodeCell({ name: "s", type: "RECORD", fields: "x" as never }, { f: [] })).toEqual({});
    expect(decodeCell({ name: "t", type: "TIMESTAMP" }, "soon")).toBeNull();
    expect(decodeCell({ name: "t", type: "TIMESTAMP" }, "9".repeat(30))).toBeNull();
  });

  test("rows without cells, a non-list schema and a non-string pageToken decode to nulls and stop", async () => {
    const fields = [{ name: "a", type: "STRING" }];
    api = () =>
      json({ jobComplete: true, jobReference: { jobId: "j" }, schema: { fields }, rows: [null, {}], pageToken: 5 });
    const bq = createBigQueryTransport("p", creds);
    expect((await bq.query("SELECT 1", opts)).rows).toEqual([{ a: null }, { a: null }]);
    expect(apiCalls()).toHaveLength(1);
    api = () => json({ jobComplete: true, schema: { fields: "x" }, rows: [{ f: [{ v: "1" }] }] });
    expect(await bq.query("SELECT 1", opts)).toMatchObject({ fields: [], rows: [{}] });
    api = () => ({ status: 200, text: "null" });
    expect((await bq.query("SELECT 1", opts)).rows).toEqual([]);
  });

  test("an error envelope with odd shapes still reports by status", async () => {
    const bq = createBigQueryTransport("p", creds);
    api = () => json({ error: { message: 5, errors: "x" } }, 400);
    expect(await bq.query("SELECT 1", opts).catch((e) => e)).toMatchObject({
      reason: null,
      message: "BigQuery answered HTTP 400",
    });
    api = () => json({ error: { errors: [{ reason: 3 }] } }, 400);
    expect(await bq.query("SELECT 1", opts).catch((e) => e)).toMatchObject({ reason: null });
    api = () => json([1], 500);
    expect(await bq.query("SELECT 1", opts).catch((e) => e)).toMatchObject({ status: 500, reason: null });
  });

  test("malformed catalog entries are skipped and a non-list page is empty", async () => {
    api = () =>
      json({
        datasets: [
          null,
          {},
          { datasetReference: { datasetId: 1 }, location: "US" },
          { datasetReference: { datasetId: "x" } },
          { datasetReference: { datasetId: "a" }, location: "US" },
        ],
        nextPageToken: 7,
      });
    const bq = createBigQueryTransport("p", creds);
    expect(await bq.listDatasets(signal)).toEqual([{ id: "x" }, { id: "a", location: "US" }]);
    api = () =>
      json({
        tables: [
          3,
          { tableReference: null },
          { tableReference: { tableId: "t" } },
          { tableReference: { tableId: "u" }, type: "VIEW" },
        ],
      });
    expect(await bq.listTables("d", signal)).toEqual([{ id: "u", type: "VIEW" }]);
    api = () => json({ tables: { nope: 1 } });
    expect(await bq.listTables("d", signal)).toEqual([]);
  });
});

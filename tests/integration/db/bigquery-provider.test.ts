/**
 * BigQuery provider, end to end: real provider, transport and token source; only `createNodeTransport` is faked.
 * Answers replay tests/fixtures/bigquery/2026-10-13-eu/, recorded on 2026-10-13 in region EU (see its README).
 * Built instead: a successful token answer (it carries a live token) and transport timeouts (no answer exists).
 * `mock.module()` is process-wide, so the runner gives this file its own process.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuthenticationError, QueryError, TimeoutError } from "@/lib/db/errors";
import type { NodeRequest, NodeResponse, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { BIGQUERY_DRY_RUN_MARKER } from "@/lib/explain/bigquery-dryrun";
import type { DatabaseConnection } from "@/lib/types";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

const realNode = { ...(await import("@/lib/db/http/node-transport")) };
const { TransportError } = realNode;

// ============================================================================
// The fake network
// ============================================================================

type Wire = Record<string, unknown>;
type Reply = { status: number; json: Wire };
interface Logged {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Wire | null;
  authorization: string | undefined;
}

const CAPTURES = join(import.meta.dir, "..", "..", "fixtures", "bigquery", "2026-10-13-eu");
function captured(scenario: string, exchange = 0): Reply {
  const file = JSON.parse(readFileSync(join(CAPTURES, `${scenario}.json`), "utf8")) as {
    exchanges: {
      request: { path: string };
      response: { status: number; body: Wire };
    }[];
  };
  const { status, body } = file.exchanges[exchange].response;
  return { status, json: body };
}
function capturedGet(scenario: string, path: string): Reply | undefined {
  const file = JSON.parse(readFileSync(join(CAPTURES, `${scenario}.json`), "utf8")) as {
    exchanges: {
      request: { path: string };
      response: { status: number; body: Wire };
    }[];
  };
  const hit = file.exchanges.find((e) => e.request.path.split("?")[0] === path);
  return hit && { status: hit.response.status, json: hit.response.body };
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const CLIENT_EMAIL = "studio@demo-project.iam.gserviceaccount.com";
const KEY_JSON = JSON.stringify({
  type: "service_account",
  client_email: CLIENT_EMAIL,
  private_key: privateKey,
});

const WIF_AUDIENCE =
  "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/studio/providers/adapter";
const EXTERNAL_ACCOUNT = JSON.stringify({
  type: "external_account",
  audience: WIF_AUDIENCE,
  subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  token_url: "https://sts.googleapis.com/v1/token",
  credential_source: {
    url: "https://adapter.example.com/subject/alice",
    headers: { authorization: "Bearer adapter-secret" },
    format: { type: "json", subject_token_field_name: "id_token" },
  },
});

const ok = (json: Wire): Reply => ({ status: 200, json });
const apiError = (status: number, message: string, reason: string): Reply => ({
  status,
  json: { error: { code: status, message, errors: [{ reason, message }] } },
});
class FakeGoogle {
  requests: Logged[] = [];
  informationSchema = true;
  refundsCreated = false;
  missing = new Set<string>();
  tokenReply: Reply | null = null;
  datasetsReply: Reply | null = null;
  tokensIssued = 0;
  closed = 0;
  /** external_account: the subject tokens the adapter handed out and the STS exchanges it was used in. */
  subjectAuthorizations: (string | undefined)[] = [];
  stsForms: Record<string, string>[] = [];
  /** A test's own answer for a jobs.query / GET getQueryResults; return undefined to fall through. */
  onQuery: (sql: string, body: Wire) => Reply | undefined = () => undefined;
  onPoll: (jobId: string, params: URLSearchParams) => Reply | undefined = () => undefined;

  create(options: NodeTransportOptions) {
    const authorization = options.headers.authorization;
    return {
      request: async (request: NodeRequest): Promise<NodeResponse> => {
        const url = new URL(request.url);
        const reply = this.route(request, url, authorization);
        return {
          status: reply.status,
          contentType: "application/json",
          retryAfter: null,
          text: JSON.stringify(reply.json),
        };
      },
      close: () => {
        this.closed += 1;
      },
    };
  }

  private route(request: NodeRequest, url: URL, authorization: string | undefined): Reply {
    if (url.host === "oauth2.googleapis.com") return this.token(request);
    if (url.host === "adapter.example.com") return this.subject(authorization);
    if (url.host === "sts.googleapis.com") return this.sts(request);
    const path = url.pathname.replace("/bigquery/v2/projects/demo-project", "");
    const body = request.body ? (JSON.parse(request.body) as Wire) : null;
    this.requests.push({
      method: request.method,
      path,
      params: url.searchParams,
      body,
      authorization,
    });
    if (url.host !== "bigquery.googleapis.com" || !url.pathname.startsWith("/bigquery/v2/projects/demo-project")) {
      return apiError(404, "no such route", "notFound");
    }

    if (request.method === "POST" && path === "/queries") return this.jobsQuery(body!);
    if (request.method === "POST" && /^\/jobs\/[^/]+\/cancel$/.test(path)) return captured("slow-job", 3);
    const poll = /^\/queries\/([^/]+)$/.exec(path);
    if (request.method === "GET" && poll) {
      return this.onPoll(decodeURIComponent(poll[1]), url.searchParams) ?? apiError(404, "Not found: Job", "notFound");
    }
    if (request.method === "GET" && path === "/datasets") return this.datasetsReply ?? captured("datasets-list");
    if (request.method === "GET" && /^\/datasets\/[^/]+\/tables$/.test(path)) {
      return capturedGet("tables-list", path) ?? apiError(404, "Not found: Dataset", "notFound");
    }
    const table = /^\/datasets\/([^/]+)\/tables\/([^/]+)$/.exec(path);
    if (request.method === "GET" && table) {
      const missing = captured("tables-get", 5);
      if (this.missing.has(`${table[1]}/${table[2]}`)) return missing;
      return capturedGet("tables-get", path) ?? missing;
    }
    return apiError(404, `no route for ${request.method} ${path}`, "notFound");
  }

  private token(request: NodeRequest): Reply {
    if (this.tokenReply) return this.tokenReply;
    const form = request.form!;
    expect(form.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, payload, signature] = form.assertion.split(".");
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, signature, "base64url");
    expect(verified).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Wire;
    expect(claims).toMatchObject({
      iss: CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/bigquery",
    });
    this.tokensIssued += 1;
    return ok({
      access_token: `ya29.fake-token-${this.tokensIssued}`,
      expires_in: 3600,
    });
  }

  private subject(authorization: string | undefined): Reply {
    this.subjectAuthorizations.push(authorization);
    return ok({ id_token: `subject-jwt-${this.subjectAuthorizations.length}` });
  }

  private sts(request: NodeRequest): Reply {
    const form = request.form!;
    this.stsForms.push(form);
    this.tokensIssued += 1;
    return ok({
      access_token: `federated-token-${this.tokensIssued}`,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer",
      expires_in: 3600,
    });
  }

  private jobsQuery(body: Wire): Reply {
    const sql = String(body.query);
    if (body.dryRun === true) return captured("dry-run");
    const own = this.onQuery(sql, body);
    if (own) return own;
    if (/INFORMATION_SCHEMA/.test(sql)) {
      if (!this.informationSchema) return captured("access-denied");
      return this.informationSchemaReply(sql);
    }
    if (/^\s*CREATE TABLE shop\.refunds/i.test(sql)) {
      this.refundsCreated = true;
      return captured("ddl");
    }
    if (sql === "SELECT 1") return captured("select-1");
    return captured("syntax-error");
  }

  private informationSchemaReply(sql: string): Reply {
    const catalog = this.refundsCreated ? "catalog-after-ddl" : "catalog";
    if (/INFORMATION_SCHEMA\.TABLES$/.test(sql)) return captured(catalog, 0);
    if (/INFORMATION_SCHEMA\.COLUMNS\b/.test(sql)) return captured(catalog, 1);
    if (/COUNTIF\(cache_hit\)/.test(sql)) return captured("monitoring", 0);
    if (/GROUP BY query/.test(sql)) return captured("monitoring", 1);
    if (/state != 'DONE'/.test(sql)) return captured("slow-job", 2);
    if (/GROUP BY table_schema/.test(sql)) return captured("storage", 0);
    if (/total_rows, total_logical_bytes/.test(sql)) return captured("storage", 1);
    return apiError(400, `unexpected INFORMATION_SCHEMA read: ${sql}`, "invalidQuery");
  }
}

let google = new FakeGoogle();
mock.module("@/lib/db/http/node-transport", () => ({
  ...realNode,
  createNodeTransport: (options: NodeTransportOptions) => google.create(options),
}));
const { BigQueryProvider } = await import("@/lib/db/providers/sql/bigquery");

// ============================================================================
// Harness
// ============================================================================

const connection = (over: Partial<DatabaseConnection> = {}): DatabaseConnection =>
  ({
    id: "bq-demo",
    name: "Demo BigQuery",
    type: "bigquery",
    database: "demo-project",
    password: KEY_JSON,
    createdAt: new Date(),
    ...over,
  }) as DatabaseConnection;

const opened: InstanceType<typeof BigQueryProvider>[] = [];
async function open(over: Partial<DatabaseConnection> = {}) {
  const provider = new BigQueryProvider(connection(over));
  opened.push(provider);
  await provider.connect();
  return provider;
}
const posted = (path: string) => google.requests.filter((r) => r.method === "POST" && r.path === path);
const queriesWith = (needle: RegExp) => posted("/queries").filter((r) => needle.test(String(r.body?.query)));

beforeEach(() => {
  google = new FakeGoogle();
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.disconnect()));
});

// ============================================================================
// Connect
// ============================================================================

describe("connect", () => {
  test("signs a service-account assertion, detects the dataset location and probes with SELECT 1 there", async () => {
    const provider = await open();
    expect(provider.isConnected()).toBe(true);
    expect(google.tokensIssued).toBe(1);
    const probe = queriesWith(/^SELECT 1$/)[0];
    expect(probe.body).toMatchObject({
      location: "EU",
      useLegacySql: false,
      dryRun: false,
    });
    expect(probe.authorization).toBe("Bearer ya29.fake-token-1");

    await provider.query("SELECT 1");
    expect(google.tokensIssued).toBe(1);
  });

  test("an explicit location skips the datasets listing", async () => {
    await open({ location: "europe-west3" });
    expect(google.requests.some((r) => r.path === "/datasets")).toBe(false);
    expect(queriesWith(/^SELECT 1$/)[0].body).toMatchObject({
      location: "europe-west3",
    });
  });

  test("the default dataset's location wins over the majority", async () => {
    google.datasetsReply = captured("datasets-list-mixed-locations");
    await open({ schema: "regional" });
    expect(queriesWith(/^SELECT 1$/)[0].body).toMatchObject({
      location: "europe-west3",
    });
  });

  test("a principal without datasets.list still connects, leaving the location to BigQuery", async () => {
    google.datasetsReply = captured("access-denied");
    const provider = await open();
    expect(provider.isConnected()).toBe(true);
    expect(queriesWith(/^SELECT 1$/)[0].body?.location).toBeUndefined();
  });

  test("a keyless connection that is not operator-seeded is refused before anything is sent", async () => {
    const provider = new BigQueryProvider(connection({ password: "" }));
    await expect(provider.connect()).rejects.toThrow(/only for operator-seeded connections/);
    expect(google.requests).toHaveLength(0);
    expect(google.tokensIssued).toBe(0);
  });

  test("external_account fetches the subject token, exchanges it at STS and queries with the federated token", async () => {
    const provider = await open({ password: EXTERNAL_ACCOUNT, managed: true });
    expect(provider.isConnected()).toBe(true);
    expect(google.subjectAuthorizations).toEqual(["Bearer adapter-secret"]);
    expect(google.stsForms).toEqual([
      {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: WIF_AUDIENCE,
        scope: "https://www.googleapis.com/auth/bigquery",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        subject_token: "subject-jwt-1",
      },
    ]);
    expect(queriesWith(/^SELECT 1$/)[0].authorization).toBe("Bearer federated-token-1");

    await provider.query("SELECT 1");
    expect(google.stsForms).toHaveLength(1);
  });

  test("external_account on a connection that is not operator-seeded is refused before anything is sent", async () => {
    const provider = new BigQueryProvider(connection({ password: EXTERNAL_ACCOUNT }));
    await expect(provider.connect()).rejects.toThrow(/external_account credentials are used only for operator-seeded/);
    expect(google.subjectAuthorizations).toHaveLength(0);
    expect(google.stsForms).toHaveLength(0);
    expect(google.requests).toHaveLength(0);
  });

  test("a rejected token request is an AuthenticationError and leaves the provider disconnected", async () => {
    google.tokenReply = captured("token-rejected");
    const provider = new BigQueryProvider(connection());
    opened.push(provider);
    const failure = await provider.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuthenticationError);
    expect((failure as Error).message).toContain("Invalid grant: account not found");
    expect(provider.isConnected()).toBe(false);
    expect(google.closed).toBeGreaterThan(0);
  });
});

// ============================================================================
// query()
// ============================================================================

describe("query", () => {
  test("polls an unfinished job, follows pageToken and decodes INT64, TIMESTAMP, STRUCT and ARRAY", async () => {
    google.onQuery = (sql) => (sql.startsWith("SELECT order_id") ? captured("slow-job", 0) : undefined);
    const polls: URLSearchParams[] = [];
    google.onPoll = (_job, params) => {
      polls.push(params);
      return captured("typed-pages", polls.length);
    };
    const provider = await open({ schema: "shop" });
    const result = await provider.query("SELECT order_id, placed_at, ship, tags, total, paid FROM orders");

    expect(posted("/queries").at(-1)!.body).toMatchObject({
      location: "EU",
      defaultDataset: { projectId: "demo-project", datasetId: "shop" },
      formatOptions: { useInt64Timestamp: true },
    });
    expect(polls[0].get("location")).toBe("EU");
    expect(polls[0].get("pageToken")).toBeNull();
    expect(polls[1].get("pageToken")).toBe("<page-1>");

    expect(result.fields).toEqual(["order_id", "placed_at", "ship", "tags", "total", "paid"]);
    expect(result.rowCount).toBe(3);
    expect(result.rows[0]).toEqual({
      order_id: "9007199254740993",
      placed_at: "2023-11-14T22:13:20.123Z",
      ship: { city: "Berlin", zip: "10115" },
      tags: ["a", "b"],
      total: 12.5,
      paid: true,
    });
    expect(result.rows[1].tags).toEqual([]);
    expect(result.rows[2].ship).toEqual({ city: "Bonn", zip: "10115" });
    expect(result.columnTypes).toEqual({
      order_id: "INT64",
      placed_at: "TIMESTAMP",
      ship: "STRUCT<city STRING, zip INT64>",
      tags: "ARRAY<STRING>",
      total: "FLOAT64",
      paid: "BOOL",
    });
    // getQueryResults carries no billed bytes.
    expect(result.warnings).toEqual([{ message: "Processed 0 B (cache hit)", severity: "info" }]);
  });

  test("says when the answer came from the cache and reports DML rows as rowCount", async () => {
    google.onQuery = (sql) =>
      sql.startsWith("SELECT cached")
        ? captured("cache-hit", 1)
        : sql.startsWith("DELETE")
          ? captured("dml")
          : undefined;
    const provider = await open();
    expect((await provider.query("SELECT cached")).warnings).toEqual([
      { message: "Processed 0 B, billed 0 B (cache hit)", severity: "info" },
    ]);
    const dml = await provider.query("DELETE FROM shop.orders WHERE true");
    expect(dml.rowCount).toBe(7);
    // BigQuery answers a DELETE with the table's schema; the grid shows the count only when fields are empty.
    expect(dml).toMatchObject({ rows: [], fields: [] });
    expect(dml.columnTypes).toBeUndefined();
  });

  test("the dry-run marker sends dryRun:true and answers one bytes row without executing", async () => {
    const provider = await open();
    const result = await provider.query(`${BIGQUERY_DRY_RUN_MARKER}SELECT * FROM shop.orders`);
    const sent = posted("/queries").at(-1)!;
    expect(sent.body).toMatchObject({ dryRun: true });
    expect(result.rows).toEqual([{ bytes_processed: 280, bytes_processed_human: "280 B" }]);
    expect(result.fields).toEqual(["bytes_processed", "bytes_processed_human"]);
    expect(result.rowCount).toBe(1);
    expect(result.warnings).toBeUndefined();
  });

  test("refuses parameters before anything is sent", async () => {
    const provider = await open();
    const before = google.requests.length;
    await expect(provider.query("SELECT ?", [1])).rejects.toBeInstanceOf(QueryError);
    expect(google.requests).toHaveLength(before);
  });

  test("a 400 envelope is a QueryError carrying BigQuery's message", async () => {
    const provider = await open();
    const failure = await provider.query("SELEC nope").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as Error).message).toContain("Syntax error");
  });

  test("a 401 is an AuthenticationError and a 403 a QueryError", async () => {
    const provider = await open();
    google.onQuery = (sql) =>
      sql === "SELECT unauth" ? captured("auth-401") : sql === "SELECT denied" ? captured("access-denied") : undefined;
    await expect(provider.query("SELECT unauth")).rejects.toBeInstanceOf(AuthenticationError);
    const denied = await provider.query("SELECT denied").catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(QueryError);
    expect((denied as Error).message).toContain("Access Denied");
  });

  test("a transport timeout is a TimeoutError", async () => {
    const provider = await open();
    google.onQuery = () => {
      throw new TransportError("timeout", "request timed out");
    };
    await expect(provider.query("SELECT slow")).rejects.toBeInstanceOf(TimeoutError);
  });

  test("a timeout while polling cancels the job so it stops billing", async () => {
    google.onQuery = (sql) => (sql === "SELECT slow" ? captured("slow-job", 0) : undefined);
    google.onPoll = () => {
      throw new TransportError("timeout", "request timed out");
    };
    const provider = await open();
    await expect(provider.query("SELECT slow")).rejects.toBeInstanceOf(TimeoutError);
    const job = (captured("slow-job", 0).json.jobReference as { jobId: string }).jobId;
    const cancel = posted(`/jobs/${encodeURIComponent(job)}/cancel`);
    expect(cancel).toHaveLength(1);
    expect(cancel[0].params.get("location")).toBe("EU");
  });
});

// ============================================================================
// Object surface and catalog
// ============================================================================

describe("object surface", () => {
  // BigQuery declares no source-bearing or editable kind, so the source half of the helper has nothing to read and no
  // absentSource / emptyKinds apply; every declared kind carries columns, hence noAbstainingKinds.
  const expectation = {
    containers: [["archive"], ["shop"]],
    container: ["shop"],
    kinds: { table: 2, view: 1, materialized_view: 1 },
    sampleObject: { path: ["shop", "orders"], kind: "table" },
    noAbstainingKinds: true,
  } as const;

  test("satisfies the conformance contract with INFORMATION_SCHEMA readable", async () => {
    const provider = await open({ schema: "shop" });
    await assertObjectSurface(provider, expectation);
    // One catalog read of each view serves every listing, count and bulk column read.
    expect(queriesWith(/INFORMATION_SCHEMA\.TABLES/)).toHaveLength(1);
    expect(queriesWith(/INFORMATION_SCHEMA\.COLUMNS/)).toHaveLength(1);
    expect(queriesWith(/INFORMATION_SCHEMA\.TABLES/)[0].body).toMatchObject({
      jobTimeoutMs: expect.any(String),
    });
    expect(String(queriesWith(/INFORMATION_SCHEMA\.TABLES/)[0].body?.query)).toContain(
      "`demo-project`.`region-eu`.INFORMATION_SCHEMA.TABLES",
    );
  });

  test("satisfies it again over REST alone when INFORMATION_SCHEMA is refused", async () => {
    google.informationSchema = false;
    const provider = await open();
    await assertObjectSurface(provider, expectation);
    expect(google.requests.some((r) => r.method === "GET" && r.path === "/datasets/shop/tables")).toBe(true);
    expect(google.requests.some((r) => r.method === "GET" && r.path === "/datasets/shop/tables/orders")).toBe(true);
  });

  test("lists datasets as containers, marking the connection's default", async () => {
    const provider = await open({ schema: "shop" });
    expect(await provider.listContainers()).toEqual([
      { path: ["archive"], name: "archive", level: 0, isSessionDefault: false },
      { path: ["shop"], name: "shop", level: 0, isSessionDefault: true },
    ]);
    expect(await provider.listContainers(["shop"])).toEqual([]);
  });

  test("describeObjects reads columns from the catalog without a per-table call, and from REST per table otherwise", async () => {
    const withCatalog = await open();
    const batch = await withCatalog.describeObjects(["shop"], "table");
    expect(batch.details.map((d) => d.path)).toEqual([
      ["shop", "customers"],
      ["shop", "orders"],
    ]);
    expect(batch.details[0].columns).toContainEqual({
      name: "address",
      type: "STRUCT<city STRING, zip INT64>",
      nullable: true,
      isPrimary: false,
    });
    expect(batch.details[1].columns[0]).toEqual({
      name: "order_id",
      type: "INT64",
      nullable: false,
      isPrimary: false,
    });
    expect(google.requests.filter((r) => r.path.startsWith("/datasets/shop/tables/"))).toHaveLength(0);

    google.informationSchema = false;
    google.requests.length = 0;
    const viaRest = await (await open()).describeObjects(["shop"], "table");
    expect(viaRest.details[0].columns.map((c) => c.type)).toEqual([
      "INT64",
      "STRING",
      "STRUCT<city STRING, zip INT64>",
      "ARRAY<STRING>",
    ]);
    expect(google.requests.filter((r) => /^\/datasets\/shop\/tables\/[^/]+$/.test(r.path))).toHaveLength(2);
  });

  test("a table whose columns cannot be read loses its columns, not the inventory", async () => {
    google.informationSchema = false;
    const provider = await open();
    expect((await provider.listObjects(["shop"], "table")).map((o) => o.name)).toEqual(["customers", "orders"]);
    // Dropped after the (cached) listing: its columns read 404.
    google.missing.add("shop/customers");
    const batch = await provider.describeObjects(["shop"], "table");
    expect(batch.details.map((d) => [d.path[1], d.columns.length])).toEqual([
      ["customers", 0],
      ["orders", 4],
    ]);
  });

  test("a DDL statement invalidates the cached catalog, a dry run does not", async () => {
    const provider = await open();
    expect((await provider.listObjects(["shop"], "table")).map((o) => o.name)).toEqual(["customers", "orders"]);
    await provider.query(`${BIGQUERY_DRY_RUN_MARKER}CREATE TABLE shop.refunds (refund_id INT64)`);
    await provider.listObjects(["shop"], "table");
    expect(queriesWith(/INFORMATION_SCHEMA\.TABLES/)).toHaveLength(1);

    await provider.query("CREATE TABLE shop.refunds (refund_id INT64)");
    expect((await provider.listObjects(["shop"], "table")).map((o) => o.name)).toEqual([
      "customers",
      "orders",
      "refunds",
    ]);
    expect(queriesWith(/INFORMATION_SCHEMA\.TABLES/)).toHaveLength(2);
  });

  test("refuses an undeclared kind and a malformed container path", async () => {
    const provider = await open();
    await expect(provider.listObjects(["shop"], "routine")).rejects.toBeInstanceOf(QueryError);
    await expect(provider.listObjects(["demo-project", "shop"], "table")).rejects.toThrow();
  });
});

// ============================================================================
// Monitoring
// ============================================================================

describe("monitoring", () => {
  test("every panel reads its region's INFORMATION_SCHEMA view and maps the rows", async () => {
    const provider = await open();
    const overview = await provider.getOverview();
    expect(overview).toMatchObject({
      version: "BigQuery (EU)",
      tableCount: 4,
      databaseSize: "551 B",
      databaseSizeBytes: 551,
      indexCount: 0,
    });
    expect(await provider.getPerformanceMetrics()).toEqual({
      cacheHitRatio: 15,
      queriesPerSecond: 0.01,
    });
    const slow = await provider.getSlowQueries({ limit: 5 });
    expect(slow).toHaveLength(5);
    expect(slow[1]).toEqual({
      query: "DELETE FROM shop.orders WHERE true",
      calls: 1,
      totalTime: 885,
      avgTime: 885,
      minTime: 885,
      maxTime: 885,
      rows: 0,
    });
    const sessions = await provider.getActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      pid: (captured("slow-job", 0).json.jobReference as { jobId: string }).jobId,
      user: "<user-1>",
      database: "demo-project",
      state: "running",
      duration: "8s",
      durationMs: 8090,
    });
    expect(sessions[0].queryStart).toEqual(new Date(1791876491557));
    expect(await provider.getTableStats({ schema: "shop" })).toEqual([
      {
        schemaName: "shop",
        tableName: "orders",
        rowCount: 7,
        totalSize: "280 B",
        totalSizeBytes: 280,
      },
      {
        schemaName: "shop",
        tableName: "daily_totals",
        rowCount: 7,
        totalSize: "168 B",
        totalSizeBytes: 168,
      },
      {
        schemaName: "shop",
        tableName: "customers",
        rowCount: 2,
        totalSize: "63 B",
        totalSizeBytes: 63,
      },
    ]);
    expect(await provider.getStorageStats()).toEqual([
      { name: "shop", location: "EU", size: "511 B", sizeBytes: 511 },
      { name: "archive", location: "EU", size: "40 B", sizeBytes: 40 },
    ]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect((await provider.getHealth()).slowQueries).toEqual([]);
    await expect(provider.runMaintenance("vacuum" as never)).rejects.toBeInstanceOf(QueryError);

    const sent = posted("/queries").map((r) => r.body!);
    const storage = sent.find((b) => /COUNT\(\*\) AS tables/.test(String(b.query)))!;
    expect(storage).toMatchObject({ location: "EU" });
    expect(String(storage.query)).toContain("`demo-project`.`region-eu`.INFORMATION_SCHEMA.TABLE_STORAGE");
    expect(String(storage.query)).toContain("project_id = 'demo-project' AND NOT deleted");
    expect(sent.some((b) => String(b.query).includes("table_schema = 'shop'"))).toBe(true);
    expect(sent.some((b) => String(b.query).includes("LIMIT 5"))).toBe(true);
  });

  test("a repeated poll within a minute is served from the cache", async () => {
    const provider = await open();
    await provider.getOverview();
    await provider.getOverview();
    expect(queriesWith(/COUNT\(\*\) AS tables/)).toHaveLength(1);
  });

  test("a refused read leaves the panels empty rather than failing", async () => {
    google.informationSchema = false;
    const provider = await open();
    expect(await provider.getOverview()).toMatchObject({
      databaseSize: "N/A",
      tableCount: 0,
    });
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
  });
});

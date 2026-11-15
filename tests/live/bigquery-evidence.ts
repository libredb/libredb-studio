/**
 * Records the captures tests/integration/db/bigquery-provider.test.ts replays (see tests/fixtures/bigquery/README.md):
 * labelled scratch datasets are created, recorded against over raw REST with the server's ADC, scrubbed, and dropped.
 *
 *   bun tests/live/bigquery-evidence.ts --project <project id> [--refuse <name>[,<name>...]]
 *
 * The project id, and every --refuse name (an organisation, a domain), stops the run if a scrubbed capture still holds it.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { importPKCS8, SignJWT } from "jose";
import { createGoogleTokenSource } from "@/lib/db/auth/google/token-source";
import {
  bigQueryCredentialIo,
  bigQueryTokenSourceDeps,
  resolveBigQueryCredential,
} from "@/lib/db/providers/sql/bigquery/credential-policy";

/** Region INFORMATION_SCHEMA keeps listing a dropped dataset's tables for a while, so names are per run. */
const RUN = Date.now().toString(36);
// TABLE_STORAGE prunes by where table_schema sorts; a name sorting last sits in a small block in most projects.
const PREFIX = `zz_libredb_capture_${RUN}_`;
const LABEL = `libredb-capture-${RUN}`;
const REGION = "eu";
const MAX_BILLED_BYTES = 1024 ** 3;
const API = "https://bigquery.googleapis.com/bigquery/v2/projects";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const OUT_ROOT = path.join(import.meta.dir, "..", "fixtures", "bigquery");

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const project = flag("--project") ?? "";
const refused = (flag("--refuse") ?? "").split(",").filter(Boolean);
if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
  console.error("bigquery-evidence: pass --project <project id>");
  process.exit(2);
}

// The server's ADC, as an operator seed with the opt-in set reads it.
const creds = resolveBigQueryCredential(
  { password: undefined, managed: true },
  { ...bigQueryCredentialIo(), env: { ...process.env, BIGQUERY_SERVER_CREDENTIALS: "true" } },
);
const tokens = createGoogleTokenSource(creds, bigQueryTokenSourceDeps());
const token = (signal: AbortSignal) => tokens.token(signal);

type Wire = Record<string, unknown>;
interface Exchange {
  request: { method: string; path: string; body?: Wire };
  response: { status: number; body: unknown };
}

const ds = (name: string) => `${PREFIX}${name}`;
const captures = new Map<string, Exchange[]>();
let recording: string | null = null;

async function api(
  method: "GET" | "POST" | "DELETE",
  pathAndQuery: string,
  body?: Wire,
  bearer?: string,
  inProject: string = project,
): Promise<{ status: number; json: Wire }> {
  const response = await fetch(`${API}/${inProject}${pathAndQuery}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer ?? (await token(AbortSignal.timeout(30_000)))}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  const json = (text ? JSON.parse(text) : {}) as Wire;
  if (recording) {
    captures.get(recording)!.push({
      request: {
        method,
        ...(inProject === project ? {} : { project: inProject }),
        path: pathAndQuery,
        ...(body ? { body } : {}),
      },
      response: { status: response.status, body: json },
    });
  }
  return { status: response.status, json };
}

async function ok(method: "GET" | "POST" | "DELETE", pathAndQuery: string, body?: Wire): Promise<Wire> {
  const { status, json } = await api(method, pathAndQuery, body);
  if (status >= 300) throw new Error(`${method} ${pathAndQuery}: HTTP ${status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

const jobBody = (query: string, extra: Wire = {}): Wire => ({
  query,
  location: "EU",
  useLegacySql: false,
  maxResults: 1000,
  timeoutMs: 60_000,
  jobTimeoutMs: "120000",
  formatOptions: { useInt64Timestamp: true },
  ...extra,
});

async function guardedQuery(query: string, extra: Wire = {}): Promise<Wire> {
  const saved = recording;
  recording = null;
  const dry = await ok("POST", "/queries", jobBody(query, { ...extra, dryRun: true }));
  recording = saved;
  if (Number(dry.totalBytesProcessed ?? 0) > MAX_BILLED_BYTES) {
    throw new Error(`refused, would process ${String(dry.totalBytesProcessed)} bytes: ${query}`);
  }
  return ok("POST", "/queries", jobBody(query, extra));
}

async function scenario(name: string, body: () => Promise<void>): Promise<void> {
  captures.set(name, []);
  recording = name;
  try {
    await body();
  } finally {
    recording = null;
  }
  console.log(`recorded ${name}: ${captures.get(name)!.length} exchange(s)`);
}

function expect(condition: unknown, what: string): void {
  if (!condition) throw new Error(`unexpected answer: ${what}`);
}

const ourJobs: string[] = [];
const jobOf = (answer: Wire) => {
  const id = (answer.jobReference as { jobId?: string } | undefined)?.jobId;
  if (id) ourJobs.push(id);
  return id;
};

const DATASETS = [
  { id: ds("shop"), location: "EU", label: "main" },
  { id: ds("archive"), location: "EU", label: "main" },
  { id: ds("regional"), location: "europe-west3", label: "regional" },
];

async function setup(): Promise<void> {
  for (const d of DATASETS) {
    const existing = await api("GET", `/datasets/${d.id}`);
    if (existing.status !== 404) throw new Error(`dataset ${d.id} already exists; drop it by hand first`);
  }
  for (const d of DATASETS) {
    await ok("POST", "/datasets", {
      datasetReference: { projectId: project, datasetId: d.id },
      location: d.location,
      labels: { [LABEL]: d.label },
      defaultTableExpirationMs: String(24 * 3600 * 1000),
    });
  }
  const orders = "order_id INT64 NOT NULL, customer_id INT64, placed_at TIMESTAMP, total NUMERIC";
  for (const sql of [
    `CREATE TABLE ${ds("shop")}.orders (${orders})`,
    `CREATE TABLE ${ds("shop")}.customers (customer_id INT64 NOT NULL, name STRING, address STRUCT<city STRING, zip INT64>, tags ARRAY<STRING>)`,
    `CREATE TABLE ${ds("archive")}.orders_2023 (${orders})`,
    `INSERT ${ds("shop")}.orders (order_id, customer_id, placed_at, total) VALUES ` +
      Array.from(
        { length: 7 },
        (_, i) => `(${i + 1}, ${(i % 2) + 1}, TIMESTAMP '2026-10-0${i + 1} 10:00:00+00', ${i + 1}.50)`,
      ).join(", "),
    // A table without data has no storage, so TABLE_STORAGE would never list `archive`.
    `INSERT ${ds("archive")}.orders_2023 (order_id, customer_id, placed_at, total) VALUES (1, 1, TIMESTAMP '2023-06-01 10:00:00+00', 9.50)`,
    `INSERT ${ds("shop")}.customers (customer_id, name, address, tags) VALUES ` +
      "(1, 'Ada', STRUCT('Berlin', 10115), ['vip']), (2, 'Grace', STRUCT('Bonn', 53111), [])",
    `CREATE VIEW ${ds("shop")}.order_summary AS SELECT customer_id, SUM(total) AS spent FROM ${ds("shop")}.orders GROUP BY customer_id`,
    `CREATE MATERIALIZED VIEW ${ds("shop")}.daily_totals AS SELECT DATE(placed_at) AS day, SUM(total) AS total FROM ${ds("shop")}.orders GROUP BY day`,
  ]) {
    jobOf(await ok("POST", "/queries", jobBody(sql)));
  }
}

async function teardown(): Promise<void> {
  recording = null;
  for (const d of DATASETS) {
    const { status } = await api("DELETE", `/datasets/${d.id}?deleteContents=true`).catch(() => ({ status: -1 }));
    console.log(`dropped ${d.id}: HTTP ${status}`);
  }
}

const TYPED_ROWS =
  "SELECT * FROM UNNEST([" +
  "STRUCT(9007199254740993 AS order_id, TIMESTAMP_MICROS(1700000000123456) AS placed_at, STRUCT('Berlin' AS city, 10115 AS zip) AS ship, ['a', 'b'] AS tags, 12.5 AS total, true AS paid), " +
  "(2, TIMESTAMP_MICROS(1700000100000000), ('Hamburg', 10115), ARRAY<STRING>[], 0.5, false), " +
  "(3, TIMESTAMP_MICROS(1700000200000000), ('Bonn', 10115), ['c'], 7, true)" +
  "]) ORDER BY placed_at";
const SLOW =
  "SELECT COUNT(*) AS n FROM UNNEST(GENERATE_ARRAY(1, 100000)) AS a CROSS JOIN UNNEST(GENERATE_ARRAY(1, 100000)) AS b";
const filtered = `STARTS_WITH(table_schema, '${PREFIX}')`;
const region = `\`${project}\`.\`region-${REGION}\`.INFORMATION_SCHEMA`;

async function record(): Promise<void> {
  await scenario("datasets-list", async () => {
    const page = await ok("GET", `/datasets?maxResults=1000&filter=${encodeURIComponent(`labels.${LABEL}:main`)}`);
    expect((page.datasets as unknown[] | undefined)?.length === 2, "two labelled EU datasets");
  });
  await scenario("datasets-list-mixed-locations", async () => {
    const page = await ok("GET", `/datasets?maxResults=1000&filter=${encodeURIComponent(`labels.${LABEL}`)}`);
    expect((page.datasets as unknown[] | undefined)?.length === 3, "three labelled datasets");
  });
  await scenario("select-1", async () => {
    jobOf(await ok("POST", "/queries", jobBody("SELECT 1", { maxResults: 1 })));
  });
  await scenario("tables-list", async () => {
    await ok("GET", `/datasets/${ds("shop")}/tables?maxResults=1000`);
    await ok("GET", `/datasets/${ds("archive")}/tables?maxResults=1000`);
  });
  await scenario("tables-get", async () => {
    for (const t of ["orders", "customers", "order_summary", "daily_totals"])
      await ok("GET", `/datasets/${ds("shop")}/tables/${t}`);
    await ok("GET", `/datasets/${ds("archive")}/tables/orders_2023`);
    const missing = await api("GET", `/datasets/${ds("shop")}/tables/no_such_table`);
    expect(missing.status === 404, "404 for a missing table");
  });
  const catalog = async () => {
    jobOf(await guardedQuery(`SELECT table_schema, table_name, table_type FROM ${region}.TABLES WHERE ${filtered}`));
    jobOf(
      await guardedQuery(
        `SELECT table_schema, table_name, column_name, data_type, is_nullable FROM ${region}.COLUMNS WHERE ${filtered} ` +
          "ORDER BY table_schema, table_name, ordinal_position",
      ),
    );
  };
  await scenario("catalog", catalog);
  await scenario("dry-run", async () => {
    const dry = await ok("POST", "/queries", jobBody(`SELECT * FROM ${ds("shop")}.orders`, { dryRun: true }));
    expect(dry.totalBytesProcessed !== undefined, "dry run reports bytes");
  });
  await scenario("ddl", async () => {
    jobOf(await ok("POST", "/queries", jobBody(`CREATE TABLE ${ds("shop")}.refunds (refund_id INT64)`)));
  });
  await scenario("catalog-after-ddl", catalog);
  await scenario("typed-pages", async () => {
    const first = await ok("POST", "/queries", jobBody(TYPED_ROWS, { maxResults: 2 }));
    const job = jobOf(first);
    expect(job && first.jobComplete === true, "the typed query completes");
    const page1 = await ok("GET", `/queries/${job}?maxResults=2&location=EU&formatOptions.useInt64Timestamp=true`);
    expect(typeof page1.pageToken === "string", "a page token after two rows");
    await ok(
      "GET",
      `/queries/${job}?maxResults=2&location=EU&formatOptions.useInt64Timestamp=true&pageToken=${encodeURIComponent(String(page1.pageToken))}`,
    );
  });
  await scenario("cache-hit", async () => {
    const sql = `SELECT COUNT(*) AS n FROM ${ds("shop")}.orders`;
    jobOf(await ok("POST", "/queries", jobBody(sql)));
    const again = await ok("POST", "/queries", jobBody(sql));
    jobOf(again);
    expect(again.cacheHit === true, "the second run is a cache hit");
  });
  await scenario("syntax-error", async () => {
    const { status } = await api("POST", "/queries", jobBody("SELEC nope"));
    expect(status === 400, "HTTP 400");
  });
  await scenario("auth-401", async () => {
    const { status } = await api("POST", "/queries", jobBody("SELECT 1"), "ya29.not-a-valid-token-for-the-capture");
    expect(status === 401, "HTTP 401");
  });
  await scenario("slow-job", async () => {
    const started = await ok("POST", "/queries", jobBody(SLOW, { timeoutMs: 1, useQueryCache: false }));
    const job = jobOf(started);
    expect(job && started.jobComplete === false, "the slow query is still running");
    const poll = await ok("GET", `/queries/${job}?maxResults=1000&timeoutMs=1&location=EU`);
    expect(poll.jobComplete === false, "the poll finds it still running");
    await Bun.sleep(5000);
    jobOf(
      await guardedQuery(
        "SELECT job_id, user_email, state, query, creation_time, start_time, " +
          "TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), COALESCE(start_time, creation_time), MILLISECOND) AS ms " +
          `FROM ${region}.JOBS_BY_PROJECT WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY) ` +
          `AND state != 'DONE' AND job_id = '${job}' ORDER BY creation_time LIMIT 50`,
      ),
    );
    await ok("POST", `/jobs/${job}/cancel?location=EU`);
  });
  await scenario("access-denied", async () => {
    // A public project grants no one bigquery.jobs.create.
    const { status, json } = await api("POST", "/queries", jobBody("SELECT 1"), undefined, "bigquery-public-data");
    const reason = (json.error as { errors?: { reason?: string }[] } | undefined)?.errors?.[0]?.reason;
    expect(status === 403 && reason === "accessDenied", "HTTP 403 accessDenied");
  });
  await scenario("token-rejected", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const iat = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/bigquery" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer("libredb-capture@example.iam.gserviceaccount.com")
      .setAudience(TOKEN_URL)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(await importPKCS8(privateKey, "RS256"));
    const grant = "urn:ietf:params:oauth:grant-type:jwt-bearer";
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: grant, assertion }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json()) as Wire;
    // The assertion is left out: a signed JWT reads as a secret to the scanners, and the replay signs its own.
    captures.get("token-rejected")!.push({
      request: { method: "POST", path: TOKEN_URL, body: { grant_type: grant } },
      response: { status: response.status, body },
    });
    expect(response.status === 400 && typeof body.error === "string", "HTTP 400 with an OAuth error");
  });
  await scenario("storage", async () => {
    const grouped =
      "SELECT table_schema, COUNT(*) AS tables, SUM(total_logical_bytes) AS bytes " +
      `FROM ${region}.TABLE_STORAGE WHERE project_id = '${project}' AND NOT deleted AND ${filtered} ` +
      "GROUP BY table_schema ORDER BY bytes DESC";
    // TABLE_STORAGE lags behind new tables; a read that does not show both datasets yet is dropped and retried.
    for (let attempt = 1; ; attempt++) {
      const rows = (await guardedQuery(grouped)).rows as unknown[] | undefined;
      if (rows?.length === 2) break;
      captures.get("storage")!.pop();
      console.log(`storage: ${rows?.length ?? 0} of 2 datasets listed, attempt ${attempt}/15`);
      if (attempt === 15) throw new Error(`TABLE_STORAGE listed ${rows?.length ?? 0} of 2 datasets after 15 minutes`);
      await Bun.sleep(60_000);
    }
    await guardedQuery(
      "SELECT table_schema, table_name, total_rows, total_logical_bytes " +
        `FROM ${region}.TABLE_STORAGE WHERE project_id = '${project}' AND NOT deleted AND table_schema = '${ds("shop")}' ` +
        "ORDER BY total_logical_bytes DESC LIMIT 500",
    );
  });
  await scenario("dml", async () => {
    const dml = await ok("POST", "/queries", jobBody(`DELETE FROM ${ds("shop")}.orders WHERE true`));
    jobOf(dml);
    expect(dml.numDmlAffectedRows === "7", "seven rows deleted");
  });
  // JOBS lags a few seconds behind the jobs it lists.
  await Bun.sleep(10_000);
  const ours = ourJobs.map((id) => `'${id}'`).join(", ");
  await scenario("monitoring", async () => {
    await guardedQuery(
      `SELECT COUNT(*) AS total, COUNTIF(cache_hit) AS cached FROM ${region}.JOBS_BY_PROJECT ` +
        `WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR) AND job_type = 'QUERY' AND job_id IN (${ours})`,
    );
    await guardedQuery(
      "SELECT query, COUNT(*) AS calls, " +
        "SUM(TIMESTAMP_DIFF(end_time, start_time, MILLISECOND)) AS total_ms, " +
        "MIN(TIMESTAMP_DIFF(end_time, start_time, MILLISECOND)) AS min_ms, " +
        "MAX(TIMESTAMP_DIFF(end_time, start_time, MILLISECOND)) AS max_ms " +
        `FROM ${region}.JOBS_BY_PROJECT WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY) ` +
        `AND job_type = 'QUERY' AND state = 'DONE' AND statement_type != 'SCRIPT' AND job_id IN (${ours}) ` +
        "GROUP BY query ORDER BY total_ms DESC LIMIT 5",
    );
  });
}

function scrub(all: Map<string, Exchange[]>): Map<string, string> {
  const ids = new Map<string, string>();
  const pages = new Map<string, string>();
  const emails = new Map<string, string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!value || typeof value !== "object") return;
    for (const [key, v] of Object.entries(value)) {
      if ((key === "jobId" || key === "queryId") && typeof v === "string" && !ids.has(v))
        ids.set(v, `<job-${ids.size + 1}>`);
      if (key === "pageToken" && typeof v === "string" && !pages.has(v)) pages.set(v, `<page-${pages.size + 1}>`);
      collect(v);
    }
  };
  for (const id of ourJobs) if (!ids.has(id)) ids.set(id, `<job-${ids.size + 1}>`);
  for (const exchanges of all.values()) collect(exchanges);

  const out = new Map<string, string>();
  for (const [name, exchanges] of all) {
    let text = JSON.stringify(
      { scenario: name, exchanges },
      (key, value) =>
        // destinationTable names the anonymous result dataset, a hash of the principal.
        key === "etag" || key === "destinationTable" ? undefined : value,
      2,
    );
    // Longest first, so no id is replaced inside a longer one.
    for (const [real, placeholder] of [...ids, ...pages].sort((a, b) => b[0].length - a[0].length)) {
      text = text.split(real).join(placeholder).split(encodeURIComponent(real)).join(placeholder);
    }
    text = text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (email) => {
      if (!emails.has(email)) emails.set(email, `<user-${emails.size + 1}>`);
      return emails.get(email)!;
    });
    text = text.split(project).join("demo-project").split(PREFIX).join("").split(LABEL).join("libredb-capture");
    out.set(name, text);
  }

  const escape = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const forbidden = [
    escape(project),
    ...refused.map(escape),
    /ya29\.(?!not-a-valid)/,
    /bearer\s+\S/i,
    /private_key/,
    /access_token/,
    /refresh_token/,
    /\w@\w/,
  ];
  if (creds.type === "authorized_user") forbidden.push(escape(creds.clientId));
  for (const [name, text] of out) {
    for (const pattern of forbidden) {
      const line = text.split("\n").find((l) => pattern.test(l));
      if (line) throw new Error(`${name} still matches ${pattern} after the scrub, at ${line.trim()}; nothing written`);
    }
  }
  return out;
}

const date = new Date().toISOString().slice(0, 10);
const dir = path.join(OUT_ROOT, `${date}-${REGION}`);
let failed = false;
try {
  await setup();
  await record();
  const files = scrub(captures);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of files) writeFileSync(path.join(dir, `${name}.json`), `${text}\n`);
  console.log(`wrote ${files.size} capture(s) to ${path.relative(process.cwd(), dir)}`);
} catch (error) {
  failed = true;
  console.error(`bigquery-evidence: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await teardown();
  tokens.close();
}
process.exit(failed ? 1 : 0);

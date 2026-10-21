/**
 * Hand-run live check of the Databend provider (plan D14 and section 7): S1 to S16 and S3b, run through a real
 * `DatabendProvider` against the `databend-http` fixture of docker/databend/README.md, every pinned setting of design
 * 3.3 read back from the server's echo [X09], and the every-type export replay [X01].
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The unit and integration tests drive the provider over a
 * scripted transport and replay captures; only a server can say that a statement, a page chain, a kill, a sign-in
 * refusal or an exported INSERT does what the captures claim on the build that answers it.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 *
 * Run it from the repository root with the fixture up and seeded (docker/databend/README.md):
 *
 *   bun tests/live/databend-live-check.ts --target local       # the pinned image on 127.0.0.1:8000
 *   bun tests/live/databend-live-check.ts --target v1.2.881    # the floor build on 127.0.0.1:18009, seeded by seed.sh
 *
 * The Cloud target of plan section 7 dials the tenant over TLS (verify-system) on 443 with its warehouse, as the
 * `studio` user (role `studio_rw` on `studio_demo`), and reads the fixture's objects from `studio_demo`, where the
 * Cloud setup put them, since the tenant has no `libredb_demo`. Its credentials come from the environment only:
 * DATABEND_CLOUD_HOST, _PORT and _WAREHOUSE and the pairs DATABEND_CLOUD_STUDIO_USER/_PASSWORD,
 * DATABEND_CLOUD_RO_USER/_PASSWORD and DATABEND_CLOUD_SCRATCH_USER/_PASSWORD. There S7 creates no user: the setup's
 * `studio_scratch`, under no password policy, takes the one wrong password. S8 and S9 expect the gateway's refusals as
 * the configuration sentences, and S12 times the run's first request, since the SQL user cannot suspend a warehouse:
 *   (set -a; . <the operator's env file>; set +a; bun tests/live/databend-live-check.ts --target cloud)
 *
 * Each provider is built by the factory (`createDatabaseProvider`), except where a check's pass condition is what
 * went over the wire: there the same `DatabendProvider` is built with the production node transport wrapped in a
 * recorder, so the check can count the pages, see the final, the kill and the ROLLBACK, read an error code the house
 * error does not carry, compare each pinned setting with its echo, and prove that a latched sign-in sent nothing.
 *
 * It writes only to `studio_demo` and `libredb_demo`, every write naming its table qualified in a literal, plus S7's
 * scratch user `studio_scratch` under a password policy of its own (created at the start of S7, dropped at its end),
 * so a wrong password counts toward a lockout of that user only. The export replay's INSERTs are built at run time,
 * so no literal holds them: each `replay` call names its table as a `studio_demo.<name>` literal, the export writes
 * that qualified name, and `replay` refuses to send a line that does not start `INSERT INTO <that table> (`.
 * tests/unit/db/databend/live-environment.test.ts holds both rules. Every table and view it creates is dropped before it ends. The local credentials are read from
 * database-compose.yml and docker/databend/fixture.jsonl, the files that set them. Every line it prints has each
 * password replaced by `<password>`, and on Cloud the host by `<host>`, the tenant by `<tenant>` and the
 * region by `<region>`; an error outside a check prints only its redacted message and exits 1.
 *
 * It prints one line per check, `PASS <name> (<ms> ms)`, `FAIL <name>: <error>` or `SKIP <name>: <why>`, then
 * `<passed> of <total> checks passed on <target> (<version>)`, and exits 1 on any failure; an argument it does not
 * accept exits 2 before any socket opens.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AuthenticationError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import { createNodeTransport, type NodeTransport, type NodeTransportOptions } from "@/lib/db/http/node-transport";
import { DATABEND_STATEMENT_BYTES } from "@/lib/db/providers/sql/databend/connection-options";
import { DATABEND_ERROR_SENTENCES } from "@/lib/db/providers/sql/databend/errors";
import { DATABEND_PROVIDER_SENTENCES, DatabendProvider } from "@/lib/db/providers/sql/databend/index";
import { DATABEND_OBJECT_SENTENCES } from "@/lib/db/providers/sql/databend/objects";
import { TRANSACTION_ENDED, USE_NOT_CARRIED } from "@/lib/db/providers/sql/databend/session";
import { buildResultExport } from "@/lib/export/result-export";
import type { DatabaseConnection } from "@/lib/types";

// ============================================================================
// Arguments and credentials
// ============================================================================

const ROOT = path.resolve(import.meta.dir, "../..");
const QUERY_TIMEOUT_MS = 60_000;

interface Target {
  readonly port: number;
  /** What `SELECT version()` must answer on this build. */
  readonly version: RegExp;
  /** Whether the build knows materialized views: v1.2.881 refuses `CREATE MATERIALIZED VIEW` with 1005. */
  readonly materializedViews: boolean;
  /** Databend Cloud: TLS, a warehouse, and the credentials of the environment. */
  readonly cloud: boolean;
  /** Where the fixture's every-type table, views and materialized view are read. */
  readonly demo: string;
  /** A second database S14's `USE` names, which must not carry. */
  readonly other: string;
}

const TARGETS: Readonly<Record<string, Target>> = {
  local: {
    port: 8000,
    version: /^Databend Query v1\.2\.951-nightly-9b7eeff9a8\(/,
    materializedViews: true,
    cloud: false,
    demo: "libredb_demo",
    other: "studio_demo",
  },
  "v1.2.881": {
    port: 18009,
    version: /^Databend Query v1\.2\.881-/,
    materializedViews: false,
    cloud: false,
    demo: "libredb_demo",
    other: "studio_demo",
  },
  cloud: {
    port: 443,
    version: /^Databend Query v\d+\.\d+\.\d+/,
    materializedViews: true,
    cloud: true,
    demo: "studio_demo",
    // `studio` (role studio_rw) may not use `default` or `system` on Cloud (1063); information_schema is open to all.
    other: "information_schema",
  },
};

function parseArguments(argv: readonly string[]): { name: string; target: Target } {
  const at = argv.indexOf("--target");
  const name = at === -1 ? undefined : argv[at + 1];
  if (argv.length !== 2 || name === undefined || !Object.hasOwn(TARGETS, name)) {
    console.error(
      `databend-live-check: give --target with one of ${Object.keys(TARGETS).join(", ")}; nothing was sent.`,
    );
    process.exit(2);
  }
  return { name, target: TARGETS[name] };
}

interface Credential {
  readonly user: string;
  readonly password: string;
}

interface Credentials {
  readonly admin: Credential;
  readonly reader: Credential;
  /** Cloud only: the setup's `studio_scratch`, under no password policy, for S7's one wrong password. */
  readonly scratch?: Credential;
}

function environment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`databend-live-check: ${name} is not set; source the operator's env file. Nothing was sent.`);
    process.exit(2);
  }
  return value;
}

function cloudCredentials(): Credentials {
  const pair = (prefix: string): Credential => ({
    user: environment(`DATABEND_CLOUD_${prefix}_USER`),
    password: environment(`DATABEND_CLOUD_${prefix}_PASSWORD`),
  });
  return { admin: pair("STUDIO"), reader: pair("RO"), scratch: pair("SCRATCH") };
}

function readCredentials(): Credentials {
  if (target.cloud) return cloudCredentials();
  const compose = parseYaml(readFileSync(path.join(ROOT, "database-compose.yml"), "utf8"), { merge: true }) as {
    services: Record<string, { environment?: Record<string, string> }>;
  };
  const environment = compose.services["databend-http"]?.environment ?? {};
  const user = environment.QUERY_DEFAULT_USER;
  const password = environment.QUERY_DEFAULT_PASSWORD;
  if (user === undefined || password === undefined) throw new Error("databend-http sets no default user");
  const fixture = readFileSync(path.join(ROOT, "docker/databend/fixture.jsonl"), "utf8");
  const reader = /USER studio_reader IDENTIFIED BY '([^']+)'/.exec(fixture)?.[1];
  if (reader === undefined) throw new Error("fixture.jsonl creates no studio_reader");
  return { admin: { user, password }, reader: { user: "studio_reader", password: reader } };
}

const { name: targetName, target } = parseArguments(process.argv.slice(2));
const credentials = readCredentials();
const HOST = target.cloud ? environment("DATABEND_CLOUD_HOST") : "127.0.0.1";
const PORT = target.cloud ? Number(process.env.DATABEND_CLOUD_PORT ?? "443") : target.port;
const WAREHOUSE = target.cloud ? environment("DATABEND_CLOUD_WAREHOUSE") : undefined;
/** The fixture's database and S14's second one, from the target. */
const DEMO = target.demo;
const OTHER = target.other;

function connection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "databend-live-check",
    name: "Databend live check",
    type: "databend",
    host: HOST,
    port: PORT,
    user: credentials.admin.user,
    password: credentials.admin.password,
    createdAt: new Date(0),
    ...(target.cloud ? { ssl: { mode: "verify-system" as const }, warehouse: WAREHOUSE } : {}),
    ...overrides,
  };
}

// ============================================================================
// Providers: from the factory, or with the wire recorded
// ============================================================================

/** One request as the recorder saw it. */
interface Recorded {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
  status?: number;
  answer?: Record<string, unknown>;
  failed?: string;
}

interface Recorder {
  readonly log: Recorded[];
  /** The connection headers each transport was built with. */
  readonly headers: Readonly<Record<string, string>>[];
  readonly createNodeTransport: (options: NodeTransportOptions) => NodeTransport;
}

/** The production node transport, every request and answer kept in order. */
function recorder(): Recorder {
  const log: Recorded[] = [];
  const headers: Readonly<Record<string, string>>[] = [];
  return {
    log,
    headers,
    createNodeTransport: (options) => {
      headers.push(options.headers);
      const inner = createNodeTransport(options);
      return {
        async request(request) {
          const entry: Recorded = {
            method: request.method,
            path: new URL(request.url).pathname,
            body: request.body === undefined ? undefined : (JSON.parse(request.body) as Record<string, unknown>),
          };
          log.push(entry);
          try {
            const response = await inner.request(request);
            entry.status = response.status;
            try {
              entry.answer = JSON.parse(response.text) as Record<string, unknown>;
            } catch {
              // A non-JSON body is the transport's to refuse; the recorder keeps the status.
            }
            return response;
          } catch (error) {
            entry.failed = error instanceof Error ? error.message : String(error);
            throw error;
          }
        },
        close: () => inner.close(),
      };
    },
  };
}

async function factoryProvider(
  overrides: Partial<DatabaseConnection> = {},
  queryTimeout = QUERY_TIMEOUT_MS,
): Promise<DatabendProvider> {
  const provider = await createDatabaseProvider(connection(overrides), { queryTimeout });
  assert(provider instanceof DatabendProvider, "the factory did not build a DatabendProvider");
  return provider;
}

function recordedProvider(
  record: Recorder,
  overrides: Partial<DatabaseConnection> = {},
  queryTimeout = QUERY_TIMEOUT_MS,
): DatabendProvider {
  return new DatabendProvider(
    connection(overrides),
    { queryTimeout },
    { createNodeTransport: record.createNodeTransport },
  );
}

/** Connects, runs `body`, and disconnects whatever `body` did. */
async function using<T>(provider: DatabendProvider, body: (provider: DatabendProvider) => Promise<T>): Promise<T> {
  await provider.connect();
  try {
    return await body(provider);
  } finally {
    await provider.disconnect();
  }
}

// ============================================================================
// The checks
// ============================================================================

const tally = { passed: 0, total: 0, skipped: 0 };
/** Every password this run holds, replaced by `<password>` in any line it prints. */
const secrets = [credentials.admin.password, credentials.reader.password, credentials.scratch?.password ?? ""].filter(
  (secret) => secret !== "",
);

function redact(text: string): string {
  const masked = secrets.reduce((line, secret) => line.split(secret).join("<password>"), text);
  if (!target.cloud) return masked;
  // The gateway host is `<tenant>.gw.<region>.default.databend.com`; a TLS error may name the region alone.
  const [tenant, , region] = HOST.split(".");
  const labels: [string | undefined, string][] = [
    [tenant, "<tenant>"],
    [region, "<region>"],
  ];
  return labels.reduce(
    (line, [label, mask]) => (label ? line.split(label).join(mask) : line),
    masked.split(HOST).join("<host>"),
  );
}

async function check(name: string, body: () => Promise<string | undefined | void>): Promise<void> {
  tally.total += 1;
  const started = performance.now();
  try {
    const note = await body();
    tally.passed += 1;
    const ms = Math.round(performance.now() - started);
    console.log(redact(`PASS ${name} (${ms} ms)${note ? `: ${note}` : ""}`));
  } catch (error) {
    console.log(redact(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`));
  }
}

function skip(name: string, why: string): void {
  tally.skipped += 1;
  console.log(redact(`SKIP ${name}: ${why}`));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, what: string): void {
  if (!Bun.deepEquals(actual, expected, true))
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** The error a promise rejects with, which must be an instance of `type`. */
async function refusal<E extends Error>(promise: Promise<unknown>, type: new (...args: never[]) => E): Promise<E> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof type) return error;
    throw new Error(
      `expected ${type.name}, got ${error instanceof Error ? `${error.name}: ${error.message}` : error}`,
      {
        cause: error,
      },
    );
  }
  throw new Error(`expected ${type.name}, but it succeeded`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The statement POSTs the recorder saw whose SQL is `sql`. */
function posts(record: Recorder, sql: string): Recorded[] {
  return record.log.filter((entry) => entry.method === "POST" && entry.body?.sql === sql);
}

function answerError(entry: Recorded): { code?: number; message?: string } | undefined {
  const error = entry.answer?.error;
  return error === null || typeof error !== "object" ? undefined : (error as { code?: number; message?: string });
}

/**
 * A statement that runs for minutes unless it is stopped. Not the plan's `SELECT sleep(60)`: v1.2.881 refuses any
 * sleep past 3 seconds, so the evidence plan's long count runs on every build instead.
 */
const LONG_SQL = "SELECT count(*) FROM numbers(100000000000) WHERE number % 7 = 3";
const MISSING_TABLE_SQL = "SELECT * FROM studio_demo.live_check_missing";
const SYNTAX_SQL = `SELECT * FRM ${DEMO}.every_type`;

let serverVersion = "unknown";
/** How long the run's first request, the admin's connect probe, took: S12 reads it on Cloud. */
let firstRequestMs = 0;

async function scenarios(admin: DatabendProvider): Promise<void> {
  await check("S1 version() answers the target's build", async () => {
    const result = await admin.query("SELECT version() AS version");
    serverVersion = String(result.rows[0]?.version);
    assert(target.version.test(serverVersion), `version() answered ${serverVersion}, not ${target.version}`);
    serverVersion = serverVersion.replace(/^Databend Query /, "").replace(/\(.*$/, "");
    return serverVersion;
  });

  await check("S2 create, insert, select, update, delete, merge and drop in studio_demo", async () => {
    try {
      await admin.query("CREATE OR REPLACE TABLE studio_demo.live_check_s2 (id INT NOT NULL, body VARCHAR)");
      same(
        (await admin.query("INSERT INTO studio_demo.live_check_s2 VALUES (1, 'one'), (2, 'two')")).rowCount,
        2,
        "rows inserted",
      );
      const read = await admin.query("SELECT id, body FROM studio_demo.live_check_s2 ORDER BY id");
      same(
        read.rows,
        [
          { id: 1, body: "one" },
          { id: 2, body: "two" },
        ],
        "the rows read back",
      );
      same(
        (await admin.query("UPDATE studio_demo.live_check_s2 SET body = 'deux' WHERE id = 2")).rowCount,
        1,
        "rows updated",
      );
      same((await admin.query("DELETE FROM studio_demo.live_check_s2 WHERE id = 1")).rowCount, 1, "rows deleted");
      await admin.query(
        "MERGE INTO studio_demo.live_check_s2 AS t USING (SELECT 2 AS id, 'zwei' AS body UNION ALL SELECT 3 AS id, 'three' AS body) AS s ON t.id = s.id WHEN MATCHED THEN UPDATE SET t.body = s.body WHEN NOT MATCHED THEN INSERT (id, body) VALUES (s.id, s.body)",
      );
      const merged = await admin.query("SELECT id, body FROM studio_demo.live_check_s2 ORDER BY id");
      same(
        merged.rows,
        [
          { id: 2, body: "zwei" },
          { id: 3, body: "three" },
        ],
        "the rows after the merge",
      );
      await admin.query("DROP TABLE studio_demo.live_check_s2");
      await refusal(admin.query("SELECT id FROM studio_demo.live_check_s2"), QueryError);
    } finally {
      await admin.query("DROP TABLE IF EXISTS studio_demo.live_check_s2");
    }
  });

  await check("S3 100,000 rows arrive whole over the page chain", async () => {
    const record = recorder();
    return using(recordedProvider(record), async (provider) => {
      const prepared = provider.prepareQuery("SELECT number FROM numbers(100000) ORDER BY number", { unlimited: true });
      record.log.length = 0;
      const result = await provider.query(prepared.query);
      same(result.rows.length, 100_000, "rows");
      same([result.rows[0]?.number, result.rows[99_999]?.number], [0, 99_999], "the first and last number");
      assert(result.pagination?.wasLimited !== true, "a whole result was reported as cut");
      same(result.warnings, undefined, "warnings");
      const pages = record.log.filter((entry) => entry.method === "GET" && entry.path.includes("/page/")).length;
      assert(pages >= 10, `the rows came in ${pages} page requests, fewer than 10 pages of 10,000`);
      return `${pages} page requests`;
    });
  });

  await check("S3b a statement past the 16 MiB statement budget ends cut, wasLimited, with a final", async () => {
    const record = recorder();
    return using(recordedProvider(record), async (provider) => {
      record.log.length = 0;
      const result = await provider.query("SELECT number, repeat('x', 1000) AS wide FROM numbers(30000)");
      assert(result.pagination?.wasLimited === true, "the cut result does not say wasLimited");
      assert(result.rows.length > 0 && result.rows.length < 30_000, `${result.rows.length} rows of 30,000 arrived`);
      const cut = DATABEND_PROVIDER_SENTENCES.resultCut({ bound: "bytes", limit: DATABEND_STATEMENT_BYTES });
      same(
        result.warnings?.map((warning) => warning.message),
        [cut],
        "warnings",
      );
      const final = record.log.find((entry) => entry.method === "GET" && entry.path.endsWith("/final"));
      assert(final !== undefined, "no final was sent after the cut");
      same(final.status, 200, "the final's status");
      return `${result.rows.length} rows kept`;
    });
  });

  await check("S4 load more reads the next page at an offset", async () => {
    const sql = "SELECT number FROM numbers(100000) ORDER BY number";
    const prepared = admin.prepareQuery(sql, { limit: 500, offset: 500 });
    assert(prepared.wasLimited, "the limiter did not bound the statement");
    const result = await admin.query(prepared.query);
    same(result.rows.length, 500, "rows");
    same([result.rows[0]?.number, result.rows[499]?.number], [500, 999], "the first and last number");
  });

  await check("S5 an unknown table is 1025 and a QueryError", async () => {
    const record = recorder();
    return using(recordedProvider(record), async (provider) => {
      const error = await refusal(provider.query(MISSING_TABLE_SQL), QueryError);
      const codes = posts(record, MISSING_TABLE_SQL).map((entry) => answerError(entry)?.code);
      same(codes, [1025], "the answer's code");
      assert(error.message.includes("live_check_missing"), `the error does not name the table: ${error.message}`);
    });
  });

  await check("S6 a syntax error carries its position", async () => {
    const error = await refusal(admin.query(SYNTAX_SQL), QueryError);
    same(error.position, 10, "the position");
  });

  await s7(admin);

  if (target.cloud) await cloudWarehouseChecks();
  else
    await check("S8 with no warehouse, a self-hosted server answers and nothing claims billed compute", async () => {
      const record = recorder();
      return using(recordedProvider(record), async (provider) => {
        same((await provider.query("SELECT 1 AS one")).rows, [{ one: 1 }], "rows");
        same(provider.getCapabilities().resumesBilledCompute, undefined, "resumesBilledCompute");
        assert(
          record.headers.every((headers) => headers["x-databend-warehouse"] === undefined),
          "a warehouse header was sent",
        );
      });
    });

  if (!target.cloud)
    await check("S9 an unknown warehouse is sent, and self-hosted Databend ignores it", async () => {
      const record = recorder();
      return using(recordedProvider(record, { warehouse: "live_check_no_such_wh" }), async (provider) => {
        same((await provider.query("SELECT 1 AS one")).rows, [{ one: 1 }], "rows");
        same(provider.getCapabilities().resumesBilledCompute, true, "resumesBilledCompute");
        assert(
          record.headers.every((headers) => headers["x-databend-warehouse"] === "live_check_no_such_wh"),
          "the warehouse header was not sent",
        );
        return "the Cloud gateway's refusal is owed to the Cloud run";
      });
    });

  await check("S10 a cancel stops a long statement with a kill the server acknowledges", async () => {
    const record = recorder();
    return using(recordedProvider(record), async (provider) => {
      const started = performance.now();
      const running = refusal(provider.query(LONG_SQL, undefined, "live-check-s10"), QueryCancelledError);
      await sleep(1500);
      same(await provider.cancelQuery("live-check-s10"), true, "cancelQuery");
      const error = await running;
      const seconds = (performance.now() - started) / 1000;
      same(error.message, DATABEND_ERROR_SENTENCES.cancelled, "the message");
      assert(seconds < 10, `the cancelled statement ended after ${seconds.toFixed(1)} s`);
      const kills = record.log.filter((entry) => entry.method === "GET" && entry.path.endsWith("/kill"));
      same(
        kills.map((entry) => entry.status),
        [200],
        "the kill's status",
      );
      return `ended ${seconds.toFixed(1)} s after the start`;
    });
  });

  await check("S11 the statement deadline stops the statement on the server too", async () => {
    const record = recorder();
    return using(recordedProvider(record, {}, 2000), async (provider) => {
      const started = performance.now();
      const error = await refusal(provider.query(LONG_SQL), TimeoutError);
      const seconds = (performance.now() - started) / 1000;
      same(error.message, DATABEND_ERROR_SENTENCES.deadline("2"), "the message");
      const [post] = posts(record, LONG_SQL);
      const settings = (post?.body?.session as { settings?: Record<string, string> } | undefined)?.settings;
      same(settings?.max_execute_time_in_seconds, "2", "max_execute_time_in_seconds");
      const kills = record.log.filter((entry) => entry.method === "GET" && entry.path.endsWith("/kill"));
      same(
        kills.map((entry) => entry.status),
        [200],
        "the kill's status",
      );
      return `ended after ${seconds.toFixed(1)} s, one kill answered 200`;
    });
  });

  if (!target.cloud)
    skip("S12 cold start", "a self-hosted server has no warehouse to suspend; the Cloud run owes it [X07]");
  else
    skip(
      "S12 cold start",
      `the SQL user may not suspend the warehouse (Cloud refuses it, I19), so no resume was provoked; the run's first request, the connect probe, took ${firstRequestMs} ms and succeeded, which shows no resume [X07]`,
    );

  await check("S13 a lone BEGIN is rolled back, with its warning", async () => {
    const record = recorder();
    return using(recordedProvider(record), async (provider) => {
      const result = await provider.query("BEGIN");
      same(
        result.warnings?.map((warning) => warning.message),
        [TRANSACTION_ENDED],
        "warnings",
      );
      same(
        posts(record, "ROLLBACK").map((entry) => entry.status),
        [200],
        "the ROLLBACK's status",
      );
    });
  });

  await check("S14 the session echo: Database is current, USE does not carry, no result-mode warning", async () => {
    const provider = await factoryProvider({ database: DEMO });
    return using(provider, async () => {
      const current = await provider.query("SELECT current_database() AS db");
      same(current.rows, [{ db: DEMO }], "current_database()");
      same(current.warnings, undefined, "warnings");
      const use = await provider.query(`USE ${OTHER}`);
      same(
        use.warnings?.map((warning) => warning.message),
        [USE_NOT_CARRIED],
        "the USE warnings",
      );
      same((await provider.query("SELECT current_database() AS db")).rows, [{ db: DEMO }], "after USE");
    });
  });

  await check("every pinned setting of design 3.3 is echoed as sent [X09]", async () => {
    const record = recorder();
    return using(recordedProvider(record), async (provider) => {
      await provider.query("SELECT 1 AS one");
      await provider.listContainers(["default"]);
      const findings: string[] = [];
      const statements = record.log.filter((entry) => entry.method === "POST" && entry.path === "/v1/query");
      for (const entry of statements) {
        const sent = (entry.body?.session as { settings?: Record<string, string> } | undefined)?.settings ?? {};
        const echoed = (entry.answer?.session as { settings?: Record<string, string> } | undefined)?.settings ?? {};
        for (const [key, value] of Object.entries(sent)) {
          if (echoed[key]?.toLowerCase() !== value.toLowerCase())
            findings.push(
              `${key}=${value} echoed as ${echoed[key] ?? "nothing"} for ${String(entry.body?.sql).slice(0, 40)}`,
            );
        }
      }
      same(findings, [], "settings not echoed as sent");
      const keys = new Set(
        statements.flatMap((entry) =>
          Object.keys((entry.body?.session as { settings?: Record<string, string> } | undefined)?.settings ?? {}),
        ),
      );
      return [...keys].sort().join(", ");
    });
  });

  await check("S15 studio_reader is refused a write and changes nothing", async () => {
    const before = await admin.query("SELECT count(*) AS n FROM studio_demo.notes");
    const reader = await factoryProvider({ user: credentials.reader.user, password: credentials.reader.password });
    await using(reader, async () => {
      same((await reader.query(`SELECT count(*) AS n FROM ${DEMO}.every_type`)).rows, [{ n: 4 }], "a read");
      const error = await refusal(reader.query("INSERT INTO studio_demo.notes VALUES (9, 'nine')"), QueryError);
      assert(/permission|privilege/i.test(error.message), `the refusal does not name a privilege: ${error.message}`);
    });
    same((await admin.query("SELECT count(*) AS n FROM studio_demo.notes")).rows, before.rows, "the notes count");
  });

  await check("S16 the object tree, columns and DDL of studio_demo", async () => {
    const catalogs = (await admin.listContainers()).map((container) => container.name);
    assert(catalogs.includes("default"), `the catalogs are ${catalogs.join(", ")}`);
    const databases = (await admin.listContainers(["default"])).map((container) => container.name);
    for (const database of new Set(["studio_demo", DEMO]))
      assert(databases.includes(database), `the databases are ${databases.join(", ")}`);
    const counts = await admin.countObjects(["default", "studio_demo"]);
    const tableCount = counts.table !== undefined && "count" in counts.table ? counts.table.count : 0;
    assert(tableCount >= 1, `studio_demo counts ${JSON.stringify(counts)}`);
    const tables = (await admin.listObjects(["default", "studio_demo"], "table")).map((object) => object.name);
    assert(tables.includes("notes"), `studio_demo's tables are ${tables.join(", ")}`);
    const detail = await admin.describeObject(["default", "studio_demo", "notes"], "table");
    same(
      detail.columns.map((entry) => entry.name),
      ["id", "body"],
      "the columns of notes",
    );
    const source = await admin.readObjectSource(["default", "studio_demo", "notes"], "table");
    const text = source.parts.map((part) => ("text" in part ? part.text : "")).join("\n");
    // Provider statements run under the PostgreSQL dialect (design 3.3), so every name is double-quoted.
    assert(
      /^CREATE TABLE "notes" \(\s+"id" INT NOT NULL,\s+"body" VARCHAR/.test(text),
      `the DDL starts ${text.slice(0, 80)}`,
    );
  });

  if (!target.materializedViews)
    skip(`S16 the materialized view of ${DEMO} [I5]`, "this build has no materialized views, so the seed makes none");
  else
    await check(`S16 the materialized view of ${DEMO}: listed, described and its DDL read [I5]`, async () => {
      const views = (await admin.listObjects(["default", DEMO], "materialized_view")).map((object) => object.name);
      same(views, ["every_type_mv"], "the materialized views");
      const detail = await admin.describeObject(["default", DEMO, "every_type_mv"], "materialized_view");
      same(
        detail.columns.map((entry) => entry.name),
        ["id", "txt"],
        "the columns",
      );
      const source = await admin.readObjectSource(["default", DEMO, "every_type_mv"], "materialized_view");
      const text = source.parts.map((part) => ("text" in part ? part.text : "")).join("\n");
      // SHOW CREATE MATERIALIZED VIEW backticks and qualifies every name whatever the dialect (L6).
      // A regular expression, not a string: the write-surface guard reads every string literal as a statement.
      const qualifier = /^CREATE MATERIALIZED VIEW `(\w+)`\.`every_type_mv` \(`id`, `txt`\) AS SELECT /.exec(text)?.[1];
      assert(qualifier === DEMO, `the DDL starts ${text.slice(0, 80)}`);
    });

  await check("S16 a view over a dropped table is refused by name, and left out of the bulk read", async () => {
    try {
      await admin.query("CREATE OR REPLACE TABLE studio_demo.live_check_base (a INT)");
      await admin.query(
        "CREATE OR REPLACE VIEW studio_demo.live_check_broken AS SELECT a FROM studio_demo.live_check_base",
      );
      await admin.query("DROP TABLE studio_demo.live_check_base");
      const error = await refusal(
        admin.describeObject(["default", "studio_demo", "live_check_broken"], "view"),
        QueryError,
      );
      same(error.message, DATABEND_OBJECT_SENTENCES.noColumns("live_check_broken"), "the refusal");
      const batch = await admin.describeObjects(["default", "studio_demo"], "view");
      assert(
        batch.truncated?.reason.includes(DATABEND_OBJECT_SENTENCES.noColumnsLeftOut(["live_check_broken"])) === true,
        `truncated is ${JSON.stringify(batch.truncated)}`,
      );
      assert(
        batch.details.every((entry) => entry.path.at(-1) !== "live_check_broken"),
        "the broken view was handed over as described",
      );
    } finally {
      await admin.query("DROP VIEW IF EXISTS studio_demo.live_check_broken");
      await admin.query("DROP TABLE IF EXISTS studio_demo.live_check_base");
    }
  });
}

/**
 * S7: one wrong password for `studio_scratch`, a user under a password policy of its own, then a second instance on
 * the same key sends nothing, and the right password still signs in, so the policy counted one failure, not five.
 */
async function s7(admin: DatabendProvider): Promise<void> {
  if (target.cloud) return s7Cloud();
  const scratchPassword = `Scratch9${randomUUID().slice(0, 8)}`;
  const wrongPassword = `Wrong9${randomUUID().slice(0, 8)}`;
  secrets.push(scratchPassword, wrongPassword);
  const scratch = { user: "studio_scratch" };
  await check("S7 one wrong password is refused and latched, and a second instance sends nothing", async () => {
    try {
      await admin.query("DROP USER IF EXISTS studio_scratch");
      await admin.query("DROP PASSWORD POLICY IF EXISTS studio_scratch_policy");
      await admin.query("CREATE PASSWORD POLICY studio_scratch_policy PASSWORD_MAX_RETRIES = 5");
      await admin.query(
        `CREATE USER studio_scratch IDENTIFIED BY '${scratchPassword}' WITH SET PASSWORD POLICY = 'studio_scratch_policy'`,
      );
      const first = await factoryProvider({ ...scratch, password: wrongPassword });
      const refused = await refusal(first.connect(), AuthenticationError);
      assert(
        refused.message.startsWith(DATABEND_ERROR_SENTENCES.signInRefused),
        `the first refusal is: ${refused.message}`,
      );
      const record = recorder();
      const second = recordedProvider(record, { ...scratch, password: wrongPassword });
      const latched = await refusal(second.connect(), AuthenticationError);
      assert(
        latched.message.startsWith("Databend refused this sign-in at "),
        `the second refusal is: ${latched.message}`,
      );
      same(record.log.length, 0, "requests the latched instance sent");
      const right = await factoryProvider({ ...scratch, password: scratchPassword });
      await using(right, async () => {
        same((await right.query("SELECT current_user() AS who")).rows.length, 1, "rows");
      });
      return "the right password still signs in: one failure counted, no lockout";
    } finally {
      await admin.query("DROP USER IF EXISTS studio_scratch");
      await admin.query("DROP PASSWORD POLICY IF EXISTS studio_scratch_policy");
    }
  });
}

/**
 * S7 on Cloud: the setup's `studio_scratch`, under no password policy, so its one wrong password locks nothing; a
 * second instance on the same key sends nothing, and the right password still signs in. No user is created here.
 */
async function s7Cloud(): Promise<void> {
  const scratch = credentials.scratch;
  assert(scratch !== undefined, "the Cloud target has no studio_scratch pair");
  const wrongPassword = `Wrong9${randomUUID().slice(0, 8)}`;
  secrets.push(wrongPassword);
  await check("S7 one wrong password is refused and latched, and a second instance sends nothing", async () => {
    const first = await factoryProvider({ user: scratch.user, password: wrongPassword });
    const refused = await refusal(first.connect(), AuthenticationError);
    assert(
      refused.message.startsWith(DATABEND_ERROR_SENTENCES.signInRefused),
      `the first refusal is: ${refused.message}`,
    );
    const record = recorder();
    const second = recordedProvider(record, { user: scratch.user, password: wrongPassword });
    const latched = await refusal(second.connect(), AuthenticationError);
    assert(
      latched.message.startsWith("Databend refused this sign-in at "),
      `the second refusal is: ${latched.message}`,
    );
    same(record.log.length, 0, "requests the latched instance sent");
    const right = await factoryProvider({ user: scratch.user, password: scratch.password });
    await using(right, async () => {
      same((await right.query("SELECT current_user() AS who")).rows.length, 1, "rows");
    });
    return `first refusal: ${refused.message}; the right password still signs in`;
  });
}

/**
 * S8 and S9 on Cloud: the gateway refuses a request with no warehouse and one with a warehouse the tenant does not
 * have, and the provider words each as its configuration sentence, a DatabaseConfigError that latches nothing.
 */
async function cloudWarehouseChecks(): Promise<void> {
  await check("S8 with no warehouse, the Cloud gateway's refusal is the warehouse-required sentence", async () => {
    const record = recorder();
    const provider = recordedProvider(record, { warehouse: undefined });
    const error = await refusal(provider.connect(), DatabaseConfigError);
    same(error.message, DATABEND_ERROR_SENTENCES.warehouseRequired, "the message");
    assert(
      record.headers.every((headers) => headers["x-databend-warehouse"] === undefined),
      "a warehouse header was sent",
    );
    same(
      record.log.map((entry) => entry.status),
      [400],
      "the statuses",
    );
    // A configuration refusal latches nothing: the same instance's next connect sends again.
    await refusal(provider.connect(), DatabaseConfigError);
    same(record.log.length, 2, "requests after a second connect");
    return `HTTP 400 ${String((record.log[0]?.answer?.error as { kind?: string } | undefined)?.kind)}`;
  });

  await check("S9 an unknown warehouse is sent, and the Cloud gateway's refusal names it", async () => {
    const record = recorder();
    const provider = recordedProvider(record, { warehouse: "live_check_no_such_wh" });
    const error = await refusal(provider.connect(), DatabaseConfigError);
    same(error.message, DATABEND_ERROR_SENTENCES.warehouseRefused("live_check_no_such_wh"), "the message");
    same(provider.getCapabilities().resumesBilledCompute, true, "resumesBilledCompute");
    assert(
      record.headers.every((headers) => headers["x-databend-warehouse"] === "live_check_no_such_wh"),
      "the warehouse header was not sent",
    );
    same(
      record.log.map((entry) => entry.status),
      [400],
      "the statuses",
    );
    return `HTTP 400 ${String((record.log[0]?.answer?.error as { kind?: string } | undefined)?.kind)}`;
  });
}

// ============================================================================
// The every-type export replay [X01]
// ============================================================================

/** The columns of `every_type` whose type `DATABEND_SQL_WRITING.export.typedLiteral` writes (design 7.2): the rest throw. */
const WRITABLE_COLUMNS = [
  "id",
  "i8",
  "i16",
  "i32",
  "i64",
  "u8",
  "u64",
  "f32",
  "f64",
  "dec",
  "flag",
  "txt",
  "bin",
  "d",
  "ts",
  "v",
  "u16",
  "u32",
  "tz",
];

interface ReplayOutcome {
  readonly replayed: number[];
  readonly skipped: string[];
  readonly mismatches: string[];
}

/**
 * Exports `select` through the provider and `buildResultExport` as SQL INSERTs into `table` (a fresh copy of
 * `every_type`, named `studio_demo.<name>`), runs each statement on a connection whose Database is studio_demo, as a
 * person would run the file, and compares every cell of every replayed row with its source row. A line that is not an
 * INSERT into `table` is refused before anything is sent, so the writes stay in studio_demo whatever the export or the
 * writer's Database does.
 */
async function replay(
  admin: DatabendProvider,
  writer: DatabendProvider,
  select: string,
  table: string,
  readBack: string,
): Promise<ReplayOutcome> {
  assert(/^studio_demo\.\w+$/.test(table), `the replay target ${table} is not a studio_demo table`);
  const source = await admin.query(select);
  const file = buildResultExport("sql-insert", {
    rows: source.rows,
    fields: source.fields,
    tabName: table,
    dialect: "databend",
    columnTypes: source.columnTypes,
  });
  const skipped: string[] = [];
  for (const line of file.content.split("\n")) {
    if (line.startsWith("-- ")) {
      skipped.push(line);
      continue;
    }
    // A regular expression, not a string: the write-surface guard reads every string literal as a statement.
    const target = /^INSERT INTO (\S+) \(/.exec(line)?.[1];
    assert(target === table, `the export wrote a line whose target is ${target ?? "missing"}, not ${table}`);
    // oxlint-disable-next-line no-await-in-loop -- one statement at a time, as the file runs.
    await writer.query(line);
  }
  const copy = await admin.query(readBack);
  const mismatches: string[] = [];
  const replayed: number[] = [];
  for (const row of source.rows) {
    const twin = copy.rows.find((candidate) => candidate.id === row.id);
    if (twin === undefined) continue;
    replayed.push(Number(row.id));
    for (const field of source.fields) {
      if (!Bun.deepEquals(twin[field], row[field], true))
        mismatches.push(
          `row id ${row.id}, column ${field}: ${JSON.stringify(row[field])} replayed as ${JSON.stringify(twin[field])}`,
        );
    }
  }
  const ids = source.rows.map((row) => Number(row.id));
  const accounted = ids.filter(
    (id, index) => replayed.includes(id) || skipped.some((line) => line.startsWith(`-- Row ${index + 1} skipped:`)),
  );
  if (accounted.length !== ids.length)
    mismatches.push(
      `rows neither replayed nor skipped by name: ${ids.filter((id) => !accounted.includes(id)).join(", ")}`,
    );
  if (copy.rows.length !== replayed.length)
    mismatches.push(`the copy holds ${copy.rows.length} rows, ${replayed.length} matched`);
  return { replayed, skipped, mismatches };
}

async function exportReplay(admin: DatabendProvider): Promise<void> {
  const writer = await factoryProvider({ database: "studio_demo" });
  await writer.connect();
  try {
    await check("X01 every row of every_type replays equal, or is skipped by name", async () => {
      try {
        await admin.query(`CREATE OR REPLACE TABLE studio_demo.every_type_replay LIKE ${DEMO}.every_type`);
        const outcome = await replay(
          admin,
          writer,
          `SELECT * FROM ${DEMO}.every_type ORDER BY id`,
          "studio_demo.every_type_replay",
          "SELECT * FROM studio_demo.every_type_replay ORDER BY id",
        );
        for (const line of outcome.skipped) console.log(`  ${line}`);
        same(outcome.mismatches, [], "mismatches");
        return `replayed ids ${outcome.replayed.join(", ") || "none"}; ${outcome.skipped.length} skipped by name`;
      } finally {
        await admin.query("DROP TABLE IF EXISTS studio_demo.every_type_replay");
      }
    });

    await check("X01 every cell of the writable columns replays equal", async () => {
      try {
        await admin.query(`CREATE OR REPLACE TABLE studio_demo.every_type_scalar_replay LIKE ${DEMO}.every_type`);
        const list = WRITABLE_COLUMNS.join(", ");
        const outcome = await replay(
          admin,
          writer,
          `SELECT ${list} FROM ${DEMO}.every_type ORDER BY id`,
          "studio_demo.every_type_scalar_replay",
          `SELECT ${list} FROM studio_demo.every_type_scalar_replay ORDER BY id`,
        );
        for (const line of outcome.skipped) console.log(`  ${line}`);
        same(outcome.mismatches, [], "mismatches");
        same(outcome.skipped, [], "rows skipped");
        return `replayed ids ${outcome.replayed.join(", ")} over ${WRITABLE_COLUMNS.length} columns`;
      } finally {
        await admin.query("DROP TABLE IF EXISTS studio_demo.every_type_scalar_replay");
      }
    });

    await check("X01 each other column alone: a non-NULL cell skips its row by that column's name", async () => {
      const source = await admin.query(`SELECT * FROM ${DEMO}.every_type ORDER BY id`);
      const others = source.fields.filter((field) => !WRITABLE_COLUMNS.includes(field));
      const findings: string[] = [];
      try {
        for (const field of others) {
          // oxlint-disable-next-line no-await-in-loop -- one fresh copy per column.
          await admin.query(`CREATE OR REPLACE TABLE studio_demo.every_type_column_replay LIKE ${DEMO}.every_type`);
          // oxlint-disable-next-line no-await-in-loop -- one fresh copy per column.
          const outcome = await replay(
            admin,
            writer,
            `SELECT id, ${field} FROM ${DEMO}.every_type ORDER BY id`,
            "studio_demo.every_type_column_replay",
            `SELECT id, ${field} FROM studio_demo.every_type_column_replay ORDER BY id`,
          );
          findings.push(...outcome.mismatches.map((mismatch) => `${field}: ${mismatch}`));
          const unnamed = outcome.skipped.filter((line) => !line.includes(`column "${field}"`));
          findings.push(...unnamed.map((line) => `${field}: a skip names another column: ${line}`));
          const nonNull = source.rows.filter((row) => row[field] !== null).length;
          if (outcome.skipped.length !== nonNull)
            findings.push(`${field}: ${outcome.skipped.length} rows skipped, ${nonNull} cells are not NULL`);
        }
      } finally {
        await admin.query("DROP TABLE IF EXISTS studio_demo.every_type_column_replay");
      }
      same(findings, [], "findings");
      return `skipped by name: ${others.join(", ")}`;
    });
  } finally {
    await writer.disconnect();
  }
}

// ============================================================================
// Main
// ============================================================================

async function run(): Promise<void> {
  const admin = await factoryProvider();
  const connectStarted = performance.now();
  await admin.connect();
  firstRequestMs = Math.round(performance.now() - connectStarted);
  try {
    await scenarios(admin);
    await exportReplay(admin);
  } finally {
    await admin.disconnect();
  }
}

// An error outside a check (the first connect, the replay writer's connect, a cleanup) names the host in its message
// and in its properties, so only its redacted message is printed.
try {
  await run();
} catch (error) {
  console.error(redact(`databend-live-check: stopped: ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
}
console.log(
  redact(
    `${tally.passed} of ${tally.total} checks passed on ${targetName} ${HOST}:${PORT} (${serverVersion}), ${tally.skipped} skipped`,
  ),
);
process.exit(tally.passed === tally.total ? 0 : 1);

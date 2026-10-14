/**
 * Hand-run live check of the Apache Spark provider against the compose fixture of database-compose.yml (spark,
 * spark-4-1, spark-auth, spark-tls), the list every later change of the provider runs: connect on both versions, the
 * token and TLS outcomes, the tree, queries and the three budgets, writes, errors, Explain, every monitoring panel,
 * maintenance, cancel, the heartbeat, sessions, substitution and the codec, the export replay, and the release of a
 * session whose statement still runs.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Start the services, load the variables of
 * tests/helpers/spark-live.ts, then run `bun tests/live/spark-live-check.ts` from the repository root (add
 * `--only <item number>` to run one). Each provider is built by the factory, as the server builds it, except where an
 * item's pass condition is what went over the wire: there the same `SparkProvider` gets the production transport
 * wrapped in a recorder.
 *
 * It writes only under spark_catalog (the sample objects of tests/live/spark-evidence-plan.ts, and tables under
 * spark_catalog.studio that it drops again). It prints one line per item, `PASS <name> (<ms> ms)`,
 * `FAIL <name>: <error>` or `SKIP <name>: <why>`, every line masked, then `<passed> of <total> items passed`, and
 * exits 1 on any failure; a missing or malformed variable exits 2 before any socket opens.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthenticationError, ConnectionError, QueryCancelledError, QueryError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import { SPARK_ERROR_SENTENCES } from "@/lib/db/providers/sql/spark/errors";
import { grpcWireTransport, type SparkWireTransport } from "@/lib/db/providers/sql/spark/grpc-client";
import { SPARK_PROVIDER_SENTENCES, SparkProvider } from "@/lib/db/providers/sql/spark/index";
import { SPARK_MONITORING_LABELS } from "@/lib/db/providers/sql/spark/monitoring";
import { SPARK_CUT_WARNINGS } from "@/lib/db/providers/sql/spark/result-stream";
import type { DatabaseProvider } from "@/lib/db/types";
import { sparkTextStrategy } from "@/lib/explain/spark-text";
import type { ExplainTreeNode } from "@/lib/explain/types";
import { buildResultExport } from "@/lib/export/result-export";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { splitStatements } from "@/lib/sql/statement-splitter";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import {
  maskSparkLive,
  readSparkLiveArguments,
  type SparkLiveArguments,
  type SparkLiveService,
  sparkLiveSecrets,
} from "../helpers/spark-live";
import { SPARK_EVERY_TYPE_SELECT, SPARK_SAMPLE_STATEMENTS } from "./spark-evidence-plan";

const read = readSparkLiveArguments(process.env);
if ("exitCode" in read) {
  console.error(`spark-live-check: ${read.message}`);
  process.exit(read.exitCode);
}
const args: SparkLiveArguments = read;
const secrets = sparkLiveSecrets(args);
const say = (line: string): void => console.log(maskSparkLive(line, secrets));
const only = process.argv.includes("--only") ? Number(process.argv[process.argv.indexOf("--only") + 1]) : undefined;
const underBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * Calibrated on the `spark` service (local[4], 2g driver heap): 1e11 rows took 29.7 s and 4e10 took 12.5 s, about
 * 0.29 s per 1e9; 2.7e11 then ran 85 s on `spark` and 86 s through `spark-tls` in the heartbeat item (2026-10-14). The
 * items that use it need it to outlast four heartbeat beats (15 s each), a 3 s wait before a cancel or a release, and
 * the 10 s job-state wait after one.
 */
const LONG_STATEMENT = "SELECT count(*) FROM range(0, 270000000000, 1, 4) WHERE (id * 7919) % 104729 = 0";
/** The query timeout of the items that run LONG_STATEMENT to its end: above it, below nginx's 300 s on spark-tls. */
const LONG_TIMEOUT_MS = 240_000;

type Skip = { readonly skip: string };
const results: { readonly ok: boolean }[] = [];

async function item(number: number, name: string, run: () => Promise<Skip | void>): Promise<void> {
  if (only !== undefined && only !== number) return;
  const started = performance.now();
  try {
    const outcome = await run();
    if (outcome !== undefined) say(`SKIP ${number} ${name}: ${outcome.skip}`);
    else say(`PASS ${number} ${name} (${Math.round(performance.now() - started)} ms)`);
    results.push({ ok: true });
  } catch (error) {
    say(`FAIL ${number} ${name}: ${error instanceof Error ? error.message : String(error)}`);
    results.push({ ok: false });
  }
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** The error `promise` rejects with; a promise that resolves fails the item. */
async function rejection(promise: Promise<unknown>, what: string): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`${what} rejected with a non-Error value: ${String(error)}`, { cause: error });
  }
  throw new Error(`${what} succeeded, and a refusal was expected`);
}

function refusedWith(error: Error, kind: new (...a: never[]) => Error, message: string, what: string): void {
  check(
    error instanceof kind && error.message === message,
    `${what} ended with ${error.constructor.name} "${error.message}", not ${kind.name} "${message}"`,
  );
}

function connection(service: SparkLiveService, fields: Partial<DatabaseConnection> = {}): DatabaseConnection {
  const target = args.targets[service];
  return {
    id: `live-${service}-${randomUUID()}`,
    name: `live ${service}`,
    type: "spark",
    host: target.host,
    port: target.port,
    createdAt: new Date(),
    ...fields,
  } as DatabaseConnection;
}

/** The token and the given SSL mode, with the fixture's CA pasted for every verifying mode. */
function tls(mode: "require" | "verify-ca" | "verify-full", host?: string, ca?: string): Partial<DatabaseConnection> {
  return {
    ...(host === undefined ? {} : { host }),
    password: args.token,
    ssl: mode === "require" ? { mode } : { mode, caCert: ca ?? readFileSync(path.join(args.tlsDir, "ca.pem"), "utf8") },
  };
}

/** What went over the wire, for the items whose pass condition is a call: heartbeat beats, Interrupts, releases. */
interface WireCounts {
  beats: number;
  interrupts: number;
  releases: number;
  batches: { rowCount: string; chunkIndex: number; chunks: number; bytes: number }[];
}

function recordingTransport(counts: WireCounts): SparkWireTransport {
  return (options) => {
    const channel = grpcWireTransport(options);
    return {
      unary: (rpc, request, call) => {
        if (rpc === "Config" && JSON.stringify(request).includes("spark.sql.ansi.enabled")) counts.beats += 1;
        if (rpc === "Interrupt") counts.interrupts += 1;
        if (rpc === "ReleaseSession") counts.releases += 1;
        return channel.unary(rpc, request, call);
      },
      executePlan: (request, call, limits) => {
        const stream = channel.executePlan(request, call, limits);
        const next = stream.read.bind(stream);
        // Records each arrow_batch's row count, chunk fields and chunk size, then hands the response on unchanged.
        stream.read = async () => {
          const response = (await next()) as { arrow_batch?: Record<string, unknown> | null } | undefined;
          const batch = response?.arrow_batch;
          if (batch !== undefined && batch !== null) {
            const data = batch.data as { length?: number } | undefined;
            counts.batches.push({
              rowCount: String(batch.row_count),
              chunkIndex: Number(batch.chunk_index ?? 0),
              chunks: Number(batch.num_chunks_in_batch ?? 1),
              bytes: data?.length ?? 0,
            });
          }
          return response;
        };
        return stream;
      },
      close: () => channel.close(),
    };
  };
}

function recorded(
  service: SparkLiveService,
  fields: Partial<DatabaseConnection> = {},
  queryTimeout?: number,
): { provider: SparkProvider; counts: WireCounts } {
  const counts: WireCounts = { beats: 0, interrupts: 0, releases: 0, batches: [] };
  const provider = new SparkProvider(connection(service, fields), queryTimeout === undefined ? {} : { queryTimeout }, {
    transport: recordingTransport(counts),
  });
  return { provider, counts };
}

interface DriverJob {
  readonly jobId: number;
  readonly status: string;
  readonly submissionTime?: string;
}

/** Jobs the driver UI's REST API lists as submitted at or after `since` (epoch ms); the fixture runs nothing else. */
async function jobsSince(ui: string, since: number): Promise<DriverJob[]> {
  const apps = (await (await fetch(`${ui}/api/v1/applications`)).json()) as { id: string }[];
  check(apps.length === 1, `the driver UI at ${ui} lists ${apps.length} applications, not 1`);
  const jobs = (await (await fetch(`${ui}/api/v1/applications/${apps[0].id}/jobs`)).json()) as DriverJob[];
  return jobs.filter(
    (job) => job.submissionTime !== undefined && Date.parse(job.submissionTime.replace("GMT", "Z")) >= since,
  );
}

async function settledJob(ui: string, since: number, waitMs: number): Promise<DriverJob | undefined> {
  const end = Date.now() + waitMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a poll: one read of the driver UI at a time.
    const job = (await jobsSince(ui, since)).sort((a, b) => b.jobId - a.jobId)[0];
    if (job !== undefined && job.status !== "RUNNING") return job;
    if (Date.now() > end) return job;
    // oxlint-disable-next-line no-await-in-loop -- a poll interval.
    await sleep(500);
  }
}

/** The "<n> session(s) are online" figure of the driver UI's Connect tab. */
async function onlineSessions(ui: string): Promise<number> {
  const text = (await (await fetch(`${ui}/connect/`)).text()).replace(/<[^>]*>/g, " ");
  const match = /(\d+)\s+session\(s\) are online/.exec(text);
  check(match !== null, `the Connect tab at ${ui} shows no online session count`);
  return Number((match as RegExpExecArray)[1]);
}

/** Reads the online count until it equals `expected` or `waitMs` passes; answers the last figure read. */
async function onlineSessionsSettled(ui: string, expected: number, waitMs: number): Promise<number> {
  const end = Date.now() + waitMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a poll: one read of the driver UI at a time.
    const count = await onlineSessions(ui);
    if (count === expected || Date.now() > end) return count;
    // oxlint-disable-next-line no-await-in-loop -- a poll interval.
    await sleep(500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withProvider<T>(provider: DatabaseProvider, run: (p: DatabaseProvider) => Promise<T>): Promise<T> {
  await provider.connect();
  try {
    return await run(provider);
  } finally {
    await provider.disconnect();
  }
}

/** Runs the sample statements in one request scope and ends it: the standalone server's catalog lives in memory. */
async function loadSamples(p: DatabaseProvider): Promise<void> {
  const scope = `samples-${randomUUID()}`;
  try {
    for (const sql of SPARK_SAMPLE_STATEMENTS) {
      // oxlint-disable-next-line no-await-in-loop -- in order, in one session, as a script runs.
      await p.query(sql, undefined, undefined, scope);
    }
  } finally {
    await p.endOpenQueryTransaction?.(scope);
  }
}

/** Every node of a plan tree, the root included. */
function nodeCount(node: ExplainTreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + nodeCount(child), 0);
}

/** Each batch of the recorded stream, from its first chunk: its row count, chunk count and largest chunk. */
function batchesOf(counts: WireCounts): string {
  const batches = counts.batches.filter((batch) => batch.chunkIndex === 0);
  const rows = [...new Set(batches.map((batch) => batch.rowCount))].join("/");
  const chunks = [...new Set(batches.map((batch) => batch.chunks))].join("/");
  const largest = Math.max(0, ...counts.batches.map((batch) => batch.bytes));
  return `${batches.length} batches, rows per batch ${rows}, chunks per batch ${chunks}, largest chunk ${largest} bytes`;
}

/** A cell as text for a comparison: a Buffer as hex, NaN and the infinities as their names. */
function cellText(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (Buffer.isBuffer(inner)) return inner.toString("hex");
    if (inner !== null && typeof inner === "object" && (inner as { type?: unknown }).type === "Buffer") {
      return Buffer.from((inner as { data: number[] }).data).toString("hex");
    }
    if (typeof inner === "number" && !Number.isFinite(inner)) return String(inner);
    return inner;
  });
}

const VERSIONS = [
  ["spark", "4.2."],
  ["spark-4-1", "4.1."],
] as const;

await item(1, "connect on 4.2.0 and 4.1.3, version read and the tokenless caution", async () => {
  for (const [service, prefix] of VERSIONS) {
    // oxlint-disable-next-line no-await-in-loop -- one version after the other.
    const provider = await createDatabaseProvider(connection(service));
    // oxlint-disable-next-line no-await-in-loop -- one version after the other.
    await withProvider(provider, async (p) => {
      const overview = await p.getOverview();
      check(overview.version.includes(prefix), `${service} reports ${overview.version}, not ${prefix}x`);
      const target = args.targets[service];
      check(
        JSON.stringify(p.connectWarnings?.() ?? []) ===
          JSON.stringify([{ message: SPARK_ERROR_SENTENCES.tokenlessCaution(target.host, target.port) }]),
        `${service} did not give exactly the tokenless caution: ${JSON.stringify(p.connectWarnings?.() ?? [])}`,
      );
    });
  }
});

await item(2, "the token outcomes on spark-auth", async () => {
  const none = await createDatabaseProvider(connection("spark-auth"));
  refusedWith(
    await rejection(none.connect(), "a connect without a token"),
    AuthenticationError,
    SPARK_ERROR_SENTENCES.tokenMissing,
    "a connect without a token",
  );
  await none.disconnect();
  const wrong = await createDatabaseProvider(connection("spark-auth", { password: `x${args.token}` }));
  refusedWith(
    await rejection(wrong.connect(), "a connect with a wrong token"),
    AuthenticationError,
    SPARK_ERROR_SENTENCES.tokenWrong,
    "a connect with a wrong token",
  );
  await wrong.disconnect();
  const right = await createDatabaseProvider(connection("spark-auth", { password: args.token }));
  await withProvider(right, async (p) => {
    check(JSON.stringify(p.connectWarnings?.() ?? []) === "[]", "the token connection gave a connect warning");
    const one = await p.query("SELECT 1");
    check(one.rows.length === 1, `SELECT 1 answered ${one.rows.length} rows`);
  });
});

await item(
  3,
  "TLS through spark-tls: the four modes, an untrusted CA, and plaintext against TLS both ways",
  async () => {
    const tlsTarget = args.targets["spark-tls"];
    const plain = args.targets.spark;
    for (const [mode, host] of [
      ["verify-full", "localhost"],
      ["verify-full", "127.0.0.1"],
      ["verify-ca", "localhost"],
      ["require", undefined],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one mode after the other.
      const provider = await createDatabaseProvider(connection("spark-tls", tls(mode, host)));
      // oxlint-disable-next-line no-await-in-loop -- one mode after the other.
      await withProvider(provider, async (p) => {
        const one = await p.query("SELECT 1");
        check(one.rows.length === 1, `${mode} to ${host ?? tlsTarget.host}: SELECT 1 answered ${one.rows.length} rows`);
      });
    }
    const other = mkdtempSync(path.join(tmpdir(), "spark-live-ca-"));
    try {
      execFileSync(path.resolve("docker/spark/make-certs.sh"), [other], { stdio: "ignore" });
      const untrusted = await createDatabaseProvider(
        connection("spark-tls", tls("verify-full", "localhost", readFileSync(path.join(other, "ca.pem"), "utf8"))),
      );
      refusedWith(
        await rejection(untrusted.connect(), "verify-full with another CA"),
        ConnectionError,
        SPARK_ERROR_SENTENCES.tlsUntrusted,
        "verify-full with another CA",
      );
      await untrusted.disconnect();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    const disabled = await createDatabaseProvider(
      connection("spark-tls", { password: args.token, ssl: { mode: "disable" } }),
    );
    refusedWith(
      await rejection(disabled.connect(), "SSL mode disable to the TLS port"),
      ConnectionError,
      SPARK_ERROR_SENTENCES.tlsPortExpected(tlsTarget.host, tlsTarget.port),
      "SSL mode disable to the TLS port",
    );
    await disabled.disconnect();
    const toPlain = await createDatabaseProvider(connection("spark", { ssl: { mode: "require" } }));
    refusedWith(
      await rejection(toPlain.connect(), "TLS to the plaintext port"),
      ConnectionError,
      SPARK_ERROR_SENTENCES.tlsPlaintextServer(plain.host, plain.port),
      "TLS to the plaintext port",
    );
    await toPlain.disconnect();
    if (!underBun) return;
    // The same item under Node: this file bundled for Node, run with --only 3 in a child that inherits the variables.
    const dir = mkdtempSync(path.join(tmpdir(), "spark-live-node-"));
    try {
      // At tests/live/ below the temporary directory, as in the repository: tests/helpers/spark-live.ts takes the
      // directory two levels above this file for the repository root, and SPARK_TLS_DIR must lie outside it.
      const bundle = path.join(dir, "tests", "live", "live-node.mjs");
      // The factory's lazy imports reach every provider, and three of their native or optional packages cannot be
      // bundled; a Spark run never loads them.
      const externals = ["@duckdb/*", "cpu-features", "proper-lockfile"].flatMap((name) => ["--external", name]);
      execFileSync(
        process.execPath,
        ["build", "tests/live/spark-live-check.ts", "--target", "node", "--outfile", bundle, ...externals],
        { stdio: "ignore" },
      );
      let output: string;
      try {
        output = execFileSync("node", [bundle, "--only", "3"], { encoding: "utf8", timeout: 120_000 });
      } catch (error) {
        output = String((error as { stdout?: unknown }).stdout ?? error);
      }
      const line = output.split("\n").find((text) => /^(PASS|FAIL|SKIP) 3 /.test(text)) ?? "no item 3 line";
      check(line.startsWith("PASS 3 "), `under Node: ${maskSparkLive(line, secrets)}`);
      say(`  item 3 under Node: ${maskSparkLive(line, secrets)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await item(4, "the sample objects and the tree", async () => {
  const provider = await createDatabaseProvider(connection("spark"));
  await withProvider(provider, async (p) => {
    await loadSamples(p);
    const catalogs = await p.listContainers([]);
    const sessionCatalog = catalogs.find((container) => container.name === "spark_catalog");
    check(sessionCatalog?.isSessionDefault === true, "spark_catalog is not listed as the session default");
    check(
      catalogs.some((container) => container.name === "studio_unloaded"),
      `the configured studio_unloaded catalog is missing from ${catalogs.map((c) => c.name).join(", ")}`,
    );
    const namespaces = (await p.listContainers(["spark_catalog"])).map((container) => container.name);
    check(
      namespaces.includes("default") && namespaces.includes("studio"),
      `spark_catalog lists ${namespaces.join(", ")}`,
    );
    const counts = await p.countObjects(["spark_catalog", "studio"]);
    const count = (kind: string) => {
      const entry = counts[kind];
      return entry !== undefined && "count" in entry ? entry.count : undefined;
    };
    check(
      count("table") === 2 && count("view") === 1 && count("function") === 1,
      `spark_catalog.studio counts ${JSON.stringify(counts)}, not 2 tables, 1 view and 1 function`,
    );
    const table = await p.describeObject(["spark_catalog", "studio", "every_type"], "table");
    const types = Object.fromEntries(table.columns.map((column) => [column.name, column.type]));
    check(
      types.c_decimal === "decimal(10,2)" && types.c_map_nested_key === "map<array<int>,string>",
      `every_type's columns read ${JSON.stringify(types)}`,
    );
    for (const [name, kind] of [
      ["every_type", "table"],
      ["every_type_view", "view"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one definition after the other.
      const part = (await p.readObjectSource?.(["spark_catalog", "studio", name], kind))?.parts[0];
      const text = part !== undefined && "text" in part ? part.text : undefined;
      check(text?.includes("CREATE") === true, `the definition of ${name} reads ${JSON.stringify(part)}`);
    }
    const wide = await p.describeObject(["spark_catalog", "studio", "wide_struct"], "table");
    const struct = wide.columns.find((column) => column.name === "s")?.type ?? "";
    check(
      struct.includes("f1:int") && struct.includes("f30:int") && !struct.includes("more fields"),
      `wide_struct.s reads ${struct}`,
    );
    await p.query("CREATE DATABASE IF NOT EXISTS spark_catalog.studio_unloaded");
  });
  const scoped = await createDatabaseProvider(
    connection("spark", { database: "spark_catalog", schema: "studio_unloaded" }),
  );
  await withProvider(scoped, async (p) => {
    const answer = await p.query("SHOW CURRENT NAMESPACE");
    say(
      `  namespace setup: Catalog spark_catalog and Namespace studio_unloaded answer SHOW CURRENT NAMESPACE with ${JSON.stringify(answer.rows)}`,
    );
    check(
      answer.rows.length === 1 &&
        answer.rows[0].catalog === "spark_catalog" &&
        answer.rows[0].namespace === "studio_unloaded",
      `SHOW CURRENT NAMESPACE answered ${JSON.stringify(answer.rows)}`,
    );
  });
});

await item(5, "queries, the row and byte budgets, chunks and intervals on both versions", async () => {
  for (const [service] of VERSIONS) {
    const { provider, counts } = recorded(service);
    // oxlint-disable-next-line no-await-in-loop -- one version after the other.
    await withProvider(provider, async (p) => {
      await loadSamples(p);
      const everyType = await p.query(SPARK_EVERY_TYPE_SELECT);
      check(
        everyType.fields.length === 34,
        `${service}: the every-type select answered ${everyType.fields.length} columns`,
      );
      JSON.stringify(everyType.rows);
      const tables = await p.query("SHOW TABLES IN spark_catalog.studio");
      check(tables.rows.length > 0, `${service}: SHOW TABLES IN spark_catalog.studio answered no rows`);
      const prepared = p.prepareQuery("SELECT * FROM spark_catalog.studio.every_type").query;
      check(/LIMIT 500\s*$/.test(prepared), `${service}: the prepared query reads ${prepared}`);

      const budget = async (sql: string, rows: number, warning: string, label: string): Promise<QueryResult> => {
        counts.interrupts = 0;
        counts.batches = [];
        const result = await p.query(sql);
        const warnings = (result.warnings ?? []).map((entry) => entry.message);
        say(
          `  chunks ${service} ${label}: ${batchesOf(counts)}; ${result.rows.length} rows kept; cut ${JSON.stringify(warnings)}; Interrupts ${counts.interrupts}`,
        );
        check(result.rows.length === rows, `${service} ${label}: kept ${result.rows.length} rows, not ${rows}`);
        check(
          warnings.length === 1 && warnings[0] === warning,
          `${service} ${label}: warnings ${JSON.stringify(warnings)}`,
        );
        check(counts.interrupts === 1, `${service} ${label}: ${counts.interrupts} Interrupts, not 1`);
        return result;
      };
      const rowCut = await budget(
        "FROM range(0, 200000, 1, 1) SELECT id, repeat('x', 100) AS v",
        100_000,
        SPARK_CUT_WARNINGS.rows,
        "row budget",
      );
      check(rowCut.pagination?.wasLimited === true, `${service}: the row cut is not marked wasLimited`);
      await budget(
        "FROM range(0, 100, 1, 1) SELECT repeat('x', 262144) AS v",
        63,
        SPARK_CUT_WARNINGS.bytes,
        "byte budget",
      );
      const largest = Math.max(...counts.batches.map((batch) => batch.bytes));
      check(largest <= 4_194_304, `${service}: a chunk of ${largest} bytes is above 4 MiB`);
      check(
        counts.batches.some((batch) => batch.chunkIndex === 0 && batch.chunks === 7),
        `${service}: no batch was read in 7 chunks (${batchesOf(counts)})`,
      );

      const intervals = await p.query(
        "SELECT INTERVAL '-3-7' YEAR TO MONTH AS ym, CAST(INTERVAL '-3-7' YEAR TO MONTH AS STRING) AS ym_text, INTERVAL '-1 02:03:04.5' DAY TO SECOND AS dt, CAST(INTERVAL '-1 02:03:04.5' DAY TO SECOND AS STRING) AS dt_text",
      );
      const row = intervals.rows[0] ?? {};
      say(`  intervals ${service}: ${JSON.stringify(row)}`);
      check(
        intervals.rows.length === 1 && row.ym === row.ym_text && row.dt === row.dt_text,
        `${service}: the interval texts differ from Spark's: ${JSON.stringify(row)}`,
      );
    });
  }
});

await item(6, "a write: create, insert, select, alter column type, drop", async () => {
  const provider = await createDatabaseProvider(connection("spark"));
  await withProvider(provider, async (p) => {
    const table = "spark_catalog.studio.live_write";
    try {
      await p.query(`CREATE TABLE ${table} (id INT, v STRING) USING parquet`);
      await p.query(`INSERT INTO ${table} VALUES (1, 'a'), (2, 'b')`);
      const rows = await p.query(`SELECT * FROM ${table}`);
      check(rows.rows.length === 2, `the table answered ${rows.rows.length} rows, not 2`);
      try {
        const altered = await p.query(`ALTER TABLE ${table} ALTER COLUMN v TYPE INT`);
        say(`  column type change: ALTER COLUMN v TYPE INT answered ${JSON.stringify(altered.rows)}`);
      } catch (error) {
        say(
          `  column type change: ALTER COLUMN v TYPE INT failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      await p.query(`DROP TABLE IF EXISTS ${table}`);
    }
  });
});

await item(7, "errors: syntax, a missing table, a refused path with its cause, maxResultSize", async () => {
  const provider = await createDatabaseProvider(connection("spark"));
  await withProvider(provider, async (p) => {
    const syntax = await rejection(p.query("SELEC 1"), "a syntax error");
    check(syntax instanceof QueryError, `a syntax error ended with ${syntax.constructor.name}`);
    const missing = await rejection(p.query("SELECT * FROM spark_catalog.studio.no_such_table"), "a missing table");
    check(
      missing instanceof QueryError && missing.message.includes("no_such_table"),
      `a missing table ended with ${missing.constructor.name} "${missing.message}"`,
    );
    const denied = await rejection(p.query("SELECT * FROM parquet.`file:///root`"), "a refused path");
    check(
      denied instanceof QueryError && denied.message.includes("Cause:") && denied.message.includes("Permission denied"),
      `a refused path ended with ${denied.constructor.name} "${denied.message}"`,
    );
  });
  const auth = await createDatabaseProvider(connection("spark-auth", { password: args.token }));
  await withProvider(auth, async (p) => {
    const tooLarge = await rejection(
      p.query("FROM range(0, 20000, 1, 4) SELECT repeat('x', 1000) AS v"),
      "a result above maxResultSize",
    );
    check(
      tooLarge instanceof QueryError && tooLarge.message.includes(SPARK_ERROR_SENTENCES.maxResultSize),
      `a result above maxResultSize ended with ${tooLarge.constructor.name} "${tooLarge.message}"`,
    );
  });
});

await item(8, "Explain plans a tree and runs no job", async () => {
  const provider = await createDatabaseProvider(connection("spark"));
  await withProvider(provider, async (p) => {
    const since = Date.now();
    const result = await p.query("EXPLAIN FORMATTED SELECT * FROM spark_catalog.studio.every_type WHERE 1 = 1");
    check(result.rows.length === 1, `EXPLAIN answered ${result.rows.length} rows, not 1`);
    const model = sparkTextStrategy.toRenderModel(sparkTextStrategy.extractPlan(result));
    check(model?.kind === "tree", "the plan did not read as a tree");
    const nodes = model?.kind === "tree" ? nodeCount(model.root) : 0;
    check(nodes >= 1, "the plan tree has no node");
    await sleep(1_000);
    const jobs = await jobsSince(args.driverUi.spark, since);
    check(jobs.length === 0, `Explain ran ${jobs.length} jobs: ${JSON.stringify(jobs)}`);
  });
});

await item(9, "the monitoring panels", async () => {
  const provider = await createDatabaseProvider(connection("spark"));
  await withProvider(provider, async (p) => {
    const overview = await p.getOverview();
    say(
      `  overview: version ${overview.version}, uptime ${overview.uptime}, ${overview.tableCount} tables (${overview.tableCountSampledFrom ?? "no counted-from line"})`,
    );
    check(overview.version.startsWith("4.2."), `the overview's version is ${overview.version}`);
    check(overview.uptime !== "N/A" && overview.startTime !== undefined, "the overview has no uptime");
    check(Number.isInteger(overview.tableCount), "the overview has no table count");
    const health = await p.getHealth();
    check(health.databaseSize === "N/A" && health.cacheHitRatio === "N/A", `health reads ${JSON.stringify(health)}`);
    check(JSON.stringify(await p.getPerformanceMetrics()) === "{}", "performance metrics are not {}");
    check((await p.getSlowQueries()).length === 0, "slow queries are not empty");
    check((await p.getActiveSessions()).length === 0, "active sessions are not empty");
    check((await p.getIndexStats()).length === 0, "index stats are not empty");
    const labels = p.getLabels();
    check(
      labels.slowQueriesEmptyState === SPARK_MONITORING_LABELS.slowQueriesEmptyState &&
        labels.sessionsEmptyState === SPARK_MONITORING_LABELS.sessionsEmptyState,
      "the empty-state labels are not the provider's",
    );
    refusedWith(
      await rejection(p.getTableStats(), "the tables panel"),
      QueryError,
      SPARK_MONITORING_LABELS.tablesRefused,
      "the tables panel",
    );
    refusedWith(
      await rejection(p.getStorageStats(), "the storage panel"),
      QueryError,
      SPARK_MONITORING_LABELS.storageRefused,
      "the storage panel",
    );
  });
});

await item(10, "maintenance is refused", async () => {
  const provider = await createDatabaseProvider(connection("spark"));
  await withProvider(provider, async (p) => {
    refusedWith(
      await rejection(p.runMaintenance("analyze"), "runMaintenance"),
      QueryError,
      SPARK_PROVIDER_SENTENCES.maintenanceRefused,
      "runMaintenance",
    );
  });
});

await item(11, "cancel: one Interrupt, the query cancelled, the job failed", async () => {
  const { provider, counts } = recorded("spark", {}, LONG_TIMEOUT_MS);
  await withProvider(provider, async (p) => {
    const queryId = `live-cancel-${randomUUID()}`;
    const sent = Date.now();
    const running = rejection(p.query(LONG_STATEMENT, undefined, queryId), "the cancelled query");
    await sleep(3_000);
    const answered = await provider.cancelQuery(queryId);
    check(answered === true, `cancelQuery answered ${String(answered)}`);
    const error = await running;
    check(error instanceof QueryCancelledError, `the query ended with ${error.constructor.name} "${error.message}"`);
    check(counts.interrupts === 1, `${counts.interrupts} Interrupts, not 1`);
    const job = await settledJob(args.driverUi.spark, sent, 10_000);
    check(job?.status === "FAILED", `the job's status is ${job?.status ?? "none"}`);
  });
});

await item(12, "the heartbeat through a silent statement, plaintext and through the TLS proxy", async () => {
  for (const [service, fields] of [
    ["spark", {}],
    ["spark-tls", tls("verify-full", "localhost")],
  ] as const) {
    const { provider, counts } = recorded(service, fields, LONG_TIMEOUT_MS);
    // oxlint-disable-next-line no-await-in-loop -- one service after the other.
    await withProvider(provider, async (p) => {
      const scope = `live-heartbeat-${randomUUID()}`;
      try {
        await p.query("SET spark.connect.progress.reportInterval=-1", undefined, undefined, scope);
        const started = performance.now();
        const result = await p.query(LONG_STATEMENT, undefined, undefined, scope);
        const seconds = Math.round((performance.now() - started) / 1_000);
        say(
          `  heartbeat ${service}: the statement ran ${seconds} s, ${counts.beats} beats, ${result.rows.length} rows`,
        );
        check(result.rows.length === 1, `${service}: the statement answered ${result.rows.length} rows`);
        check(counts.beats >= 4, `${service}: ${counts.beats} beats, fewer than 4`);
      } finally {
        await p.endOpenQueryTransaction?.(scope);
      }
    });
  }
});

await item(13, "a request session ends with its scope, and the server lets it go", async () => {
  const { provider, counts } = recorded("spark");
  await withProvider(provider, async (p) => {
    const before = await onlineSessions(args.driverUi.spark);
    const a = `live-scope-a-${randomUUID()}`;
    await p.query("CREATE TEMP VIEW live_tv AS SELECT 1 AS x", undefined, undefined, a);
    const seen = await p.query("SELECT * FROM live_tv", undefined, undefined, a);
    check(seen.rows.length === 1, `scope A's SELECT answered ${seen.rows.length} rows`);
    const during = await onlineSessions(args.driverUi.spark);
    const releases = counts.releases;
    await p.endOpenQueryTransaction?.(a);
    check(counts.releases === releases + 1, `ending scope A sent ${counts.releases - releases} releases, not 1`);
    const after = await onlineSessionsSettled(args.driverUi.spark, before, 5_000);
    say(`  online sessions: ${before} before scope A, ${during} with it, ${after} after its end`);
    check(after === before, `the online count is ${after} after scope A ended, ${before} before it`);
    const b = `live-scope-b-${randomUUID()}`;
    try {
      const missing = await rejection(p.query("SELECT * FROM live_tv", undefined, undefined, b), "scope B's SELECT");
      check(
        missing instanceof QueryError &&
          missing.message.includes("live_tv") &&
          missing.message.includes("cannot be found"),
        `scope B's SELECT ended with ${missing.constructor.name} "${missing.message}"`,
      );
    } finally {
      await p.endOpenQueryTransaction?.(b);
    }
    const end = await onlineSessionsSettled(args.driverUi.spark, before, 5_000);
    check(end === before, `the online count is ${end} after scope B ended, ${before} before scope A`);
  });
});

await item(14, "substitution stays off, a compressed result is refused, the next session is clean", async () => {
  const provider = await createDatabaseProvider(connection("spark"));
  await withProvider(provider, async (p) => {
    const first = `live-subst-${randomUUID()}`;
    try {
      await p.query("SET x=1", undefined, undefined, first);
      const text = await p.query("SELECT '${x}' AS v", undefined, undefined, first);
      check(text.rows[0]?.v === "${x}", `SELECT '\${x}' answered ${JSON.stringify(text.rows)}`);
    } finally {
      await p.endOpenQueryTransaction?.(first);
    }
    const second = `live-codec-${randomUUID()}`;
    try {
      // The SET's own inline answer is already a ZSTD batch, so it is refused as the SELECT after it is; the setting
      // holds in the session all the same.
      refusedWith(
        await rejection(
          p.query("SET spark.sql.execution.arrow.compression.codec=zstd", undefined, undefined, second),
          "the SET of zstd",
        ),
        QueryError,
        SPARK_ERROR_SENTENCES.compressed("zstd"),
        "the SET of zstd",
      );
      refusedWith(
        await rejection(p.query("SELECT 1", undefined, undefined, second), "SELECT 1 under zstd"),
        QueryError,
        SPARK_ERROR_SENTENCES.compressed("zstd"),
        "SELECT 1 under zstd",
      );
    } finally {
      await p.endOpenQueryTransaction?.(second);
    }
    const third = `live-clean-${randomUUID()}`;
    try {
      const one = await p.query("SELECT 1", undefined, undefined, third);
      check(one.rows.length === 1, `the third session's SELECT 1 answered ${one.rows.length} rows`);
    } finally {
      await p.endOpenQueryTransaction?.(third);
    }
  });
});

await item(15, "the SQL INSERT export replays into Spark cell for cell", async () => {
  const provider = await createDatabaseProvider(connection("spark", { database: "spark_catalog", schema: "studio" }));
  await withProvider(provider, async (p) => {
    // (a) The whole every-type result: its one row holds a map keyed by arrays, which has no Spark literal.
    const whole = await p.query(SPARK_EVERY_TYPE_SELECT);
    const wholeFile = buildResultExport("sql-insert", {
      rows: whole.rows,
      fields: whole.fields,
      tabName: "live_export",
      dialect: "spark",
      columnTypes: whole.columnTypes,
    }).content;
    const inserts = wholeFile.split("\n").filter((line) => line.startsWith("INSERT"));
    const skipped = wholeFile.split("\n").filter((line) => line.startsWith("-- Row 1 skipped"));
    say(`  export of the every-type select: ${inserts.length} INSERT statements; ${skipped.join(" ")}`);
    check(inserts.length === 0, `the every-type export holds ${inserts.length} INSERT statements`);
    check(
      skipped.length === 1 && skipped[0].includes("c_map_nested_key"),
      `the every-type export's skipped-row comment reads ${JSON.stringify(skipped)}`,
    );

    // (b) Every stored column but c_map_nested_key, in table order, replayed into a table of the same projection.
    const described = await p.describeObject(["spark_catalog", "studio", "every_type"], "table");
    const columns = described.columns.map((column) => column.name).filter((name) => name !== "c_map_nested_key");
    check(columns.length === 31, `every_type lists ${columns.length} columns besides c_map_nested_key, not 31`);
    const projection = columns.map((name) => `\`${name}\``).join(", ");
    const source = await p.query(`SELECT ${projection} FROM spark_catalog.studio.every_type`);
    const file = buildResultExport("sql-insert", {
      rows: source.rows,
      fields: source.fields,
      tabName: "live_export",
      dialect: "spark",
      columnTypes: source.columnTypes,
    }).content;
    const table = "spark_catalog.studio.live_export";
    try {
      await p.query(`DROP TABLE IF EXISTS ${table}`);
      await p.query(
        `CREATE TABLE ${table} USING parquet AS SELECT ${projection} FROM spark_catalog.studio.every_type WHERE false`,
      );
      let sent = 0;
      for (const { sql } of splitStatements(file, resolveSqlGrammar("spark"))) {
        const statement = sql.replace(/^(?:--[^\n]*\n\s*)+/, "").trim();
        if (statement === "" || statement.startsWith("--")) continue;
        const target = /^INSERT INTO (\S+) /.exec(statement)?.[1];
        check(target === "live_export", `the export wrote a statement whose target is ${target ?? "missing"}`);
        try {
          // oxlint-disable-next-line no-await-in-loop -- one statement at a time, as the file runs.
          await p.query(statement);
        } catch (error) {
          throw new Error(
            `Spark refused the exported INSERT: ${error instanceof Error ? error.message : String(error)}\n${statement}`,
            { cause: error },
          );
        }
        sent += 1;
      }
      check(sent === source.rows.length, `the export sent ${sent} INSERT statements for ${source.rows.length} rows`);
      const replayed = await p.query(`SELECT ${projection} FROM ${table}`);
      check(
        replayed.rows.length === source.rows.length,
        `the copy holds ${replayed.rows.length} rows, the projection ${source.rows.length}`,
      );
      const differing = source.rows.flatMap((row, index) =>
        source.fields.flatMap((field) =>
          cellText(replayed.rows[index]?.[field]) === cellText(row[field])
            ? []
            : [
                `row ${index + 1} ${field}: ${cellText(row[field])} came back as ${cellText(replayed.rows[index]?.[field])}`,
              ],
        ),
      );
      check(differing.length === 0, `the replayed cells differ: ${differing.join("; ")}`);
      say(`  export replay: ${source.rows.length} rows, ${source.rows.length * source.fields.length} cells compared`);
    } finally {
      await p.query(`DROP TABLE IF EXISTS ${table}`);
    }
  });
});

await item(16, "a catalog that nests namespaces", async () => ({
  skip: "no catalog of the open-source fixture nests namespaces; the walk is covered by the BUILT replay case and introspect.test.ts",
}));

await item(17, "releasing a session whose statement still runs, on both versions", async () => {
  const failures: string[] = [];
  for (const [service] of VERSIONS) {
    const ui = args.driverUi[service];
    // oxlint-disable-next-line no-await-in-loop -- one version after the other.
    const provider = await createDatabaseProvider(connection(service), { queryTimeout: LONG_TIMEOUT_MS });
    // oxlint-disable-next-line no-await-in-loop -- one version after the other.
    await provider.connect();
    let running: Promise<string> | undefined;
    try {
      const scope = `live-release-${randomUUID()}`;
      const sent = Date.now();
      running = provider.query(LONG_STATEMENT, undefined, undefined, scope).then(
        (result) => `answered ${result.rows.length} rows`,
        (error: unknown) =>
          `ended with ${error instanceof Error ? `${error.constructor.name} "${error.message}"` : String(error)}`,
      );
      // oxlint-disable-next-line no-await-in-loop -- the statement must be running when its session is released.
      await sleep(3_000);
      // oxlint-disable-next-line no-await-in-loop -- the release, then the job's state.
      await provider.endOpenQueryTransaction?.(scope);
      // oxlint-disable-next-line no-await-in-loop -- the job's state after the release.
      const job = await settledJob(ui, sent, 10_000);
      say(`  release ${service}: the job's status 10 s after the release is ${job?.status ?? "none"}`);
      if (job?.status !== "FAILED") {
        failures.push(
          `${service}: the release did not stop the job (${job?.status ?? "no job"}): only Interrupt stops Spark work`,
        );
      }
    } finally {
      // oxlint-disable-next-line no-await-in-loop -- the disconnect stops whatever still runs.
      await provider.disconnect();
      // oxlint-disable-next-line no-await-in-loop -- the statement's own outcome, once it settled.
      say(`  release ${service}: the statement ${(await running) ?? "was not sent"}`);
    }
  }
  check(failures.length === 0, failures.join("; "));
});

const passed = results.filter((result) => result.ok).length;
say(`${passed} of ${results.length} items passed`);
process.exit(passed === results.length ? 0 : 1);

/**
 * The InfluxDB 3 write-refusal captures: what 3.12.0 Core answers when a write, a DDL statement, a COPY, a SET or a
 * transaction statement is sent raw to `/api/v3/query_sql`, with Studio's read policy out of the way.
 *
 * WHY THIS EXISTS. The `influxdb3` agent read-only profile rests on the engine: the query route carries free statement
 * text, so it is only as strong as what the server does with that text, and the server's own answers are the evidence.
 * Every statement below goes straight to the `influxdb3` service of `database-compose.yml` over `fetch`, with no
 * provider import and no policy check in front, as the admin token, the only token Core mints. Each answer is written
 * as tests/fixtures/influxdb/3.12.0-core/write-refusal/<name>.json in the `InfluxCapture` shape of
 * tests/helpers/influxdb-fixtures.ts, which tests/integration/db/influxdb3-provider.test.ts replays.
 *
 * The run stops, writing nothing, when any statement answers 200, or when the server's state after a statement differs
 * from its state before the run: the databases, every table of each, the row counts of the seeded tables and the
 * tokens all read back the same, and no file a COPY names exists in the container. Two token captures record what a
 * Core token is: the token table lists one token whose permission is `*:*:*`, and the resource-token route of
 * Enterprise is not served (404). Neither request changes anything.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/), with the `influxdb3` service
 * up and seeded (`docker/influxdb/seed.sh`, or its `seed_v3` step alone):
 *   bun tests/live/influxdb3-write-refusals.ts
 */
// oxlint-disable no-await-in-loop -- one statement at a time on purpose: each state read follows the statement before it.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InfluxCapture } from "../helpers/influxdb-fixtures";
import { readFixtureCredentials } from "./influxdb-evidence-checks";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "tests/fixtures/influxdb/3.12.0-core/write-refusal");
const CONTAINER = "libredb-influxdb3";
const ORIGIN = "http://127.0.0.1:8181";
const DATABASE = "home";
/** Where each COPY below would write, inside the container; none may exist after the run. */
const COPY_TARGETS = ["/tmp/libredb-wr-copy.csv", "/tmp/libredb-wr-copy.parquet"];

/** Every statement sent, by capture name: each write and DDL verb DataFusion parses, and each statement form around them. */
const STATEMENTS: readonly (readonly [string, string])[] = [
  ["insert-values", "INSERT INTO home (room, temp, time) VALUES ('Probe', 1.0, now())"],
  ["insert-select", "INSERT INTO home SELECT * FROM home"],
  ["insert-system", "INSERT INTO system.queries SELECT * FROM system.queries"],
  ["create-table", "CREATE TABLE libredb_wr_t (a INT)"],
  ["create-table-as", "CREATE TABLE libredb_wr_t AS SELECT 1 AS a"],
  ["create-external-table", "CREATE EXTERNAL TABLE libredb_wr_x STORED AS CSV LOCATION '/tmp/libredb-wr.csv'"],
  ["create-view", "CREATE VIEW libredb_wr_v AS SELECT 1"],
  ["create-schema", "CREATE SCHEMA libredb_wr_s"],
  ["create-database", "CREATE DATABASE libredb_wr_db"],
  ["create-function", "CREATE FUNCTION libredb_wr_f(INT) RETURNS INT RETURN $1 + 1"],
  ["create-index", "CREATE INDEX libredb_wr_i ON home (room)"],
  ["select-into", "SELECT 1 INTO libredb_wr_into"],
  ["drop-table", "DROP TABLE home"],
  ["drop-view", "DROP VIEW IF EXISTS libredb_wr_v"],
  ["drop-schema", "DROP SCHEMA iox"],
  ["drop-database", "DROP DATABASE home"],
  ["drop-function", "DROP FUNCTION IF EXISTS libredb_wr_f"],
  ["delete", "DELETE FROM home"],
  ["delete-where", "DELETE FROM home WHERE room = 'Kitchen'"],
  ["update", "UPDATE home SET temp = 0"],
  ["truncate", "TRUNCATE TABLE home"],
  ["merge", "MERGE INTO home USING home AS s ON true WHEN MATCHED THEN DELETE"],
  ["copy-table", `COPY home TO '${COPY_TARGETS[0]}'`],
  ["copy-query", `COPY (SELECT 1) TO '${COPY_TARGETS[1]}' STORED AS PARQUET`],
  ["alter-add-column", "ALTER TABLE home ADD COLUMN libredb_wr INT"],
  ["alter-rename", "ALTER TABLE home RENAME TO libredb_wr_home"],
  ["set-variable", "SET datafusion.execution.batch_size = 1"],
  ["set-time-zone", "SET TIME ZONE 'UTC'"],
  ["reset-variable", "RESET datafusion.execution.batch_size"],
  ["prepare", "PREPARE libredb_wr_p AS SELECT 1"],
  ["execute", "EXECUTE libredb_wr_p"],
  ["deallocate", "DEALLOCATE libredb_wr_p"],
  ["begin", "BEGIN"],
  ["start-transaction", "START TRANSACTION"],
  ["commit", "COMMIT"],
  ["rollback", "ROLLBACK"],
  ["vacuum", "VACUUM"],
  ["analyze-table", "ANALYZE TABLE home COMPUTE STATISTICS"],
  ["explain-insert", "EXPLAIN INSERT INTO home (room, temp, time) VALUES ('Probe', 1.0, now())"],
  ["explain-analyze-insert", "EXPLAIN ANALYZE INSERT INTO home (room, temp, time) VALUES ('Probe', 1.0, now())"],
  ["explain-analyze-copy", `EXPLAIN ANALYZE COPY (SELECT 1) TO '${COPY_TARGETS[0]}'`],
  ["with-insert", "WITH x AS (SELECT 1) INSERT INTO home SELECT * FROM home"],
  ["second-statement", "SELECT 1; DROP TABLE home"],
];

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

const IMAGE = docker(["inspect", "--format", "{{.Config.Image}}", CONTAINER]);
if (!/^influxdb:3\.12\.0-core@sha256:[0-9a-f]{64}$/.test(IMAGE)) throw new Error(`${CONTAINER} runs ${IMAGE}`);
const TOKEN = readFixtureCredentials(
  readFileSync(path.join(ROOT, "database-compose.yml"), "utf8"),
  readFileSync(path.join(ROOT, "docker/influxdb/seed.sh"), "utf8"),
).v3AdminToken;
const CAPTURED_AT = new Date().toISOString().slice(0, 10);

interface Sent {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: Record<string, unknown>;
}

async function send(request: Sent): Promise<{ status: number; contentType: string | null; body: string }> {
  const response = await fetch(`${ORIGIN}${request.path}`, {
    method: request.method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(request.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
}

function sqlRequest(q: string, db = DATABASE): Sent {
  return { method: "POST", path: "/api/v3/query_sql", body: { db, q, format: "jsonl" } };
}

/** A read the state check needs; anything but a 200 stops the run. */
async function read(q: string, db = DATABASE): Promise<string> {
  const answer = await send(sqlRequest(q, db));
  if (answer.status !== 200) throw new Error(`state read ${q} on ${db}: ${answer.status} ${answer.body}`);
  return answer.body;
}

/** Everything a write or a DDL statement could change, as one comparable text. */
async function serverState(): Promise<string> {
  const databases = await send({ method: "GET", path: "/api/v3/configure/database?format=json" });
  const names = (JSON.parse(databases.body) as { "iox::database": string }[]).map((row) => row["iox::database"]);
  const parts = [`databases ${names.join(",")}`];
  for (const name of names.filter((db) => db !== "_internal")) {
    parts.push(
      `${name} tables ${await read("SELECT table_schema, table_name FROM information_schema.tables ORDER BY 1, 2", name)}`,
    );
    parts.push(
      `${name} columns ${await read("SELECT table_name, column_name, data_type FROM information_schema.columns ORDER BY 1, 2", name)}`,
    );
  }
  parts.push(`home rows ${await read("SELECT count(*) AS n FROM home")}`);
  parts.push(`edge rows ${await read("SELECT count(*) AS n FROM edge", "edge")}`);
  parts.push(`tokens ${await read("SELECT name, permissions FROM system.tokens ORDER BY name", "_internal")}`);
  parts.push(
    `files ${docker(["exec", CONTAINER, "sh", "-c", `ls ${COPY_TARGETS.join(" ")} /tmp/libredb-wr.csv 2>/dev/null; true`])}`,
  );
  return parts.join("\n");
}

function captureOf(name: string, request: Sent, answer: Awaited<ReturnType<typeof send>>): InfluxCapture {
  const text = JSON.stringify(answer);
  if (text.includes(TOKEN)) throw new Error(`${name}: the answer holds the token; nothing written`);
  const pathOnly = request.path.split("?")[0];
  const query = Object.fromEntries(new URLSearchParams(request.path.split("?")[1] ?? ""));
  return {
    version: "3.12.0-core",
    name: `write-refusal/${name}`,
    image: IMAGE,
    capturedAt: CAPTURED_AT,
    request: {
      method: request.method,
      path: pathOnly,
      query,
      ...(request.body === undefined ? {} : { body: request.body }),
      auth: "bearer",
    },
    status: answer.status,
    contentType: answer.contentType,
    body: answer.body,
  };
}

async function main(): Promise<void> {
  const before = await serverState();
  const captures: InfluxCapture[] = [];
  for (const [name, q] of STATEMENTS) {
    const request = sqlRequest(q);
    const answer = await send(request);
    if (answer.status === 200) throw new Error(`${name}: the server answered 200 to ${q}: ${answer.body}`);
    const after = await serverState();
    if (after !== before) throw new Error(`${name}: the server's state changed after ${q}\n${before}\n---\n${after}`);
    console.log(`refused ${answer.status} ${name}: ${answer.body.slice(0, 100)}`);
    captures.push(captureOf(name, request, answer));
  }

  const tokens = sqlRequest("SELECT name, permissions FROM system.tokens ORDER BY name", "_internal");
  const tokenAnswer = await send(tokens);
  if (tokenAnswer.status !== 200 || tokenAnswer.body !== '{"name":"_admin","permissions":"*:*:*"}\n') {
    throw new Error(`token-permissions: ${tokenAnswer.status} ${tokenAnswer.body}`);
  }
  captures.push(captureOf("token-permissions", tokens, tokenAnswer));
  const resource: Sent = {
    method: "POST",
    path: "/api/v3/enterprise/configure/token",
    body: {
      token_name: "libredb-wr-read",
      permissions: [{ resource_type: "db", resource_identifier: [DATABASE], actions: ["read"] }],
      expiry_secs: 60,
    },
  };
  const resourceAnswer = await send(resource);
  if (resourceAnswer.status !== 404) throw new Error(`token-resource-route: ${resourceAnswer.status}`);
  captures.push(captureOf("token-resource-route", resource, resourceAnswer));
  if ((await serverState()) !== before) throw new Error("the server's state changed after the token captures");

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const capture of captures) {
    writeFileSync(
      path.join(OUT, `${capture.name.slice("write-refusal/".length)}.json`),
      `${JSON.stringify(capture, null, 2)}\n`,
    );
  }
  console.log(
    `${captures.length} captures written to ${path.relative(ROOT, OUT)}; the server's state read back the same`,
  );
}

await main();

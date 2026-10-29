/**
 * The Elasticsearch write-refusal captures: what 9.1.4 answers when a write or a DDL statement is sent raw to `/_sql`,
 * with Studio's admission out of the way.
 *
 * WHY THIS EXISTS. The `elasticsearch` agent read-only profile rests on the engine: the SQL route carries free statement
 * text, so it is only as strong as what the server does with that text, and the server's own answers are the evidence.
 * Every statement below goes straight to the cluster over `fetch`, with no provider import and no check in front, on a
 * node with security disabled, so no privilege stands between the statement and the grammar. Each answer is written as
 * tests/fixtures/elasticsearch/9.1.4/write-refusal/<name>.json, which tests/integration/db/elasticsearch-provider.test.ts
 * replays.
 *
 * The run stops, writing nothing, when any statement answers 200, or when the cluster's state after a statement
 * differs from its state before the run: the index listing with its document counts, every mapping, the aliases, the
 * composable templates and the ingest pipelines all read back the same.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/), against the `elasticsearch`
 * service of `database-compose.yml` seeded per docs/providers/elasticsearch.md section 11.4:
 *   bun tests/live/elasticsearch-write-refusals.ts
 * LIBREDB_ES_ORIGIN and LIBREDB_ES_CONTAINER name another node of the same image.
 */
// oxlint-disable no-await-in-loop -- one statement at a time on purpose: each state read follows the statement before it.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "tests/fixtures/elasticsearch/9.1.4/write-refusal");
const CONTAINER = process.env.LIBREDB_ES_CONTAINER ?? "libredb-elasticsearch";
const ORIGIN = process.env.LIBREDB_ES_ORIGIN ?? "http://127.0.0.1:9200";
const SQL_PATH = "/_sql";
const SQL_QUERY = { format: "json" };

/** Every statement sent, by capture name: each write and DDL verb, and each read keyword a write could hide behind. */
const STATEMENTS: readonly (readonly [string, string])[] = [
  ["insert-values", "INSERT INTO probe_orders (id, customer) VALUES (2, 'probe')"],
  ["insert-select", "INSERT INTO probe_orders SELECT * FROM probe_orders"],
  ["update", "UPDATE probe_orders SET customer = 'x' WHERE id = 1"],
  ["delete", "DELETE FROM probe_orders"],
  ["delete-where", "DELETE FROM probe_orders WHERE id = 1"],
  ["create-table", "CREATE TABLE libredb_wr_t (id BIGINT)"],
  ["create-table-as", "CREATE TABLE libredb_wr_t AS SELECT * FROM probe_orders"],
  ["create-index", "CREATE INDEX libredb_wr_i ON probe_orders (customer)"],
  ["create-view", "CREATE VIEW libredb_wr_v AS SELECT * FROM probe_orders"],
  ["drop-table", "DROP TABLE probe_orders"],
  ["drop-index", "DROP INDEX probe_orders"],
  ["alter-add-column", "ALTER TABLE probe_orders ADD COLUMN libredb_wr INT"],
  ["alter-rename", "ALTER TABLE probe_orders RENAME TO libredb_wr_orders"],
  ["truncate", "TRUNCATE TABLE probe_orders"],
  ["merge", "MERGE INTO probe_orders USING probe_orders AS s ON true WHEN MATCHED THEN DELETE"],
  ["select-into", "SELECT * INTO libredb_wr_into FROM probe_orders"],
  ["explain-insert", "EXPLAIN INSERT INTO probe_orders (id) VALUES (2)"],
  ["debug-delete", "DEBUG DELETE FROM probe_orders"],
  ["with-insert", "WITH x AS (SELECT 1) INSERT INTO probe_orders SELECT * FROM probe_orders"],
  ["second-statement", "SELECT 1; DELETE FROM probe_orders"],
];

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

const IMAGE = docker(["inspect", "--format", "{{.Config.Image}}", CONTAINER]);
if (IMAGE !== "docker.elastic.co/elasticsearch/elasticsearch:9.1.4") throw new Error(`${CONTAINER} runs ${IMAGE}`);
const CAPTURED_AT = new Date().toISOString().slice(0, 10);

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}

async function send(method: "GET" | "POST", pathname: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
}

/** A read the state check needs; anything but a 200 stops the run. */
async function read(pathname: string): Promise<string> {
  const answer = await send("GET", pathname);
  if (answer.status !== 200) throw new Error(`state read ${pathname}: ${answer.status} ${answer.body}`);
  return answer.body;
}

/** Everything a write or a DDL statement could change, as one comparable text. */
async function clusterState(): Promise<string> {
  await send("POST", "/_refresh");
  return [
    `indices ${await read("/_cat/indices?format=json&h=index,docs.count,status&s=index&expand_wildcards=all")}`,
    `mappings ${await read("/_mapping")}`,
    `aliases ${await read("/_cat/aliases?format=json&s=alias")}`,
    `templates ${await read("/_cat/templates?format=json&s=name")}`,
    `pipelines ${Object.keys(JSON.parse(await read("/_ingest/pipeline")) as object)
      .sort()
      .join(",")}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const before = await clusterState();
  if (!before.includes('"probe_orders"')) throw new Error("probe_orders is not seeded; see section 11.4 of the doc");
  const captures: Record<string, unknown>[] = [];
  for (const [name, query] of STATEMENTS) {
    const answer = await send("POST", `${SQL_PATH}?format=json`, { query });
    if (answer.status === 200) throw new Error(`${name}: the cluster answered 200 to ${query}: ${answer.body}`);
    const after = await clusterState();
    if (after !== before)
      throw new Error(`${name}: the cluster's state changed after ${query}\n${before}\n---\n${after}`);
    console.log(`refused ${answer.status} ${name}: ${answer.body.slice(0, 100)}`);
    captures.push({
      version: "9.1.4",
      name: `write-refusal/${name}`,
      image: IMAGE,
      capturedAt: CAPTURED_AT,
      request: { method: "POST", path: SQL_PATH, query: SQL_QUERY, body: { query }, auth: "none" },
      status: answer.status,
      contentType: answer.contentType,
      body: answer.body,
    });
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const capture of captures) {
    const name = (capture.name as string).slice("write-refusal/".length);
    writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(capture, null, 2)}\n`);
  }
  console.log(`${captures.length} captures written to ${path.relative(ROOT, OUT)}; the cluster read back the same`);
}

await main();

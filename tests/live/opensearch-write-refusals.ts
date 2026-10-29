/**
 * The OpenSearch write-refusal captures: what a node answers when a write or a DDL statement is sent raw to its SQL
 * route, with Studio's admission out of the way, and what it answers a DELETE with the plugin's delete setting off and
 * on.
 *
 * WHY THIS EXISTS. The `opensearch` agent read-only profile rests on the engine: the SQL route carries free statement
 * text, so it is only as strong as what the server does with that text, and the server's own answers are the evidence.
 * Every statement below goes straight to the cluster over `fetch`, with no provider import and no check in front, on a
 * node with security disabled, so no privilege stands between the statement and the SQL plugin. Each answer is written
 * as tests/fixtures/opensearch/<version>/write-refusal/<name>.json, which
 * tests/integration/db/opensearch-provider.test.ts replays. A version that still serves the plugin's older route,
 * `/_opendistro/_sql`, has each statement sent there too, and that answer is kept beside the first.
 *
 * The run stops, writing nothing, when a write answers 200, or when the cluster's state after a statement differs
 * from its state before the run: the index listing with its document counts, every mapping, the aliases and the
 * templates read back the same. Indices the node writes on its own while it serves queries (a leading `.`, and the
 * query-insights `top_queries-` indices) are left out of the comparison, since every statement adds to them.
 *
 * The delete-setting phase then turns `plugins.sql.delete.enabled` on, captures the answer, and sends a DELETE on a
 * name no index holds and on a scratch index it seeded; it resets the setting and removes the scratch index whatever
 * happened. On a version where the setting is not recognized, the refusal of the setting write is the capture.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/), against a single node of the
 * `opensearch` image seeded per docs/providers/opensearch.md section 11.4:
 *   LIBREDB_OS_ORIGIN=http://127.0.0.1:9201 LIBREDB_OS_CONTAINER=libredb-opensearch bun tests/live/opensearch-write-refusals.ts
 */
// oxlint-disable no-await-in-loop -- one statement at a time on purpose: each state read follows the statement before it.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CONTAINER = process.env.LIBREDB_OS_CONTAINER ?? "libredb-opensearch";
const ORIGIN = process.env.LIBREDB_OS_ORIGIN ?? "http://127.0.0.1:9201";
const SQL_PATH = "/_plugins/_sql";
const LEGACY_SQL_PATH = "/_opendistro/_sql";
const DELETE_SETTING = "plugins.sql.delete.enabled";
const SCRATCH_INDEX = "libredb_wr_scratch";
const MISSING_INDEX = "libredb_wr_no_such_index";

/**
 * Every statement sent, by capture name: each write and DDL verb, each read keyword a write could hide behind, and a
 * second statement after `;`. `read` marks a form the plugin answers as a plain read (`SELECT ... INTO`, and a catalog
 * command with a second statement behind it): it must answer 200, and the cluster must read back the same, exactly as
 * for a refusal.
 */
const STATEMENTS: readonly (readonly [string, string, "refused" | "read"])[] = [
  ["insert-values", "INSERT INTO probe_orders (id, customer) VALUES (2, 'probe')", "refused"],
  ["insert-select", "INSERT INTO probe_orders SELECT * FROM probe_orders", "refused"],
  ["update", "UPDATE probe_orders SET customer = 'x' WHERE id = 1", "refused"],
  ["delete", "DELETE FROM probe_orders", "refused"],
  ["delete-where", "DELETE FROM probe_orders WHERE id = 1", "refused"],
  ["create-table", "CREATE TABLE libredb_wr_t (id BIGINT)", "refused"],
  ["create-table-as", "CREATE TABLE libredb_wr_t AS SELECT * FROM probe_orders", "refused"],
  ["create-index", "CREATE INDEX libredb_wr_i ON probe_orders (customer)", "refused"],
  ["create-view", "CREATE VIEW libredb_wr_v AS SELECT * FROM probe_orders", "refused"],
  ["drop-table", "DROP TABLE probe_orders", "refused"],
  ["drop-index", "DROP INDEX probe_orders", "refused"],
  ["alter-add-column", "ALTER TABLE probe_orders ADD COLUMN libredb_wr INT", "refused"],
  ["alter-rename", "ALTER TABLE probe_orders RENAME TO libredb_wr_orders", "refused"],
  ["truncate", "TRUNCATE TABLE probe_orders", "refused"],
  ["merge", "MERGE INTO probe_orders USING probe_orders AS s ON true WHEN MATCHED THEN DELETE", "refused"],
  ["explain-delete", "EXPLAIN DELETE FROM probe_orders", "refused"],
  ["with-delete", "WITH x AS (SELECT 1) DELETE FROM probe_orders", "refused"],
  ["second-statement", "SELECT 1; DELETE FROM probe_orders", "refused"],
  ["second-statement-select", "SELECT * FROM probe_orders; DELETE FROM probe_orders", "refused"],
  ["select-into", "SELECT * INTO libredb_wr_into FROM probe_orders", "read"],
  ["describe-second-statement", "DESCRIBE TABLES LIKE 'probe_orders'; DELETE FROM probe_orders", "read"],
  ["show-second-statement", "SHOW TABLES LIKE 'probe_orders'; DELETE FROM probe_orders", "read"],
];

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

const IMAGE = docker(["inspect", "--format", "{{.Config.Image}}", CONTAINER]);
const VERSION = /^opensearchproject\/opensearch:(\d+\.\d+\.\d+)$/.exec(IMAGE)?.[1];
if (VERSION === undefined) throw new Error(`${CONTAINER} runs ${IMAGE}, not a pinned opensearchproject/opensearch`);
const OUT = path.join(ROOT, `tests/fixtures/opensearch/${VERSION}`);
const CAPTURED_AT = new Date().toISOString().slice(0, 10);

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}

async function send(method: "GET" | "POST" | "PUT" | "DELETE", pathname: string, body?: unknown): Promise<Answer> {
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

/** Whether an index is one the node writes on its own while it serves queries. */
function bookkeeping(index: string): boolean {
  return index.startsWith(".") || index.startsWith("top_queries-");
}

/** Everything a write or a DDL statement could change, as one comparable text. */
async function clusterState(): Promise<string> {
  await send("POST", "/_refresh");
  const indices = (
    JSON.parse(await read("/_cat/indices?format=json&h=index,docs.count,status&s=index&expand_wildcards=all")) as {
      index: string;
    }[]
  ).filter((row) => !bookkeeping(row.index));
  const mappings = Object.entries(JSON.parse(await read("/_mapping")) as Record<string, unknown>)
    .filter(([index]) => !bookkeeping(index))
    .sort(([a], [b]) => a.localeCompare(b));
  return [
    `indices ${JSON.stringify(indices)}`,
    `mappings ${JSON.stringify(mappings)}`,
    `aliases ${await read("/_cat/aliases?format=json&s=alias")}`,
    `templates ${await read("/_cat/templates?format=json&s=name")}`,
  ].join("\n");
}

function capture(name: string, pathname: string, body: unknown, answer: Answer, extra: Record<string, unknown> = {}) {
  return {
    version: VERSION,
    name,
    image: IMAGE,
    capturedAt: CAPTURED_AT,
    request: { method: "POST", path: pathname, body, auth: "none" },
    status: answer.status,
    contentType: answer.contentType,
    body: answer.body,
    ...extra,
  };
}

async function main(): Promise<void> {
  const before = await clusterState();
  if (!before.includes('"probe_orders"')) throw new Error("probe_orders is not seeded; see section 11.4 of the doc");
  const legacyProbe = await send("POST", LEGACY_SQL_PATH, { query: "SELECT 1" });
  const legacyServed = legacyProbe.status === 200;
  console.log(`${LEGACY_SQL_PATH} ${legacyServed ? "is served" : `is not served (${legacyProbe.status})`}`);

  const writes: Record<string, unknown>[] = [];
  for (const [name, query, expected] of STATEMENTS) {
    const answer = await send("POST", SQL_PATH, { query });
    if (expected === "refused" && answer.status === 200) {
      throw new Error(`${name}: the cluster answered 200 to ${query}: ${answer.body}`);
    }
    if (expected === "read" && answer.status !== 200) {
      throw new Error(`${name}: expected a read, the cluster answered ${answer.status} to ${query}: ${answer.body}`);
    }
    let legacy: Answer | undefined;
    if (legacyServed) {
      legacy = await send("POST", LEGACY_SQL_PATH, { query });
      if (legacy.status !== answer.status || legacy.body !== answer.body) {
        throw new Error(`${name}: ${LEGACY_SQL_PATH} answered differently: ${legacy.status} ${legacy.body}`);
      }
    }
    const after = await clusterState();
    if (after !== before) {
      throw new Error(`${name}: the cluster's state changed after ${query}\n${before}\n---\n${after}`);
    }
    console.log(`${expected === "read" ? "read" : "refused"} ${answer.status} ${name}: ${answer.body.slice(0, 120)}`);
    writes.push(
      capture(`write-refusal/${name}`, SQL_PATH, { query }, answer, {
        legacyRoute: legacyServed
          ? { path: LEGACY_SQL_PATH, sameAnswer: true }
          : { path: LEGACY_SQL_PATH, status: legacyProbe.status, body: legacyProbe.body },
      }),
    );
  }

  // The delete setting: read it, turn it on, and send a DELETE on a name no index holds and on a scratch index.
  const settings: Record<string, unknown>[] = [];
  const settingsPath = `/_cluster/settings?include_defaults=true&filter_path=*.${DELETE_SETTING}`;
  const readSetting = async (name: string) => {
    const answer = await send("GET", settingsPath);
    settings.push({
      ...capture(name, settingsPath, undefined, answer),
      request: { method: "GET", path: settingsPath },
    });
  };
  const deleteOn = async (name: string, index: string) => {
    const query = `DELETE FROM ${index}`;
    settings.push(capture(name, SQL_PATH, { query }, await send("POST", SQL_PATH, { query })));
  };
  await send("POST", `/${SCRATCH_INDEX}/_doc?refresh=true`, { id: 7 });
  try {
    await readSetting("delete-setting/setting-default");
    await deleteOn("delete-setting/missing-index-setting-off", MISSING_INDEX);
    await deleteOn("delete-setting/scratch-index-setting-off", SCRATCH_INDEX);
    const turnOn = await send("PUT", "/_cluster/settings", { transient: { [DELETE_SETTING]: true } });
    settings.push({
      ...capture("delete-setting/setting-on-write", "/_cluster/settings", undefined, turnOn),
      request: { method: "PUT", path: "/_cluster/settings", body: { transient: { [DELETE_SETTING]: true } } },
    });
    await readSetting("delete-setting/setting-after-on-write");
    await deleteOn("delete-setting/missing-index-setting-on", MISSING_INDEX);
    await deleteOn("delete-setting/scratch-index-setting-on", SCRATCH_INDEX);
    await send("POST", `/${SCRATCH_INDEX}/_refresh`);
    const left = await send("GET", `/_cat/indices/${SCRATCH_INDEX}?format=json&h=index,docs.count`);
    settings.push({
      ...capture("delete-setting/scratch-index-after", `/_cat/indices/${SCRATCH_INDEX}`, undefined, left),
      request: { method: "GET", path: `/_cat/indices/${SCRATCH_INDEX}?format=json&h=index,docs.count` },
    });
  } finally {
    await send("PUT", "/_cluster/settings", { transient: { [DELETE_SETTING]: null } });
    await send("DELETE", `/${SCRATCH_INDEX}`);
  }
  for (const entry of settings) console.log(`${entry.name as string}: ${entry.status as number}`);
  if ((await clusterState()) !== before) throw new Error("the cluster's state differs after the delete-setting phase");

  for (const [dir, entries] of [
    ["write-refusal", writes],
    ["delete-setting", settings],
  ] as const) {
    rmSync(path.join(OUT, dir), { recursive: true, force: true });
    mkdirSync(path.join(OUT, dir), { recursive: true });
    for (const entry of entries) {
      writeFileSync(path.join(OUT, `${entry.name as string}.json`), `${JSON.stringify(entry, null, 2)}\n`);
    }
  }
  console.log(`${writes.length + settings.length} captures written to ${path.relative(ROOT, OUT)}`);
}

await main();

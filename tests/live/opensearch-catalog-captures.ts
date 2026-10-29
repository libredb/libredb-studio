/**
 * The OpenSearch catalog-read captures: what 3.8.0 answers each statement the agent's catalog read composes.
 *
 * WHY THIS EXISTS. OpenSearch SQL answers its catalog only to commands, and the agent's catalog read maps the
 * command's answer into the column inventory. Whether the mapper reads the right cells is the engine's answer to say,
 * so each statement below is composed by the overlay itself (`composeCatalogRead`), sent straight to the cluster over
 * `fetch` with the body the provider's bounded read sends, and the answer is written as
 * tests/fixtures/opensearch/3.8.0/catalog-read/<name>.json, which tests/unit/lib/agent/opensearch-catalog-read.test.ts
 * drives the mapper from and tests/integration/db/opensearch-provider.test.ts replays through `queryReadOnly`.
 *
 * The run stops, writing nothing, when a statement answers other than its expected status or leaves a cursor open, or
 * when the cluster's state after the run differs from its state before it. A name the node does not hold is answered
 * with the engine's missing-index fault, and that answer is the capture.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/), against a single 3.8.0 node
 * seeded per docs/providers/opensearch.md section 11.4:
 *   LIBREDB_OS_ORIGIN=http://127.0.0.1:9201 LIBREDB_OS_CONTAINER=libredb-opensearch bun tests/live/opensearch-catalog-captures.ts
 */
// oxlint-disable no-await-in-loop -- one statement at a time on purpose, so each answer is the node's alone.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { composeCatalogRead } from "@/lib/agent/composed-sql";
import type { AgentCatalogSelector } from "@/lib/agent/composed-sql-primitives";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "tests/fixtures/opensearch/3.8.0/catalog-read");
const CONTAINER = process.env.LIBREDB_OS_CONTAINER ?? "libredb-opensearch";
const ORIGIN = process.env.LIBREDB_OS_ORIGIN ?? "http://127.0.0.1:9201";
const SQL_PATH = "/_plugins/_sql";

/**
 * Every catalog read captured, by name and the status it must answer: the whole inventory, one index, one alias, and a
 * name the node does not hold.
 */
const SELECTORS: readonly (readonly [string, AgentCatalogSelector, number])[] = [
  ["columns", { kind: "columns" }, 200],
  ["columns-table", { kind: "columns", table: "probe_shapes" }, 200],
  ["columns-alias", { kind: "columns", table: "probe_orders_alias" }, 200],
  ["columns-missing", { kind: "columns", table: "zq_no_such_index" }, 404],
];

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

const IMAGE = docker(["inspect", "--format", "{{.Config.Image}}", CONTAINER]);
if (IMAGE !== "opensearchproject/opensearch:3.8.0") throw new Error(`${CONTAINER} runs ${IMAGE}`);
const CAPTURED_AT = new Date().toISOString().slice(0, 10);

async function send(method: "GET" | "POST", pathname: string, body?: unknown) {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
}

/** Everything the run could change, as one comparable text; the query-insights indices change on every statement. */
async function clusterState(): Promise<string> {
  const indices = await send("GET", "/_cat/indices?format=json&h=index,docs.count,status&s=index");
  const rows = (JSON.parse(indices.body) as { index: string }[]).filter((row) => !row.index.startsWith("top_queries-"));
  const aliases = await send("GET", "/_cat/aliases?format=json&s=alias");
  return `${JSON.stringify(rows)}\n${aliases.body}`;
}

async function main(): Promise<void> {
  const before = await clusterState();
  if (!before.includes('"probe_shapes"')) throw new Error("probe_shapes is not seeded; see section 11.4 of the doc");
  const captures: Record<string, unknown>[] = [];
  for (const [name, selector, status] of SELECTORS) {
    const query = composeCatalogRead("opensearch", selector);
    const body = { query };
    const answer = await send("POST", SQL_PATH, body);
    if (answer.status !== status) throw new Error(`${name}: ${query} answered ${answer.status}: ${answer.body}`);
    if ((JSON.parse(answer.body) as { cursor?: string }).cursor !== undefined) {
      throw new Error(`${name}: ${query} left a cursor open`);
    }
    console.log(`answered ${answer.status} ${name}: ${query}`);
    captures.push({
      version: "3.8.0",
      name: `catalog-read/${name}`,
      image: IMAGE,
      capturedAt: CAPTURED_AT,
      request: { method: "POST", path: SQL_PATH, body, auth: "none" },
      status: answer.status,
      contentType: answer.contentType,
      body: answer.body,
    });
  }
  const after = await clusterState();
  if (after !== before) throw new Error(`the cluster's state changed during the run\n${before}\n---\n${after}`);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const capture of captures) {
    const name = (capture.name as string).slice("catalog-read/".length);
    writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(capture, null, 2)}\n`);
  }
  console.log(`${captures.length} captures written to ${path.relative(ROOT, OUT)}; the cluster read back the same`);
}

await main();

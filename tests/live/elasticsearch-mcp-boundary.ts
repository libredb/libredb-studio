/**
 * Live check of MCP's `run_read_query` on Elasticsearch, against single 9.1.4 nodes, one with security off and one
 * with security on, and an OpenSearch node behind an Elasticsearch connection.
 *
 * WHY THIS EXISTS. `run_read_query` serves Elasticsearch through the same boundary agent mode does: the connection is
 * acquired under the agent read-only profile, whose open reads the server's version and admits only the release line
 * whose write refusals were captured, and every statement goes through the provider's `queryReadOnly` on the SQL
 * endpoint, whose grammar holds no write. The MCP fence in front of it is defence in depth. So this script replays the
 * agent boundary check (`tests/live/elasticsearch-agent-boundary.ts`, and the write refusals it rests on,
 * `tests/fixtures/elasticsearch/9.1.4/write-refusal/`) through the MCP tool's own handler (`runStatement`) with that
 * fence removed, against real nodes:
 *
 *  - the open, through MCP: the 9.1.4 node is served under `agent-read-only` with security off, where no login exists
 *    to check; with it on, the open asks the server what the seed's login may do and lists its privileges, so a seed
 *    signed in as the superuser, one whose role reads the security indices with `allow_restricted_indices`, one whose
 *    role is granted two Kibana indices of other releases by name with it, and one whose role is granted the security
 *    indices of every remote cluster with it, are refused before any statement runs, in the MCP refusal sentence,
 *    while the documented seed role and a role reading every unrestricted index are served; a user whose role cannot
 *    read the version is refused the same way, and an OpenSearch node behind an Elasticsearch connection fails the
 *    open's connect probe, so nothing runs there either;
 *  - the boundary, with the MCP fence bypassed: each captured write and DDL statement is sent through the MCP handler;
 *    the fenced tool refuses every one before anything is acquired, unfenced the provider's statement check refuses
 *    each before it is sent but the one SELECT-shaped write, which the grammar refuses in its own words, as the
 *    database's refusal, and sent raw each answers 400 `parsing_exception`; the positive control is a document written
 *    through the document API into a scratch index, which MCP then reads and the script deletes; the index listing with
 *    its document counts, every mapping, the aliases, the templates and the pipelines read back the same before and
 *    after;
 *  - the hidden targets, with security off: a dot-led hidden index, a hidden index without a dot, an alias over it, a
 *    hidden data stream, the built-in `ilm-history-7`, `"*"` while that alias exists, an expression that excludes the
 *    alias a wildcard of it reaches, and statements holding a comment, a number run into a word or an `EXPLAIN` of a
 *    catalog command, each created by the script where it is not built in, each answer raw, and each is refused through
 *    MCP before it is sent; an alias and a data stream that are not hidden are served;
 *  - the security index with security on: signed in as a role reading every unrestricted index, each spelling of it
 *    that 9.1.4 answers the superuser raw is refused by the provider's statement check before it is sent, `"*"` counts
 *    the open indices alone, and the least-privilege role is refused the security index by the server and served the
 *    probe indices through MCP;
 *  - the forms and paging: a `SELECT` and an `EXPLAIN` answer; a `WITH`, `VALUES` and `TABLE` pass the MCP fence and
 *    are refused by the provider's statement check, and each sent raw is refused by the engine; a read past `max_rows`
 *    names no next offset and says how to page by key, an offset is refused before anything is sent, and the next page
 *    asked for by key answers it;
 *  - the limits and the search contexts: a read with its own `LIMIT` past the 1000-row provider budget, a plain one
 *    and an aggregation, and a read past the 1 MiB budget are refused, never cut, and after each refusal the node holds
 *    no open search context; a read past `timeout_ms` and a read whose client closes the call are answered as the
 *    timeout and the cancel, the statement runs on in the cluster until it ends, and then no search context is left;
 *    the node answers the next call.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against nodes seeded per section 11.4
 * of docs/providers/elasticsearch.md:
 *
 *   LIBREDB_ES_ORIGIN=http://127.0.0.1:9200 LIBREDB_ES_SECURED_ORIGIN=http://127.0.0.1:9210 \
 *   LIBREDB_ES_ADMIN_USER=elastic LIBREDB_ES_ADMIN_PASSWORD=<secret> \
 *   LIBREDB_LIVE_OPENSEARCH_ORIGIN=http://127.0.0.1:9201 bun tests/live/elasticsearch-mcp-boundary.ts
 *
 * The scratch index is named `libredb_lm_<random>`, the hidden ones `.libredb_lm_<random>` and `libredb_lm_<random>_hid`,
 * the alias over the second `libredb_lm_<random>_alias`, the hidden data stream `libredb_lm_<random>_hds` with its
 * template, and the users and roles the script creates `libredb_lm_<random>` and `libredb_lm_<random>_<kind>`; all are
 * deleted before exit. Each check prints one line, and a line that would carry the admin password fails
 * instead of printing it; any failure ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the node holds after the one before.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import {
  CHARACTER_REFUSAL,
  COMMENT_REFUSAL,
  DOT_INDEX_REFUSAL,
  EXCLUSION_REFUSAL,
  expressionRefusal,
  FROM_REFUSAL,
  hiddenTargetRefusal,
  NUMBER_REFUSAL,
  STATEMENT_REFUSAL,
  SUBQUERY_REFUSAL,
  UNREADABLE_REFUSAL,
} from "@/lib/db/providers/sql/search/elasticsearch-agent-index-fence";
import type { McpConnectionContext } from "@/lib/mcp/context";
import type { ToolResult } from "@/lib/mcp/output";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: the check runs every part of the boundary, so it has no default`);
    process.exit(2);
  }
  return value;
}

const ORIGIN = new URL(env("LIBREDB_ES_ORIGIN"));
const SECURED = new URL(env("LIBREDB_ES_SECURED_ORIGIN"));
const ADMIN_USER = env("LIBREDB_ES_ADMIN_USER");
const ADMIN_PASSWORD = env("LIBREDB_ES_ADMIN_PASSWORD");
const OPENSEARCH = new URL(env("LIBREDB_LIVE_OPENSEARCH_ORIGIN"));
const SCRATCH = `libredb_lm_${randomBytes(4).toString("hex")}`;
/** A password for the throwaway user, never printed: a check line holding it fails instead. */
const USER_PASSWORD = randomBytes(12).toString("hex");

const ROOT = path.resolve(import.meta.dirname, "../..");
const CAPTURES = path.join(ROOT, "tests/fixtures/elasticsearch/9.1.4/write-refusal");
const WRITES: readonly { readonly query: string; readonly reason: string }[] = readdirSync(CAPTURES)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => {
    const capture = JSON.parse(readFileSync(path.join(CAPTURES, file), "utf8")) as {
      request: { body: { query: string } };
      body: string;
    };
    return {
      query: capture.request.body.query,
      reason: (JSON.parse(capture.body) as { error: { reason: string } }).error.reason,
    };
  });

/** The tool as MCP registers it, and the same tool with its statement fence removed: the boundary under test. */
const RUN_READ_QUERY = mcpStatementArm("run_read_query");
const UNFENCED: McpStatementArm = { ...RUN_READ_QUERY, fence: () => null };
const ENGINES = RUN_READ_QUERY.engines;
const ENGINE_PREFIX = "The database refused or failed the call: ";
const NOT_SENT = "The statement was refused before it reached the database: ";
/** The tool's answer for a statement the provider refused before it was sent. */
const unsent = (sentence: string) => `${NOT_SENT}${sentence}.`;
const DOT_REFUSAL = unsent(DOT_INDEX_REFUSAL);
const COMMAND_REFUSAL = unsent(STATEMENT_REFUSAL);
/** The open's advice when it refuses a login for its reach. */
const GRANT_INSTEAD =
  "Give the agent a user whose role holds the cluster action cluster:monitor/main and read and view_index_metadata on the indices it reads, without allow_restricted_indices, such as the libredb_agent_read role";
const KEYSET =
  "Page it in SQL: ORDER BY a unique field, and for the next page add WHERE that field > the last value read.";

/** A statement the engine takes about ten seconds over, on probe_buckets: each term repeats every key 200,000 times. */
function slow(projection: string, tail: string): string {
  const terms = Array.from({ length: 60 }, (_, i) => `LOCATE('z${i}', REPEAT(k, 200000)) > 0`).join(" OR ");
  // A random literal, so the shard request cache never answers it.
  return `SELECT ${projection} FROM probe_buckets WHERE ${terms} OR k <> 'r${randomBytes(4).toString("hex")}'${tail}`;
}

let failures = 0;
function check(ok: boolean, line: string): void {
  if (line.includes(ADMIN_PASSWORD) || line.includes(USER_PASSWORD)) {
    console.log("FAIL a check line carried a password, and is not printed");
    failures++;
    return;
  }
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

/** A request past every check of Studio's, as the superuser on the secured node. */
async function send(
  origin: URL,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const response = await fetch(new URL(pathname, origin), {
    method,
    headers: {
      "content-type": "application/json",
      ...(origin === SECURED ? { authorization: basic(ADMIN_USER, ADMIN_PASSWORD) } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, text: await response.text() };
}

async function read(origin: URL, pathname: string): Promise<string> {
  const answer = await send(origin, "GET", pathname);
  if (answer.status !== 200) throw new Error(`state read ${pathname}: ${answer.status}`);
  return answer.text;
}

/** Everything a write or a DDL statement could change, as one text; the scratch index is left out. */
async function clusterState(origin: URL): Promise<string> {
  await send(origin, "POST", "/_refresh");
  const indices = (
    JSON.parse(await read(origin, "/_cat/indices?format=json&h=index,docs.count,status&s=index")) as {
      index: string;
    }[]
  ).filter((row) => row.index !== SCRATCH);
  return [
    `indices ${JSON.stringify(indices)}`,
    `mappings ${await read(origin, "/probe_*/_mapping")}`,
    `aliases ${await read(origin, "/_cat/aliases?format=json&s=alias")}`,
    `templates ${await read(origin, "/_cat/templates?format=json&s=name")}`,
    `pipelines ${Object.keys(JSON.parse(await read(origin, "/_ingest/pipeline")) as object)
      .sort()
      .join(",")}`,
  ].join("\n");
}

/** The search contexts the node holds open, summed over its nodes: a cursor left open is one of them. */
async function openContexts(origin: URL = ORIGIN): Promise<number> {
  const stats = JSON.parse(await read(origin, "/_nodes/stats/indices/search")) as {
    nodes: Record<string, { indices: { search: { open_contexts: number } } }>;
  };
  return Object.values(stats.nodes).reduce((sum, node) => sum + node.indices.search.open_contexts, 0);
}

/** The SQL tasks the node is running: a statement whose wait ended may still be one of them. */
async function sqlTasks(): Promise<number> {
  const tasks = JSON.parse(await read(ORIGIN, "/_tasks?actions=indices:data/read/sql*")) as {
    nodes: Record<string, { tasks: Record<string, unknown> }>;
  };
  return Object.values(tasks.nodes).reduce((sum, node) => sum + Object.keys(node.tasks).length, 0);
}

/** Polls until `done` holds or `ms` pass, and answers whether it held. */
async function within(ms: number, done: () => Promise<boolean>): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await done()) return true;
    await Bun.sleep(250);
  }
  return done();
}

function seed(name: string, origin: URL, login?: { user: string; password: string }): ManagedConnection {
  return {
    id: `seed:live-${name}`,
    name,
    seedId: `live-${name}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "elasticsearch",
    host: origin.hostname,
    port: Number(origin.port),
    ...(login === undefined ? {} : login),
    createdAt: new Date(),
  } as ManagedConnection;
}

/** One MCP call on `connection`, through the factory's own profiled acquisition, as the route makes it. */
async function mcp(
  connection: ManagedConnection,
  args: Partial<McpStatementInput> & { readonly sql: string },
  arm: McpStatementArm = UNFENCED,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ readonly result: ToolResult; readonly acquired: ExecutionProfile[] }> {
  const acquired: ExecutionProfile[] = [];
  const context = {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    acquire: (target: ManagedConnection, profile: ExecutionProfile) => {
      acquired.push(profile);
      return acquireExecutionProfileProvider(target, profile);
    },
  } as unknown as McpConnectionContext;
  const input = arm.inputSchema.parse({ connection_id: connection.id, ...args }) as McpStatementInput;
  const result = await runStatement(arm, input, { context, signal });
  return { result, acquired };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).join(" ");

/** The engine's answer in an MCP result that is the database's own refusal, or null when it is not one. */
function engineTextOf(result: ToolResult): string | null {
  const last = result.content.map((part) => ("text" in part ? part.text : "")).at(-1) ?? "";
  return result.isError === true && last.startsWith(ENGINE_PREFIX) ? last.slice(ENGINE_PREFIX.length) : null;
}

const rowsOf = (result: ToolResult) => result.structuredContent?.rows as Record<string, unknown>[] | undefined;

async function checkOpen(agent: ManagedConnection, admin: ManagedConnection): Promise<void> {
  const served = await mcp(agent, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" }, RUN_READ_QUERY);
  check(
    served.result.isError === undefined &&
      JSON.stringify(rowsOf(served.result)) === '[{"n":1500}]' &&
      served.acquired.join() === "agent-read-only",
    `open: the 9.1.4 node is served under agent-read-only -> ${JSON.stringify(rowsOf(served.result))}`,
  );
  const superuser = await mcp(admin, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" }, RUN_READ_QUERY);
  check(
    textOf(superuser.result) ===
      `run_read_query cannot run on this connection: The agent read-only profile needs an Elasticsearch login that holds no cluster privilege all, reads no restricted system index and is granted no index privilege with allow_restricted_indices; the user ${ADMIN_USER} holds the cluster privilege all and read on every index, the restricted system indices included, so the connection is refused. ${GRANT_INSTEAD}. It runs on ${ENGINES}.` &&
      superuser.acquired.join() === "agent-read-only",
    `open: with security on, a seed signed in as the superuser is refused at open -> ${textOf(superuser.result).slice(0, 220)}`,
  );
  // OpenSearch has no SQL endpoint at Elasticsearch's path, so the open's connect probe is refused before the version
  // read, and the call fails at open with nothing sent.
  const fork = await mcp(seed("opensearch", OPENSEARCH), { sql: "SELECT 1" }, RUN_READ_QUERY);
  check(
    engineTextOf(fork.result)?.startsWith(
      "Failed to connect to Elasticsearch: Elasticsearch did not route the request to its SQL endpoint: ",
    ) === true && fork.acquired.join() === "agent-read-only",
    `open: an OpenSearch 3.8.0 node behind an Elasticsearch connection is refused at open through MCP -> ${engineTextOf(fork.result)}`,
  );
}

/** A user whose role reads the probe indices but not the version: the open cannot read it, and refuses. */
async function checkUnreadVersion(): Promise<void> {
  const role = await send(SECURED, "PUT", `/_security/role/${SCRATCH}`, {
    indices: [{ names: ["probe_*"], privileges: ["read", "view_index_metadata"] }],
  });
  const user = await send(SECURED, "PUT", `/_security/user/${SCRATCH}`, { password: USER_PASSWORD, roles: [SCRATCH] });
  check(role.status === 200 && user.status === 200, `open: a user reading probe_* with no cluster action is created`);
  const refused = await mcp(seed("unversioned", SECURED, { user: SCRATCH, password: USER_PASSWORD }), {
    sql: "SELECT COUNT(*) AS n FROM probe_buckets",
  });
  const text = textOf(refused.result);
  check(
    text.startsWith(
      "run_read_query cannot run on this connection: The agent read-only profile is checked on Elasticsearch 9.1, and this server's version could not be read, so it is refused (a user needs the cluster privilege cluster:monitor/main to read it): ",
    ) && text.endsWith(`It runs on ${ENGINES}.`),
    `open: that user is refused at open through MCP -> ${text.slice(0, 200)}`,
  );
}

/** A user of its own role on the secured node, named for its kind, as the superuser creates it. */
async function userWithRole(kind: string, role: Record<string, unknown>): Promise<ManagedConnection> {
  const name = `${SCRATCH}_${kind}`;
  const created = await send(SECURED, "PUT", `/_security/role/${name}`, role);
  const user = await send(SECURED, "PUT", `/_security/user/${name}`, { password: USER_PASSWORD, roles: [name] });
  if (created.status !== 200 || user.status !== 200) throw new Error(`user ${kind}: ${created.status} ${user.status}`);
  return seed(name, SECURED, { user: name, password: USER_PASSWORD });
}

const LOGIN_KINDS = ["restricted", "kibana", "remote", "seed", "wide"] as const;

/**
 * The open's login check, with security on: a role reading the security indices with `allow_restricted_indices`, a
 * role granted two Kibana indices of other releases by name with it, and a role granted the security indices of every
 * remote cluster with it, the last two of which every ask of the check answers false and the listing of its privileges
 * names, are refused before any statement, and the documented seed role and a role reading every unrestricted index
 * are served.
 */
async function checkLogins(): Promise<{ seedRole: ManagedConnection; wide: ManagedConnection }> {
  const restricted = await userWithRole("restricted", {
    cluster: ["cluster:monitor/main"],
    indices: [
      { names: ["probe_*"], privileges: ["read", "view_index_metadata"] },
      { names: [".security*"], privileges: ["read"], allow_restricted_indices: true },
    ],
  });
  const refused = await mcp(restricted, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" }, RUN_READ_QUERY);
  check(
    textOf(refused.result) ===
      `run_read_query cannot run on this connection: The agent read-only profile needs an Elasticsearch login that holds no cluster privilege all, reads no restricted system index and is granted no index privilege with allow_restricted_indices; the user ${SCRATCH}_restricted holds read on the restricted system index names and patterns .security*, .security-7, .security-tokens-7, .security-profile-8, so the connection is refused. ${GRANT_INSTEAD}. It runs on ${ENGINES}.`,
    `login: a role reading .security* with allow_restricted_indices is refused at open -> ${textOf(refused.result).slice(0, 220)}`,
  );
  const kibana = await userWithRole("kibana", {
    cluster: ["cluster:monitor/main"],
    indices: [
      { names: ["probe_*"], privileges: ["read", "view_index_metadata"] },
      { names: [".kibana_8.18.0_001", ".kibana_9.1.0_001"], privileges: ["read"], allow_restricted_indices: true },
    ],
  });
  const kibanaRefused = await mcp(kibana, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" }, RUN_READ_QUERY);
  check(
    textOf(kibanaRefused.result) ===
      `run_read_query cannot run on this connection: ${"The agent read-only profile needs an Elasticsearch login that holds no cluster privilege all, reads no restricted system index and is granted no index privilege with allow_restricted_indices; "}the user ${SCRATCH}_kibana holds an index privilege granted with allow_restricted_indices on .kibana_8.18.0_001, .kibana_9.1.0_001, so the connection is refused. ${GRANT_INSTEAD}. It runs on ${ENGINES}.`,
    `login: a role granted two Kibana indices of other releases by name with allow_restricted_indices is refused at open -> ${textOf(kibanaRefused.result).slice(0, 220)}`,
  );
  const remote = await userWithRole("remote", {
    cluster: ["cluster:monitor/main"],
    indices: [{ names: ["probe_*"], privileges: ["read", "view_index_metadata"] }],
    remote_indices: [{ clusters: ["*"], names: [".security*"], privileges: ["read"], allow_restricted_indices: true }],
  });
  const remoteRefused = await mcp(remote, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" }, RUN_READ_QUERY);
  check(
    textOf(remoteRefused.result) ===
      `run_read_query cannot run on this connection: ${"The agent read-only profile needs an Elasticsearch login that holds no cluster privilege all, reads no restricted system index and is granted no index privilege with allow_restricted_indices; "}the user ${SCRATCH}_remote holds a remote index privilege granted with allow_restricted_indices on *:.security*, so the connection is refused. ${GRANT_INSTEAD}. It runs on ${ENGINES}.`,
    `login: a role granted the security indices of every remote cluster with allow_restricted_indices is refused at open -> ${textOf(remoteRefused.result).slice(0, 220)}`,
  );
  const seedRole = await userWithRole("seed", {
    cluster: ["cluster:monitor/main", "monitor", "read_pipeline"],
    indices: [{ names: ["probe_*"], privileges: ["read", "view_index_metadata", "monitor"] }],
  });
  const seedServed = await mcp(seedRole, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" }, RUN_READ_QUERY);
  check(
    JSON.stringify(rowsOf(seedServed.result)) === '[{"n":1500}]',
    `login: the documented seed role (libredb_seed_read) is served -> ${JSON.stringify(rowsOf(seedServed.result))}`,
  );
  const wide = await userWithRole("wide", {
    cluster: ["cluster:monitor/main"],
    indices: [{ names: ["*"], privileges: ["read", "view_index_metadata"] }],
  });
  const wideServed = await mcp(wide, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" }, RUN_READ_QUERY);
  check(
    JSON.stringify(rowsOf(wideServed.result)) === '[{"n":1500}]',
    `login: a role reading * without allow_restricted_indices is served -> ${JSON.stringify(rowsOf(wideServed.result))}`,
  );
  return { seedRole, wide };
}

/** Polls the security-off node until the built-in data stream exists: ILM creates it shortly after a node starts. */
async function builtInStream(name: string): Promise<boolean> {
  return within(60_000, async () => (await send(ORIGIN, "GET", `/_data_stream/${name}`)).status === 200);
}

/**
 * With security off there is no login to check, so the statement check is what keeps hidden targets from MCP. Each
 * statement below answers raw on 9.1.4, and through MCP each is refused before it is sent: a hidden target by the
 * server's answer about the statement's index, and a statement the reader cannot read with certainty by the reader.
 * An alias and a data stream that are not hidden are served.
 */
async function checkHiddenTargets(agent: ManagedConnection): Promise<void> {
  const dot = `.${SCRATCH}`;
  const hid = `${SCRATCH}_hid`;
  const alias = `${SCRATCH}_alias`;
  const stream = `${SCRATCH}_hds`;
  try {
    const made = [
      await send(ORIGIN, "PUT", `/${dot}`, { settings: { "index.hidden": true } }),
      await send(ORIGIN, "PUT", `/${dot}/_doc/1?refresh=true`, { probe: "hidden" }),
      await send(ORIGIN, "PUT", `/${hid}`, { settings: { "index.hidden": true } }),
      await send(ORIGIN, "PUT", `/${hid}/_doc/1?refresh=true`, { probe: "hidden" }),
      await send(ORIGIN, "POST", "/_aliases", { actions: [{ add: { index: hid, alias } }] }),
      await send(ORIGIN, "PUT", `/_index_template/${stream}_t`, {
        index_patterns: [`${stream}*`],
        data_stream: { hidden: true },
        priority: 500,
        template: { settings: { "index.hidden": true } },
      }),
      await send(ORIGIN, "POST", `/${stream}/_doc?refresh=true`, { "@timestamp": "2026-11-01T00:00:00Z" }),
    ];
    check(
      made.every((answer) => answer.status === 200 || answer.status === 201) && (await builtInStream("ilm-history-7")),
      `hidden: the script creates a dot-led hidden index, a hidden index without a dot, an alias over it and a hidden data stream, and ilm-history-7 exists -> ${made.map((answer) => answer.status).join(",")}`,
    );
    const cases: readonly [string, string][] = [
      [`SELECT COUNT(*) AS n FROM "${dot}"`, DOT_REFUSAL],
      [`SELECT COUNT(*) AS n FROM ${hid}`, unsent(hiddenTargetRefusal(hid))],
      [`SELECT COUNT(*) AS n FROM ${alias}`, unsent(hiddenTargetRefusal(alias))],
      ['SELECT COUNT(*) AS n FROM "*"', unsent(hiddenTargetRefusal("*"))],
      [`SELECT COUNT(*) AS n FROM ${stream}`, unsent(hiddenTargetRefusal(stream))],
      ['SELECT COUNT(*) AS n FROM "ilm-history-7"', unsent(hiddenTargetRefusal("ilm-history-7"))],
      [`SELECT COUNT(*) AS n FROM ${hid} /* /* */ */`, unsent(COMMENT_REFUSAL)],
      [`SELECT COUNT(*) AS n FROM ${hid} -- note\r`, unsent(COMMENT_REFUSAL)],
      [`SELECT 1.5AS n FROM ${hid}`, unsent(NUMBER_REFUSAL)],
      [`EXPLAIN DESC LIKE '${hid}'`, COMMAND_REFUSAL],
      [`SELECT COUNT(*) AS n FROM "probe_orders,${SCRATCH}_al*,-${alias}"`, unsent(EXCLUSION_REFUSAL)],
      [`SELECT COUNT(*) AS n FROM "*,-${alias}"`, unsent(EXCLUSION_REFUSAL)],
    ];
    for (const [sql, refusal] of cases) {
      const raw = await send(ORIGIN, "POST", "/_sql?format=json", { query: sql });
      const { result, acquired } = await mcp(agent, { sql });
      check(
        raw.status === 200 &&
          raw.text.includes('"rows":[[') &&
          textOf(result) === refusal &&
          acquired.join() === "agent-read-only",
        `hidden: ${JSON.stringify(sql)} answers raw, and MCP refuses it before it is sent -> ${textOf(result).slice(0, 110)}`,
      );
    }
    for (const visible of ["probe_orders_alias", "probe_stream"]) {
      const served = await mcp(agent, { sql: `SELECT COUNT(*) AS n FROM ${visible}` }, RUN_READ_QUERY);
      check(
        served.result.isError === undefined && Number(rowsOf(served.result)?.[0]?.n) > 0,
        `hidden: ${visible}, which the server marks neither hidden nor system, is served -> ${JSON.stringify(rowsOf(served.result))}`,
      );
    }
  } finally {
    await send(ORIGIN, "DELETE", `/_data_stream/${stream}`);
    await send(ORIGIN, "DELETE", `/_index_template/${stream}_t`);
    await send(ORIGIN, "DELETE", `/${hid}`);
    await send(ORIGIN, "DELETE", `/${dot}`);
  }
}

async function checkBoundary(origin: URL, connection: ManagedConnection, label: string): Promise<void> {
  const before = await clusterState(origin);
  for (const { query, reason } of WRITES) {
    const fenced = await mcp(connection, { sql: query }, RUN_READ_QUERY);
    check(
      fenced.result.isError === true && fenced.acquired.length === 0,
      `${label}: the MCP fence refuses ${query} before anything is acquired`,
    );
    const { result, acquired } = await mcp(connection, { sql: query });
    // The provider's statement check refuses every capture before it is sent but the SELECT-shaped write, which reads
    // one visible index: no SELECT is a statement it refuses, and the second statement holds a `;`.
    const refusedUnsent = query.startsWith("SELECT * INTO")
      ? null
      : query.includes(";")
        ? CHARACTER_REFUSAL
        : STATEMENT_REFUSAL;
    if (refusedUnsent !== null) {
      check(
        acquired.join() === "agent-read-only" && textOf(result) === unsent(refusedUnsent),
        `${label}: bypassed, the provider's statement check refuses ${query} unsent -> ${textOf(result).slice(0, 90)}`,
      );
    } else {
      const engine = engineTextOf(result);
      // A SELECT-shaped statement goes out with the page's LIMIT the tool adds, so its refusal names that text's column.
      const same = engine === reason || engine?.replace(/^line 1:\d+:/, "") === reason.replace(/^line 1:\d+:/, "");
      check(
        acquired.join() === "agent-read-only" && same,
        `${label}: bypassed, the grammar refuses ${query} in its own words -> ${engine?.slice(0, 90)}`,
      );
    }
    const raw = await send(origin, "POST", "/_sql?format=json", { query });
    check(
      raw.status === 400 && raw.text.includes('"type":"parsing_exception"') && raw.text.includes(reason),
      `${label}: sent raw, ${query} -> ${raw.status} parsing_exception`,
    );
  }
  check(
    (await clusterState(origin)) === before,
    `${label}: indices, counts, mappings, aliases, templates and pipelines read back the same`,
  );
}

/**
 * Each statement read the security index's rows, or its name, when the superuser sent it raw on 9.1.4: through MCP,
 * whatever login the open admits, the provider's statement check refuses each before it is sent.
 */
const HIDDEN: readonly [string, string][] = [
  ['SELECT COUNT(*) AS n FROM ".security"', DOT_REFUSAL],
  ['SELECT COUNT(*) AS n FROM ".security-7"', DOT_REFUSAL],
  ['SELECT COUNT(*) AS n FROM ".sec*"', DOT_REFUSAL],
  ['SELECT COUNT(*) AS n FROM "probe_orders,.security-7"', DOT_REFUSAL],
  ['SELECT COUNT(*) AS n FROM "*,.security"', DOT_REFUSAL],
  ['SELECT COUNT(*) AS n FROM "-probe_orders,.security"', DOT_REFUSAL],
  ['SELECT COUNT(*) AS n FROM "<.security-7>"', unsent(expressionRefusal("<.security-7>"))],
  ['SELECT COUNT(*) AS n FROM /* c */ ".security"', unsent(COMMENT_REFUSAL)],
  ['SELECT COUNT(*) AS n FROM (SELECT * FROM ".security") s', unsent(SUBQUERY_REFUSAL)],
  ['SELECT COUNT(*) AS n FROM "*,.security*"', DOT_REFUSAL],
  ['SELECT COUNT(*) AS n FROM "docker-cluster":".security"', unsent(CHARACTER_REFUSAL)],
  ['SELECT COUNT(*) AS n FROM ""', unsent(expressionRefusal(""))],
  // The engine reads the backslash as an ordinary character, so the string ends there and the security index is read.
  ["SELECT 'a\\' AS x FROM \".security\"", DOT_REFUSAL],
  ['SELECT COUNT(*) AS n FROM -- x\r".security"', unsent(COMMENT_REFUSAL)],
  ["SHOW TABLES LIKE '.sec%'", COMMAND_REFUSAL],
  ['SHOW COLUMNS IN ".security"', COMMAND_REFUSAL],
  ['DESCRIBE ".security"', COMMAND_REFUSAL],
];

/**
 * Spellings the statement check refuses although 9.1.4 answers none of them with rows sent raw: an empty name before
 * a `.`, a mixed-case or URL-escaped name, a quote that never closes, and a dot-led part after a qualifier. Each is
 * refused unsent, and the raw answer is the engine's refusal.
 */
const REFUSED_UNREAD: readonly [string, string][] = [
  ['SELECT COUNT(*) AS n FROM "".security', unsent(FROM_REFUSAL)],
  ['SELECT COUNT(*) AS n FROM ".SECURITY"', DOT_REFUSAL],
  ['SELECT COUNT(*) AS n FROM "%2Esecurity"', unsent(expressionRefusal("%2Esecurity"))],
  ['SELECT COUNT(*) AS n FROM ".security', unsent(UNREADABLE_REFUSAL)],
  ['SELECT COUNT(*) AS n FROM "x".".security"', unsent(FROM_REFUSAL)],
  ['SELECT COUNT(*) AS n FROM probe_orders.".security"', unsent(FROM_REFUSAL)],
  ["SELECT COUNT(*) AS n FROM probe_orders.`.security`", unsent(CHARACTER_REFUSAL)],
  ['SELECT COUNT(*) AS n FROM "x"."%2Esecurity"', unsent(FROM_REFUSAL)],
  ['SELECT COUNT(*) AS n FROM "docker-cluster".".security"', unsent(FROM_REFUSAL)],
  ['SELECT COUNT(*) AS n FROM "x"."".security', unsent(FROM_REFUSAL)],
];

async function checkHidden(wide: ManagedConnection): Promise<void> {
  for (const [sql, refusal] of REFUSED_UNREAD) {
    const { result } = await mcp(wide, { sql });
    const raw = await send(SECURED, "POST", "/_sql?format=json", { query: sql });
    check(
      textOf(result) === refusal && raw.status === 400 && !raw.text.includes('"rows"'),
      `security index: as a role reading every unrestricted index, ${sql} is refused by the provider unsent; sent raw as the superuser the engine refuses it -> ${raw.status}`,
    );
  }
  for (const [sql, refusal] of HIDDEN) {
    const { result, acquired } = await mcp(wide, { sql });
    const raw = await send(SECURED, "POST", "/_sql?format=json", { query: sql });
    check(
      textOf(result) === refusal &&
        acquired.join() === "agent-read-only" &&
        raw.status === 200 &&
        raw.text.includes('"rows":[[') &&
        (sql.startsWith("SELECT") || raw.text.includes(".security") || raw.text.includes("access_token")),
      `security index: as a role reading every unrestricted index, ${sql} is refused by the provider unsent; sent raw as the superuser it answers -> ${raw.status}`,
    );
  }
  // A wildcard that does not start with a dot reaches no hidden index: its count is the open indices' own.
  const counted = JSON.parse(await read(SECURED, "/*/_count")) as { count: number };
  const all = await mcp(wide, { sql: 'SELECT COUNT(*) AS n FROM "*"' }, RUN_READ_QUERY);
  check(
    JSON.stringify(rowsOf(all.result)) === JSON.stringify([{ n: counted.count }]),
    `security index: "*" reaches no hidden index -> ${JSON.stringify(rowsOf(all.result))}, the open indices hold ${counted.count}`,
  );
  // The documented least-privilege role reads no hidden index even when a statement names one raw.
  await send(SECURED, "PUT", `/_security/role/${SCRATCH}`, {
    cluster: ["cluster:monitor/main"],
    indices: [{ names: ["probe_*"], privileges: ["read", "view_index_metadata"] }],
  });
  await send(SECURED, "PUT", `/_security/user/${SCRATCH}`, { password: USER_PASSWORD, roles: [SCRATCH] });
  const response = await fetch(new URL("/_sql?format=json", SECURED), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: basic(SCRATCH, USER_PASSWORD) },
    body: JSON.stringify({ query: 'SELECT COUNT(*) AS n FROM ".security"' }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  check(
    response.status !== 200 && !body.includes('"rows"'),
    `security index: the least-privilege role, sending ".security" raw, is refused by the server -> ${response.status}`,
  );
  const served = await mcp(seed("least-privilege", SECURED, { user: SCRATCH, password: USER_PASSWORD }), {
    sql: "SELECT COUNT(*) AS n FROM probe_buckets",
  });
  check(
    JSON.stringify(rowsOf(served.result)) === '[{"n":1500}]',
    `security index: the least-privilege role is served through MCP -> ${JSON.stringify(rowsOf(served.result))}`,
  );
}

async function checkControl(): Promise<void> {
  try {
    const written = await send(ORIGIN, "PUT", `/${SCRATCH}/_doc/1?refresh=true`, { probe: "control" });
    check(written.status === 201, `control: a document written through the document API -> ${written.status}`);
    const back = await mcp(seed("control", ORIGIN), { sql: `SELECT probe FROM "${SCRATCH}"` }, RUN_READ_QUERY);
    check(
      JSON.stringify(rowsOf(back.result)) === '[{"probe":"control"}]',
      `control: MCP reads the written document back -> ${JSON.stringify(rowsOf(back.result))}`,
    );
  } finally {
    await send(ORIGIN, "DELETE", `/${SCRATCH}`);
  }
}

async function checkForms(agent: ManagedConnection): Promise<void> {
  const select = await mcp(agent, { sql: "SELECT customer FROM probe_orders" }, RUN_READ_QUERY);
  check(
    JSON.stringify(rowsOf(select.result)) === '[{"customer":"acme"}]',
    `forms: a SELECT answers -> ${JSON.stringify(rowsOf(select.result))}`,
  );
  const plan = await mcp(agent, { sql: "EXPLAIN SELECT customer FROM probe_orders" }, RUN_READ_QUERY);
  check(
    String(rowsOf(plan.result)?.[0]?.plan).includes("EsRelation[probe_orders]"),
    `forms: EXPLAIN answers the engine's plan text -> ${String(rowsOf(plan.result)?.[0]?.plan).slice(0, 40)}`,
  );
  const refusals: readonly [string, string][] = [
    ["WITH x AS (SELECT customer FROM probe_orders) SELECT customer FROM x", "Unknown index [x]"],
    ["VALUES (1), (2)", "extraneous input 'VALUES'"],
    ["TABLE probe_orders", "mismatched input 'TABLE'"],
  ];
  for (const [sql, says] of refusals) {
    const { result } = await mcp(agent, { sql }, RUN_READ_QUERY);
    const raw = await send(ORIGIN, "POST", "/_sql?format=json", { query: sql });
    check(
      textOf(result) === COMMAND_REFUSAL && raw.status === 400 && raw.text.includes(says),
      `forms: ${sql} passes the MCP fence and the provider refuses it unsent; sent raw the engine refuses it -> ${textOf(result).slice(0, 70)}`,
    );
  }
}

async function checkPaging(agent: ManagedConnection): Promise<void> {
  const first = await mcp(agent, { sql: "SELECT k FROM probe_buckets ORDER BY k", max_rows: 3 }, RUN_READ_QUERY);
  const keys = rowsOf(first.result)?.map((row) => row.k);
  check(
    JSON.stringify(keys) === '["k1","k10","k100"]' &&
      JSON.stringify(first.result.structuredContent?.pagination) ===
        '{"offset":0,"limit":3,"hasMore":true,"nextOffset":null,"wasLimited":true}' &&
      first.result.structuredContent?.hint ===
        `More rows exist than this result holds, and this query cannot be paged with offset. ${KEYSET}`,
    `paging: a read past max_rows names no next offset and says how to page by key -> ${JSON.stringify(first.result.structuredContent?.pagination)}`,
  );
  const offset = await mcp(agent, { sql: "SELECT k FROM probe_buckets ORDER BY k", max_rows: 3, offset: 3 });
  check(
    textOf(offset.result) === `This engine's SQL has no OFFSET, so this query cannot be paged with offset. ${KEYSET}` &&
      offset.acquired.join() === "agent-read-only",
    `paging: an offset is refused before the statement is sent -> ${textOf(offset.result)}`,
  );
  const raw = await send(ORIGIN, "POST", "/_sql?format=json", {
    query: "SELECT k FROM probe_buckets LIMIT 2 OFFSET 1",
  });
  check(
    raw.status === 400 && raw.text.includes("mismatched input 'OFFSET' expecting <EOF>"),
    `paging: the engine's SQL has no OFFSET -> ${raw.status}`,
  );
  const next = await mcp(
    agent,
    { sql: "SELECT k FROM probe_buckets WHERE k > 'k100' ORDER BY k", max_rows: 3 },
    RUN_READ_QUERY,
  );
  check(
    JSON.stringify(rowsOf(next.result)?.map((row) => row.k)) === '["k1000","k1001","k1002"]',
    `paging: the next page asked for by key answers it -> ${JSON.stringify(rowsOf(next.result)?.map((row) => row.k))}`,
  );
}

async function checkLimits(agent: ManagedConnection): Promise<void> {
  const ROWS =
    "The result has more than 1000 rows, the most this server reads for one call. Add a LIMIT of 1000 or less, and page it in SQL: ORDER BY a unique field, and for the next page add WHERE that field > the last value read.";
  const plain = await mcp(agent, { sql: "SELECT k FROM probe_buckets LIMIT 2000" }, RUN_READ_QUERY);
  check(textOf(plain.result) === ROWS, `limits: a plain read past 1000 rows -> ${textOf(plain.result)}`);
  check((await openContexts()) === 0, "limits: no search context stays open after the plain read's refusal");
  const groups = await mcp(
    agent,
    { sql: "SELECT k, COUNT(*) AS n FROM probe_buckets GROUP BY k LIMIT 2000" },
    RUN_READ_QUERY,
  );
  check(textOf(groups.result) === ROWS, `limits: an aggregation past 1000 rows -> ${textOf(groups.result)}`);
  check((await openContexts()) === 0, "limits: no search context stays open after the aggregation's refusal");
  // About 1.3 MiB of rows on one page, inside the page cap and the row budget.
  const bytes = await mcp(agent, { sql: "SELECT k, REPEAT(k, 300) AS w FROM probe_buckets LIMIT 900" }, RUN_READ_QUERY);
  check(
    textOf(bytes.result) ===
      "The result is larger than 1 MiB, the most this server reads for one call. Select fewer or narrower columns, or add a smaller LIMIT.",
    `limits: a read past 1 MiB -> ${textOf(bytes.result)}`,
  );
  check((await openContexts()) === 0, "limits: no search context stays open after the byte refusal");
  const one = await mcp(
    agent,
    { sql: "SELECT REPEAT('x', 600000) AS a, REPEAT('y', 600000) AS b FROM probe_orders" },
    RUN_READ_QUERY,
  );
  check(
    textOf(one.result).startsWith("The result is larger than 1 MiB"),
    `limits: a single row past 1 MiB -> ${textOf(one.result)}`,
  );
  check((await openContexts()) === 0, "limits: no search context stays open after it");
}

async function checkTimeAndCancel(agent: ManagedConnection): Promise<void> {
  const timed = await mcp(agent, { sql: slow("k", " LIMIT 2000"), timeout_ms: 1_000 }, RUN_READ_QUERY);
  check(
    textOf(timed.result) ===
      "The statement did not finish within timeout_ms (1000 ms). Narrow it, or raise timeout_ms up to 30000.",
    `time: past timeout_ms -> ${textOf(timed.result)}`,
  );
  const runningAfterTimeout = await sqlTasks();
  check(
    runningAfterTimeout > 0,
    `time: the statement runs on in the cluster after the timeout -> ${runningAfterTimeout} SQL task(s)`,
  );
  check(
    await within(30_000, async () => (await sqlTasks()) === 0 && (await openContexts()) === 0),
    "time: once it ends, no SQL task and no search context is left",
  );

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1_000);
  const cancelled = await mcp(
    agent,
    { sql: slow("k", " LIMIT 2000"), timeout_ms: 20_000 },
    RUN_READ_QUERY,
    controller.signal,
  );
  check(
    textOf(cancelled.result) === "The call was cancelled before it finished.",
    `cancel: a client close -> ${textOf(cancelled.result)}`,
  );
  const runningAfterCancel = await sqlTasks();
  check(
    runningAfterCancel > 0,
    `cancel: the statement runs on in the cluster after the close -> ${runningAfterCancel} SQL task(s)`,
  );
  check(
    await within(30_000, async () => (await sqlTasks()) === 0 && (await openContexts()) === 0),
    "cancel: once it ends, no SQL task and no search context is left",
  );
  const next = await mcp(agent, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" }, RUN_READ_QUERY);
  check(
    JSON.stringify(rowsOf(next.result)) === '[{"n":1500}]',
    `time: the node answers the next call -> ${JSON.stringify(rowsOf(next.result))}`,
  );
}

async function main(): Promise<void> {
  const agent = seed("es-9-1", ORIGIN);
  const admin = seed("es-9-1-secured", SECURED, { user: ADMIN_USER, password: ADMIN_PASSWORD });
  await checkOpen(agent, admin);
  await checkUnreadVersion();
  const { seedRole, wide } = await checkLogins();
  await checkHiddenTargets(agent);
  await checkBoundary(ORIGIN, agent, "boundary");
  await checkBoundary(SECURED, seedRole, "boundary as the seed role");
  await checkHidden(wide);
  await checkControl();
  await checkForms(agent);
  await checkPaging(agent);
  await checkLimits(agent);
  await checkTimeAndCancel(agent);
}

try {
  await main();
} finally {
  await send(ORIGIN, "DELETE", `/${SCRATCH}`);
  await send(SECURED, "DELETE", `/_security/user/${SCRATCH}`);
  await send(SECURED, "DELETE", `/_security/role/${SCRATCH}`);
  for (const kind of LOGIN_KINDS) {
    await send(SECURED, "DELETE", `/_security/user/${SCRATCH}_${kind}`);
    await send(SECURED, "DELETE", `/_security/role/${SCRATCH}_${kind}`);
  }
  await clearProviderCache();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

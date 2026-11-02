/**
 * Live check of MCP's `run_read_query` on OpenSearch, against single 3.8.0 nodes, one with security off and one with
 * security on.
 *
 * WHY THIS EXISTS. `run_read_query` serves OpenSearch through the same boundary agent mode does: the connection is
 * acquired under the agent read-only profile, whose open proves the SQL plugin's DELETE off, admits only the release
 * line whose write refusals were captured and, with security on, probes what the login may do, and every statement
 * goes through the provider's `queryReadOnly`, whose statement check keeps hidden and dot-led indices from it before
 * the plugin, which refuses every write, is reached. The MCP fence in front of it is defence in depth. So this script
 * replays the agent boundary check (`tests/live/opensearch-agent-boundary.ts`, and the write refusals it rests on,
 * `tests/fixtures/opensearch/3.8.0/write-refusal/`) through the MCP tool's own handler (`runStatement`) with that fence
 * removed, against real nodes:
 *
 *  - the open, through MCP: the security-off node is served under `agent-read-only`, where no login exists to check;
 *    with security on, a seed signed in as `admin`, one whose role writes every index and one whose role manages every
 *    index are refused before any statement runs, in the MCP refusal sentence, while the documented seed role
 *    (`libredb_seed_read`) is served; a user whose role cannot read the version is refused the same way;
 *  - the boundary, with the MCP fence bypassed: each captured write and DDL statement is sent through the MCP handler;
 *    the fenced tool refuses every one before anything is acquired, unfenced the provider's statement check refuses
 *    each before it is sent but the one SELECT-shaped capture, which the plugin answers as a read, and sent raw each
 *    write is refused by the plugin; the positive control is a document written through the document API into a
 *    scratch index, which MCP then reads and the script deletes; the index listing with its document counts, the
 *    probe mappings, the aliases and the templates read back the same before and after, on both nodes;
 *  - the hidden targets, with security off: a dot-led index, a hidden index, a visible alias over it, a data stream's
 *    backing index named directly, `*` and a wildcard reaching the hidden index each answer raw, and each is refused
 *    through MCP before it is sent, as are a comment, `#` and a double-quoted name; a bare name with an `@` in it,
 *    which 3.8.0 ends at the `@` (so beside a visible index named `<hidden>@y` it answers the hidden index's rows), is
 *    refused through the fenced tool and unfenced alike; the data stream read by its own name is served;
 *  - the plugins' own indices, on both nodes: every index of a family the dialect declares (`top_queries-*`, and with
 *    security on `security-auditlog-*`, are required; the others are checked where present) answers sent raw, as the
 *    role reading every index with security on, and MCP refuses each before it is sent, by its name, through `t*`, a
 *    comma list, an alias the script makes over the query insights index and the one-table catalog read of the family;
 *  - the security index with security on: signed in as a role reading every index, which the open admits,
 *    `.opendistro_security`, quoted or bare, and `*` are refused by the statement check before they are sent, while
 *    `admin` sending the first raw is answered its columns;
 *  - the forms and paging: a `SELECT` answers; `WITH`, `VALUES`, `TABLE` and `EXPLAIN` pass the MCP fence and are
 *    refused by the statement check, and each sent raw is refused by the plugin; a read past `max_rows` names the next
 *    offset, and the next page asked for by offset answers the next rows;
 *  - the limits and the search contexts: a read with its own `LIMIT` past the 1000-row provider budget, a plain one
 *    and an aggregation, and a read past the 1 MiB budget are refused, never cut, and after each refusal the node holds
 *    no open search context; a read past `timeout_ms` and a read whose client closes the call are answered as the
 *    timeout and the cancel, the search runs on in the cluster until it ends, and then no search context is left; the
 *    node answers the next call.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against nodes seeded per section 11.4
 * of docs/providers/opensearch.md, the secured one started without `DISABLE_SECURITY_PLUGIN`:
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 LIBREDB_OS_ORIGIN=http://127.0.0.1:9201 \
 *   LIBREDB_OS_SECURED_ORIGIN=https://127.0.0.1:9202 LIBREDB_OS_ADMIN_USER=admin LIBREDB_OS_ADMIN_PASSWORD=<secret> \
 *   bun tests/live/opensearch-mcp-boundary.ts
 *
 * The scratch index is named `libredb_lm_<random>`, the others the script makes `libredb_lm_<random>_<kind>` and
 * `.libredb_lm_<random>`, and the users and roles it creates `libredb_lm_<random>_<kind>`; all are deleted before exit.
 * Each check prints one line, and a line that would carry a password fails instead of printing it; any failure ends
 * the run non-zero.
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
  FROM_REFUSAL,
  hiddenTargetRefusal,
  STATEMENT_REFUSAL,
} from "@/lib/db/providers/sql/search/opensearch-agent-index-fence";
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

const ORIGIN = new URL(env("LIBREDB_OS_ORIGIN"));
const SECURED = new URL(env("LIBREDB_OS_SECURED_ORIGIN"));
const ADMIN_USER = env("LIBREDB_OS_ADMIN_USER");
const ADMIN_PASSWORD = env("LIBREDB_OS_ADMIN_PASSWORD");
const SCRATCH = `libredb_lm_${randomBytes(4).toString("hex")}`;
/** A password for the throwaway users, never printed: a check line holding it fails instead. */
const USER_PASSWORD = `Lm-${randomBytes(12).toString("hex")}-x9`;

const ROOT = path.resolve(import.meta.dirname, "../..");
const CAPTURES = path.join(ROOT, "tests/fixtures/opensearch/3.8.0/write-refusal");
/** The three captures the plugin answers as plain reads (they write nothing, and the cluster read back unchanged). */
const READ_ANSWERS = new Set([
  "write-refusal/select-into",
  "write-refusal/describe-second-statement",
  "write-refusal/show-second-statement",
]);
const WRITES: readonly { readonly name: string; readonly query: string }[] = readdirSync(CAPTURES)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => {
    const capture = JSON.parse(readFileSync(path.join(CAPTURES, file), "utf8")) as {
      name: string;
      request: { body: { query: string } };
    };
    return { name: capture.name, query: capture.request.body.query };
  });

/** The tool as MCP registers it, and the same tool with its statement fence removed: the boundary under test. */
const RUN_READ_QUERY = mcpStatementArm("run_read_query");
const UNFENCED: McpStatementArm = { ...RUN_READ_QUERY, fence: () => null };
const ENGINES = RUN_READ_QUERY.engines;
const NOT_SENT = "The statement was refused before it reached the database: ";
/** The tool's answer for a statement the provider refused before it was sent. */
const unsent = (sentence: string) => `${NOT_SENT}${sentence}.`;
const TOO_BROAD =
  "run_read_query cannot run on this connection: The agent read-only profile refuses an OpenSearch login that the security plugin lets call its REST API, or whose delete by query or index close on a fresh index name passes the plugin's permission check; these probes narrow the login and do not show that it cannot write, since the statement check and the SQL plugin refuse every write whatever the login. The user ";
const GRANT_INSTEAD = `, so the connection is refused. Give the agent a user whose role holds the cluster actions cluster:monitor/main and cluster:monitor/state and only reads on the indices it reads, such as the libredb_agent_read role, or libredb_seed_read for a seed that MCP reads. It runs on ${ENGINES}.`;
/** The plugin's refusal of a statement that is not a read, as 3.8.0 words it. */
const PLUGIN_REFUSAL = /Query must start with SELECT, DELETE, SHOW or DESCRIBE: |Illegal SQL expression : /;

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

/** A request past every check of Studio's, as `admin` on the secured node. */
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
    signal: AbortSignal.timeout(120_000),
  });
  return { status: response.status, text: await response.text() };
}

async function read(origin: URL, pathname: string): Promise<string> {
  const answer = await send(origin, "GET", pathname);
  if (answer.status !== 200) throw new Error(`state read ${pathname}: ${answer.status}`);
  return answer.text;
}

/**
 * The index families the plugins bundled with 3.8.0 write their own records into with no leading dot and no hidden
 * mark, as the OpenSearch dialect declares them (`pluginIndexFamilies` in `http-transport.ts`): a name, or a prefix
 * where it ends in `-`.
 */
const PLUGIN_FAMILIES = [
  "top_queries-",
  "security-auditlog-",
  "ubi_queries",
  "ubi_events",
  "search-relevance-",
  "opensearch-forecast-",
  "opensearch-ad-plugin-",
] as const;

const inPluginFamily = (index: string) =>
  PLUGIN_FAMILIES.some((family) => (family.endsWith("-") ? index.startsWith(family) : index === family));

/** Whether an index is one the node writes on its own, or one the script made. */
const unwatched = (index: string) => index.startsWith(".") || inPluginFamily(index) || index.startsWith(SCRATCH);

/** Everything a write or a DDL statement could change, as one text. */
async function clusterState(origin: URL): Promise<string> {
  await send(origin, "POST", "/_refresh");
  const indices = (
    JSON.parse(await read(origin, "/_cat/indices?format=json&h=index,docs.count,status&s=index")) as {
      index: string;
    }[]
  ).filter((row) => !unwatched(row.index));
  return [
    `indices ${JSON.stringify(indices)}`,
    `mappings ${await read(origin, "/probe_*/_mapping")}`,
    `aliases ${await read(origin, "/_cat/aliases?format=json&s=alias")}`,
    `templates ${await read(origin, "/_cat/templates?format=json&s=name")}`,
  ].join("\n");
}

/** The search contexts the node holds open, summed over its nodes: a cursor left open is one of them. */
async function openContexts(origin: URL = ORIGIN): Promise<number> {
  const stats = JSON.parse(await read(origin, "/_nodes/stats/indices/search")) as {
    nodes: Record<string, { indices: { search: { open_contexts: number } } }>;
  };
  return Object.values(stats.nodes).reduce((sum, node) => sum + node.indices.search.open_contexts, 0);
}

/** The searches the node is running: a statement whose wait ended may still be one of them. */
async function searchTasks(): Promise<number> {
  const tasks = JSON.parse(await read(ORIGIN, "/_tasks?actions=indices:data/read/search")) as {
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
    type: "opensearch",
    host: origin.hostname,
    port: Number(origin.port),
    ...(origin.protocol === "https:" ? { ssl: { mode: "require" } } : {}),
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

const rowsOf = (result: ToolResult) => result.structuredContent?.rows as Record<string, unknown>[] | undefined;

/** The rows a statement sent raw answers, or null where it was refused. */
async function rawRows(origin: URL, sql: string): Promise<unknown[] | null> {
  const raw = await send(origin, "POST", "/_plugins/_sql", { query: sql });
  if (raw.status !== 200) return null;
  return (JSON.parse(raw.text) as { datarows?: unknown[] }).datarows ?? null;
}

/** A user of its own role on the secured node, named for its kind, as `admin` creates it. */
async function userWithRole(kind: string, role: Record<string, unknown>): Promise<ManagedConnection> {
  const name = `${SCRATCH}_${kind}`;
  const created = await send(SECURED, "PUT", `/_plugins/_security/api/roles/${name}`, role);
  const user = await send(SECURED, "PUT", `/_plugins/_security/api/internalusers/${name}`, {
    password: USER_PASSWORD,
    opendistro_security_roles: [name],
  });
  if (![200, 201].includes(created.status) || ![200, 201].includes(user.status)) {
    throw new Error(`user ${kind}: ${created.status} ${user.status}`);
  }
  return seed(name, SECURED, { user: name, password: USER_PASSWORD });
}

const LOGIN_KINDS = ["writer", "manager", "unversioned", "seed", "wide"] as const;
const AGENT_CLUSTER = ["cluster:monitor/main", "cluster:monitor/state"];
const AGENT_INDICES = ["read", "indices:admin/mappings/get", "indices:monitor/settings/get"];

/**
 * The open, through MCP: the security-off node is served; with security on, `admin`, a role writing every index and a
 * role managing every index are refused before any statement, a user that cannot read the version is refused, and the
 * documented seed role and a role reading every index are served.
 */
async function checkOpen(agent: ManagedConnection): Promise<{ seedRole: ManagedConnection; wide: ManagedConnection }> {
  const served = await mcp(agent, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" }, RUN_READ_QUERY);
  check(
    served.result.isError === undefined &&
      JSON.stringify(rowsOf(served.result)) === '[{"n":1500}]' &&
      served.acquired.join() === "agent-read-only",
    `open: the security-off 3.8.0 node is served under agent-read-only -> ${JSON.stringify(rowsOf(served.result))}`,
  );
  const admin = await mcp(seed("admin", SECURED, { user: ADMIN_USER, password: ADMIN_PASSWORD }), {
    sql: "SELECT COUNT(*) AS n FROM probe_buckets",
  });
  check(
    textOf(admin.result) ===
      `${TOO_BROAD}${ADMIN_USER} may call the security plugin's REST API, and passed the delete by query on a fresh index name, and passed the index close on a fresh index name${GRANT_INSTEAD}` &&
      admin.acquired.join() === "agent-read-only",
    `open: with security on, a seed signed in as admin is refused at open -> ${textOf(admin.result).slice(0, 200)}`,
  );
  for (const [kind, actions, finding] of [
    ["writer", ["read", "write"], "passed the delete by query on a fresh index name"],
    ["manager", ["read", "manage"], "passed the index close on a fresh index name"],
  ] as const) {
    const login = await userWithRole(kind, {
      cluster_permissions: AGENT_CLUSTER,
      index_permissions: [{ index_patterns: ["*"], allowed_actions: actions }],
    });
    const refused = await mcp(login, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" });
    check(
      textOf(refused.result) === `${TOO_BROAD}${SCRATCH}_${kind} ${finding}${GRANT_INSTEAD}`,
      `open: a role granting ${actions.join(" and ")} on * is refused at open -> ${textOf(refused.result).slice(0, 200)}`,
    );
  }
  const unversioned = await userWithRole("unversioned", {
    cluster_permissions: ["cluster:monitor/state"],
    index_permissions: [{ index_patterns: ["probe_*"], allowed_actions: AGENT_INDICES }],
  });
  const noVersion = textOf((await mcp(unversioned, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" })).result);
  check(
    noVersion.startsWith(
      "run_read_query cannot run on this connection: The agent read-only profile is checked on OpenSearch 3.8, and this server's version could not be read, so it is refused (a user needs the cluster privilege cluster:monitor/main to read it): ",
    ) && noVersion.endsWith(`It runs on ${ENGINES}.`),
    `open: a user that cannot read the version is refused at open -> ${noVersion.slice(0, 200)}`,
  );
  const seedRole = await userWithRole("seed", {
    cluster_permissions: [
      ...AGENT_CLUSTER,
      "cluster:monitor/health",
      "cluster:admin/ingest/pipeline/get",
      "indices:admin/index_template/get",
    ],
    index_permissions: [
      { index_patterns: ["probe_*"], allowed_actions: AGENT_INDICES },
      {
        index_patterns: ["*"],
        allowed_actions: [
          "indices:monitor/settings/get",
          "indices:monitor/stats",
          "indices:admin/aliases/get",
          "indices:admin/data_stream/get",
          "indices:admin/mappings/get",
        ],
      },
    ],
  });
  const seedServed = await mcp(seedRole, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" }, RUN_READ_QUERY);
  check(
    JSON.stringify(rowsOf(seedServed.result)) === '[{"n":1500}]',
    `open: the documented seed role (libredb_seed_read) is served -> ${JSON.stringify(rowsOf(seedServed.result))}`,
  );
  const wide = await userWithRole("wide", {
    cluster_permissions: AGENT_CLUSTER,
    index_permissions: [{ index_patterns: ["*"], allowed_actions: AGENT_INDICES }],
  });
  const wideServed = await mcp(wide, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" }, RUN_READ_QUERY);
  check(
    JSON.stringify(rowsOf(wideServed.result)) === '[{"n":1500}]',
    `open: a role reading every index, which neither writes nor manages, is served -> ${JSON.stringify(rowsOf(wideServed.result))}`,
  );
  const probes = await read(SECURED, "/_cat/indices/libredb_write_probe_*?format=json");
  check(probes === "[]", `open: the login probes left no index behind -> ${probes}`);
  return { seedRole, wide };
}

async function checkBoundary(origin: URL, connection: ManagedConnection, label: string): Promise<void> {
  const before = await clusterState(origin);
  for (const { name, query } of WRITES) {
    const fenced = await mcp(connection, { sql: query }, RUN_READ_QUERY);
    check(
      fenced.result.isError === true && fenced.acquired.length === 0,
      `${label}: the MCP fence refuses ${query} before anything is acquired`,
    );
    const { result, acquired } = await mcp(connection, { sql: query });
    const raw = await send(origin, "POST", "/_plugins/_sql", { query });
    if (name === "write-refusal/select-into") {
      // The one SELECT-shaped capture reads one visible index; the plugin answers it as a read and writes nothing.
      check(
        acquired.join() === "agent-read-only" && result.isError === undefined && raw.status === 200,
        `${label}: bypassed, ${query} reads probe_orders and writes nothing -> ${JSON.stringify(rowsOf(result))}`,
      );
      continue;
    }
    const refused = query.includes(";") ? CHARACTER_REFUSAL : STATEMENT_REFUSAL;
    check(
      acquired.join() === "agent-read-only" && textOf(result) === unsent(refused),
      `${label}: bypassed, the provider's statement check refuses ${query} unsent -> ${textOf(result).slice(0, 90)}`,
    );
    check(
      READ_ANSWERS.has(name) ? raw.status === 200 : raw.status === 400 && PLUGIN_REFUSAL.test(raw.text),
      `${label}: sent raw, ${query} -> ${raw.status}${READ_ANSWERS.has(name) ? " (a read the plugin answers)" : ""}`,
    );
  }
  check(
    (await clusterState(origin)) === before,
    `${label}: indices, counts, mappings, aliases and templates read back the same`,
  );
}

/**
 * With security off there is no login to check, so the statement check is what keeps hidden targets from MCP. Each
 * statement below answers raw on 3.8.0, and through MCP each is refused before it is sent.
 */
async function checkHiddenTargets(agent: ManagedConnection): Promise<void> {
  const dot = `.${SCRATCH}`;
  const hid = `${SCRATCH}_hid`;
  const alias = `${SCRATCH}_alias`;
  const stream = `${SCRATCH}-ds`;
  const at = `${hid}@y`;
  try {
    const made = [
      await send(ORIGIN, "PUT", `/${dot}/_doc/1?refresh=true`, { probe: "dot" }),
      await send(ORIGIN, "PUT", `/${at}/_doc/1?refresh=true`, { probe: "at" }),
      await send(ORIGIN, "PUT", `/${hid}`, { settings: { "index.hidden": true } }),
      await send(ORIGIN, "PUT", `/${hid}/_doc/1?refresh=true`, { probe: "hidden" }),
      await send(ORIGIN, "POST", "/_aliases", { actions: [{ add: { index: hid, alias } }] }),
      await send(ORIGIN, "PUT", `/_index_template/${stream}_t`, {
        index_patterns: [`${stream}*`],
        data_stream: {},
        priority: 500,
      }),
      await send(ORIGIN, "POST", `/${stream}/_doc?refresh=true`, { "@timestamp": "2026-11-02T00:00:00Z", probe: "s" }),
    ];
    check(
      made.every((answer) => answer.status === 200 || answer.status === 201),
      `hidden: the script makes a dot-led index, a visible index named for the hidden one with @y, a hidden index, an alias over it and a data stream -> ${made.map((answer) => answer.status).join(",")}`,
    );
    const backing = (
      JSON.parse(await read(ORIGIN, `/_data_stream/${stream}`)) as {
        data_streams: { indices: { index_name: string }[] }[];
      }
    ).data_streams[0].indices[0].index_name;
    const cases: readonly [string, string][] = [
      [`SELECT COUNT(*) AS n FROM \`${dot}\``, unsent(DOT_INDEX_REFUSAL)],
      [`SELECT COUNT(*) AS n FROM ${hid}`, unsent(hiddenTargetRefusal(hid))],
      [`SELECT COUNT(*) AS n FROM ${alias}`, unsent(hiddenTargetRefusal(alias))],
      [`SELECT COUNT(*) AS n FROM \`${backing}\``, unsent(DOT_INDEX_REFUSAL)],
      ["SELECT COUNT(*) AS n FROM `*`", unsent(hiddenTargetRefusal("*"))],
      [`SELECT COUNT(*) AS n FROM \`${SCRATCH}*\``, unsent(hiddenTargetRefusal(`${SCRATCH}*`))],
      [`SELECT COUNT(*) AS n FROM ${hid} /* note */`, unsent(COMMENT_REFUSAL)],
      [`SELECT COUNT(*) AS n FROM ${hid} # note`, unsent(COMMENT_REFUSAL)],
      [`SELECT COUNT(*) AS n FROM "${hid}"`, unsent(CHARACTER_REFUSAL)],
    ];
    for (const [sql, refusal] of cases) {
      const rows = await rawRows(ORIGIN, sql);
      const { result, acquired } = await mcp(agent, { sql });
      // A double-quoted name is part of the index name to 3.8.0, so that one answers raw with no such index.
      const answered = sql.includes('"') ? rows === null : rows !== null && rows.length > 0;
      check(
        answered && textOf(result) === refusal && acquired.join() === "agent-read-only",
        `hidden: ${sql} ${sql.includes('"') ? "is refused raw too" : "answers raw"}, and MCP refuses it before it is sent -> ${textOf(result).slice(0, 110)}`,
      );
    }
    // A bare name ends at an `@` to 3.8.0: raw, `<hidden>@y` reads the hidden index, and only quoted the visible one.
    const bare = `SELECT probe FROM ${at}`;
    const bareRows = await rawRows(ORIGIN, bare);
    const quotedRows = await rawRows(ORIGIN, `SELECT probe FROM \`${at}\``);
    check(
      JSON.stringify(bareRows) === '[["hidden"]]' && JSON.stringify(quotedRows) === '[["at"]]',
      `hidden: raw, ${bare} answers the hidden index's rows and the quoted name the visible one's -> ${JSON.stringify(bareRows)} ${JSON.stringify(quotedRows)}`,
    );
    for (const arm of [RUN_READ_QUERY, UNFENCED]) {
      const { result, acquired } = await mcp(agent, { sql: bare }, arm);
      check(
        textOf(result) === unsent(CHARACTER_REFUSAL) && acquired.join() === "agent-read-only",
        `hidden: ${bare} is refused before it is sent, ${arm === UNFENCED ? "unfenced" : "through the fenced tool"} -> ${textOf(result).slice(0, 110)}`,
      );
    }
    const served = await mcp(agent, { sql: `SELECT probe FROM \`${stream}\`` }, RUN_READ_QUERY);
    check(
      JSON.stringify(rowsOf(served.result)) === '[{"probe":"s"}]',
      `hidden: the data stream read by its own name is served -> ${JSON.stringify(rowsOf(served.result))}`,
    );
  } finally {
    await send(ORIGIN, "DELETE", `/_data_stream/${stream}`);
    await send(ORIGIN, "DELETE", `/_index_template/${stream}_t`);
    await send(ORIGIN, "DELETE", `/${hid}`);
    await send(ORIGIN, "DELETE", `/${encodeURIComponent(at)}`);
    await send(ORIGIN, "DELETE", `/${dot}`);
  }
}

/**
 * The plugins' own indices on one node, named with no dot and marked neither hidden nor system: each answers sent raw
 * as the reader's login, and MCP refuses each before it is sent, by its name, through a wildcard, a comma list, an
 * alias over one and the one-table catalog read.
 */
async function checkPluginIndices(origin: URL, reader: ManagedConnection, label: string): Promise<void> {
  const view = `${SCRATCH}_pv`;
  const login = (reader as { user?: string }).user;
  const auth: Record<string, string> = login === undefined ? {} : { authorization: basic(login, USER_PASSWORD) };
  const present = (JSON.parse(await read(origin, "/_cat/indices?format=json&h=index&s=index")) as { index: string }[])
    .map((row) => row.index)
    .filter(inPluginFamily);
  const insights = present.find((index) => index.startsWith("top_queries-"));
  const audit = present.find((index) => index.startsWith("security-auditlog-"));
  check(
    insights !== undefined && (origin !== SECURED || audit !== undefined),
    `plugin (${label}): the node holds the query insights index${origin === SECURED ? " and the audit log" : ""} -> ${present.join(", ")}`,
  );
  if (insights === undefined) return;
  try {
    const made = await send(origin, "POST", "/_aliases", { actions: [{ add: { index: insights, alias: view } }] });
    check(made.status === 200, `plugin (${label}): the script makes an alias over ${insights} -> ${made.status}`);
    for (const reference of [...present, "t*", view]) {
      const raw = await fetch(new URL("/_plugins/_sql", origin), {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ query: `SELECT * FROM \`${reference}\` LIMIT 1` }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await raw.text();
      const rows = raw.status === 200 ? (JSON.parse(text) as { datarows: unknown[] }).datarows.length : -1;
      const needsRows = reference === insights || reference === audit || reference === "t*" || reference === view;
      check(
        raw.status === 200 && (!needsRows || rows > 0),
        `plugin (${label}): SELECT * FROM \`${reference}\` sent raw as the reader's login answers -> ${raw.status} ${rows} row(s)`,
      );
    }
    const references = [
      ...present,
      "t*",
      "top_queries-*",
      "probe_orders,top_queries-*",
      "probe_orders,t*",
      view,
      ...(origin === SECURED ? ["security-auditlog-*", "se*"] : []),
    ];
    const statements: [string, string][] = [
      ...references.map((reference): [string, string] => [`SELECT * FROM \`${reference}\` LIMIT 1`, reference]),
      ["DESCRIBE TABLES LIKE 'top_queries-*'", "top_queries-*"],
    ];
    for (const [sql, reference] of statements) {
      const { result, acquired } = await mcp(reader, { sql });
      check(
        textOf(result) === unsent(hiddenTargetRefusal(reference)) && acquired.join() === "agent-read-only",
        `plugin (${label}): ${sql} is refused before it is sent -> ${textOf(result).slice(0, 110)}`,
      );
    }
  } finally {
    await send(origin, "POST", "/_aliases", { actions: [{ remove: { index: insights, alias: view } }] });
  }
}

/** The security index, with security on: a role reading every index is refused it by the statement check. */
async function checkSecurityIndex(wide: ManagedConnection): Promise<void> {
  const raw = await send(SECURED, "POST", "/_plugins/_sql", { query: "SELECT * FROM `.opendistro_security`" });
  check(
    raw.status === 200 && raw.text.includes('"internalusers"'),
    `security index: sent raw as admin, it answers its columns -> ${raw.status}`,
  );
  for (const [sql, refusal] of [
    ["SELECT * FROM `.opendistro_security`", unsent(DOT_INDEX_REFUSAL)],
    ["SELECT * FROM .opendistro_security", unsent(FROM_REFUSAL)],
    ["SELECT COUNT(*) AS n FROM `*`", unsent(hiddenTargetRefusal("*"))],
  ] as const) {
    const { result, acquired } = await mcp(wide, { sql });
    check(
      textOf(result) === refusal && acquired.join() === "agent-read-only",
      `security index: as a role reading every index, ${sql} is refused unsent -> ${textOf(result).slice(0, 110)}`,
    );
  }
}

async function checkControl(agent: ManagedConnection): Promise<void> {
  try {
    const written = await send(ORIGIN, "PUT", `/${SCRATCH}/_doc/1?refresh=true`, { probe: "control" });
    check(written.status === 201, `control: a document written through the document API -> ${written.status}`);
    const back = await mcp(agent, { sql: `SELECT probe FROM ${SCRATCH}` }, RUN_READ_QUERY);
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
  for (const sql of [
    "WITH x AS (SELECT customer FROM probe_orders) SELECT customer FROM x",
    "VALUES (1), (2)",
    "TABLE probe_orders",
    "EXPLAIN SELECT customer FROM probe_orders",
  ]) {
    const { result } = await mcp(agent, { sql }, RUN_READ_QUERY);
    const raw = await send(ORIGIN, "POST", "/_plugins/_sql", { query: sql });
    check(
      textOf(result) === unsent(STATEMENT_REFUSAL) && raw.status === 400 && PLUGIN_REFUSAL.test(raw.text),
      `forms: ${sql} passes the MCP fence and the provider refuses it unsent; sent raw the plugin refuses it -> ${raw.status}`,
    );
  }
}

async function checkPaging(agent: ManagedConnection): Promise<void> {
  const first = await mcp(agent, { sql: "SELECT k FROM probe_buckets ORDER BY k", max_rows: 3 }, RUN_READ_QUERY);
  check(
    JSON.stringify(rowsOf(first.result)?.map((row) => row.k)) === '["k1","k10","k100"]' &&
      JSON.stringify(first.result.structuredContent?.pagination) ===
        '{"offset":0,"limit":3,"hasMore":true,"nextOffset":3,"wasLimited":true}' &&
      first.result.structuredContent?.hint === "Call again with offset 3 for the next page.",
    `paging: a read past max_rows names the next offset -> ${JSON.stringify(first.result.structuredContent?.pagination)}`,
  );
  const next = await mcp(
    agent,
    { sql: "SELECT k FROM probe_buckets ORDER BY k", max_rows: 3, offset: 3 },
    RUN_READ_QUERY,
  );
  check(
    JSON.stringify(rowsOf(next.result)?.map((row) => row.k)) === '["k1000","k1001","k1002"]' &&
      (next.result.structuredContent?.pagination as { nextOffset?: number } | undefined)?.nextOffset === 6,
    `paging: the next page asked for by offset answers the next rows -> ${JSON.stringify(rowsOf(next.result)?.map((row) => row.k))}`,
  );
  const own = await mcp(agent, { sql: "SELECT k FROM probe_buckets ORDER BY k LIMIT 5", offset: 3 }, RUN_READ_QUERY);
  check(
    textOf(own.result) ===
      "This query has its own LIMIT or TOP, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: LIMIT n OFFSET m.",
    `paging: an offset on a query with its own LIMIT is refused -> ${textOf(own.result)}`,
  );
}

async function checkLimits(agent: ManagedConnection): Promise<void> {
  const ROWS =
    "The result has more than 1000 rows, the most this server reads for one call. Add a LIMIT of 1000 or less, or remove your own LIMIT and page with offset.";
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
  // About 1.4 MiB of rows, inside the row budget.
  const bytes = await mcp(
    agent,
    { sql: `SELECT k, CONCAT(t, t, t, t, t, t, t, t) AS w FROM ${SCRATCH}_big LIMIT 900` },
    RUN_READ_QUERY,
  );
  check(
    textOf(bytes.result) ===
      "The result is larger than 1 MiB, the most this server reads for one call. Select fewer or narrower columns, or add a smaller LIMIT.",
    `limits: a read past 1 MiB -> ${textOf(bytes.result)}`,
  );
  check((await openContexts()) === 0, "limits: no search context stays open after the byte refusal");
}

/** A statement the node takes about nine seconds over, on the 300,000-document scratch index. */
function slow(): string {
  const terms = Array.from({ length: 3 }, (_, i) => `LOCATE('z${i}', CONCAT(t, t, t, t, t, t, t, t)) > 0`).join(" OR ");
  // A random literal, so the shard request cache never answers it.
  return `SELECT k FROM ${SCRATCH}_big WHERE ${terms} OR k = 'r${randomBytes(4).toString("hex")}' LIMIT 2000`;
}

async function checkTimeAndCancel(agent: ManagedConnection): Promise<void> {
  const timed = await mcp(agent, { sql: slow(), timeout_ms: 1_000 }, RUN_READ_QUERY);
  check(
    textOf(timed.result) ===
      "The statement did not finish within timeout_ms (1000 ms). Narrow it, or raise timeout_ms up to 30000.",
    `time: past timeout_ms -> ${textOf(timed.result)}`,
  );
  const runningAfterTimeout = await searchTasks();
  check(
    runningAfterTimeout > 0,
    `time: the search runs on in the cluster after the timeout -> ${runningAfterTimeout} search task(s)`,
  );
  check(
    await within(60_000, async () => (await searchTasks()) === 0 && (await openContexts()) === 0),
    "time: once it ends, no search task and no search context is left",
  );

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1_000);
  const cancelled = await mcp(agent, { sql: slow(), timeout_ms: 20_000 }, RUN_READ_QUERY, controller.signal);
  check(
    textOf(cancelled.result) === "The call was cancelled before it finished.",
    `cancel: a client close -> ${textOf(cancelled.result)}`,
  );
  const runningAfterCancel = await searchTasks();
  check(
    runningAfterCancel > 0,
    `cancel: the search runs on in the cluster after the close -> ${runningAfterCancel} search task(s)`,
  );
  check(
    await within(60_000, async () => (await searchTasks()) === 0 && (await openContexts()) === 0),
    "cancel: once it ends, no search task and no search context is left",
  );
  const next = await mcp(agent, { sql: "SELECT COUNT(*) AS n FROM probe_buckets" }, RUN_READ_QUERY);
  check(
    JSON.stringify(rowsOf(next.result)) === '[{"n":1500}]',
    `time: the node answers the next call -> ${JSON.stringify(rowsOf(next.result))}`,
  );
}

/** The 300,000-document index the slow statement and the byte refusal read, about 200 bytes of text each. */
async function makeBigIndex(): Promise<void> {
  const big = `${SCRATCH}_big`;
  await send(ORIGIN, "PUT", `/${big}`, {
    settings: { number_of_replicas: 0 },
    mappings: { properties: { k: { type: "keyword" }, t: { type: "keyword" } } },
  });
  const letters = "abcdefghijklmnopqrst";
  for (let batch = 0; batch < 30; batch++) {
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const t = Array.from({ length: 200 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
      lines.push('{"index":{}}', JSON.stringify({ k: `k${batch * 10_000 + i}`, t }));
    }
    const response = await fetch(new URL(`/${big}/_bulk`, ORIGIN), {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: `${lines.join("\n")}\n`,
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status !== 200) throw new Error(`bulk: ${response.status}`);
    await response.text();
  }
  await send(ORIGIN, "POST", `/${big}/_refresh`);
  const count = JSON.parse(await read(ORIGIN, `/${big}/_count`)) as { count: number };
  check(count.count === 300_000, `setup: the scratch index holds 300,000 documents -> ${count.count}`);
}

async function main(): Promise<void> {
  const agent = seed("os-3-8", ORIGIN);
  const { seedRole, wide } = await checkOpen(agent);
  await checkHiddenTargets(agent);
  await checkPluginIndices(ORIGIN, agent, "security off");
  await checkPluginIndices(SECURED, wide, "security on, a role reading every index");
  await checkBoundary(ORIGIN, agent, "boundary");
  await checkBoundary(SECURED, seedRole, "boundary as the seed role");
  await checkSecurityIndex(wide);
  await checkControl(agent);
  await checkForms(agent);
  await checkPaging(agent);
  await makeBigIndex();
  await checkLimits(agent);
  await checkTimeAndCancel(agent);
}

try {
  await main();
} finally {
  await send(ORIGIN, "DELETE", `/${SCRATCH}`);
  await send(ORIGIN, "DELETE", `/${SCRATCH}_big`);
  for (const kind of LOGIN_KINDS) {
    await send(SECURED, "DELETE", `/_plugins/_security/api/internalusers/${SCRATCH}_${kind}`);
    await send(SECURED, "DELETE", `/_plugins/_security/api/roles/${SCRATCH}_${kind}`);
  }
  await clearProviderCache();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

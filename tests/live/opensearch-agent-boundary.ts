/**
 * Live check of the OpenSearch agent read-only execution profile, against a single node.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The profile's boundary is the engine's: the SQL plugin refuses
 * every write and DDL statement sent to its endpoint, the one route the provider sends statement text to, and the one
 * DELETE its grammar holds is off, which the open proves. The provider suite replays the answers
 * tests/live/opensearch-write-refusals.ts captured; whether a node still refuses them, whether the open's proof reads
 * the node right, and whether the production path holds its budgets and closes its cursors against real answers, is
 * the node's to say. So this script asks one, through the production path (`createDatabaseProvider` with the agent
 * profile's execution context, then `connect` and `queryReadOnly`), with no admission of Studio's in front.
 *
 * Against a 3.8.0 node (the default):
 *
 *  - the open: the agent profile reads the DELETE setting, sends its DELETE probe, reads the version and opens the
 *    node; the operations profile opens it too, and an editor handle's `queryReadOnly` refuses with nothing sent;
 *  - the boundary: each write and DDL statement sent through `queryReadOnly` is refused by the plugin in its own words
 *    (never a budget or a credential refusal), and the same text sent raw answers 400; the index listing with its
 *    document counts, the probe mappings, the aliases and the templates read back the same before and after; the
 *    positive control is a document written through the document API, a route the provider does not send to, into a
 *    scratch index the agent then reads and the script deletes;
 *  - the budgets: a plain read and an aggregation past the row budget, a read past the byte budget and a statement
 *    past its deadline are each refused, never truncated; with the engine's `plugins.query.size_limit` lowered to 1000,
 *    a read past it answers 1000 rows and a cursor: past a smaller row budget it is refused and that cursor closed (the
 *    node's open search contexts go back to where they were), and past a larger one it is refused as cut at the limit,
 *    and so is an aggregation the engine cuts there; the agent handle opened before the limit was lowered refuses the
 *    same cut read, since the limit is read before every statement, never kept from the open;
 *  - the catalog read: the `DESCRIBE TABLES` command the agent's OpenSearch overlay composes, for every table and for
 *    one, sent through `queryReadOnly` and mapped into column rows, with the cluster unchanged afterwards;
 *  - with security on (LIBREDB_OS_AGENT_USER set): the agent user's role holds the cluster actions
 *    `cluster:monitor/main` and `cluster:monitor/state` and, on `probe_*`, `read`, `indices:admin/mappings/get` and
 *    `indices:monitor/settings/get`; without either cluster action the agent profile is refused at open; the user reads
 *    no cluster health, its document write is refused 403, an index outside its role is refused, and the every-table
 *    catalog read is refused while the one-table read answers;
 *  - with security on, plan-mode grounding: the plan run's schema read (`captureContextSnapshot` in planning mode,
 *    under the operations profile, signed in as the same user) is refused on the agent's role alone, captures once the
 *    role adds the privileges in PLAN_CLUSTER and PLAN_INDICES (the index ones on every index), and is refused again
 *    with any one of them taken away; the agent profile still opens under that wider role.
 *
 * Against an older node (LIBREDB_OS_EXPECT_REFUSED=1, a 2.19.4 node with security off): the agent profile is refused at
 * open by the version check, since only 3.8 is admitted; with `plugins.sql.delete.enabled` turned on, it is refused
 * before that by the setting read, and no DELETE reaches the node; the operations profile opens either way.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against a node seeded per section 11.4
 * of docs/providers/opensearch.md:
 *
 *   LIBREDB_OS_ORIGIN=http://127.0.0.1:9201 bun tests/live/opensearch-agent-boundary.ts
 *
 * For the security-on pass, LIBREDB_OS_ORIGIN is the node's https origin, NODE_TLS_REJECT_UNAUTHORIZED=0 accepts its
 * demo certificate for the script's own requests, LIBREDB_OS_ADMIN_USER and LIBREDB_OS_ADMIN_PASSWORD name the admin
 * the script uses for the state reads, the positive control and the role, and LIBREDB_OS_AGENT_USER and
 * LIBREDB_OS_AGENT_PASSWORD the least-privilege user the script creates and the agent signs in as. The scratch index is
 * named `libredb_lb_<random>` and deleted before exit. Each check prints one line, and the first that fails ends the
 * run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the node holds after the one before.
import { randomBytes } from "node:crypto";
import { composeCatalogRead } from "@/lib/agent/composed-sql";
import { captureContextSnapshot } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { engineServerDialect } from "@/lib/agent/languages/engines/server";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import type { AgentToolContext } from "@/lib/agent/tools";
import { createDatabaseProvider, executionContextFor } from "@/lib/db/factory";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const ORIGIN = new URL(process.env.LIBREDB_OS_ORIGIN ?? "http://127.0.0.1:9201");
const ADMIN_USER = process.env.LIBREDB_OS_ADMIN_USER;
const ADMIN_PASSWORD = process.env.LIBREDB_OS_ADMIN_PASSWORD ?? "";
const AGENT_USER = process.env.LIBREDB_OS_AGENT_USER;
const AGENT_PASSWORD = process.env.LIBREDB_OS_AGENT_PASSWORD ?? "";
const SECURED = ADMIN_USER !== undefined && AGENT_USER !== undefined;
const EXPECT_REFUSED = process.env.LIBREDB_OS_EXPECT_REFUSED === "1";
const AGENT_ROLE = "libredb_agent_read";
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 10_000, maxResultRows: 2_000, maxResultBytes: 1_000_000 };
const SCRATCH = `libredb_lb_${randomBytes(4).toString("hex")}`;
const DELETE_SETTING = "plugins.sql.delete.enabled";
const SIZE_LIMIT_SETTING = "plugins.query.size_limit";

const WRITES: readonly string[] = [
  "INSERT INTO probe_orders (id, customer) VALUES (2, 'probe')",
  "INSERT INTO probe_orders SELECT * FROM probe_orders",
  "UPDATE probe_orders SET customer = 'x' WHERE id = 1",
  "DELETE FROM probe_orders",
  "CREATE TABLE libredb_lb_t (id BIGINT)",
  "CREATE INDEX libredb_lb_i ON probe_orders (customer)",
  "DROP TABLE probe_orders",
  "ALTER TABLE probe_orders ADD COLUMN libredb_lb INT",
  "TRUNCATE TABLE probe_orders",
  "MERGE INTO probe_orders USING probe_orders AS s ON true WHEN MATCHED THEN DELETE",
  "EXPLAIN DELETE FROM probe_orders",
  "WITH x AS (SELECT 1) DELETE FROM probe_orders",
  "SELECT 1; DELETE FROM probe_orders",
];

/** The plugin's refusals, as the provider carries them through: the engine's own text. */
const PLUGIN_REFUSAL = /Query must start with SELECT, DELETE, SHOW or DESCRIBE: |Illegal SQL expression : /;

let checks = 0;
function check(ok: boolean, line: string): void {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"} ${checks} ${line}`);
  if (!ok) {
    console.error(`check ${checks} failed`);
    process.exitCode = 1;
    throw new Error(line);
  }
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

const ADMIN_AUTH = ADMIN_USER === undefined ? undefined : basic(ADMIN_USER, ADMIN_PASSWORD);

/** A request past every check of Studio's, as the admin when there is one. */
async function send(
  method: string,
  pathname: string,
  body?: unknown,
  auth = ADMIN_AUTH,
): Promise<{ status: number; text: string }> {
  const response = await fetch(new URL(pathname, ORIGIN), {
    method,
    headers: { "content-type": "application/json", ...(auth === undefined ? {} : { authorization: auth }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, text: await response.text() };
}

async function read(pathname: string): Promise<string> {
  const answer = await send("GET", pathname);
  if (answer.status !== 200) throw new Error(`state read ${pathname}: ${answer.status} ${answer.text}`);
  return answer.text;
}

/** Whether an index is one the node writes on its own, or the script's scratch index. */
function unwatched(index: string): boolean {
  return (
    index.startsWith(".") ||
    index.startsWith("top_queries-") ||
    index.startsWith("security-auditlog-") ||
    index === SCRATCH
  );
}

/** Everything a write or a DDL statement could change, as one text. */
async function clusterState(): Promise<string> {
  await send("POST", "/_refresh");
  const indices = (
    JSON.parse(await read("/_cat/indices?format=json&h=index,docs.count,status&s=index")) as { index: string }[]
  ).filter((row) => !unwatched(row.index));
  return [
    `indices ${JSON.stringify(indices)}`,
    `mappings ${await read("/probe_*/_mapping")}`,
    `aliases ${await read("/_cat/aliases?format=json&s=alias")}`,
    `templates ${await read("/_cat/templates?format=json&s=name")}`,
  ].join("\n");
}

/** The search contexts the node holds open, summed over its nodes: a cursor left open is one of them. */
async function openContexts(): Promise<number> {
  const stats = JSON.parse(await read("/_nodes/stats/indices/search")) as {
    nodes: Record<string, { indices: { search: { open_contexts: number } } }>;
  };
  return Object.values(stats.nodes).reduce((sum, node) => sum + node.indices.search.open_contexts, 0);
}

async function setCluster(setting: string, value: unknown): Promise<void> {
  const answer = await send("PUT", "/_cluster/settings", { transient: { [setting]: value } });
  if (answer.status !== 200) throw new Error(`setting ${setting}: ${answer.status} ${answer.text}`);
}

function connection(): DatabaseConnection {
  return {
    id: "opensearch-live",
    name: "OpenSearch live",
    type: "opensearch",
    host: ORIGIN.hostname,
    port: Number(ORIGIN.port),
    ...(ORIGIN.protocol === "https:" ? { ssl: { mode: "require" } } : {}),
    ...(AGENT_USER === undefined ? {} : { user: AGENT_USER, password: AGENT_PASSWORD }),
    createdAt: new Date(0),
  } as DatabaseConnection;
}

async function open(profile?: "agent-read-only" | "agent-operations"): Promise<DatabaseProvider> {
  const provider = await createDatabaseProvider(
    connection(),
    {},
    profile === undefined ? {} : executionContextFor(profile),
  );
  await provider.connect();
  return provider;
}

async function refusalOf(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error as Error;
  }
}

/** The agent's role, measured on 3.8.0 with security on: each action below was refused without it. */
const AGENT_CLUSTER = ["cluster:monitor/main", "cluster:monitor/state"] as const;
const AGENT_INDICES = ["read", "indices:admin/mappings/get", "indices:monitor/settings/get"] as const;

/** What plan mode adds to the agent's role, each measured as needed on 3.8.0; the index ones on every index. */
const PLAN_CLUSTER = [
  "cluster:monitor/health",
  "cluster:admin/ingest/pipeline/get",
  "indices:admin/index_template/get",
] as const;
const PLAN_INDICES = [
  "indices:monitor/settings/get",
  "indices:monitor/stats",
  "indices:admin/aliases/get",
  "indices:admin/data_stream/get",
  "indices:admin/mappings/get",
] as const;

async function setAgentRole(
  cluster: readonly string[],
  indexPrivileges: readonly string[],
  everyIndex: readonly string[] = [],
): Promise<void> {
  const role = await send("PUT", `/_plugins/_security/api/roles/${AGENT_ROLE}`, {
    cluster_permissions: cluster,
    index_permissions: [
      { index_patterns: ["probe_*"], allowed_actions: indexPrivileges },
      ...(everyIndex.length === 0 ? [] : [{ index_patterns: ["*"], allowed_actions: everyIndex }]),
    ],
  });
  if (role.status !== 200 && role.status !== 201) throw new Error(`role update: ${role.status} ${role.text}`);
}

/**
 * The agent user, created by the admin with the agent's role. The role is first set without each of its two cluster
 * actions in turn, to show the open refuses a server whose DELETE setting or version it cannot read.
 */
async function createAgentUser(): Promise<void> {
  if (!SECURED) return;
  await setAgentRole(["cluster:monitor/main"], AGENT_INDICES);
  const user = await send("PUT", `/_plugins/_security/api/internalusers/${AGENT_USER}`, {
    password: AGENT_PASSWORD,
    opendistro_security_roles: [AGENT_ROLE],
  });
  check(user.status === 200 || user.status === 201, `security: the admin creates the agent user -> ${user.status}`);
  const unsettled = await refusalOf(() => open("agent-read-only"));
  check(
    unsettled?.name === "ExecutionProfileError" && unsettled.message.includes("cluster:monitor/state"),
    `security: without cluster:monitor/state the setting is unread and the agent profile refused -> ${unsettled?.message.slice(0, 110)}`,
  );
  await setAgentRole(["cluster:monitor/state"], AGENT_INDICES);
  const unversioned = await refusalOf(() => open("agent-read-only"));
  check(
    unversioned?.name === "ExecutionProfileError" && unversioned.message.includes("cluster:monitor/main"),
    `security: without cluster:monitor/main the version is unread and the agent profile refused -> ${unversioned?.message.slice(0, 110)}`,
  );
  await setAgentRole(AGENT_CLUSTER, AGENT_INDICES);
  const health = await send("GET", "/_cluster/health", undefined, basic(AGENT_USER, AGENT_PASSWORD));
  check(health.status === 403, `security: the agent's role reads no cluster health -> ${health.status}`);
}

/** The plan run's schema read, as a plan run takes it: planning mode, under the operations profile. */
async function planGrounding(): Promise<Awaited<ReturnType<typeof captureContextSnapshot>>> {
  const provider = await open("agent-operations");
  const clock = () => Date.now();
  const context: AgentToolContext = {
    runId: "opensearch-live-plan",
    modelId: "unmeasured-model-for-tests",
    mode: "planning",
    workflowType: "investigation",
    actor: { sessionId: "opensearch-live", role: "user" },
    connection: connection(),
    capabilities: provider.getCapabilities(),
    labels: provider.getLabels(),
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection().id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, clock),
    repairs: new AgentRepairLedger(),
    acquireProvider: async () => provider,
    clock,
  };
  try {
    return await captureContextSnapshot(context);
  } finally {
    await provider.disconnect();
  }
}

/**
 * Plan mode grounds through the provider's object surface with the connection's own login, and the cluster-wide
 * listings it reads (indices, aliases, data streams) answer 403 to a role that does not cover every index they list,
 * so plan mode's index privileges are on every index. A seed carries one login only (B85), so on a seed that login
 * holds the agent's role and plan mode's additions together.
 */
async function checkPlanGrounding(): Promise<void> {
  if (!SECURED) return;
  const refused = await planGrounding();
  check(
    refused.kind === "unavailable" && refused.reasonCode === "CATALOG_READ_REFUSED",
    `plan: on the agent's role alone the plan run's schema read is refused -> ${refused.kind}`,
  );
  await setAgentRole([...AGENT_CLUSTER, ...PLAN_CLUSTER], AGENT_INDICES, PLAN_INDICES);
  const grounded = await planGrounding();
  const kinds = grounded.kind === "captured" ? [...new Set(grounded.snapshot.objects.map((o) => o.kind))].sort() : [];
  check(
    grounded.kind === "captured" && kinds.includes("index"),
    `plan: with plan mode's privileges added it captures -> ${grounded.kind} ${kinds.join(", ")}`,
  );
  const agent = await open("agent-read-only");
  check(agent.isConnected(), "plan: the agent profile still opens under the wider role");
  await agent.disconnect();
  for (const missing of [...PLAN_CLUSTER, ...PLAN_INDICES]) {
    await setAgentRole(
      [...AGENT_CLUSTER, ...PLAN_CLUSTER.filter((action) => action !== missing)],
      AGENT_INDICES,
      PLAN_INDICES.filter((action) => action !== missing),
    );
    const capture = await planGrounding();
    check(
      capture.kind === "unavailable",
      `plan: without ${missing} the schema read is refused again -> ${capture.kind}`,
    );
  }
  await setAgentRole(AGENT_CLUSTER, AGENT_INDICES);
}

/** An older node: the version check refuses it, and the setting read refuses it first once the setting is on. */
async function checkRefusedNode(): Promise<void> {
  const version = (JSON.parse(await read("/")) as { version: { number: string } }).version.number;
  const off = await refusalOf(() => open("agent-read-only"));
  check(
    off?.name === "ExecutionProfileError" &&
      off.message ===
        `The agent read-only profile is checked on OpenSearch 3.8, and this server reports OpenSearch ${version}: its write refusals have not been captured, so it is refused`,
    `version: with the DELETE setting off, ${version} passes the DELETE proof and is refused by the version check -> ${off?.message}`,
  );
  const scratch = await send("PUT", `/${SCRATCH}/_doc/1?refresh=true`, { probe: "kept" });
  check(scratch.status === 201, `setting: a scratch document is written -> ${scratch.status}`);
  await setCluster(DELETE_SETTING, true);
  try {
    const on = await refusalOf(() => open("agent-read-only"));
    check(
      on?.name === "ExecutionProfileError" &&
        on.message ===
          `The agent read-only profile needs OpenSearch SQL's DELETE off, and this server's ${DELETE_SETTING} reads true, so it is refused`,
      `setting: with the DELETE setting on the agent profile is refused before the version check -> ${on?.message}`,
    );
    const deleted = await send("POST", "/_plugins/_sql", { query: `DELETE FROM ${SCRATCH}` });
    check(
      deleted.status === 200 && deleted.text.includes("deleted_rows"),
      `setting: and with it on, a DELETE sent raw deletes -> ${deleted.status} ${deleted.text.replaceAll(/\s+/g, "").slice(0, 80)}`,
    );
  } finally {
    await setCluster(DELETE_SETTING, null);
    await send("DELETE", `/${SCRATCH}`);
  }
  const operations = await open("agent-operations");
  check(operations.isConnected(), "open: the operations profile opens the same node");
  await operations.disconnect();
}

async function checkBoundary(agent: DatabaseProvider): Promise<string> {
  const before = await clusterState();
  for (const sql of WRITES) {
    const viaProvider = await refusalOf(() => agent.queryReadOnly!(sql, BUDGET));
    check(
      viaProvider !== null && PLUGIN_REFUSAL.test(viaProvider.message),
      `boundary: queryReadOnly sends ${sql} and the plugin refuses it (${viaProvider?.message.slice(0, 60)})`,
    );
    const answer = await send("POST", "/_plugins/_sql", { query: sql });
    check(answer.status === 400, `boundary: ${sql} sent raw -> ${answer.status}`);
  }
  check(
    (await clusterState()) === before,
    "boundary: indices, counts, mappings, aliases and templates read back the same",
  );

  // The positive control: a document written through the document API, a route the provider does not send to.
  try {
    if (SECURED) {
      const own = await send(
        "PUT",
        `/probe_orders/_doc/libredb-lb?refresh=true`,
        { id: 9 },
        basic(AGENT_USER, AGENT_PASSWORD),
      );
      check(own.status === 403, `security: the agent user's own document write is refused -> ${own.status}`);
    }
    const written = await send("PUT", `/${SCRATCH}/_doc/1?refresh=true`, { probe: "control" });
    check(written.status === 201, `control: a document written through the document API -> ${written.status}`);
    if (SECURED) {
      const outside = await refusalOf(() => agent.queryReadOnly!(`SELECT probe FROM ${SCRATCH}`, BUDGET));
      check(
        outside !== null,
        `security: an index outside the agent's role is refused -> ${outside?.message.slice(0, 80)}`,
      );
      const described = await refusalOf(() =>
        agent.queryReadOnly!(composeCatalogRead("opensearch", { kind: "columns", table: SCRATCH }), BUDGET),
      );
      check(described !== null, `security: and so is its catalog read -> ${described?.message.slice(0, 80)}`);
    } else {
      const control = await agent.queryReadOnly!(`SELECT probe FROM ${SCRATCH}`, BUDGET);
      check(
        control.rowCount === 1,
        `control: the agent reads the written document back -> ${JSON.stringify(control.rows)}`,
      );
    }
  } finally {
    await send("DELETE", `/${SCRATCH}`);
  }
  return before;
}

async function checkBudgets(agent: DatabaseProvider): Promise<void> {
  const rows = await refusalOf(() =>
    agent.queryReadOnly!("SELECT k FROM probe_buckets", { ...BUDGET, maxResultRows: 100 }),
  );
  check(
    rows?.message === "Read-only execution exceeded the row budget: 1500 rows > 100 allowed",
    `budget: a plain read past the row budget -> ${rows?.message}`,
  );
  const groups = await refusalOf(() =>
    agent.queryReadOnly!("SELECT k, COUNT(*) AS n FROM probe_buckets GROUP BY k", { ...BUDGET, maxResultRows: 100 }),
  );
  check(
    groups?.message === "Read-only execution exceeded the row budget: 1500 rows > 100 allowed",
    `budget: an aggregation past the row budget -> ${groups?.message}`,
  );
  const bytes = await refusalOf(() =>
    agent.queryReadOnly!("SELECT k FROM probe_buckets", { ...BUDGET, maxResultBytes: 1_000 }),
  );
  check(
    bytes?.message.startsWith("Read-only execution exceeded the byte budget") === true,
    `budget: a read past the byte budget -> ${bytes?.message}`,
  );
  const slow = await refusalOf(() =>
    agent.queryReadOnly!("SELECT k, COUNT(*) AS n FROM probe_buckets GROUP BY k", { ...BUDGET, statementTimeoutMs: 1 }),
  );
  check(
    slow?.message === "Read-only execution exceeded the time budget: no answer within 1ms",
    `budget: a statement past its deadline -> ${slow?.message}`,
  );
  const plan = await refusalOf(() => agent.queryReadOnly!("SELECT 1", BUDGET, "estimate-plan"));
  check(
    plan?.message === "OpenSearch composes no estimating plan for the agent",
    `mode: the estimate-plan mode is refused -> ${plan?.message}`,
  );

  const count = await agent.queryReadOnly!("SELECT COUNT(*) AS n FROM probe_buckets", BUDGET);
  check(count.rows[0]?.n === 1500, `read: the agent counts probe_buckets -> ${JSON.stringify(count.rows)}`);
  const all = await agent.queryReadOnly!("SELECT k FROM probe_buckets", { ...BUDGET, maxResultRows: 1_500 });
  check(all.rowCount === 1500, `read: an answer of exactly the row budget is returned whole -> ${all.rowCount}`);
  const grouped = await agent.queryReadOnly!("SELECT k, COUNT(*) AS n FROM probe_buckets GROUP BY k", BUDGET);
  check(grouped.rowCount === 1500, `read: an aggregation within the budget is returned whole -> ${grouped.rowCount}`);

  // The engine's result limit: a read past it answers that many rows and a cursor whose next page holds no row, so an
  // answer that reaches the limit is refused. The limit is read before every statement, so the handle opened before
  // it was lowered sees the new limit as one opened after does.
  await setCluster(SIZE_LIMIT_SETTING, 1_000);
  try {
    const stale = await refusalOf(() =>
      agent.queryReadOnly!("SELECT k FROM probe_buckets", { ...BUDGET, maxResultRows: 1_500 }),
    );
    check(
      stale?.message ===
        `Read-only execution exceeded the row budget: OpenSearch answers at most 1000 rows (${SIZE_LIMIT_SETTING}) and cuts the rest without saying so, so an answer that reaches it is refused`,
      `limit: a handle opened at the default limit refuses a read cut at the lowered one -> ${stale?.message}`,
    );
    const limited = await open("agent-read-only");
    const contexts = await openContexts();
    const paged = await refusalOf(() =>
      limited.queryReadOnly!("SELECT k FROM probe_buckets", { ...BUDGET, maxResultRows: 900 }),
    );
    check(
      paged?.message === "Read-only execution exceeded the row budget: 1000 rows > 900 allowed",
      `limit: a first page past the row budget is refused -> ${paged?.message}`,
    );
    check(
      (await openContexts()) === contexts,
      `limit: and the cursor it left open is closed (open search contexts back to ${contexts})`,
    );
    const CUT = `Read-only execution exceeded the row budget: OpenSearch answers at most 1000 rows (${SIZE_LIMIT_SETTING}) and cuts the rest without saying so, so an answer that reaches it is refused`;
    const cut = await refusalOf(() =>
      limited.queryReadOnly!("SELECT k FROM probe_buckets", { ...BUDGET, maxResultRows: 1_500 }),
    );
    check(
      cut?.message === CUT,
      `limit: a read the engine cuts at its limit is refused, not returned cut -> ${cut?.message}`,
    );
    const cutGroups = await refusalOf(() =>
      limited.queryReadOnly!("SELECT k, COUNT(*) AS n FROM probe_buckets GROUP BY k", {
        ...BUDGET,
        maxResultRows: 1_500,
      }),
    );
    check(cutGroups?.message === CUT, `limit: and so is an aggregation it cuts -> ${cutGroups?.message}`);
    check((await openContexts()) === contexts, "limit: no search context stays open after them");
    const within = await limited.queryReadOnly!("SELECT k FROM probe_buckets LIMIT 999", {
      ...BUDGET,
      maxResultRows: 1_500,
    });
    check(within.rowCount === 999, `limit: an answer below the limit is returned whole -> ${within.rowCount}`);
    await limited.disconnect();
  } finally {
    await setCluster(SIZE_LIMIT_SETTING, null);
  }
}

async function checkCatalog(agent: DatabaseProvider, before: string): Promise<void> {
  const catalogRead = engineServerDialect("opensearch").catalogRead;
  if (catalogRead === "unsupported" || catalogRead.mapRows === undefined) throw new Error("no catalog read to check");
  const everyTable = composeCatalogRead("opensearch", { kind: "columns" });
  if (SECURED) {
    const refused = await refusalOf(() => agent.queryReadOnly!(everyTable, BUDGET));
    check(
      refused?.message === "OpenSearch refused the credentials (HTTP 403)",
      `catalog: ${everyTable} names every index, so a role on probe_* alone is refused it -> ${refused?.message.slice(0, 90)}`,
    );
  } else {
    const inventory = catalogRead.mapRows("columns", (await agent.queryReadOnly!(everyTable, BUDGET)).rows);
    const tables = [...new Set(inventory.rows.map((row) => String(row.table_name)))].sort();
    check(
      inventory.rows.some((row) => row.table_name === "probe_orders" && row.column_name === "customer"),
      `catalog: ${everyTable} answers the column inventory -> ${inventory.rows.length} columns of ${tables.join(", ")}`,
    );
  }
  const oneTable = composeCatalogRead("opensearch", { kind: "columns", table: "probe_orders" });
  const columns = catalogRead.mapRows("columns", (await agent.queryReadOnly!(oneTable, BUDGET)).rows);
  check(
    columns.rows.length > 0 && columns.rows.every((row) => row.table_name === "probe_orders"),
    `catalog: ${oneTable} answers that table's columns -> ${columns.rows.map((row) => row.column_name).join(", ")}`,
  );
  check((await clusterState()) === before, "catalog: the cluster reads back the same after the catalog reads");
}

async function main(): Promise<void> {
  if (EXPECT_REFUSED) {
    await checkRefusedNode();
    console.log(`${checks} checks passed`);
    return;
  }
  await createAgentUser();
  await checkPlanGrounding();
  const agent = await open("agent-read-only");
  check(agent.isConnected(), "open: the agent profile proves the DELETE off, reads the version and opens the node");
  const operations = await open("agent-operations");
  check(operations.isConnected(), "open: the operations profile opens the same node");
  await operations.disconnect();
  const editor = await open();
  const editorRefusal = await refusalOf(() => editor.queryReadOnly!("SELECT 1", BUDGET));
  check(
    editorRefusal?.message === "Read-only execution requires a provider opened under the agent read-only profile",
    `open: an editor handle's queryReadOnly refuses -> ${editorRefusal?.message}`,
  );
  await editor.disconnect();

  const before = await checkBoundary(agent);
  await checkBudgets(agent);
  await checkCatalog(agent, before);
  await agent.disconnect();

  if (SECURED) {
    await send("DELETE", `/_plugins/_security/api/internalusers/${AGENT_USER}`);
    await send("DELETE", `/_plugins/_security/api/roles/${AGENT_ROLE}`);
  }
  console.log(`${checks} checks passed`);
}

await main();

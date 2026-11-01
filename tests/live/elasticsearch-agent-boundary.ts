/**
 * Live check of the Elasticsearch agent read-only execution profile, against a single 9.1.4 node.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The profile's boundary is the engine's: the grammar of the SQL
 * endpoint holds no write or DDL statement, and that endpoint is the one route the provider sends statement text to.
 * The provider suite replays the answers tests/live/elasticsearch-write-refusals.ts captured; whether a node still
 * refuses them, and whether the production path holds its budgets and closes its cursors against real answers, is the
 * node's to say. So this script asks one, through the production path (`createDatabaseProvider` with the agent
 * profile's execution context, then `connect` and `queryReadOnly`), with no admission of Studio's in front:
 *
 *  - the open: the agent profile reads the node's version and opens it, the operations profile opens it too, and an
 *    editor handle's `queryReadOnly` refuses with nothing sent;
 *  - the boundary: each write and DDL statement sent through `queryReadOnly` is refused by the grammar in the engine's
 *    own words (a `line 1:N: mismatched input` or `extraneous input` refusal, never a budget or a credential refusal),
 *    a `DEBUG` command by the provider's catalog-command fence before it is sent,
 *    and the same text sent raw answers 400 `parsing_exception`; the index listing with its document counts, every
 *    mapping, the aliases, the templates and the pipelines read back the same before and after; the positive control
 *    is a document written through the document API, a route the provider does not send to, into a scratch index the
 *    agent then reads and the script deletes;
 *  - the catalog read: the `SYS COLUMNS` command the agent's Elasticsearch overlay composes, for every table and for
 *    one, sent through `queryReadOnly` and mapped into column rows, with the cluster unchanged afterwards; with security
 *    on, the agent user's inventory holds only the tables its role reads;
 *  - the budgets: a result past the row budget (a plain read and an aggregation), past the byte budget, and a
 *    statement past its deadline are each refused, never truncated, and after each refusal the node holds no open
 *    search context: the cursor the answer left open was closed; a read within the budgets answers its rows;
 *  - with security on (LIBREDB_ES_AGENT_USER set): the agent user holds only `read` and `view_index_metadata` on
 *    `probe_*` and the cluster action `cluster:monitor/main`; without that action the agent profile is refused at open,
 *    since the version cannot be read; its own document write is refused 403, and an index outside its role is
 *    refused;
 *  - with security on, plan-mode grounding: the plan run's schema read (`captureContextSnapshot` in planning mode,
 *    under the operations profile, signed in as the same user) is refused on the agent's role alone, captures once the
 *    role adds the cluster privileges `monitor` and `read_pipeline` and the index privilege `monitor`, and is refused
 *    again with any one of the three taken away; the agent profile still opens under that wider role.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against a node seeded per section 11.4
 * of docs/providers/elasticsearch.md:
 *
 *   bun tests/live/elasticsearch-agent-boundary.ts
 *
 * LIBREDB_ES_ORIGIN names the node (default http://127.0.0.1:9200). For the security-on pass, LIBREDB_ES_ADMIN_USER
 * and LIBREDB_ES_ADMIN_PASSWORD name a superuser the script uses for the state reads, the positive control and the
 * role, and LIBREDB_ES_AGENT_USER and LIBREDB_ES_AGENT_PASSWORD the least-privilege user the script creates and the
 * agent signs in as. The scratch index is named `libredb_lb_<random>` and deleted before exit. Each check prints one
 * line, and the first that fails ends the run non-zero.
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
import { CATALOG_COMMAND_REFUSAL } from "@/lib/db/providers/sql/search/agent-index-fence";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const ORIGIN = new URL(process.env.LIBREDB_ES_ORIGIN ?? "http://127.0.0.1:9200");
const ADMIN_USER = process.env.LIBREDB_ES_ADMIN_USER;
const ADMIN_PASSWORD = process.env.LIBREDB_ES_ADMIN_PASSWORD ?? "";
const AGENT_USER = process.env.LIBREDB_ES_AGENT_USER;
const AGENT_PASSWORD = process.env.LIBREDB_ES_AGENT_PASSWORD ?? "";
const SECURED = ADMIN_USER !== undefined && AGENT_USER !== undefined;
const AGENT_ROLE = "libredb_agent_read";
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 10_000, maxResultRows: 2_000, maxResultBytes: 1_000_000 };
const SCRATCH = `libredb_lb_${randomBytes(4).toString("hex")}`;

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
  "SELECT * INTO libredb_lb_into FROM probe_orders",
  "EXPLAIN INSERT INTO probe_orders (id) VALUES (2)",
  "DEBUG DELETE FROM probe_orders",
  "WITH x AS (SELECT 1) INSERT INTO probe_orders SELECT * FROM probe_orders",
  "SELECT 1; DELETE FROM probe_orders",
];

/** The grammar's refusal, as the provider carries it through: the engine's own text, which locates the token. */
const GRAMMAR_REFUSAL = /^line 1:\d+: (mismatched|extraneous) input /;

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

/** A request past every check of Studio's, as the superuser when there is one. */
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

/** Everything a write or a DDL statement could change, as one text; the scratch index is left out. */
async function clusterState(): Promise<string> {
  await send("POST", "/_refresh");
  const indices = (
    JSON.parse(await read("/_cat/indices?format=json&h=index,docs.count,status&s=index")) as {
      index: string;
    }[]
  ).filter((row) => row.index !== SCRATCH);
  return [
    `indices ${JSON.stringify(indices)}`,
    `mappings ${await read("/probe_*/_mapping")}`,
    `aliases ${await read("/_cat/aliases?format=json&s=alias")}`,
    `templates ${await read("/_cat/templates?format=json&s=name")}`,
    `pipelines ${Object.keys(JSON.parse(await read("/_ingest/pipeline")) as object)
      .sort()
      .join(",")}`,
  ].join("\n");
}

/** The search contexts the node holds open, summed over its nodes: a cursor left open is one of them. */
async function openContexts(): Promise<number> {
  const stats = JSON.parse(await read("/_nodes/stats/indices/search")) as {
    nodes: Record<string, { indices: { search: { open_contexts: number } } }>;
  };
  return Object.values(stats.nodes).reduce((sum, node) => sum + node.indices.search.open_contexts, 0);
}

function connection(): DatabaseConnection {
  return {
    id: "elasticsearch-live",
    name: "Elasticsearch live",
    type: "elasticsearch",
    host: ORIGIN.hostname,
    port: Number(ORIGIN.port),
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

const AGENT_INDICES = [{ names: ["probe_*"], privileges: ["read", "view_index_metadata"] }];

/**
 * The agent user's role, created by the superuser: reads on the probe indices, and the one cluster action that reads
 * the server's version. The role is created without that action first, to show the open refuses a version it cannot
 * read.
 */
async function createAgentUser(): Promise<void> {
  if (!SECURED) return;
  const role = await send("PUT", `/_security/role/${AGENT_ROLE}`, { indices: AGENT_INDICES });
  check(role.status === 200, `security: the superuser creates the role ${AGENT_ROLE} -> ${role.status}`);
  const user = await send("PUT", `/_security/user/${AGENT_USER}`, { password: AGENT_PASSWORD, roles: [AGENT_ROLE] });
  check(user.status === 200, `security: the superuser creates the agent user with that role alone -> ${user.status}`);
  const unread = await refusalOf(() => open("agent-read-only"));
  check(
    unread?.name === "ExecutionProfileError" && unread.message.includes("cluster:monitor/main"),
    `security: without cluster:monitor/main the version is unread and the agent profile refused -> ${unread?.message.slice(0, 110)}`,
  );
  const versioned = await send("PUT", `/_security/role/${AGENT_ROLE}`, {
    cluster: ["cluster:monitor/main"],
    indices: AGENT_INDICES,
  });
  check(versioned.status === 200, `security: the role gains cluster:monitor/main alone -> ${versioned.status}`);
  const health = await send("GET", "/_cluster/health", undefined, basic(AGENT_USER, AGENT_PASSWORD));
  check(health.status === 403, `security: that action reads no cluster health -> ${health.status}`);
}

/** What plan mode adds to the agent's role, each measured as needed on 9.1.4 (section 5.9 of the provider doc). */
const PLAN_CLUSTER = ["monitor", "read_pipeline"] as const;
const PLAN_INDICES = ["monitor"] as const;

/** The plan run's schema read, as a plan run takes it: planning mode, under the operations profile. */
async function planGrounding(): Promise<Awaited<ReturnType<typeof captureContextSnapshot>>> {
  const provider = await open("agent-operations");
  const clock = () => Date.now();
  const context: AgentToolContext = {
    runId: "elasticsearch-live-plan",
    modelId: "unmeasured-model-for-tests",
    mode: "planning",
    workflowType: "investigation",
    actor: { sessionId: "elasticsearch-live", role: "user" },
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

async function setAgentRole(cluster: readonly string[], indexPrivileges: readonly string[]): Promise<void> {
  const role = await send("PUT", `/_security/role/${AGENT_ROLE}`, {
    cluster,
    indices: [{ names: ["probe_*"], privileges: indexPrivileges }],
  });
  if (role.status !== 200) throw new Error(`role update: ${role.status} ${role.text}`);
}

/**
 * Plan mode grounds through the provider's object surface with the connection's own login, and a seed carries one
 * login only (B85), so on a seed that login holds the agent's role and plan mode's additions together.
 */
async function checkPlanGrounding(): Promise<void> {
  if (!SECURED) return;
  const agentCluster = ["cluster:monitor/main"];
  const agentIndices = AGENT_INDICES[0].privileges;
  const refused = await planGrounding();
  check(
    refused.kind === "unavailable" && refused.reasonCode === "CATALOG_READ_REFUSED",
    `plan: on the agent's role alone the plan run's schema read is refused -> ${refused.kind}`,
  );
  await setAgentRole([...agentCluster, ...PLAN_CLUSTER], [...agentIndices, ...PLAN_INDICES]);
  const grounded = await planGrounding();
  const kinds = grounded.kind === "captured" ? [...new Set(grounded.snapshot.objects.map((o) => o.kind))].sort() : [];
  check(
    grounded.kind === "captured" && kinds.includes("index"),
    `plan: with cluster monitor and read_pipeline and index monitor added it captures -> ${grounded.kind} ${kinds.join(", ")}`,
  );
  const agent = await open("agent-read-only");
  check(agent.isConnected(), "plan: the agent profile still opens under the wider role");
  await agent.disconnect();
  const without: readonly [string, readonly string[], readonly string[]][] = [
    ["cluster monitor", [...agentCluster, "read_pipeline"], [...agentIndices, ...PLAN_INDICES]],
    ["read_pipeline", [...agentCluster, "monitor"], [...agentIndices, ...PLAN_INDICES]],
    ["index monitor", [...agentCluster, ...PLAN_CLUSTER], agentIndices],
  ];
  for (const [name, cluster, indexPrivileges] of without) {
    await setAgentRole(cluster, indexPrivileges);
    const capture = await planGrounding();
    check(capture.kind === "unavailable", `plan: without ${name} the schema read is refused again -> ${capture.kind}`);
  }
  await setAgentRole(agentCluster, agentIndices);
}

async function main(): Promise<void> {
  await createAgentUser();
  await checkPlanGrounding();
  const agent = await open("agent-read-only");
  check(agent.isConnected(), "open: the agent profile opens the node");
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

  const before = await clusterState();
  for (const sql of WRITES) {
    const viaProvider = await refusalOf(() => agent.queryReadOnly!(sql, BUDGET));
    // A DEBUG command never reaches the grammar on this path: the catalog-command fence refuses it unsent.
    const refusedUnsent = sql.startsWith("DEBUG ");
    check(
      viaProvider !== null &&
        (refusedUnsent ? viaProvider.message === CATALOG_COMMAND_REFUSAL : GRAMMAR_REFUSAL.test(viaProvider.message)),
      `boundary: queryReadOnly ${refusedUnsent ? "refuses" : "sends"} ${sql} and ${refusedUnsent ? "the fence" : "the grammar"} refuses it (${viaProvider?.message.slice(0, 70)})`,
    );
    const answer = await send("POST", "/_sql?format=json", { query: sql });
    check(
      answer.status === 400 && answer.text.includes('"type":"parsing_exception"'),
      `boundary: ${sql} sent raw -> ${answer.status} ${answer.text.slice(0, 60)}`,
    );
  }
  check(
    (await clusterState()) === before,
    "boundary: indices, counts, mappings, aliases, templates and pipelines read back the same",
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
      const outside = await refusalOf(() => agent.queryReadOnly!(`SELECT probe FROM "${SCRATCH}"`, BUDGET));
      check(
        outside !== null,
        `security: an index outside the agent's role is refused -> ${outside?.message.slice(0, 80)}`,
      );
    } else {
      const control = await agent.queryReadOnly!(`SELECT probe FROM "${SCRATCH}"`, BUDGET);
      check(
        control.rowCount === 1,
        `control: the agent reads the written document back -> ${JSON.stringify(control.rows)}`,
      );
    }
  } finally {
    await send("DELETE", `/${SCRATCH}`);
  }

  const rows = await refusalOf(() =>
    agent.queryReadOnly!("SELECT k FROM probe_buckets", { ...BUDGET, maxResultRows: 100 }),
  );
  check(
    rows?.message === "Read-only execution exceeded the row budget: 101 rows > 100 allowed",
    `budget: a plain read past the row budget -> ${rows?.message}`,
  );
  check((await openContexts()) === 0, "budget: no search context stays open after the plain read's refusal");
  const groups = await refusalOf(() =>
    agent.queryReadOnly!("SELECT k, COUNT(*) AS n FROM probe_buckets GROUP BY k", { ...BUDGET, maxResultRows: 100 }),
  );
  check(
    groups?.message === "Read-only execution exceeded the row budget: 101 rows > 100 allowed",
    `budget: an aggregation past the row budget -> ${groups?.message}`,
  );
  check((await openContexts()) === 0, "budget: no search context stays open after the aggregation's refusal");
  const bytes = await refusalOf(() =>
    agent.queryReadOnly!("SELECT k FROM probe_buckets", { ...BUDGET, maxResultBytes: 1_000 }),
  );
  check(
    bytes?.message.startsWith("Read-only execution exceeded the byte budget") === true,
    `budget: a read past the byte budget -> ${bytes?.message}`,
  );
  check((await openContexts()) === 0, "budget: no search context stays open after the byte refusal");
  const slow = await refusalOf(() =>
    agent.queryReadOnly!("SELECT k, COUNT(*) AS n FROM probe_buckets GROUP BY k", { ...BUDGET, statementTimeoutMs: 1 }),
  );
  check(
    slow?.message === "Read-only execution exceeded the time budget: no answer within 1ms",
    `budget: a statement past its deadline -> ${slow?.message}`,
  );
  const plan = await refusalOf(() => agent.queryReadOnly!("SELECT 1", BUDGET, "estimate-plan"));
  check(
    plan?.message === "Elasticsearch composes no estimating plan for the agent",
    `mode: the estimate-plan mode is refused -> ${plan?.message}`,
  );

  const count = await agent.queryReadOnly!("SELECT COUNT(*) AS n FROM probe_buckets", BUDGET);
  check(count.rows[0]?.n === 1500, `read: the agent counts probe_buckets -> ${JSON.stringify(count.rows)}`);
  const all = await agent.queryReadOnly!("SELECT k FROM probe_buckets", { ...BUDGET, maxResultRows: 1_500 });
  check(all.rowCount === 1500, `read: an answer of exactly the row budget is returned whole -> ${all.rowCount}`);
  const grouped = await agent.queryReadOnly!("SELECT k, COUNT(*) AS n FROM probe_buckets GROUP BY k", BUDGET);
  check(grouped.rowCount === 1500, `read: an aggregation within the budget is returned whole -> ${grouped.rowCount}`);
  check((await openContexts()) === 0, "read: no search context stays open after the reads");

  // The agent's catalog read: the command its overlay composes, sent through the same path, and mapped as the run maps it.
  const catalogRead = engineServerDialect("elasticsearch").catalogRead;
  if (catalogRead === "unsupported" || catalogRead.mapRows === undefined) throw new Error("no catalog read to check");
  const everyTable = composeCatalogRead("elasticsearch", { kind: "columns" });
  // With security on, an index outside the agent's role exists while the catalog is read, and must not be listed.
  if (SECURED) await send("PUT", `/${SCRATCH}/_doc/1?refresh=true`, { probe: "outside" });
  let inventory: Awaited<ReturnType<NonNullable<typeof catalogRead.mapRows>>>;
  try {
    inventory = catalogRead.mapRows("columns", (await agent.queryReadOnly!(everyTable, BUDGET)).rows);
  } finally {
    if (SECURED) await send("DELETE", `/${SCRATCH}`);
  }
  const tables = [...new Set(inventory.rows.map((row) => String(row.table_name)))].sort();
  check(
    inventory.rows.some((row) => row.table_name === "probe_orders" && row.column_name === "customer"),
    `catalog: ${everyTable} answers the column inventory -> ${inventory.rows.length} columns of ${tables.join(", ")}`,
  );
  if (SECURED) {
    check(
      // A data stream's privileges reach its backing indices, so `probe_stream`'s `.ds-probe_stream-*` index is read too.
      !tables.includes(SCRATCH) &&
        tables.every((table) => table.startsWith("probe_") || table.startsWith(".ds-probe_")),
      `security: the agent user's catalog read holds only the tables its role reads, not ${SCRATCH} -> ${tables.join(", ")}`,
    );
  }
  const oneTable = composeCatalogRead("elasticsearch", { kind: "columns", table: "probe_orders" });
  const columns = catalogRead.mapRows("columns", (await agent.queryReadOnly!(oneTable, BUDGET)).rows);
  check(
    columns.rows.length > 0 && columns.rows.every((row) => row.table_name === "probe_orders"),
    `catalog: ${oneTable} answers that table's columns -> ${columns.rows.map((row) => row.column_name).join(", ")}`,
  );
  check((await clusterState()) === before, "catalog: the cluster reads back the same after the catalog reads");
  await agent.disconnect();

  if (SECURED) {
    await send("DELETE", `/_security/user/${AGENT_USER}`);
    await send("DELETE", `/_security/role/${AGENT_ROLE}`);
  }
  console.log(`${checks} checks passed`);
}

await main();

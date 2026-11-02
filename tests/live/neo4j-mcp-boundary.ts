/**
 * Live check of MCP's `run_cypher_read` on Neo4j, against a server of the operator's choosing.
 *
 * WHY THIS EXISTS. `run_cypher_read` serves Neo4j through the same boundary agent mode does: the connection is acquired
 * under the agent read-only profile, whose open proves the seed's user read-only from the server's own answers
 * (`agent-boundary.ts`), and every statement goes through the provider's `queryReadOnly`, which reads the statement,
 * proves the user again, has the server classify the statement and runs it in a READ session. The MCP fence in front
 * of it is the agent's own reader, defence in depth. So this script replays the agent boundary through the MCP tool's
 * own handler (`runStatement`), with the fence in place and with it removed, against a real Enterprise server:
 *
 *  - the proof, through MCP: a copy of `reader` with PUBLIC's LOAD revoked is served; the administrator, a user with
 *    the `editor` role and the reader also granted LOAD are each refused before a statement is sent, in the tool's
 *    sentence; on one cached handle a LOAD granted after a served call refuses the next call and its revoke admits the
 *    one after;
 *  - the boundary: a write, `LOAD CSV`, `CALL { } IN TRANSACTIONS`, a write procedure, `USE` and a side-effecting
 *    built-in are refused by the fence before anything is acquired, and with the fence removed by the provider's own
 *    reader before anything is sent; sent raw as the proved user, the server refuses the write in a READ session and
 *    `LOAD CSV` as `Forbidden`, and the administrator's write runs, the positive control; the node counts read the
 *    same before and after;
 *  - the forms: a MATCH, each allowlisted procedure, and the index, constraint, procedure and function listings answer;
 *    the SHOW DATABASE forms are refused by the server's own classification, the address of every server never read;
 *  - what a narrow user reads: a user granted MATCH on one label with one property denied and another label's
 *    traversal denied reads the denied property as null, never sees the hidden label in its listings, and is refused
 *    the index listing; `db.propertyKeys` names every property key of the database, the denied one included, never a
 *    value; a seed bound to `system` reads nothing of the system graph, and a seed bound to a database the user may
 *    not access is refused at open;
 *  - the limits: SKIP and LIMIT page a read; a read past `max_rows` is cut with the hint; one past the 1000-row
 *    provider budget and one past the 1 MiB budget are refused, never cut; a read past the minimum `timeout_ms` is
 *    answered as the timeout and ended on the server; a read whose client closes the call is answered at once and runs
 *    on the server until the time it had left.
 *
 * With NEO4J_MCP_CE_PORT set instead, it checks only that a Community Edition server is refused at open through MCP.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against a disposable 5.26.31
 * Enterprise server, whose licence only you can accept, as `docs/providers/neo4j.md` section 15.7 shows:
 *
 *   NEO4J_MCP_PORT=27687 NEO4J_ADMIN_PASSWORD=<the neo4j user's password> bun tests/live/neo4j-mcp-boundary.ts
 *   NEO4J_MCP_CE_PORT=27689 NEO4J_ADMIN_PASSWORD=<the neo4j user's password> bun tests/live/neo4j-mcp-boundary.ts
 *
 * Every role, user, database and label it creates carries the `lm` prefix and is dropped on exit, and PUBLIC's LOAD
 * is granted back. Each check prints one line, no credential among them, and any failure ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { randomBytes } from "node:crypto";
import neo4j, { type Driver } from "neo4j-driver-lite";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, MCP_UNTRUSTED_NOTICE, type ToolResult } from "@/lib/mcp/output";
import { inspectSchema, InspectSchemaInputSchema } from "@/lib/mcp/tools/inspect-schema";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: this script writes to the server it is pointed at, so it has no default`);
    process.exit(2);
  }
  return value;
}

const HOST = "127.0.0.1";
const ADMIN_PASSWORD = env("NEO4J_ADMIN_PASSWORD");
const USER_PASSWORD = randomBytes(12).toString("hex");
const CREDENTIALS = [ADMIN_PASSWORD, USER_PASSWORD];

/** The tool as MCP registers it, and the same tool with its fence removed: the boundary under test. */
const RUN_CYPHER_READ = mcpStatementArm("run_cypher_read");
const UNFENCED: McpStatementArm = { ...RUN_CYPHER_READ, fence: () => null };

let failures = 0;
function check(ok: boolean, line: string): void {
  if (CREDENTIALS.some((secret) => line.includes(secret))) {
    console.log("FAIL a check line would have carried a credential, and was not printed");
    failures++;
    return;
  }
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

function seed(id: string, port: number, user: string, password: string, database = "neo4j"): ManagedConnection {
  return {
    id: `seed:live-${id}`,
    name: id,
    seedId: `live-${id}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "neo4j",
    host: HOST,
    port,
    database,
    user,
    password,
    createdAt: new Date(),
  } as ManagedConnection;
}

function contextOf(connection: ManagedConnection, acquired: ExecutionProfile[]): McpConnectionContext {
  return {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    acquire: (target: ManagedConnection, profile: ExecutionProfile) => {
      acquired.push(profile);
      return acquireExecutionProfileProvider(target, profile);
    },
  } as unknown as McpConnectionContext;
}

/** One MCP call on `connection`, through the factory's own profiled acquisition, as the route makes it. */
async function mcp(
  connection: ManagedConnection,
  args: Partial<McpStatementInput> & { readonly statement: string },
  arm: McpStatementArm = RUN_CYPHER_READ,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ readonly result: ToolResult; readonly acquired: ExecutionProfile[] }> {
  const acquired: ExecutionProfile[] = [];
  const input = arm.inputSchema.parse({ connection_id: connection.id, ...args }) as McpStatementInput;
  const result = await runStatement(arm, input, { context: contextOf(connection, acquired), signal });
  return { result, acquired };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).join(" ");

/** The last content block: the answer itself, after the untrusted-data notice where one leads. */
const lastOf = (result: ToolResult): string => {
  const last = result.content.at(-1);
  return last !== undefined && "text" in last ? last.text : "";
};

/** The rows an MCP answer carries, or null when it is a refusal. */
function rowsOf(result: ToolResult): Record<string, unknown>[] | null {
  const content = (result as { structuredContent?: { rows?: Record<string, unknown>[] } }).structuredContent;
  return result.isError === true || content?.rows === undefined ? null : content.rows;
}

const hintOf = (result: ToolResult): string | null =>
  (result as { structuredContent?: { hint?: string | null } }).structuredContent?.hint ?? null;

// ---- Community Edition: refused at open, and nothing else ---------------------------------------------------------
if (process.env.NEO4J_MCP_CE_PORT !== undefined && process.env.NEO4J_MCP_CE_PORT !== "") {
  const community = seed("community", Number(process.env.NEO4J_MCP_CE_PORT), "neo4j", ADMIN_PASSWORD);
  const refused = await mcp(community, { statement: "MATCH (n) RETURN count(n) AS nodes" });
  check(
    refused.result.isError === true &&
      textOf(refused.result).startsWith("run_cypher_read cannot run on this connection: ") &&
      textOf(refused.result).includes("this server is Neo4j Community Edition"),
    `Community Edition is refused at open through MCP: ${textOf(refused.result).slice(0, 160)}`,
  );
  clearProviderCache();
  console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

const PORT = Number(env("NEO4J_MCP_PORT"));
const driver: Driver = neo4j.driver(`bolt://${HOST}:${PORT}`, neo4j.auth.basic("neo4j", ADMIN_PASSWORD), {
  userAgent: "libredb-studio-mcp-boundary",
});

/** One statement as `user` (the administrator by default), on `database`, in a session of its own. */
async function as(
  statement: string,
  { database = "neo4j", user, mode = "WRITE" }: { database?: string; user?: Driver; mode?: "READ" | "WRITE" } = {},
): Promise<Record<string, unknown>[]> {
  const session = (user ?? driver).session({
    database,
    defaultAccessMode: mode === "READ" ? neo4j.session.READ : neo4j.session.WRITE,
  });
  try {
    return (await session.run(statement)).records.map((record) => record.toObject() as Record<string, unknown>);
  } finally {
    await session.close();
  }
}

const system = (statement: string) => as(statement, { database: "system" });

/** The server's error code for `statement` sent raw as `user`, or "ran". */
async function rawAnswer(user: Driver, statement: string, mode: "READ" | "WRITE"): Promise<string> {
  try {
    await as(statement, { user, mode });
    return "ran";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

const SETUP = [
  "CREATE DATABASE lmother IF NOT EXISTS WAIT",
  "REVOKE GRANT LOAD ON ALL DATA FROM PUBLIC",
  "CREATE ROLE lm_reader IF NOT EXISTS AS COPY OF reader",
  "CREATE ROLE lm_loader IF NOT EXISTS",
  "GRANT LOAD ON ALL DATA TO lm_loader",
  "CREATE ROLE lm_narrow IF NOT EXISTS",
  "GRANT ACCESS ON DATABASE neo4j TO lm_narrow",
  "GRANT MATCH {*} ON GRAPH neo4j NODES LmPerson TO lm_narrow",
  "DENY READ {ssn} ON GRAPH neo4j NODES LmPerson TO lm_narrow",
  "DENY TRAVERSE ON GRAPH neo4j NODES LmSecret TO lm_narrow",
  ...[
    ["lm_agent", "lm_reader"],
    ["lm_narrow", "lm_narrow"],
    ["lm_editor", "editor"],
    ["lm_loader", "lm_reader"],
  ].flatMap(([user, role]) => [
    `CREATE USER ${user} IF NOT EXISTS SET PASSWORD '${USER_PASSWORD}' CHANGE NOT REQUIRED`,
    `GRANT ROLE ${role} TO ${user}`,
  ]),
  "GRANT ROLE lm_loader TO lm_loader",
];

const CLEANUP = [
  ...["lm_agent", "lm_narrow", "lm_editor", "lm_loader"].map((user) => `DROP USER ${user} IF EXISTS`),
  ...["lm_reader", "lm_loader", "lm_narrow"].map((role) => `DROP ROLE ${role} IF EXISTS`),
  "DROP DATABASE lmother IF EXISTS",
  "GRANT LOAD ON ALL DATA TO PUBLIC",
];

/** The node count of each database, as the administrator reads it. */
async function stateOf(): Promise<string> {
  const counts: string[] = [];
  for (const database of ["neo4j", "lmother"]) {
    const [row] = await as("MATCH (n) RETURN count(n) AS nodes", { database });
    counts.push(`${database}=${String(row?.nodes)}`);
  }
  return counts.join(" ");
}

const SLOW = "UNWIND range(1, 4000000000) AS x WITH x WHERE x = -4242 RETURN count(x) AS c";

async function slowRunning(): Promise<boolean> {
  const rows = await as("SHOW TRANSACTIONS YIELD currentQuery RETURN currentQuery");
  return rows.some((row) => String(row.currentQuery).includes("-4242") && !String(row.currentQuery).includes("SHOW"));
}

/** Waits for the slow statement to end on the server, and answers how long that took. */
async function untilSlowEnds(limitMs = 40_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < limitMs) {
    if (!(await slowRunning())) return Date.now() - start;
    await Bun.sleep(250);
  }
  return Number.POSITIVE_INFINITY;
}

for (const statement of SETUP) await system(statement);
await as(
  "CREATE (:LmPerson {name: 'Ada', ssn: '000-00-0000'})-[:LM_KNOWS]->(:LmPerson {name: 'Bob', ssn: '111-11-1111'}), (:LmSecret {code: 'not-a-real-code'})",
);
await as("CREATE (:LmTenant {name: 'another tenant'})", { database: "lmother" });

const AGENT = seed("agent", PORT, "lm_agent", USER_PASSWORD);
const NARROW = seed("narrow", PORT, "lm_narrow", USER_PASSWORD);
const agentDriver = neo4j.driver(`bolt://${HOST}:${PORT}`, neo4j.auth.basic("lm_agent", USER_PASSWORD));
const narrowDriver = neo4j.driver(`bolt://${HOST}:${PORT}`, neo4j.auth.basic("lm_narrow", USER_PASSWORD));

try {
  const before = await stateOf();

  // ---- The proof, through MCP --------------------------------------------------------------------------------------
  const served = await mcp(AGENT, { statement: "MATCH (n:LmPerson) RETURN n.name AS name ORDER BY name" });
  check(
    JSON.stringify(rowsOf(served.result)) === JSON.stringify([{ name: "Ada" }, { name: "Bob" }]) &&
      served.acquired.join(",") === "agent-read-only" &&
      served.result.content[0]?.type === "text" &&
      (served.result.content[0] as { text: string }).text === MCP_UNTRUSTED_NOTICE,
    `the proved reader is served under the agent read-only profile (${served.acquired.join(",")}), behind the notice`,
  );
  for (const [name, connection, words] of [
    ["the administrator", seed("admin", PORT, "neo4j", ADMIN_PASSWORD), "through the role admin"],
    ["a user with the editor role", seed("editor", PORT, "lm_editor", USER_PASSWORD), "through the role editor"],
    ["a reader also granted LOAD", seed("loader", PORT, "lm_loader", USER_PASSWORD), "through the role lm_loader"],
  ] as const) {
    const refused = await mcp(connection, { statement: "MATCH (n:LmPerson) RETURN n.name AS name" });
    check(
      refused.result.isError === true &&
        textOf(refused.result).startsWith("run_cypher_read cannot run on this connection: ") &&
        textOf(refused.result).includes(words),
      `${name} is refused at open, before a statement is sent: ${textOf(refused.result).slice(47, 200)}`,
    );
  }
  await system("GRANT ROLE lm_loader TO lm_agent");
  const widened = await mcp(AGENT, { statement: "RETURN 1 AS one" });
  await system("REVOKE ROLE lm_loader FROM lm_agent");
  const narrowedAgain = await mcp(AGENT, { statement: "RETURN 1 AS one" });
  check(
    textOf(widened.result).includes("holds LOAD on ALL DATA through the role lm_loader") &&
      rowsOf(narrowedAgain.result)?.length === 1,
    "a LOAD granted after a served call refuses the next call on the cached handle, and its revoke admits the one after",
  );

  // ---- The boundary ------------------------------------------------------------------------------------------------
  for (const statement of [
    "CREATE (:LmProbe {at: 1})",
    "MERGE (:LmProbe {at: 2})",
    "MATCH (n:LmPerson) SET n.flag = true",
    "MATCH (n:LmPerson) DETACH DELETE n",
    "LOAD CSV FROM 'file:///probe.csv' AS row RETURN row",
    "CALL { CREATE (:LmProbe {at: 3}) } IN TRANSACTIONS",
    "CALL db.createLabel('LmProbe')",
    "USE lmother MATCH (n) RETURN n LIMIT 1",
    "CALL db.checkpoint()",
  ]) {
    const fenced = await mcp(AGENT, { statement });
    const unfenced = await mcp(AGENT, { statement }, UNFENCED);
    check(
      textOf(fenced.result).startsWith("The statement was refused before it reached the database (") &&
        fenced.acquired.length === 0 &&
        textOf(unfenced.result).includes("The statement was refused before it reached the database: ") &&
        textOf(unfenced.result).endsWith("Nothing was sent."),
      `${statement}: refused by the fence before anything is acquired, and unfenced by the provider's reader, unsent`,
    );
  }
  const rawWrite = await rawAnswer(agentDriver, "CREATE (:LmProbe {at: 4})", "READ");
  const rawWriteSession = await rawAnswer(agentDriver, "CREATE (:LmProbe {at: 5})", "WRITE");
  const rawLoad = await rawAnswer(agentDriver, "LOAD CSV FROM 'file:///probe.csv' AS row RETURN row", "READ");
  const control = await rawAnswer(driver, "CREATE (:LmProbe {at: 6})", "WRITE");
  await as("MATCH (n:LmProbe) DELETE n");
  check(
    rawWrite.startsWith("Neo.ClientError.") &&
      rawWriteSession === "Neo.ClientError.Security.Forbidden" &&
      rawLoad === "Neo.ClientError.Security.Forbidden" &&
      control === "ran",
    `sent raw as the proved user, the server refuses a write (${rawWrite}, in a WRITE session ${rawWriteSession}) and LOAD CSV (${rawLoad}); the administrator's write ${control}`,
  );

  // ---- The forms ---------------------------------------------------------------------------------------------------
  for (const statement of [
    "CALL db.labels()",
    "CALL db.relationshipTypes()",
    "CALL db.propertyKeys()",
    "CALL db.schema.visualization()",
    "CALL db.schema.nodeTypeProperties()",
    "CALL db.schema.relTypeProperties()",
    "CALL db.ping()",
    "CALL dbms.components()",
    "SHOW INDEXES",
    "SHOW CONSTRAINTS",
    "SHOW PROCEDURES YIELD name RETURN count(*) AS n",
    "SHOW FUNCTIONS YIELD name RETURN count(*) AS n",
  ]) {
    const answered = await mcp(AGENT, { statement });
    check(rowsOf(answered.result) !== null, `${statement}: answered`);
  }
  for (const statement of [
    "SHOW DATABASES",
    "SHOW DATABASES YIELD address AS a RETURN a",
    "SHOW DATABASE neo4j",
    "SHOW DEFAULT DATABASE",
    "SHOW HOME DATABASE",
  ]) {
    const refused = await mcp(AGENT, { statement }, UNFENCED);
    check(
      textOf(refused.result).includes(
        "The server classifies this statement as a schema or administration statement, and a read-only Neo4j connection runs only reads.",
      ) && !textOf(refused.result).includes(`:${PORT}`),
      `${statement}: refused by the server's own classification, no address read`,
    );
  }

  // ---- What a narrow user reads ------------------------------------------------------------------------------------
  const narrowRows = await mcp(NARROW, { statement: "MATCH (n:LmPerson) RETURN n.name AS name, n.ssn AS ssn" });
  const narrowProps = await mcp(NARROW, { statement: "MATCH (n:LmPerson) RETURN properties(n) AS p" });
  const narrowSecret = await mcp(NARROW, { statement: "MATCH (n:LmSecret) RETURN n.code AS code" });
  const narrowLabels = await mcp(NARROW, { statement: "CALL db.labels()" });
  const narrowTypes = await mcp(NARROW, { statement: "CALL db.schema.nodeTypeProperties()" });
  const narrowKeys = await mcp(NARROW, { statement: "CALL db.propertyKeys()" });
  const narrowIndexes = await mcp(NARROW, { statement: "SHOW INDEXES" });
  const all = JSON.stringify([narrowRows, narrowProps, narrowSecret, narrowLabels, narrowTypes].map((c) => c.result));
  check(
    rowsOf(narrowRows.result)?.every((row) => row.ssn === null) === true &&
      !all.includes("000-00-0000") &&
      !all.includes("not-a-real-code") &&
      rowsOf(narrowSecret.result)?.length === 0 &&
      !JSON.stringify(rowsOf(narrowLabels.result)).includes("LmSecret") &&
      !JSON.stringify(rowsOf(narrowTypes.result)).includes('"ssn"'),
    "a narrow user reads its denied property as null, never sees the label it may not traverse, and its schema reads leave both out",
  );
  check(
    JSON.stringify(rowsOf(narrowKeys.result)).includes('"ssn"') &&
      JSON.stringify(rowsOf(narrowKeys.result)).includes('"code"') &&
      !JSON.stringify(narrowKeys.result).includes("000-00-0000"),
    "db.propertyKeys names every property key of the database to the narrow user, the denied ones included, and no value",
  );
  check(
    // The server answers Neo.ClientError.Security.Forbidden, which the provider's error table words as a refused write.
    lastOf(narrowIndexes.result).startsWith("The database refused or failed the call: ") &&
      rowsOf(narrowIndexes.result) === null,
    `the narrow user is refused the index listing by the server: ${lastOf(narrowIndexes.result).slice(0, 160)}`,
  );
  const narrowUse = await rawAnswer(narrowDriver, "USE lmother MATCH (n) RETURN n LIMIT 1", "READ");
  const agentUse = await rawAnswer(agentDriver, "USE lmother MATCH (n) RETURN n LIMIT 1", "READ");
  check(
    narrowUse.startsWith("Neo.ClientError.") && agentUse === "ran",
    `sent raw, USE of another database is refused to the narrow user (${narrowUse}) and answered to a reader of every database (${agentUse}), which Studio's reader refuses`,
  );
  const onSystem = seed("system", PORT, "lm_agent", USER_PASSWORD, "system");
  const systemMatch = await mcp(onSystem, { statement: "MATCH (n) RETURN n LIMIT 5" });
  const systemLabels = await mcp(onSystem, { statement: "CALL db.labels()" });
  const systemKeys = await mcp(onSystem, { statement: "CALL db.propertyKeys()" });
  check(
    rowsOf(systemMatch.result) === null &&
      rowsOf(systemLabels.result)?.length === 0 &&
      rowsOf(systemKeys.result)?.length === 0,
    `a seed bound to system reads nothing of the system graph: ${lastOf(systemMatch.result).slice(0, 160)}`,
  );
  const noAccess = await mcp(seed("noaccess", PORT, "lm_narrow", USER_PASSWORD, "lmother"), {
    statement: "MATCH (n) RETURN n LIMIT 1",
  });
  check(
    noAccess.result.isError === true && !textOf(noAccess.result).includes("another tenant"),
    `a seed bound to a database its user may not access is refused: ${textOf(noAccess.result).slice(0, 140)}`,
  );
  const inspected = await inspectSchema(InspectSchemaInputSchema.parse({ connection_id: AGENT.id }), {
    context: contextOf(AGENT, []),
    signal: new AbortController().signal,
  });
  check(JSON.stringify(inspected).includes("LmPerson"), "inspect_schema lists the reader's labels on the same seed");

  // ---- The limits --------------------------------------------------------------------------------------------------
  const page = await mcp(AGENT, {
    statement: "MATCH (n:LmPerson) RETURN n.name AS name ORDER BY name SKIP 1 LIMIT 1",
  });
  check(JSON.stringify(rowsOf(page.result)) === JSON.stringify([{ name: "Bob" }]), "SKIP and LIMIT page a read");
  const cut = await mcp(AGENT, { statement: "UNWIND range(1, 150) AS i RETURN i", max_rows: 100 });
  check(
    rowsOf(cut.result)?.length === 100 && (hintOf(cut.result) ?? "").includes("add SKIP 100 before the LIMIT"),
    "a read past max_rows is cut to it, and the hint pages with SKIP and LIMIT",
  );
  const tooMany = await mcp(AGENT, { statement: "UNWIND range(1, 1500) AS i RETURN i" });
  check(
    textOf(tooMany.result).startsWith("The result has more than 1000 rows, the most this server reads for one call."),
    `a read past the 1000-row budget is refused, never cut: ${textOf(tooMany.result).slice(0, 110)}`,
  );
  const tooBig = await mcp(AGENT, {
    statement: "UNWIND range(1, 40) AS i RETURN i, reduce(s = '', x IN range(1, 3000) | s + 'xxxxxxxxxx') AS pad",
  });
  check(
    tooBig.result.isError === true && textOf(tooBig.result).includes("1 MiB"),
    `a read past the 1 MiB budget is refused, never cut: ${textOf(tooBig.result).slice(0, 110)}`,
  );
  const timedStart = Date.now();
  const timed = await mcp(AGENT, { statement: SLOW, timeout_ms: 500 });
  const timedAnswered = Date.now() - timedStart;
  const timedRanOn = await untilSlowEnds();
  check(
    textOf(timed.result) ===
      "The statement did not finish within timeout_ms (500 ms). Narrow it, or raise timeout_ms up to 30000." &&
      timedAnswered < 2_500 &&
      timedRanOn < 2_000,
    `timeout_ms at its 500 ms minimum: answered in ${timedAnswered} ms, and the server ended the statement ${timedRanOn} ms later`,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 2_000);
  const cancelStart = Date.now();
  const cancelled = await mcp(AGENT, { statement: SLOW, timeout_ms: 10_000 }, RUN_CYPHER_READ, controller.signal);
  const cancelAnswered = Date.now() - cancelStart;
  const runningAfterCancel = await slowRunning();
  const cancelRanOn = await untilSlowEnds();
  check(
    textOf(cancelled.result) === MCP_CANCELLED_TEXT &&
      cancelAnswered < 3_000 &&
      runningAfterCancel &&
      cancelRanOn > 5_000 &&
      cancelRanOn < 10_000,
    `a client close: answered in ${cancelAnswered} ms, and the statement ran on the server ${cancelRanOn} ms more, to the time it had left`,
  );
  const next = await mcp(AGENT, { statement: "RETURN 1 AS one" });
  check(rowsOf(next.result)?.length === 1, "the call after them answers");

  check((await stateOf()) === before, `the node counts read the same before and after (${before})`);
} finally {
  await as("MATCH (n) WHERE n:LmPerson OR n:LmSecret OR n:LmProbe DETACH DELETE n");
  for (const statement of CLEANUP) await system(statement);
  clearProviderCache();
  await agentDriver.close();
  await narrowDriver.close();
  await driver.close();
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

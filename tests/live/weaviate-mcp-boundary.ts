/**
 * Live check of MCP's `run_weaviate_read`, against Weaviate servers of the operator's choosing.
 *
 * WHY THIS EXISTS. `run_weaviate_read` serves Weaviate through the same boundary agent mode does: the connection is
 * acquired under the agent read-only profile, whose open has the server prove the key a viewer, and every request goes
 * through the provider's `queryReadOnly`, which proves the key again, reads the request with the agent's reader and
 * sends it from the provider's closed table of read requests, then projects the answer to names, counts and flags. The
 * MCP fence in front of it is defence in depth. So this script replays the agent boundary check through the MCP tool's
 * own handler (`runStatement`), with that fence removed where the boundary is under test, against real servers:
 *
 *  - the open, through MCP: a viewer's key is served; the root key, an administrator's key, a role that also writes, a
 *    key on a server with RBAC off and a seed with no key are each refused before any request of the call is sent, in
 *    the MCP refusal sentence;
 *  - the boundary, with the MCP fence bypassed: a schema drop, an object write, a tenant change, an object read, a
 *    search, GraphQL, an aggregate's filter and a read of the users or roles are each refused by the provider's own reader
 *    before they are sent; with the fence in place each is refused before anything is acquired; the same writes sent
 *    raw as the viewer are refused 403 by the server, and as root, on a scratch collection, they run, the positive
 *    control; the schema, aliases, tenant statuses and counts hash the same before and after;
 *  - the data scope: a key whose role holds viewer actions scoped to one collection, one tenant, one alias and the
 *    node reads of two collections is answered only those collections, that tenant and that alias, a read outside them
 *    is the server's 403 worded by its status alone, and a verbose node read, which the server does not filter by
 *    tenant, neither names nor counts a tenant; the viewer is answered every collection, the control;
 *  - a COLD tenant: a count naming it is refused, and the tenant is still COLD after;
 *  - the limits: a tenant list past the 1000-row provider budget is refused, never cut; a read past `max_rows` is cut
 *    to it and says so;
 *  - the timeout and the cancel, through a proxy that holds one read's answer back: a read past `timeout_ms` is
 *    answered as the timeout and the provider closes its request then; a read whose client cancels is answered as the
 *    cancel at once, and the provider's request stays open until the time left of `timeout_ms` closes it.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against two fresh 1.40.2 servers, one
 * with API keys, database users and RBAC on, the other with API keys and RBAC off, started as
 * `tests/fixtures/weaviate/1.40.2/agent-boundary/run.sh` starts `weaviate-rbac` and `weaviate-keyonly`:
 *
 *   LIBREDB_LIVE_WEAVIATE_URL=http://127.0.0.1:18383 LIBREDB_LIVE_WEAVIATE_ROOT_KEY=... \
 *     LIBREDB_LIVE_WEAVIATE_KEYONLY_URL=http://127.0.0.1:18384 LIBREDB_LIVE_WEAVIATE_KEYONLY_KEY=... \
 *     bun tests/live/weaviate-mcp-boundary.ts
 *
 * Every collection, alias, role and user it creates carries the `Lm` or `libredb-lm-` prefix and is removed on exit.
 * Each check prints one line and no key, and any failure ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, type ToolResult } from "@/lib/mcp/output";
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

const RBAC = new URL(env("LIBREDB_LIVE_WEAVIATE_URL"));
const ROOT_KEY = env("LIBREDB_LIVE_WEAVIATE_ROOT_KEY");
const KEYONLY = new URL(env("LIBREDB_LIVE_WEAVIATE_KEYONLY_URL"));
const KEYONLY_KEY = env("LIBREDB_LIVE_WEAVIATE_KEYONLY_KEY");
const USER = "libredb-lm-";
const COLLECTIONS = ["LmNote", "LmDoc", "LmTenanted", "LmMany", "LmControl"] as const;
const ALIASES = ["LmNotesAlias", "LmDocsAlias"] as const;
const ROLES = ["libredb-lm-scoped", "libredb-lm-widened"] as const;
const USERS = ["viewer", "admin", "widened", "scoped"] as const;
const ENGINES = "It runs on Weaviate.";

/** The tool as MCP registers it, and the same tool with its statement fence removed: the boundary under test. */
const RUN_WEAVIATE_READ = mcpStatementArm("run_weaviate_read");
const UNFENCED: McpStatementArm = { ...RUN_WEAVIATE_READ, fence: () => null };

const keys: Record<string, string> = {};
let failures = 0;

function check(ok: boolean, line: string): void {
  for (const key of [ROOT_KEY, KEYONLY_KEY, ...Object.values(keys)]) {
    if (line.includes(key)) {
      console.log("FAIL a check line would carry a key; it was not printed");
      failures++;
      return;
    }
  }
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

async function raw(
  base: URL,
  key: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
}

/** A setup request as root, which must succeed. */
async function root(method: string, path: string, body?: unknown): Promise<unknown> {
  const answer = await raw(RBAC, ROOT_KEY, method, path, body);
  if (answer.status >= 300) throw new Error(`${method} ${path} answered ${answer.status}`);
  return answer.text === "" ? null : JSON.parse(answer.text);
}

function seed(name: string, password: string | undefined, base: URL = RBAC): ManagedConnection {
  return {
    id: `seed:live-${name}`,
    name,
    seedId: `live-${name}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "weaviate",
    host: base.hostname,
    port: Number(base.port),
    ...(password === undefined ? {} : { password }),
    createdAt: new Date(),
  } as ManagedConnection;
}

/** One MCP call on `connection`, through the factory's own profiled acquisition, as the route makes it. */
async function mcp(
  connection: ManagedConnection,
  args: Partial<McpStatementInput> & { readonly statement: string },
  arm: McpStatementArm = RUN_WEAVIATE_READ,
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
const rowsOf = (result: ToolResult): Record<string, unknown>[] =>
  (result.structuredContent?.rows ?? []) as Record<string, unknown>[];
const column = (result: ToolResult, name: string): string[] => rowsOf(result).map((row) => String(row[name]));
const ours = (names: string[]): string[] => names.filter((name) => name.startsWith("Lm")).sort();

async function cleanup(): Promise<void> {
  for (const alias of ALIASES) await raw(RBAC, ROOT_KEY, "DELETE", `/v1/aliases/${alias}`);
  for (const collection of COLLECTIONS) await raw(RBAC, ROOT_KEY, "DELETE", `/v1/schema/${collection}`);
  for (const user of USERS) await raw(RBAC, ROOT_KEY, "DELETE", `/v1/users/db/${USER}${user}`);
  for (const role of ROLES) await raw(RBAC, ROOT_KEY, "DELETE", `/v1/authz/roles/${role}`);
}

async function user(name: (typeof USERS)[number], roles: string[]): Promise<void> {
  const created = (await root("POST", `/v1/users/db/${USER}${name}`)) as { apikey: string };
  keys[name] = created.apikey;
  await root("POST", `/v1/authz/users/${USER}${name}/assign`, { roles, userType: "db" });
}

const vector = (n: number) => [0.1 * n, 0.2, 0.3, 0.4];

async function seedServer(): Promise<void> {
  await cleanup();
  for (const name of ["LmNote", "LmDoc", "LmControl"]) {
    await root("POST", "/v1/schema", {
      class: name,
      vectorizer: "none",
      properties: [{ name: "body", dataType: ["text"] }],
    });
    for (const n of [1, 2, 3]) {
      await root("POST", "/v1/objects", {
        class: name,
        properties: { body: `stored-${name}-${n}` },
        vector: vector(n),
      });
    }
  }
  for (const name of ["LmTenanted", "LmMany"]) {
    await root("POST", "/v1/schema", {
      class: name,
      vectorizer: "none",
      multiTenancyConfig: { enabled: true, autoTenantActivation: false },
      properties: [{ name: "body", dataType: ["text"] }],
    });
  }
  await root("POST", "/v1/schema/LmTenanted/tenants", [
    { name: "acme" },
    { name: "globex" },
    { name: "initech" },
    { name: "frozen" },
  ]);
  for (const tenant of ["acme", "globex", "frozen"]) {
    await root("POST", "/v1/objects", {
      class: "LmTenanted",
      tenant,
      properties: { body: `stored-${tenant}` },
      vector: vector(1),
    });
  }
  await root("PUT", "/v1/schema/LmTenanted/tenants", [{ name: "frozen", activityStatus: "COLD" }]);
  for (let start = 0; start < 1_001; start += 100) {
    const batch = Array.from({ length: Math.min(100, 1_001 - start) }, (_, index) => ({
      name: `t${start + index}`,
      activityStatus: "COLD",
    }));
    await root("POST", "/v1/schema/LmMany/tenants", batch);
  }
  await root("POST", "/v1/aliases", { alias: "LmNotesAlias", class: "LmNote" });
  await root("POST", "/v1/aliases", { alias: "LmDocsAlias", class: "LmDoc" });
  await root("POST", "/v1/authz/roles", {
    name: "libredb-lm-scoped",
    permissions: [
      { action: "read_collections", collections: { collection: "LmNote" } },
      { action: "read_collections", collections: { collection: "LmTenanted" } },
      { action: "read_tenants", tenants: { collection: "LmTenanted", tenant: "acme" } },
      { action: "read_aliases", aliases: { alias: "LmNotesAlias", collection: "LmNote" } },
      { action: "read_nodes", nodes: { verbosity: "verbose", collection: "LmNote" } },
      { action: "read_nodes", nodes: { verbosity: "verbose", collection: "LmTenanted" } },
      { action: "read_data", data: { collection: "LmNote" } },
      { action: "read_data", data: { collection: "LmTenanted", tenant: "acme" } },
    ],
  });
  await root("POST", "/v1/authz/roles", {
    name: "libredb-lm-widened",
    permissions: [
      { action: "read_data", data: { collection: "*" } },
      { action: "update_data", data: { collection: "*" } },
    ],
  });
  await user("viewer", ["viewer"]);
  await user("admin", ["admin"]);
  await user("widened", ["libredb-lm-widened"]);
  await user("scoped", ["libredb-lm-scoped"]);
}

/** The schema, the aliases, every tenant's status and every collection's count, as root reads them. */
async function state(): Promise<string> {
  const schema = (await root("GET", "/v1/schema")) as { classes: { class: string }[] };
  const aliases = (await root("GET", "/v1/aliases")) as { aliases: { alias: string; class: string }[] };
  const tenants = (await root("GET", "/v1/schema/LmTenanted/tenants")) as { name: string; activityStatus: string }[];
  const counts = [];
  for (const name of ["LmNote", "LmDoc"])
    counts.push(((await root("POST", `/v1/aggregate/${name}`, {})) as { count: number }).count);
  return JSON.stringify({
    collections: ours(schema.classes.map((entry) => entry.class)),
    aliases: aliases.aliases
      .filter((alias) => alias.alias.startsWith("Lm"))
      .map((alias) => `${alias.alias}:${alias.class}`)
      .sort(),
    tenants: tenants.map((tenant) => `${tenant.name}:${tenant.activityStatus}`).sort(),
    counts,
  });
}

/** The state once the server has settled what the seed asked of it: two reads a second apart that agree. */
async function settledState(): Promise<string> {
  let last = await state();
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const next = await state();
    if (next === last) return next;
    last = next;
  }
  throw new Error("the server's state did not settle within 30 seconds");
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function theOpen(): Promise<void> {
  const viewer = seed("viewer", keys.viewer);
  const served = await mcp(viewer, { statement: "GET /v1/meta" });
  check(
    served.result.isError === undefined &&
      rowsOf(served.result)[0]?.version === "1.40.2" &&
      served.acquired.join() === "agent-read-only",
    `open: the viewer's key is served under agent-read-only -> ${JSON.stringify(rowsOf(served.result))}`,
  );
  const refused: readonly [string, ManagedConnection, string][] = [
    ["the root key", seed("root", ROOT_KEY), "hold create_roles"],
    ["an administrator's key", seed("admin", keys.admin), "hold create_roles"],
    ["a role that also writes", seed("widened", keys.widened), "hold update_data"],
    ["a key on a server with RBAC off", seed("keyonly", KEYONLY_KEY, KEYONLY), "RBAC off"],
    ["a seed with no key", seed("nokey", undefined), "has no key"],
  ];
  for (const [who, connection, says] of refused) {
    const { result } = await mcp(connection, { statement: "GET /v1/schema" });
    const text = textOf(result);
    check(
      result.isError === true &&
        text.startsWith("run_weaviate_read cannot run on this connection: ") &&
        text.endsWith(ENGINES) &&
        text.includes(says),
      `open: ${who} is refused through MCP -> ${text}`,
    );
  }
}

/** Requests the provider's reader refuses, and the raw writes the viewer is refused by the server. */
const BYPASSED: readonly string[] = [
  "DELETE /v1/schema/LmNote",
  'POST /v1/objects {"class": "LmNote", "properties": {"body": "probe"}}',
  'PUT /v1/schema/LmTenanted/tenants [{"name": "acme", "activityStatus": "COLD"}]',
  "GET /v1/objects?class=LmNote&limit=2",
  "GET /v1/objects/LmNote/00000000-0000-4000-8000-000000000001",
  'POST /v1/search/LmNote/bm25 {"query": "stored"}',
  'POST /v1/graphql {"query": "{ Get { LmNote { body } } }"}',
  'POST /v1/aggregate/LmNote {"where": {"path": ["body"], "operator": "Like", "valueText": "stored*"}}',
  'POST /v1/aggregate/LmNote {"groupBy": ["body"]}',
  "GET /v1/users/db",
  "GET /v1/authz/roles",
];

const RAW_WRITES: readonly [string, string, unknown?][] = [
  ["POST", "/v1/objects", { class: "{c}", properties: { body: "probe" } }],
  ["POST", "/v1/schema/{c}/properties", { name: "probe", dataType: ["text"] }],
  ["DELETE", "/v1/schema/{c}"],
];

function writeOn(collection: string, [method, path, body]: (typeof RAW_WRITES)[number]) {
  return {
    method,
    path: path.replaceAll("{c}", collection),
    body: body === undefined ? undefined : JSON.parse(JSON.stringify(body).replaceAll("{c}", collection)),
  };
}

async function theBoundary(): Promise<void> {
  const viewer = seed("viewer", keys.viewer);
  const before = await settledState();
  for (const statement of BYPASSED) {
    const fenced = await mcp(viewer, { statement });
    const bypassed = await mcp(viewer, { statement }, UNFENCED);
    const text = textOf(bypassed.result);
    check(
      fenced.result.isError === true &&
        fenced.acquired.length === 0 &&
        textOf(fenced.result).startsWith("The request was refused before it reached the server") &&
        bypassed.result.isError === true &&
        text.startsWith("The statement was refused before it reached the database: "),
      `boundary: ${statement.split(" ", 2).join(" ")} is refused by the MCP fence, and bypassed, by the provider's reader before it is sent -> ${text.slice(0, 160)}`,
    );
  }
  for (const write of RAW_WRITES) {
    const { method, path, body } = writeOn("LmNote", write);
    const answer = await raw(RBAC, keys.viewer, method, path, body);
    check(answer.status === 403, `boundary: the same ${method} ${path} sent raw as the viewer -> ${answer.status}`);
  }
  const after = await state();
  check(
    before === after,
    `boundary: the state is the same before and after -> ${digest(before)} / ${digest(after)}${before === after ? "" : ` ${before} / ${after}`}`,
  );
  for (const write of RAW_WRITES) {
    const { method, path, body } = writeOn("LmControl", write);
    const answer = await raw(RBAC, ROOT_KEY, method, path, body);
    check(answer.status < 300, `control: root runs ${method} ${path} -> ${answer.status}`);
  }
}

async function theDataScope(): Promise<void> {
  const scoped = seed("scoped", keys.scoped);
  const viewer = seed("viewer", keys.viewer);
  const schema = await mcp(scoped, { statement: "GET /v1/schema" });
  check(
    JSON.stringify(column(schema.result, "collection").sort()) === '["LmNote","LmTenanted"]',
    `scope: the scoped key's schema holds its two collections and no other -> ${column(schema.result, "collection")}`,
  );
  const control = await mcp(viewer, { statement: "GET /v1/schema" });
  check(
    // LmControl is gone: the positive control dropped it.
    ours(column(control.result, "collection")).join() === "LmDoc,LmMany,LmNote,LmTenanted",
    `scope: the viewer's schema holds every collection, the control -> ${ours(column(control.result, "collection"))}`,
  );
  const tenants = await mcp(scoped, { statement: "GET /v1/schema/LmTenanted/tenants" });
  check(
    JSON.stringify(rowsOf(tenants.result)) === '[{"tenant":"acme","status":"HOT"}]',
    `scope: the scoped key's tenant list holds acme alone -> ${JSON.stringify(rowsOf(tenants.result))}`,
  );
  const aliases = await mcp(scoped, { statement: "GET /v1/aliases" });
  check(
    ours(column(aliases.result, "alias")).join() === "LmNotesAlias",
    `scope: the scoped key's alias list holds LmNotesAlias alone -> ${column(aliases.result, "alias")}`,
  );
  for (const statement of [
    "GET /v1/schema/LmDoc",
    "GET /v1/schema/LmTenanted/tenants/globex",
    "GET /v1/aliases/LmDocsAlias",
    "GET /v1/nodes/LmDoc?output=verbose",
    "POST /v1/aggregate/LmDoc",
    'POST /v1/aggregate/LmTenanted {"tenant": "globex"}',
  ]) {
    const { result } = await mcp(scoped, { statement });
    const text = textOf(result);
    check(
      result.isError === true &&
        text.includes("Weaviate answered HTTP 403 (forbidden)") &&
        !text.includes("insufficient") &&
        !text.includes(USER),
      `scope: ${statement} outside the scoped key's grants is the server's 403, in its status alone -> ${text.slice(-160)}`,
    );
  }
  for (const statement of ["GET /v1/nodes?output=verbose", "GET /v1/nodes/LmTenanted?output=verbose"]) {
    const { result } = await mcp(scoped, { statement });
    const answered = JSON.stringify(result.structuredContent);
    const named = ["acme", "globex", "initech", "frozen"].filter((tenant) => answered.includes(tenant));
    check(
      result.isError === undefined &&
        named.length === 0 &&
        rowsOf(result).length > 0 &&
        rowsOf(result).every((row) => Object.keys(row).join(",") === "node,collection") &&
        column(result, "collection").every((name) => name === "LmNote" || name === "LmTenanted"),
      `scope: ${statement} as the scoped key names no tenant, counts no shard and answers only its collections -> ${JSON.stringify(rowsOf(result))}`,
    );
  }
  const direct = await raw(RBAC, keys.scoped, "GET", "/v1/nodes/LmTenanted?output=verbose");
  check(
    direct.text.includes('"globex"') && direct.text.includes('"initech"'),
    "scope: the same verbose node read sent raw as the scoped key names tenants its role does not grant, which is why the projection neither names nor counts them",
  );
}

async function theColdTenant(): Promise<void> {
  const viewer = seed("viewer", keys.viewer);
  const { result } = await mcp(viewer, { statement: 'POST /v1/aggregate/LmTenanted {"tenant": "frozen"}' });
  const after = (await root("GET", "/v1/schema/LmTenanted/tenants/frozen")) as { activityStatus: string };
  check(
    result.isError === true &&
      textOf(result).includes('The tenant "frozen" is COLD.') &&
      after.activityStatus === "COLD",
    `cold: a count of a COLD tenant is refused and the tenant stays ${after.activityStatus} -> ${textOf(result).slice(-120)}`,
  );
}

async function theLimits(): Promise<void> {
  const viewer = seed("viewer", keys.viewer);
  const many = await mcp(viewer, { statement: "GET /v1/schema/LmMany/tenants" });
  check(
    textOf(many.result).startsWith("The result has more than 1000 rows, the most this server reads for one call."),
    `limits: 1001 tenants are refused past the provider budget, never cut -> ${textOf(many.result)}`,
  );
  const cut = await mcp(viewer, { statement: "GET /v1/schema/LmTenanted/tenants", max_rows: 2 });
  check(
    cut.result.structuredContent?.row_count === 2 && cut.result.structuredContent?.truncated_by === "max_rows",
    `limits: a read past max_rows is cut to it and says so -> ${String(cut.result.structuredContent?.hint)}`,
  );
}

/** A proxy to the RBAC server that holds `GET /v1/schema`'s answer back and records when its client closes it. */
async function holdingProxy(holdMs: number) {
  const closes: number[] = [];
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const started = Date.now();
    const held = incoming.method === "GET" && incoming.url === "/v1/schema";
    if (held) incoming.socket.once("close", () => closes.push(Date.now() - started));
    const forward = () => {
      const upstream = httpRequest(
        {
          host: RBAC.hostname,
          port: RBAC.port,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(outgoing);
        },
      );
      upstream.on("error", () => outgoing.destroy());
      incoming.pipe(upstream);
    };
    if (held) setTimeout(() => (outgoing.destroyed ? undefined : forward()), holdMs);
    else forward();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, closes, close: () => server.close() };
}

async function theTimeoutAndCancel(): Promise<void> {
  const proxy = await holdingProxy(10_000);
  try {
    const viewer = seed("proxied", keys.viewer, new URL(`http://127.0.0.1:${proxy.port}`));
    let started = Date.now();
    const slow = await mcp(viewer, { statement: "GET /v1/schema", timeout_ms: 500 });
    const answeredAt = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 500));
    check(
      textOf(slow.result) ===
        "The statement did not finish within timeout_ms (500 ms). Narrow it, or raise timeout_ms up to 30000." &&
        answeredAt < 1_500 &&
        proxy.closes.length === 1 &&
        proxy.closes[0] < 1_000,
      `timeout: a read past the minimum timeout_ms is answered as the timeout in ${answeredAt} ms, and the provider closed its request after ${proxy.closes[0]} ms`,
    );
    const controller = new AbortController();
    started = Date.now();
    setTimeout(() => controller.abort(), 1_000);
    const cancelled = await mcp(
      viewer,
      { statement: "GET /v1/schema", timeout_ms: 4_000 },
      RUN_WEAVIATE_READ,
      controller.signal,
    );
    const cancelledAt = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const closedAt = proxy.closes[1];
    check(
      textOf(cancelled.result) === MCP_CANCELLED_TEXT &&
        cancelledAt < 2_000 &&
        closedAt !== undefined &&
        closedAt > 2_500,
      `cancel: a client cancel is answered as the cancel in ${cancelledAt} ms, and the request stays open until the provider closes it at the time left, after ${closedAt} ms`,
    );
  } finally {
    proxy.close();
  }
}

try {
  await seedServer();
  await theOpen();
  await theBoundary();
  await theDataScope();
  await theColdTenant();
  await theLimits();
  await theTimeoutAndCancel();
} finally {
  await clearProviderCache();
  await cleanup();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

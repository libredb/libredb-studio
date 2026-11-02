/**
 * Live check of MCP's `run_qdrant_read` against two fresh Qdrant 1.19.1 servers: one with an API key, a read-only
 * API key and JWT RBAC, and one with no key configured.
 *
 * WHY THIS EXISTS. `run_qdrant_read` serves Qdrant through the same boundary agent mode does: the connection is
 * acquired under the agent read-only profile, and every request goes through the provider's `queryReadOnly`, whose
 * route table names no write and which, before every request, has the server refuse an empty alias update and an
 * empty point delete on every collection the key lists, then projects the answer to names, counts and flags. The
 * agent's reader in front of it is defence in depth. So this script drives the MCP tool's own handler
 * (`runStatement`) with a seed connection, with that reader as the tool's fence and with it removed:
 *
 *  - the forms: one accepted read of each of the eight metadata routes, with the read-only key, whose answer holds no
 *    stored payload, vector, peer id or configuration value the projection does not name;
 *  - the boundary, with the fence bypassed: a write and each refused form (point read, scroll, facet, query, count
 *    filter, snapshot and optimization lists) are refused by the fenced tool before anything is acquired, and by the
 *    provider's reader before anything is sent when the fence is removed; the same write sent raw with the read-only
 *    key is refused 403 by the server, the positive control with the API key is answered 200 on a scratch collection
 *    the script then drops, and the collections, their point counts and the aliases read back the same before and
 *    after;
 *  - the open, through MCP: the API key, a JWT whose access is `m`, a JWT with no access claim, a JWT that writes one
 *    collection, a JWT that writes through an alias, a made-up key and no key on a server with no key configured, and
 *    a read-only key that lists more than 32 collections are each refused in the tool's sentence before the read is
 *    sent, a JWT's claims read before the server is asked anything past the open's two reads;
 *  - the data scope: a JWT reading one collection lists that collection alone and no alias, and is refused another
 *    collection's configuration, existence, aliases, shard layout and count alike whether it exists or not, in
 *    Studio's words; a JWT reading one alias reads its collection through it and nothing else; the read-only key
 *    lists every collection and alias the server holds, which is its grant. Each probe is also sent raw, and its
 *    answer is written to tests/fixtures/qdrant/1.19.1/mcp-scope/;
 *  - the limits: a list past the 1000-row provider budget is refused, never cut, and a list past max_rows is cut with
 *    advice and no next offset; through a local proxy that stops forwarding, a read past the minimum timeout_ms is
 *    answered as the timeout and the provider closes its request at the time left, and a client cancel is answered at
 *    once while the provider's request stays open until its own deadline closes it at the time left;
 *  - the cost: the server's own request counters show how many requests one call sends, which is the proof's alias
 *    update, collection list and one empty delete per listed collection, then the read.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against two fresh servers started
 * as tests/fixtures/qdrant/1.19.1/agent-boundary/run.sh starts them, the keyed one with `jwt_rbac: true`:
 *
 *   LIBREDB_QDRANT_URL=http://127.0.0.1:18733 LIBREDB_QDRANT_OPEN_URL=http://127.0.0.1:18734 \
 *   LIBREDB_QDRANT_API_KEY=<secret> LIBREDB_QDRANT_READ_ONLY_KEY=<secret> bun tests/live/qdrant-mcp-boundary.ts
 *
 * The collections it creates are named `mcp_*` and are dropped before exit. Each check prints one line, and a line
 * that would carry a key or a token fails instead of printing it; any failure ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { posix } from "node:path";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { QDRANT_PROOF_SENTENCES } from "@/lib/db/providers/vector/qdrant/metadata-read";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, type ToolResult } from "@/lib/mcp/output";
import { timeoutText } from "@/lib/mcp/tools/read-query-limits";
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

const AUTH = new URL(env("LIBREDB_QDRANT_URL"));
const OPEN = new URL(env("LIBREDB_QDRANT_OPEN_URL"));
const FULL = env("LIBREDB_QDRANT_API_KEY");
const READ_ONLY = env("LIBREDB_QDRANT_READ_ONLY_KEY");

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A JWT the server accepts: HS256, signed with its API key. */
function jwt(claims: Record<string, unknown>): string {
  const signed = `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url(claims)}`;
  return `${signed}.${createHmac("sha256", FULL).update(signed).digest("base64url")}`;
}

const PLAIN = "mcp_plain";
const OTHER = "mcp_other";
const SCRATCH = "mcp_scratch";
const PLAIN_ALIAS = "mcp_plain_alias";
const OTHER_ALIAS = "mcp_other_alias";
const MISSING = "mcp_missing";

const KEYS = {
  readOnly: READ_ONLY,
  jwtCollection: jwt({ access: [{ collection: PLAIN, access: "r" }] }),
  jwtAlias: jwt({ access: [{ collection: OTHER_ALIAS, access: "r" }] }),
  full: FULL,
  jwtManage: jwt({ access: "m" }),
  jwtNoAccess: jwt({}),
  jwtCollectionWrite: jwt({ access: [{ collection: PLAIN, access: "rw" }] }),
  jwtAliasWrite: jwt({ access: [{ collection: PLAIN_ALIAS, access: "rw" }] }),
};
const SECRETS: readonly string[] = Object.values(KEYS);

/** What a stored payload or vector of the seed holds; none of it may reach an answer. */
const STORED = /stored-|0\.4|peer_id|hnsw_config|wal_config/;

let failures = 0;
function check(ok: boolean, line: string): void {
  if (SECRETS.some((secret) => line.includes(secret))) {
    console.log("FAIL a check line carried a key, and is not printed");
    failures++;
    return;
  }
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

interface Raw {
  readonly status: number;
  readonly text: string;
}

/** A request past every check of Studio's, as `key` (none for no header). */
async function raw(origin: URL, key: string | undefined, method: string, path: string, body?: unknown): Promise<Raw> {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(key === undefined ? {} : { "api-key": key }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, text: await response.text() };
}

/** A setup request with the API key, which must succeed. */
async function admin(method: string, path: string, body?: unknown): Promise<unknown> {
  const answer = await raw(AUTH, FULL, method, path, body);
  if (answer.status >= 300) throw new Error(`${method} ${path} answered ${answer.status}`);
  return (JSON.parse(answer.text) as { result: unknown }).result;
}

async function collectionNames(): Promise<string[]> {
  const result = (await admin("GET", "/collections")) as { collections: { name: string }[] };
  return result.collections.map((entry) => entry.name).sort();
}

/** Everything a write could change, as one text: each collection with its point count, and every alias. */
async function serverState(): Promise<string> {
  const counts: string[] = [];
  for (const name of await collectionNames()) {
    if (name === SCRATCH) continue;
    const { count } = (await admin("POST", `/collections/${name}/points/count`, { exact: true })) as { count: number };
    counts.push(`${name}=${count}`);
  }
  const { aliases } = (await admin("GET", "/aliases")) as { aliases: { alias_name: string }[] };
  return `${counts.join(",")} | ${aliases
    .map((alias) => alias.alias_name)
    .sort()
    .join(",")}`;
}

/** Every request the server has answered so far, from its own counters, outside the counter read itself. */
async function served(): Promise<number> {
  const result = (await admin("GET", "/telemetry?details_level=1")) as {
    requests: { rest: { responses: Record<string, Record<string, { count: number }>> } };
  };
  let total = 0;
  for (const [route, statuses] of Object.entries(result.requests.rest.responses)) {
    if (route.startsWith("GET /telemetry")) continue;
    for (const status of Object.values(statuses)) total += status.count;
  }
  return total;
}

async function seedServer(): Promise<void> {
  const existing = await collectionNames();
  if (existing.length > 0) throw new Error(`the server must start empty, and holds ${existing.length} collections`);
  for (const name of [PLAIN, OTHER])
    await admin("PUT", `/collections/${name}`, { vectors: { size: 4, distance: "Dot" } });
  await admin("PUT", `/collections/${PLAIN}/points?wait=true`, {
    points: [1, 2, 3].map((n) => ({ id: n, vector: [0.1 * n, 0.2, 0.3, 0.4], payload: { city: `stored-city-${n}` } })),
  });
  await admin("PUT", `/collections/${PLAIN}/index?wait=true`, { field_name: "city", field_schema: "keyword" });
  await admin("PUT", `/collections/${OTHER}/points?wait=true`, {
    points: [{ id: 21, vector: [0.1, 0.2, 0.3, 0.4], payload: { city: "stored-other" } }],
  });
  await admin("POST", "/collections/aliases", {
    actions: [
      { create_alias: { collection_name: PLAIN, alias_name: PLAIN_ALIAS } },
      { create_alias: { collection_name: OTHER, alias_name: OTHER_ALIAS } },
    ],
  });
}

async function dropAll(): Promise<void> {
  for (const name of await collectionNames()) {
    if (name.startsWith("mcp_")) await admin("DELETE", `/collections/${name}`);
  }
}

function seed(id: string, origin: URL, key: string | undefined): ManagedConnection {
  return {
    id: `seed:live-${id}`,
    name: id,
    seedId: `live-${id}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "qdrant",
    host: origin.hostname,
    port: Number(origin.port),
    ...(key === undefined ? {} : { password: key }),
    createdAt: new Date(),
  } as ManagedConnection;
}

const RUN_QDRANT_READ = mcpStatementArm("run_qdrant_read");
/** The tool with its reader removed as a fence: the boundary under test. */
const UNFENCED: McpStatementArm = { ...RUN_QDRANT_READ, fence: () => null };
const NOT_SENT = "The statement was refused before it reached the database: ";

/** One MCP call on `connection`, through the factory's own profiled acquisition, as the route makes it. */
async function mcp(
  connection: ManagedConnection,
  args: Partial<McpStatementInput> & { readonly statement: string },
  arm: McpStatementArm = RUN_QDRANT_READ,
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

interface Answered {
  readonly rows: Record<string, unknown>[];
  readonly row_count: number;
  readonly truncated: boolean;
  readonly hint: string | null;
  readonly pagination: { readonly nextOffset: number | null };
}

/** The structured answer of a served call. */
const answerOf = (result: ToolResult): Answered => result.structuredContent as unknown as Answered;

const CAPTURES = posix.join(
  import.meta.dirname.replaceAll("\\", "/"),
  "..",
  "fixtures",
  "qdrant",
  "1.19.1",
  "mcp-scope",
);

/** One raw scope probe, written as a capture that records the principal's name and rights, never its key. */
function capture(name: string, principal: string, method: string, path: string, answer: Raw, version: string): void {
  const text = JSON.stringify(
    {
      version,
      name: `mcp-scope/${name}`,
      capturedAt: new Date().toISOString().slice(0, 10),
      principal,
      request: { method, path },
      status: answer.status,
      // The server's timing changes every run, so it is written as 0.
      body: answer.text.replace(/"time":[0-9.e-]+/, '"time":0'),
    },
    null,
    2,
  );
  if (SECRETS.some((secret) => text.includes(secret))) throw new Error(`capture ${name} would carry a key`);
  writeFileSync(posix.join(CAPTURES, `${name}.json`), `${text}\n`);
}

/**
 * A TCP proxy in front of the keyed server that stops forwarding while `hold` is set, so a read waits as it would on
 * a stalled server; it records when Studio's side of each held socket was closed.
 */
function stallingProxy(): Promise<{
  port: number;
  hold: (on: boolean) => void;
  closedAfterHold: () => number | null;
  close: () => void;
}> {
  let holding = false;
  let heldAt = 0;
  let closedAt: number | null = null;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    const upstream = createConnection({ host: AUTH.hostname, port: Number(AUTH.port) });
    sockets.add(upstream);
    let heldHere = false;
    client.on("data", (chunk) => {
      if (holding) {
        heldHere = true;
        return;
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!holding) client.write(chunk);
    });
    client.on("close", () => {
      if (heldHere && closedAt === null) closedAt = Date.now() - heldAt;
      upstream.destroy();
    });
    upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
        hold: (on: boolean) => {
          holding = on;
          heldAt = Date.now();
          closedAt = null;
        },
        closedAfterHold: () => closedAt,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

try {
  await dropAll();
  await seedServer();
  const version = ((await raw(AUTH, undefined, "GET", "/")).text.match(/"version":"([^"]+)"/) ?? [])[1] ?? "unknown";
  check(version === "1.19.1", `server: the keyed server reports ${version}`);
  const reader = seed("read-only", AUTH, KEYS.readOnly);

  // The forms: one accepted read of each metadata route, metadata only.
  const FORMS: readonly (readonly [string, (answer: Answered) => boolean])[] = [
    ["GET /", (a) => a.rows[0]?.version === version],
    [
      "GET /collections",
      (a) => JSON.stringify(a.rows) === JSON.stringify([{ collection: OTHER }, { collection: PLAIN }]),
    ],
    [`GET /collections/${PLAIN}`, (a) => a.rows[0]?.points === 3 && a.rows.some((row) => row.kind === "payload_index")],
    [`GET /collections/${PLAIN}/exists`, (a) => a.rows[0]?.exists === true],
    [`GET /collections/${PLAIN}/aliases`, (a) => a.rows[0]?.alias === PLAIN_ALIAS],
    ["GET /aliases", (a) => a.row_count === 2],
    [`POST /collections/${PLAIN}/points/count\n{"exact": true}`, (a) => a.rows[0]?.count === 3],
    [`GET /collections/${PLAIN}/cluster`, (a) => a.rows[0]?.state === "Active" && a.rows[0]?.points === 3],
  ];
  for (const [statement, holds] of FORMS) {
    const { result, acquired } = await mcp(reader, { statement });
    const ok = result.isError !== true && holds(answerOf(result)) && !STORED.test(textOf(result));
    check(
      ok && acquired.join() === "agent-read-only",
      `form: ${statement.split("\n")[0]} answers metadata only through MCP`,
    );
  }

  // The boundary: a write and every refused form, fenced and unfenced, and the write sent raw.
  const before = await serverState();
  const REFUSED: readonly (readonly [string, string, string, unknown])[] = [
    ["a point write", "PUT", `/collections/${PLAIN}/points?wait=true`, { points: [{ id: 99, vector: [1, 1, 1, 1] }] }],
    ["a collection delete", "DELETE", `/collections/${OTHER}`, undefined],
    ["an alias change", "POST", "/collections/aliases", { actions: [{ delete_alias: { alias_name: PLAIN_ALIAS } }] }],
    ["a payload index", "PUT", `/collections/${PLAIN}/index`, { field_name: "note", field_schema: "keyword" }],
    ["a point read", "POST", `/collections/${PLAIN}/points`, { ids: [1], with_payload: true }],
    ["a scroll", "POST", `/collections/${PLAIN}/points/scroll`, { limit: 1 }],
    ["a facet", "POST", `/collections/${PLAIN}/facet`, { key: "city" }],
    ["a query", "POST", `/collections/${PLAIN}/points/query`, { query: [0.1, 0.2, 0.3, 0.4] }],
    ["a count filter", "POST", `/collections/${PLAIN}/points/count`, { filter: { must: [] } }],
    ["the snapshot list", "GET", `/collections/${PLAIN}/snapshots`, undefined],
  ];
  for (const [what, method, path, body] of REFUSED) {
    const statement = body === undefined ? `${method} ${path}` : `${method} ${path}\n${JSON.stringify(body)}`;
    const fenced = await mcp(reader, { statement });
    check(
      fenced.result.isError === true &&
        textOf(fenced.result).startsWith("The request was refused before it reached the server (") &&
        fenced.acquired.length === 0,
      `boundary: ${what} is refused by the tool's fence before anything is acquired`,
    );
    const bypassed = await mcp(reader, { statement }, UNFENCED);
    check(
      bypassed.result.isError === true && textOf(bypassed.result).startsWith(NOT_SENT),
      `boundary: ${what}, the fence removed, is refused by the provider's reader before it is sent`,
    );
  }
  for (const [what, method, path, body] of REFUSED.slice(0, 4)) {
    const answer = await raw(AUTH, KEYS.readOnly, method, path, body);
    check(answer.status === 403, `boundary: ${what} sent raw with the read-only key is refused ${answer.status}`);
  }
  await admin("PUT", `/collections/${SCRATCH}`, { vectors: { size: 4, distance: "Dot" } });
  const control = await raw(AUTH, FULL, "PUT", `/collections/${SCRATCH}/points?wait=true`, {
    points: [{ id: 1, vector: [1, 1, 1, 1] }],
  });
  check(
    control.status === 200,
    `boundary: the positive control, the same write with the API key, answers ${control.status}`,
  );
  await admin("DELETE", `/collections/${SCRATCH}`);
  check(
    (await serverState()) === before,
    "boundary: the collections, their counts and the aliases read the same after",
  );

  // The open, through MCP: each principal that could write is refused before the read is sent.
  const OPENS: readonly (readonly [string, URL, string | undefined, string])[] = [
    ["the API key", AUTH, KEYS.full, QDRANT_PROOF_SENTENCES.writes],
    ["a JWT whose access is m", AUTH, KEYS.jwtManage, QDRANT_PROOF_SENTENCES.claims],
    ["a JWT with no access claim", AUTH, KEYS.jwtNoAccess, QDRANT_PROOF_SENTENCES.claims],
    ["a JWT that writes one collection", AUTH, KEYS.jwtCollectionWrite, QDRANT_PROOF_SENTENCES.claims],
    ["a JWT that writes through an alias", AUTH, KEYS.jwtAliasWrite, QDRANT_PROOF_SENTENCES.claims],
    ["no key on the keyed server", AUTH, undefined, QDRANT_PROOF_SENTENCES.keyless],
    ["a made-up key on the open server", OPEN, "not-a-real-key", QDRANT_PROOF_SENTENCES.writes],
    ["no key on the open server", OPEN, undefined, QDRANT_PROOF_SENTENCES.keyless],
  ];
  for (const [index, [what, origin, key, sentence]] of OPENS.entries()) {
    const before = await served();
    const { result } = await mcp(seed(`open-${index}`, origin, key), { statement: "GET /collections" });
    const after = origin === AUTH ? await served() : before;
    const expected = `run_qdrant_read cannot run on this connection: ${sentence.replace(/\.+$/, "")}. It runs on Qdrant.`;
    check(
      result.isError === true && textOf(result) === expected,
      `open: ${what} is refused in the tool's sentence (${after - before} requests reached the keyed server)`,
    );
  }
  // A key that lists more than 32 collections is refused before it proves anything.
  for (let i = 0; i < 31; i++)
    await admin("PUT", `/collections/mcp_many_${i}`, { vectors: { size: 4, distance: "Dot" } });
  {
    const { result } = await mcp(seed("many", AUTH, KEYS.readOnly), { statement: "GET /collections" });
    check(
      result.isError === true && textOf(result).includes(QDRANT_PROOF_SENTENCES.tooMany(33).replace(/\.+$/, "")),
      "open: the read-only key listing 33 collections is refused in the tool's sentence",
    );
  }
  for (let i = 0; i < 31; i++) await admin("DELETE", `/collections/mcp_many_${i}`);
  await clearProviderCache();

  // The data scope: a narrow principal and a broad one, through MCP and raw.
  mkdirSync(CAPTURES, { recursive: true });
  const narrow = seed("jwt-collection", AUTH, KEYS.jwtCollection);
  const listed = await mcp(narrow, { statement: "GET /collections" });
  check(
    JSON.stringify(answerOf(listed.result).rows) === JSON.stringify([{ collection: PLAIN }]),
    `scope: a JWT reading ${PLAIN} lists ${PLAIN} alone`,
  );
  const aliasesNarrow = await mcp(narrow, { statement: "GET /aliases" });
  check(answerOf(aliasesNarrow.result).row_count === 0, "scope: that JWT lists no alias, not even its collection's");
  const OUTSIDE = [
    (c: string) => `GET /collections/${c}`,
    (c: string) => `GET /collections/${c}/exists`,
    (c: string) => `GET /collections/${c}/aliases`,
    (c: string) => `GET /collections/${c}/cluster`,
    (c: string) => `POST /collections/${c}/points/count`,
  ];
  for (const form of OUTSIDE) {
    const hit = await mcp(narrow, { statement: form(OTHER) });
    const miss = await mcp(narrow, { statement: form(MISSING) });
    const hitText = textOf(hit.result).replaceAll(OTHER, "X");
    const missText = textOf(miss.result).replaceAll(MISSING, "X");
    check(
      hit.result.isError === true &&
        hitText === missText &&
        !hitText.includes("Access to collection") &&
        hitText.includes("The server's own words are not passed on"),
      `scope: that JWT is refused ${form("<c>")} alike for a collection that exists and one that does not, in Studio's words`,
    );
  }
  const viaAlias = seed("jwt-alias", AUTH, KEYS.jwtAlias);
  const aliasRead = await mcp(viaAlias, { statement: `GET /collections/${OTHER_ALIAS}` });
  const aliasOther = await mcp(viaAlias, { statement: `GET /collections/${OTHER}` });
  const aliasList = await mcp(viaAlias, { statement: "GET /collections" });
  check(
    aliasRead.result.isError !== true &&
      aliasOther.result.isError === true &&
      answerOf(aliasList.result).row_count === 0,
    `scope: a JWT reading ${OTHER_ALIAS} reads its collection through the alias alone, and lists no collection`,
  );
  const broadList = await mcp(reader, { statement: "GET /aliases" });
  check(answerOf(broadList.result).row_count === 2, "scope: the read-only key lists every alias the server holds");
  const PROBES: readonly (readonly [string, string, string, string])[] = [
    [
      "collections-jwt-collection-read",
      KEYS.jwtCollection,
      `a JWT whose access claim is [{"collection":"${PLAIN}","access":"r"}]`,
      "/collections",
    ],
    [
      "aliases-jwt-collection-read",
      KEYS.jwtCollection,
      `a JWT whose access claim is [{"collection":"${PLAIN}","access":"r"}]`,
      "/aliases",
    ],
    [
      "collection-aliases-jwt-collection-read",
      KEYS.jwtCollection,
      `a JWT whose access claim is [{"collection":"${PLAIN}","access":"r"}]`,
      `/collections/${PLAIN}/aliases`,
    ],
    [
      "other-exists-jwt-collection-read",
      KEYS.jwtCollection,
      `a JWT whose access claim is [{"collection":"${PLAIN}","access":"r"}]`,
      `/collections/${OTHER}/exists`,
    ],
    [
      "missing-exists-jwt-collection-read",
      KEYS.jwtCollection,
      `a JWT whose access claim is [{"collection":"${PLAIN}","access":"r"}]`,
      `/collections/${MISSING}/exists`,
    ],
    [
      "other-cluster-jwt-collection-read",
      KEYS.jwtCollection,
      `a JWT whose access claim is [{"collection":"${PLAIN}","access":"r"}]`,
      `/collections/${OTHER}/cluster`,
    ],
    [
      "other-aliases-jwt-collection-read",
      KEYS.jwtCollection,
      `a JWT whose access claim is [{"collection":"${PLAIN}","access":"r"}]`,
      `/collections/${OTHER}/aliases`,
    ],
    [
      "collections-jwt-alias-read",
      KEYS.jwtAlias,
      `a JWT whose access claim is [{"collection":"${OTHER_ALIAS}","access":"r"}]`,
      "/collections",
    ],
    [
      "alias-cluster-jwt-alias-read",
      KEYS.jwtAlias,
      `a JWT whose access claim is [{"collection":"${OTHER_ALIAS}","access":"r"}]`,
      `/collections/${OTHER_ALIAS}/cluster`,
    ],
    [
      "other-jwt-alias-read",
      KEYS.jwtAlias,
      `a JWT whose access claim is [{"collection":"${OTHER_ALIAS}","access":"r"}]`,
      `/collections/${OTHER}`,
    ],
    ["aliases-read-only", KEYS.readOnly, "the server's read-only API key", "/aliases"],
    ["other-cluster-read-only", KEYS.readOnly, "the server's read-only API key", `/collections/${OTHER}/cluster`],
  ];
  for (const [name, key, principal, path] of PROBES) {
    capture(name, principal, "GET", path, await raw(AUTH, key, "GET", path), version);
  }
  check(true, `scope: ${PROBES.length} raw scope answers written to tests/fixtures/qdrant/1.19.1/mcp-scope/`);

  // The limits: max_rows, the row budget, the timeout and the cancel.
  const manyAliases = (from: number, to: number, action: "create_alias" | "delete_alias") =>
    admin("POST", "/collections/aliases", {
      actions: Array.from({ length: to - from }, (_, i) =>
        action === "create_alias"
          ? { create_alias: { collection_name: PLAIN, alias_name: `mcp_many_alias_${from + i}` } }
          : { delete_alias: { alias_name: `mcp_many_alias_${from + i}` } },
      ),
    });
  await manyAliases(0, 20, "create_alias");
  const cut = await mcp(reader, { statement: `GET /collections/${PLAIN}/aliases`, max_rows: 10 });
  check(
    cut.result.isError !== true &&
      answerOf(cut.result).row_count === 10 &&
      answerOf(cut.result).truncated &&
      answerOf(cut.result).pagination.nextOffset === null &&
      (answerOf(cut.result).hint ?? "").includes("this tool does not page with offset"),
    "limits: a read past max_rows is cut to it with advice and no next offset",
  );
  await manyAliases(20, 1_001, "create_alias");
  const overBudget = await mcp(reader, { statement: "GET /aliases" });
  check(
    overBudget.result.isError === true &&
      textOf(overBudget.result).startsWith(
        "The result has more than 1000 rows, the most this server reads for one call.",
      ),
    "limits: 1003 aliases are refused past the 1000-row provider budget, never cut",
  );
  await manyAliases(0, 1_001, "delete_alias");

  const proxy = await stallingProxy();
  try {
    const stalled = seed("stalled", new URL(`http://127.0.0.1:${proxy.port}`), KEYS.readOnly);
    const warm = await mcp(stalled, { statement: "GET /collections" });
    check(warm.result.isError !== true, "limits: a read through the proxy is served while it forwards");
    proxy.hold(true);
    let started = Date.now();
    const timedOut = await mcp(stalled, { statement: "GET /collections", timeout_ms: 500 });
    const answeredIn = Date.now() - started;
    await sleep(300);
    const timeoutClosed = proxy.closedAfterHold();
    check(
      textOf(timedOut.result) === timeoutText(500) && answeredIn < 1_000,
      `limits: a stalled read at the minimum timeout_ms 500 is answered as the timeout in ${answeredIn} ms`,
    );
    check(
      timeoutClosed !== null && timeoutClosed <= 700,
      `limits: the provider closed its stalled request ${timeoutClosed} ms after it was held, at the time left`,
    );
    proxy.hold(false);
    await clearProviderCache();
    const cancelled = seed("cancelled", new URL(`http://127.0.0.1:${proxy.port}`), KEYS.readOnly);
    check((await mcp(cancelled, { statement: "GET /collections" })).result.isError !== true, "limits: warm again");
    proxy.hold(true);
    const controller = new AbortController();
    started = Date.now();
    const pending = mcp(
      cancelled,
      { statement: "GET /collections", timeout_ms: 3_000 },
      RUN_QDRANT_READ,
      controller.signal,
    );
    await sleep(200);
    controller.abort();
    const cancelAnswer = await pending;
    const cancelIn = Date.now() - started;
    const openAtCancel = proxy.closedAfterHold();
    await sleep(3_300);
    const cancelClosed = proxy.closedAfterHold();
    check(
      textOf(cancelAnswer.result) === MCP_CANCELLED_TEXT && cancelIn < 1_000,
      `limits: a client cancel at 200 ms is answered as cancelled in ${cancelIn} ms`,
    );
    check(
      openAtCancel === null && cancelClosed !== null && cancelClosed >= 2_500 && cancelClosed <= 3_500,
      `limits: after the cancel the provider kept its request open, and closed it ${cancelClosed} ms after it was held, at the time left`,
    );
    proxy.hold(false);
  } finally {
    proxy.close();
  }
  await clearProviderCache();

  // The cost: the server's own counters around one call on a warm handle, and around the open.
  const coldBefore = await served();
  await mcp(reader, { statement: "GET /collections" });
  const coldCount = (await served()) - coldBefore;
  const warmBefore = await served();
  await mcp(reader, { statement: "GET /collections" });
  const warmCount = (await served()) - warmBefore;
  const listedNow = (await collectionNames()).length;
  check(
    warmCount === 2 + listedNow + 1,
    `cost: one call on a held handle sends ${warmCount} requests for ${listedNow} listed collections: the alias update, the list, one delete each, then the read`,
  );
  check(
    coldCount === 2 + (2 + listedNow) + (2 + listedNow + 1),
    `cost: the first call also opens the handle, ${coldCount} requests in all`,
  );
} finally {
  await clearProviderCache();
  await dropAll();
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

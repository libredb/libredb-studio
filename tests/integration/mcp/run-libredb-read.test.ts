/**
 * run_libredb_read: MCP's libredbkv arm, run by the statement core over the real LibreDB provider, the real factory and
 * real files, through the real seed file and MCP handler. LibreDB is embedded, with no server to start, so this is
 * the boundary replay itself: every check below opens the same kernel against the same kind of file a seed names.
 *
 * The command is the agent's own, read and admitted by the agent's own libredbkv adapter, and every command opens the
 * file on a read-only handle of its own through the read-only file adapter, which takes no lock and cannot write: a
 * read answers keys and values behind the untrusted-content notice, beside an editor that holds the file's writer; a
 * write is refused before anything is acquired and, with that fence removed, by the provider's own reader, and the
 * file stays byte for byte as it was; a result cut to max_rows says how to read on with a range, since the tool takes no
 * offset. The data scope is the one file the seed names: Studio's own storage database, its sidecars and its credential
 * file are refused as a target by path, links included, and the file's reserved internal namespace is left out of every
 * answer, whatever the command asked for. A timeout or a cancel ends the wait only when the read has ended, because the
 * read runs on the server's own thread.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_PREFIX, kv, open, RESERVED_MARKER, table } from "@libredb/libredb";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import { LibreDBProvider } from "@/lib/db/providers/embedded/libredb";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { timeoutText } from "@/lib/mcp/tools/read-query-limits";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { type McpStatementArm, mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { DatabaseConnection } from "@/lib/types";
import { createSqliteFile, pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-libredb-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("libredbkv");
const RUN_LIBREDB_READ_ARM = mcpStatementArm("run_libredb_read");
/** The tool with its fence removed: what the provider's own reader and the read-only handle refuse on their own. */
const UNFENCED: McpStatementArm = { ...RUN_LIBREDB_READ_ARM, fence: () => null };

/** Studio's own state, where the server would keep it: its storage database, sidecars and credential file. */
const STATE = join(dir, "state");
const STORAGE = join(STATE, "libredb-storage.db");
const BOOTSTRAP = join(STATE, "auth-bootstrap.json");
const previousStoragePath = process.env.STORAGE_SQLITE_PATH;
process.env.STORAGE_SQLITE_PATH = STORAGE;

const KV = join(dir, "kv.libredb");
const MANY = join(dir, "many.libredb");
const LARGE = join(dir, "large.libredb");
const SCRATCH = join(dir, "scratch.libredb");

const VALUE_32K = "v".repeat(33 * 1024);

beforeAll(() => {
  mkdirSync(STATE);
  createSqliteFile(STORAGE, [
    "CREATE TABLE users (email TEXT, password_hash TEXT)",
    "INSERT INTO users VALUES ('admin@example.test', 'not-a-real-hash')",
  ]);
  writeFileSync(`${STORAGE}-wal`, "");
  writeFileSync(BOOTSTRAP, JSON.stringify({ jwtSecret: "not-a-real-secret" }));

  const db = open({ path: KV });
  const store = kv(db);
  store.set("users:1", "Ada");
  store.set("users:2", JSON.stringify({ name: "Grace" }));
  store.set("users:3", "Linus");
  store.set("orders:1", "42");
  store.set("a key", "spaced");
  // A relational table writes its catalog entry under the reserved namespace.
  table(db, "employees", { primaryKey: "id", columns: { id: "string", name: "string" } }).insert({
    id: "1",
    name: "Ada",
  });
  db.close();

  const many = open({ path: MANY });
  const manyStore = kv(many);
  for (let i = 0; i < 1_001; i += 1) manyStore.set(`n:${String(i).padStart(4, "0")}`, "x");
  many.close();

  const large = open({ path: LARGE });
  const largeStore = kv(large);
  for (let i = 0; i < 40; i += 1) largeStore.set(`l:${String(i).padStart(2, "0")}`, "w".repeat(30 * 1024));
  largeStore.set("big:1", VALUE_32K);
  largeStore.set("half:15", "h".repeat(15 * 1024));
  largeStore.set("half:16", "h".repeat(16 * 1024));
  large.close();
});

beforeEach(() => {
  copyFileSync(KV, SCRATCH);
  writeSeedFile(dir, [
    { id: "kv", type: "libredb", database: KV },
    { id: "many", type: "libredb", database: MANY },
    { id: "large", type: "libredb", database: LARGE },
    { id: "scratch", type: "libredb", database: SCRATCH },
    { id: "storage", type: "libredb", database: STORAGE },
    { id: "storage-wal", type: "libredb", database: `${STORAGE}-wal` },
    { id: "bootstrap", type: "libredb", database: BOOTSTRAP },
    { id: "shop", type: "sqlite", database: join(dir, "absent.db") },
  ]);
});

afterEach(async () => {
  await resetMcpTestState();
});

afterAll(() => {
  if (previousStoragePath === undefined) delete process.env.STORAGE_SQLITE_PATH;
  else process.env.STORAGE_SQLITE_PATH = previousStoragePath;
  rmSync(dir, { recursive: true, force: true });
});

interface Answered {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any>;
}

async function call(name: string, args: Record<string, unknown>): Promise<Answered> {
  const session = await connectClient(serve, { negotiation: "legacy" });
  try {
    return (await session.client.callTool({ name, arguments: args })) as Answered;
  } finally {
    await session.close();
  }
}

const libredb = (statement: string, extra: Record<string, unknown> = {}, connection = "seed:kv") =>
  call("run_libredb_read", { connection_id: connection, statement, ...extra });

/** One call through the statement core with the route's own context, under `signal`. */
function direct(
  arm: McpStatementArm,
  args: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
): Promise<Answered> {
  const input = arm.inputSchema.parse(args) as McpStatementInput;
  const context = new McpConnectionContext({ username: "alice", role: "admin" });
  return runStatement(arm, input, { context, signal }) as Promise<Answered>;
}

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

const text = (result: Answered) => result.content.map((block) => block.text).join("\n");

/** The keys a kernel opened writable on `file` holds under `prefix`, reserved ones included. */
function kernelKeys(file: string, prefix: string): string[] {
  const db = open({ path: file });
  try {
    return [...kv(db).prefix(prefix)].map((entry) => entry.key);
  } finally {
    db.close();
  }
}

type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Makes every agent read spend `ms` on the server's thread before it reads, as a slow read would, after calling
 * `entered`; undone by restore.
 */
function slowReads(ms: number, entered: () => void = () => {}): { restore(): void } {
  const prototype = LibreDBProvider.prototype as unknown as Record<string, AnyMethod>;
  const original = prototype.readForAgent;
  prototype.readForAgent = function slowed(this: unknown, ...args: unknown[]) {
    entered();
    const until = Date.now() + ms;
    let spins = 0;
    while (Date.now() < until) spins += 1;
    return spins >= 0 ? original.apply(this, args) : undefined;
  };
  return { restore: () => (prototype.readForAgent = original) };
}

describe("the tool", () => {
  test("is listed with the statement schema and no offset or database, read-only", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tool = (await session.client.listTools()).tools.find((candidate) => candidate.name === "run_libredb_read");
      expect(tool?.description).toBe(RUN_LIBREDB_READ_ARM.description);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
        "connection_id",
        "statement",
        "max_rows",
        "timeout_ms",
      ]);
    } finally {
      await session.close();
    }
  });

  test("describes LibreDB as the engine it runs on", () => {
    expect(RUN_LIBREDB_READ_ARM.engines).toBe("LibreDB");
  });

  test("list_connections names it as each LibreDB connection's read tool", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.filter((connection) => connection.id === "seed:kv" || connection.id === "seed:shop")).toEqual([
      expect.objectContaining({ id: "seed:kv", read_tool: "run_libredb_read" }),
      expect.objectContaining({ id: "seed:shop", read_tool: "run_read_query" }),
    ]);
  });
});

describe("a read", () => {
  test("get answers the key and its value behind the notice, recorded under run_libredb_read", async () => {
    const result = await libredb("get users:1");
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:kv",
      columns: [{ name: "key" }, { name: "value" }],
      rows: [{ key: "users:1", value: "Ada" }],
      row_count: 1,
      truncated: false,
      hint: null,
    });
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_libredb_read", "mcp/decision", "success"],
      ["run_libredb_read", "mcp/execution", "success"],
    ]);
  });

  test("prefix reads every key that starts with it, range up to but not including its end, and a quoted key", async () => {
    const prefix = await libredb("prefix users:");
    expect(prefix.structuredContent?.rows.map((row: { key: string }) => row.key)).toEqual([
      "users:1",
      "users:2",
      "users:3",
    ]);
    const range = await libredb("range users:1 users:3");
    expect(range.structuredContent?.rows.map((row: { key: string }) => row.key)).toEqual(["users:1", "users:2"]);
    const quoted = await libredb('get "a key"');
    expect(quoted.structuredContent?.rows).toEqual([{ key: "a key", value: "spaced" }]);
  });

  test("a read past max_rows is cut to it, and the hint reads on with a range rather than paging", async () => {
    const result = await libredb("prefix users:", { max_rows: 2 });
    expect(result.structuredContent).toMatchObject({
      rows: [{ key: "users:1" }, { key: "users:2" }],
      row_count: 2,
      truncated: true,
      truncated_by: "max_rows",
      pagination: { offset: 0, limit: 2, hasMore: true, nextOffset: null, wasLimited: false },
      hint: RUN_LIBREDB_READ_ARM.moreRows("prefix users:", "libredb", { maxRows: 2, shown: 2, cut: "max_rows" }),
    });
    expect(result.structuredContent?.hint).toContain("range <the last key returned> <end>");
  });

  test("a value larger than the 32 KiB result limit is refused whole, never cut", async () => {
    const result = await libredb("get big:1", {}, "seed:large");
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(RUN_LIBREDB_READ_ARM.rowOverCap);
    expect(text(result)).not.toContain(VALUE_32K.slice(0, 1024));
  });

  test("the limit measures the whole tool result, which carries a row twice, so a 16 KiB value is refused and 15 KiB fits", async () => {
    const fits = await libredb("get half:15", {}, "seed:large");
    expect(fits.isError).toBeFalsy();
    expect(fits.structuredContent?.rows).toEqual([{ key: "half:15", value: "h".repeat(15 * 1024) }]);
    expect(text(fits)).toContain("h".repeat(15 * 1024));
    const refused = await libredb("get half:16", {}, "seed:large");
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain(RUN_LIBREDB_READ_ARM.rowOverCap);
  });

  test("reads beside the editor's writer, which holds the lock, and sees what it has committed", async () => {
    const writer = new LibreDBProvider({
      id: "editor",
      name: "editor",
      type: "libredb",
      database: SCRATCH,
    } as DatabaseConnection);
    await writer.connect();
    try {
      expect(existsSync(`${SCRATCH}.lock`)).toBe(true);
      await writer.query("put users:9 Margaret");
      const result = await libredb("get users:9", {}, "seed:scratch");
      expect(result.isError ?? false).toBe(false);
      expect(result.structuredContent?.rows).toEqual([{ key: "users:9", value: "Margaret" }]);
      // The writer keeps writing after the read.
      await writer.query("put users:10 Barbara");
      expect((await libredb("get users:10", {}, "seed:scratch")).structuredContent?.rows).toEqual([
        { key: "users:10", value: "Barbara" },
      ]);
    } finally {
      await writer.disconnect();
    }
  });
});

describe("a refusal", () => {
  test.each([
    ["a put", "put users:1 Eve"],
    ["a delete", "delete users:1"],
    ["a write in quotes", '"PUT" users:1 Eve'],
    ["a second line", "get users:1\nput users:1 Eve"],
    ["text that is no command", "SELECT * FROM users"],
    ["a command longer than the agent takes", `get ${"k".repeat(4_100)}`],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, statement) => {
    const before = readFileSync(KV);
    const result = await libredb(statement);
    const refusal = server.admit?.(statement);
    expect(refusal).not.toBeNull();
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `The command was refused before it reached the file (${refusal?.code}). ${refusal?.message}`,
        },
      ],
    });
    expect(readFileSync(KV)).toEqual(before);
    expect(mcpEvents()).toEqual([
      expect.objectContaining({
        action: "run_libredb_read",
        target: "mcp/decision",
        result: "failure",
        reason: "mcp_statement_refused",
      }),
    ]);
  });

  test.each([
    ["a put", "put users:1 Eve"],
    ["a delete", "delete users:1"],
  ])(
    "%s with the fence removed is refused by the provider's own reader, and the file is unchanged",
    async (_shape, statement) => {
      const before = readFileSync(SCRATCH);
      const result = await direct(UNFENCED, { connection_id: "seed:scratch", statement });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("The statement was refused before it reached the database");
      expect(readFileSync(SCRATCH)).toEqual(before);
      expect(existsSync(`${SCRATCH}.lock`)).toBe(false);
      // The positive control: the same command on the editor's writable handle changes the file.
      const writer = new LibreDBProvider({
        id: "editor",
        name: "editor",
        type: "libredb",
        database: SCRATCH,
      } as DatabaseConnection);
      await writer.connect();
      try {
        await writer.query(statement);
      } finally {
        await writer.disconnect();
      }
      expect(readFileSync(SCRATCH)).not.toEqual(before);
    },
  );

  test("a read past the 1000-key provider budget is refused with the command's own advice, never cut", async () => {
    const result = await libredb("prefix n:", {}, "seed:many");
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(
      `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice("prefix n:", "1000")}`,
    );
  });

  test("a read past the 1 MiB provider budget is refused, never cut", async () => {
    const result = await libredb("prefix l:", {}, "seed:large");
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("The result is larger than 1 MiB, the most this server reads for one call.");
  });

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_libredb_read", { connection_id: "seed:shop", statement: "get users:1" });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_libredb_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on LibreDB.",
        },
      ],
    });
  });

  test.each([
    ["an offset", { offset: 100 }],
    ["a database, which on LibreDB would be another file", { database: STORAGE }],
  ])("%s is an argument this tool does not take", async (_what, extra) => {
    const result = await libredb("get users:1", extra);
    expect(result.isError).toBe(true);
    expect(mcpEvents()).toEqual([]);
  });
});

/**
 * The data scope. A LibreDB file has no principal, so what a connection reaches is the one file its seed names, and
 * every key in it. Two layers keep Studio's own data and the engine's internals out, and neither reads the command: the
 * target path is refused when it is Studio's storage database, a sidecar of it or its credential file, compared by
 * resolved path and by file identity; and each key read is dropped from the answer when it is in the file's reserved
 * namespace. A file that is no LibreDB file at all is refused by the kernel's own format check.
 */
describe("the data scope", () => {
  const RESERVED = "This path is reserved for the server's own storage and cannot be opened as a connection";

  test.each([
    ["Studio's storage database", "seed:storage"],
    ["its write-ahead log", "seed:storage-wal"],
    ["its credential file", "seed:bootstrap"],
  ])("%s is refused as a target before it is opened", async (_what, connection) => {
    const before = readFileSync(STORAGE);
    const result = await libredb("prefix u", {}, connection);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(RESERVED);
    expect(text(result)).not.toContain("not-a-real");
    expect(readFileSync(STORAGE)).toEqual(before);
  });

  test("a symbolic link and a hard link to the storage database are refused as the database itself is", async () => {
    const soft = join(dir, "soft.libredb");
    const hard = join(dir, "hard.libredb");
    symlinkSync(STORAGE, soft);
    linkSync(STORAGE, hard);
    try {
      writeSeedFile(dir, [
        { id: "soft", type: "libredb", database: soft },
        { id: "hard", type: "libredb", database: hard },
      ]);
      const answers = await Promise.all(
        ["seed:soft", "seed:hard"].map(async (connection) => ({
          connection,
          refused: text(await libredb("prefix u", {}, connection)).includes(RESERVED),
        })),
      );
      expect(answers).toEqual([
        { connection: "seed:soft", refused: true },
        { connection: "seed:hard", refused: true },
      ]);
    } finally {
      rmSync(soft);
      rmSync(hard);
    }
  });

  test("a file that is no LibreDB file is refused by the kernel's format check, and left as it was", async () => {
    const copy = join(dir, "copy-of-storage.db");
    copyFileSync(STORAGE, copy);
    try {
      writeSeedFile(dir, [{ id: "copy", type: "libredb", database: copy }]);
      const before = readFileSync(copy);
      const result = await libredb("prefix u", {}, "seed:copy");
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("The file is not a LibreDB database. It was left untouched");
      expect(text(result)).not.toContain("not-a-real");
      expect(readFileSync(copy)).toEqual(before);
    } finally {
      rmSync(copy);
    }
  });

  test("a file that does not exist is refused, and none is created", async () => {
    const absent = join(dir, "absent.libredb");
    writeSeedFile(dir, [{ id: "absent", type: "libredb", database: absent }]);
    const result = await libredb("get users:1", {}, "seed:absent");
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`The LibreDB file ${absent} does not exist.`);
    expect(existsSync(absent)).toBe(false);
    expect(existsSync(`${absent}.lock`)).toBe(false);
  });

  test("inspect_schema refuses a file that does not exist with the same sentence, and creates neither it nor its lock", async () => {
    const absent = join(dir, "absent-inspected.libredb");
    writeSeedFile(dir, [{ id: "absent", type: "libredb", database: absent }]);
    const inspected = await call("inspect_schema", { connection_id: "seed:absent" });
    expect(inspected.isError).toBe(true);
    expect(text(inspected)).toContain(`The LibreDB file ${absent} does not exist.`);
    expect(existsSync(absent)).toBe(false);
    expect(existsSync(`${absent}.lock`)).toBe(false);
    // So a read after it still meets the missing file rather than an empty store it made.
    const read = await libredb("prefix u", {}, "seed:absent");
    expect(read.isError).toBe(true);
    expect(text(read)).toContain(`The LibreDB file ${absent} does not exist.`);
    expect(existsSync(absent)).toBe(false);
  });

  test("a name beside Studio's storage database that is not one of its files is never created by either tool", async () => {
    const variant = join(STATE, "LIBREDB-STORAGE.DB");
    writeSeedFile(dir, [{ id: "variant", type: "libredb", database: variant }]);
    for (const result of [
      await call("inspect_schema", { connection_id: "seed:variant" }),
      await libredb("prefix u", {}, "seed:variant"),
    ]) {
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("does not exist");
    }
    expect(existsSync(variant)).toBe(false);
    expect(existsSync(`${variant}.lock`)).toBe(false);
  });

  test("a reserved path is refused by both tools before anything is created beside it", async () => {
    for (const result of [
      await call("inspect_schema", { connection_id: "seed:storage" }),
      await libredb("prefix u", {}, "seed:storage"),
    ]) {
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("This path is reserved for the server's own storage");
    }
    expect(existsSync(`${STORAGE}.lock`)).toBe(false);
  });

  test("a pseudo-file whose size reads 0 but which holds bytes is refused by both tools as no LibreDB file", async () => {
    writeSeedFile(dir, [{ id: "environ", type: "libredb", database: "/proc/self/environ" }]);
    for (const result of [
      await call("inspect_schema", { connection_id: "seed:environ" }),
      await libredb("prefix u", {}, "seed:environ"),
    ]) {
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("The file is not a LibreDB database. It was left untouched");
      expect(text(result)).not.toContain("does not exist");
    }
  });

  test("a zero-length file is an empty store, as a freshly created one is, and both tools read it", async () => {
    const fresh = join(dir, "fresh.libredb");
    const zero = join(dir, "zero.libredb");
    open({ path: fresh }).close();
    writeFileSync(zero, "");
    // Measured: a store the kernel created and closed with no commit is zero bytes on disk.
    expect(readFileSync(fresh).length).toBe(0);
    try {
      writeSeedFile(dir, [
        { id: "fresh", type: "libredb", database: fresh },
        { id: "zero", type: "libredb", database: zero },
      ]);
      for (const id of ["seed:fresh", "seed:zero"]) {
        const inspected = await call("inspect_schema", { connection_id: id });
        expect(inspected.isError).toBeFalsy();
        const read = await libredb("prefix u", {}, id);
        expect(read.isError).toBeFalsy();
        expect(read.structuredContent?.rows).toEqual([]);
      }
      expect(readFileSync(fresh).length).toBe(0);
      expect(readFileSync(zero).length).toBe(0);
    } finally {
      rmSync(fresh, { force: true });
      rmSync(zero, { force: true });
    }
  });

  test("the file's reserved namespace holds the catalog, and no command reads a key of it", async () => {
    // The control: the kernel holds the catalog entry under the reserved marker.
    const catalog = kernelKeys(KV, RESERVED_MARKER);
    expect(catalog).toContain(`${CATALOG_PREFIX}employees`);
    const statements = [
      `get "${CATALOG_PREFIX}employees"`,
      `prefix "${RESERVED_MARKER}"`,
      `prefix "${CATALOG_PREFIX}"`,
      `range "${RESERVED_MARKER}" "${RESERVED_MARKER}~"`,
    ];
    for (const statement of statements) expect(server.admit?.(statement)).toBeNull();
    const answers = await Promise.all(
      statements.map(async (statement) => ({ statement, rows: (await libredb(statement)).structuredContent?.rows })),
    );
    expect(answers).toEqual(statements.map((statement) => ({ statement, rows: [] })));
    // A range across the whole keyspace answers every user key and no reserved one.
    const all = await libredb(`range "${RESERVED_MARKER}" "~"`, { max_rows: 500 });
    const keys = (all.structuredContent?.rows ?? []).map((row: { key: string }) => row.key);
    expect(keys).toContain("users:1");
    expect(keys).toContain("employees:1");
    expect(keys.filter((key: string) => key.startsWith(RESERVED_MARKER))).toEqual([]);
  });
});

describe("the wait", () => {
  test("a read that outruns timeout_ms is answered as the timeout when it ends, since it cannot be stopped midway", async () => {
    const slow = slowReads(800);
    try {
      const started = Date.now();
      const result = await direct(RUN_LIBREDB_READ_ARM, {
        connection_id: "seed:kv",
        statement: "get users:1",
        timeout_ms: 500,
      });
      expect(result).toEqual({ isError: true, content: [{ type: "text", text: timeoutText(500) }] });
      expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    } finally {
      slow.restore();
    }
  });

  test("a cancel during a read is seen only when the read has ended, and a cancel before it ends the call unread", async () => {
    const during = new AbortController();
    // The client cancels while the read runs: the cancel is queued then, and delivered once the thread is free.
    const slow = slowReads(400, () => setTimeout(() => during.abort(), 0));
    try {
      const started = Date.now();
      const read = await direct(
        RUN_LIBREDB_READ_ARM,
        { connection_id: "seed:kv", statement: "get users:1", timeout_ms: 5_000 },
        during.signal,
      );
      // The read held the server's thread for its whole length, so its answer settled before the cancel was delivered.
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
      expect(read.structuredContent?.rows).toEqual([{ key: "users:1", value: "Ada" }]);
      expect(during.signal.aborted).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(during.signal.aborted).toBe(true);

      const before = new AbortController();
      before.abort();
      const cancelled = await direct(
        RUN_LIBREDB_READ_ARM,
        { connection_id: "seed:kv", statement: "get users:1" },
        before.signal,
      );
      expect(cancelled).toEqual({ isError: true, content: [{ type: "text", text: MCP_CANCELLED_TEXT }] });
    } finally {
      slow.restore();
    }
  });
});

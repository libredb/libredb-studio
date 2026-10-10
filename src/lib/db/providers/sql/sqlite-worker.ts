/**
 * Child-process isolation for the SQLite provider (#1623).
 *
 * `bun:sqlite` and `node:sqlite` are both SYNCHRONOUS: a long statement runs on the
 * Studio server's own JavaScript thread and no other request is answered while it
 * runs (measured 2026-10-03, `/api/health` answered after 69.7 s during one recursive
 * CTE). Neither driver exposes `sqlite3_interrupt` or a progress handler, so the only
 * way to make the deadline preemptive is to run the statement somewhere the server can
 * kill: a child process.
 *
 * The child is started with `node -e <bootstrap>` rather than a script
 * file on purpose. The production payload deletes `src/` (see
 * `scripts/lib/prune-standalone-payload.sh`), so a worker file under `src/` would
 * exist in development and vanish in the Docker image, the npx cache and the native
 * packages. An inline `-e` script needs no file, no tracing entry and no deployment
 * edit, and it runs under Node in every environment: production already runs Node,
 * and under Bun the child is a real `node` binary, because Bun's own `bun:sqlite`
 * hangs a child a `bun test` run spawned (Bun 1.4.x).
 * A child process also avoids the worker-thread locks the Bun runtime takes around
 * its synchronous SQLite drivers, and `SIGKILL` can always stop it.
 *
 * THE BOUNDARY IS DELIBERATELY NARROW. The child opens the handle, runs SQL and reads
 * raw rows; every value it cannot JSON-encode is tagged and the tags are resolved on
 * the parent side:
 *
 * - a 64-bit integer is tagged `{ __libredb_sqlite_bigint: "..." }` and the parent
 *   resolves it through `normalizeSQLiteBigInt` — the ONE place that decides whether
 *   a 64-bit integer fits a JavaScript number, shared with the in-process driver;
 * - a BLOB (`Uint8Array`) is tagged `{ __libredb_sqlite_bytes: "<base64>" }` and the
 *   parent resolves it to a `Buffer`, exactly the shape the in-process driver hands out.
 *
 * That is the whole reason this file can stay small: it duplicates no value logic. It
 * only moves values across a boundary the synchronous drivers cannot cross.
 *
 * The handle is ONE connection and requests are SERIALISED: a second request waits
 * for the first, exactly as the single in-process handle did. Cancelling or timing out
 * a statement kills the child, which drops the operating system's file descriptors, and
 * the next statement lazily starts a fresh child and re-applies the PRAGMAs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { normalizeSQLiteBigInt, toSQLiteBindValue, type SQLiteDeclaredColumn } from "./sqlite-driver";

// ============================================================================
// Shared shapes
// ============================================================================

/** What `queryRows` answers: the raw driver read, before any result shaping. */
export interface SQLiteRawRead {
  readonly values: unknown[][];
  readonly columns: readonly SQLiteDeclaredColumn[];
  readonly returnsRows: boolean;
  readonly changes: number;
}

/** The open-time facts that decide how the child opens the handle. */
export interface SQLiteWorkerOpen {
  readonly dbPath: string;
  readonly readonly: boolean;
  readonly queryOnly: boolean;
}

/**
 * The handle surface the provider uses. Async, because every call crosses the
 * process boundary and a synchronous wait would re-block the server the worker
 * exists to unblock.
 */
export interface SQLiteHandle {
  exec(sql: string): Promise<void>;
  all(sql: string, params?: readonly unknown[]): Promise<unknown[]>;
  get(sql: string, params?: readonly unknown[]): Promise<unknown>;
  queryRows(sql: string, params: readonly unknown[], timeoutMs?: number): Promise<SQLiteRawRead>;
  inTransaction(): Promise<boolean>;
  close(): Promise<void>;
}

// ============================================================================
// Wire tags
// ============================================================================

const BIGINT_TAG = "__libredb_sqlite_bigint";
const BYTES_TAG = "__libredb_sqlite_bytes";

/**
 * Tag every value the child cannot JSON-encode. Applied to BOUND PARAMETERS on the
 * way IN (after `toSQLiteBindValue` has already run on the parent) and to result cells
 * on the way OUT. A BigInt becomes its decimal text; a `Uint8Array` becomes a plain
 * array. Everything else passes through, recursing into arrays and records.
 */
/**
 * A bound parameter on the way IN: decimal 64-bit digits become a BigInt first
 * (`toSQLiteBindValue`, the same conversion the in-process drivers apply), then
 * `serializeCell` tags the BigInt for the wire. Without the first step a decimal
 * string read back from the provider would bind as TEXT and stop matching the
 * INTEGER it was read from.
 */
export function serializeBind(value: unknown): unknown {
  return serializeCell(toSQLiteBindValue(value));
}

export function serializeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return { [BIGINT_TAG]: value.toString() };
  if (value instanceof Uint8Array) return { [BYTES_TAG]: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(serializeCell);
  if (typeof value === "object") {
    // `Object.fromEntries` rather than `out[key] = ...`: it defines OWN properties, so a cell
    // key like "__proto__" writes an own property instead of replacing the prototype (CodeQL
    // remote property injection). The same convention `declaredColumnTypes` uses for names.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, cell]) => [key, serializeCell(cell)]),
    );
  }
  return value;
}

/**
 * Resolve the tags `serializeCell` wrote, on the parent side. A tagged bigint goes
 * through `normalizeSQLiteBigInt` (number when lossless, decimal string otherwise);
 * a tagged byte array becomes a `Buffer`, the same shape the in-process driver
 * produces. Nothing else is reinterpreted.
 */
export function deserializeCell(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(deserializeCell);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record[BIGINT_TAG] === "string" && Object.keys(record).length === 1) {
      return normalizeSQLiteBigInt(BigInt(record[BIGINT_TAG] as string));
    }
    if (typeof record[BYTES_TAG] === "string" && Object.keys(record).length === 1) {
      return Buffer.from(record[BYTES_TAG] as string, "base64");
    }
    return Object.fromEntries(Object.entries(record).map(([key, cell]) => [key, deserializeCell(cell)]));
  }
  return value;
}

// ============================================================================
// The child's program
// ============================================================================

/**
 * The program the child runs. Written as plain JavaScript on purpose: it must load
 * under `process.execPath -e` on both runtimes, with no TypeScript, no path alias and
 * no `import`. It talks JSON-lines on stdin/stdout and writes nothing else to stdout,
 * so the parent can read every line as a response.
 */
const WORKER_BOOTSTRAP = [
  '"use strict";',
  "var db = null;",
  "var driver = null;",
  "function pickDriver() {",
  "  var override = process.env.LIBREDB_SQLITE_DRIVER;",
  '  if (override === "bun" || override === "node") return override;',
  '  return typeof Bun === "undefined" ? "node" : "bun";',
  "}",
  "function deser(v) {",
  "  if (v === null || v === undefined) return v;",
  "  if (Array.isArray(v)) return v.map(deser);",
  '  if (typeof v === "object") {',
  "    var keys = Object.keys(v);",
  '    if (keys.length === 1 && typeof v.__libredb_sqlite_bigint === "string") return BigInt(v.__libredb_sqlite_bigint);',
  '    if (keys.length === 1 && typeof v.__libredb_sqlite_bytes === "string") return new Uint8Array(Buffer.from(v.__libredb_sqlite_bytes, "base64"));',
  "    var out = Object.create(null);",
  "    for (var k = 0; k < keys.length; k++) out[keys[k]] = deser(v[keys[k]]);",
  "    return out;",
  "  }",
  "  return v;",
  "}",
  "function ser(v) {",
  "  if (v === null || v === undefined) return null;",
  '  if (typeof v === "bigint") { var t1 = {}; t1.__libredb_sqlite_bigint = v.toString(); return t1; }',
  '  if (v instanceof Uint8Array) { var t2 = {}; t2.__libredb_sqlite_bytes = Buffer.from(v).toString("base64"); return t2; }',
  "  if (Array.isArray(v)) return v.map(ser);",
  '  if (typeof v === "object") {',
  "    var out = Object.create(null);",
  "    var keys = Object.keys(v);",
  "    for (var k = 0; k < keys.length; k++) out[keys[k]] = ser(v[keys[k]]);",
  "    return out;",
  "  }",
  "  return v;",
  "}",
  "function allRows(sql, params) {",
  "  var stmt = db.prepare(sql);",
  "  return stmt.all.apply(stmt, params);",
  "}",
  "function open(payload) {",
  "  driver = pickDriver();",
  '  if (driver === "bun") {',
  '    var bun = require("bun:sqlite");',
  "    db = new bun.Database(payload.dbPath, { readonly: payload.readonly === true, safeIntegers: true });",
  "  } else {",
  '    var node = require("node:sqlite");',
  "    db = new node.DatabaseSync(payload.dbPath, { readOnly: payload.readonly === true, readBigInts: true });",
  "  }",
  "  if (payload.queryOnly) {",
  '    db.exec("PRAGMA query_only = true");',
  '    var readback = allRows("PRAGMA query_only", []);',
  "    var first = readback[0];",
  "    // `safeIntegers`/`readBigInts` reads the pragma back as a BigInt; compare as a number.",
  '    if (!first || Number(first.query_only) !== 1) throw new Error("query_only readback failed");',
  "  }",
  '  db.exec("PRAGMA foreign_keys = ON");',
  "  if (!payload.readonly) {",
  '    db.exec("PRAGMA journal_mode = WAL");',
  '    db.exec("PRAGMA synchronous = NORMAL");',
  "  } else if (!payload.queryOnly) {",
  "    // A read-only open fails here, not at the open itself: SQLite opens its files",
  "    // lazily, and a WAL-mode database cannot be read without its -shm file beside it.",
  "    // The agent read-only profile skips this read, exactly as connectReadOnly did.",
  '    allRows("PRAGMA journal_mode", []);',
  "  }",
  "}",
  "function query(sql, params) {",
  "  var stmt = db.prepare(sql);",
  '  var returnsRows = driver === "bun" ? stmt.columnNames.length > 0 : stmt.columns().length > 0;',
  "  if (returnsRows) {",
  "    var values;",
  "    var columns;",
  '    if (driver === "bun") {',
  "      values = stmt.values.apply(stmt, params) || [];",
  "      columns = stmt.columnNames.map(function (name, index) { return [name, stmt.declaredTypes[index] === null ? undefined : stmt.declaredTypes[index]]; });",
  "    } else {",
  "      stmt.setReturnArrays(true);",
  "      try { values = stmt.all.apply(stmt, params) || []; } finally { stmt.setReturnArrays(false); }",
  "      columns = stmt.columns().map(function (column) { return [column.name, column.type === null ? undefined : column.type]; });",
  "    }",
  "    return { values: values.map(function (row) { return row.map(ser); }), columns: columns, returnsRows: true, changes: 0 };",
  "  }",
  "  var info = stmt.run.apply(stmt, params);",
  "  return { values: [], columns: [], returnsRows: false, changes: Number(info.changes) };",
  "}",
  "function handle(req) {",
  "  try {",
  '    if (req.op === "ping") return { ok: true };',
  '    if (req.op === "open") { open(req); return { ok: true }; }',
  '    if (req.op === "exec") { db.exec(req.sql); return { ok: true }; }',
  '    if (req.op === "all") { return { ok: true, rows: allRows(req.sql, (req.params || []).map(deser)).map(ser) }; }',
  '    if (req.op === "get") {',
  "      var stmt = db.prepare(req.sql);",
  "      var row = stmt.get.apply(stmt, (req.params || []).map(deser));",
  "      return { ok: true, row: row === undefined ? null : ser(row) };",
  "    }",
  '    if (req.op === "query") { return { ok: true, read: query(req.sql, (req.params || []).map(deser)) }; }',
  '    if (req.op === "inTransaction") { return { ok: true, value: driver === "bun" ? db.inTransaction : db.isTransaction }; }',
  '    if (req.op === "close") {',
  '      if (driver === "bun") db.close(true); else db.close();',
  "      db = null;",
  "      return { ok: true };",
  "    }",
  '    return { ok: false, error: { name: "Error", message: "Unknown op: " + req.op } };',
  "  } catch (error) {",
  "    return { ok: false, error: {",
  '      name: error && error.name ? error.name : "Error",',
  "      message: error && error.message ? error.message : String(error),",
  "      code: error && error.code !== undefined ? error.code : undefined,",
  "      errcode: error && error.errcode !== undefined ? error.errcode : undefined,",
  "    } };",
  "  }",
  "}",
  'var stdinBuf = "";',
  "function handleLine(line) {",
  "  var req;",
  "  try { req = JSON.parse(line); } catch (error) { return; }",
  "  var resp = { id: req.id };",
  "  var result = handle(req);",
  "  resp.ok = result.ok;",
  "  if (result.ok) {",
  "    if (result.rows !== undefined) resp.rows = result.rows;",
  "    if (result.row !== undefined) resp.row = result.row;",
  "    if (result.value !== undefined) resp.value = result.value;",
  "    if (result.read !== undefined) resp.read = result.read;",
  "  } else {",
  "    resp.error = result.error;",
  "  }",
  '  process.stdout.write(JSON.stringify(resp) + "\\n");',
  "}",
  'process.stdin.on("data", function (chunk) {',
  "  stdinBuf += chunk;",
  "  var idx;",
  '  while ((idx = stdinBuf.indexOf("\\n")) !== -1) {',
  "    var line = stdinBuf.slice(0, idx);",
  "    stdinBuf = stdinBuf.slice(idx + 1);",
  "    handleLine(line);",
  "  }",
  "});",
].join("\n");

// ============================================================================
// Parent-side client
// ============================================================================

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  rows?: unknown;
  row?: unknown;
  value?: unknown;
  read?: SQLiteRawRead;
  error?: { name?: string; message?: string; code?: unknown; errcode?: unknown };
}

/** The error a child reports when it cannot do what it was asked. */
class SQLiteWorkerError extends Error {
  constructor(
    message: string,
    public readonly workerName?: string,
    public readonly code?: unknown,
    public readonly errcode?: unknown,
  ) {
    super(message);
    this.name = "SQLiteWorkerError";
  }
}

/**
 * The executable the child runs under. Production is Node (this module's own
 * runtime), so `process.execPath` is the exact binary. Under Bun (dev and the
 * `bun test` runner) `process.execPath` is Bun, whose `node:sqlite` lacks the
 * statement APIs the bootstrap's `query` path needs (`columns()`,
 * `setReturnArrays()`), so the child must be a real `node`. `process.versions.bun`
 * tells the two apart without a `Bun` global reference.
 */
function workerExecutable(): string {
  return typeof process.versions.bun === "string" ? "node" : process.execPath;
}

/**
 * The child's environment: one override and the handful of platform variables the
 * child runtime needs, and nothing else. `LIBREDB_SQLITE_DRIVER=node` forces
 * `node:sqlite` (never `bun:sqlite`, which hangs a child a `bun test` run spawned
 * on Bun 1.4.x). The parent's full environment is deliberately NOT inherited - it
 * can hold database passwords and JWT secrets the child has no reason to see (#1623).
 *
 * `PATH` MUST be copied: the spawner resolves `node` against the CHILD's PATH, and
 * without it POSIX spawners fall back to the OS default search path, which on CI
 * picks a node that predates `node:sqlite` (or no node at all) instead of the
 * runner's node 24. `SystemRoot`, `TEMP` and `TMP` (Windows) and `TMPDIR` and
 * `HOME` (POSIX) are the rest of what the child needs to load its own libraries
 * and place SQLite's temporary files. None of these keys carries a secret.
 */
const WORKER_ENV_KEYS = ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"] as const;

function workerEnvironment(): NodeJS.ProcessEnv {
  const parent = process.env;
  const env: Record<string, string> = { LIBREDB_SQLITE_DRIVER: "node" };
  for (const key of WORKER_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return env as unknown as NodeJS.ProcessEnv;
}

/**
 * The parent half of the boundary. One child, one serialised request at a time.
 *
 * `terminate()` is the preemptive cancel: it ends the child's stdin, kills it with
 * SIGKILL, rejects the request in flight and every request still queued, and leaves
 * the client dead until the provider starts a fresh one. It is called for both
 * `cancelQuery` and the read-only deadline, which is the whole reason the statement
 * can now be stopped before it returns.
 */
export class SQLiteWorkerClient implements SQLiteHandle {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timeouts = new Map<number, ReturnType<typeof setTimeout>>();
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly queue: Array<{ run(): void; reject(error: Error): void }> = [];
  private busy = false;
  private alive = true;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    // Manual line buffering rather than `node:readline`: readline pauses the stream,
    // and under `bun test` that pause/resume balance can leave a response undelivered
    // and the provider hung on the child's answer.
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      // Scan only the newly appended bytes. A line split across chunks waits in
      // `buffer`, but no earlier byte is ever rescanned, so a very large result
      // (one JSON line of 100k rows) is read in linear, not quadratic, time.
      const start = buffer.length;
      buffer += chunk;
      let from = start;
      let idx: number;
      while ((idx = buffer.indexOf("\n", from)) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        this.onLine(line);
        from = 0;
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(`[sqlite-worker] ${String(chunk)}`));
    child.on("error", (error) => this.failAll(new SQLiteWorkerError(`SQLite worker failed: ${error.message}`)));
    child.on("exit", (code, signal) => {
      this.alive = false;
      this.failAll(new SQLiteWorkerError(`SQLite worker exited (code ${code}, signal ${signal ?? "none"})`));
    });
  }

  /** Start a child and open the handle; rejects with the child's own error on failure. */
  static async start(open: SQLiteWorkerOpen): Promise<SQLiteWorkerClient> {
    const child = spawn(workerExecutable(), ["-e", WORKER_BOOTSTRAP], {
      stdio: ["pipe", "pipe", "pipe"],
      env: workerEnvironment(),
    });
    const client = new SQLiteWorkerClient(child);
    try {
      await client.request("open", open);
      return client;
    } catch (error) {
      // The child can hold the file open when the open itself succeeded and a later
      // PRAGMA failed ("file is not a database"). Close it gracefully before killing:
      // the close releases the file synchronously, which a caller that renames,
      // deletes or retries the path needs before it proceeds. SIGKILL alone releases
      // the descriptor only after the OS has reaped the child, which races the caller.
      await client.close().catch(() => {});
      throw error;
    }
  }

  /**
   * The upper bound every request gets when `LIBREDB_SQLITE_WORKER_TIMEOUT_MS` is set:
   * an answer that never arrives then kills the child instead of hanging the caller
   * forever (a watchdog for the unexpected, not a replacement for the read-only budget).
   */
  private defaultTimeoutMs(): number | undefined {
    const raw = process.env.LIBREDB_SQLITE_WORKER_TIMEOUT_MS;
    if (raw === undefined) return undefined;
    const ms = Number(raw);
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  }

  /** Ask the child one question and wait for its answer, in queue order. */
  private request(
    op: string,
    payload?: unknown,
    timeoutMs: number | undefined = this.defaultTimeoutMs(),
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.queue.push({ run: () => this.send(op, payload, resolve, reject, timeoutMs), reject });
      this.pump();
    });
  }

  private send(
    op: string,
    payload: unknown,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
    timeoutMs?: number,
  ): void {
    if (!this.alive) {
      this.busy = false;
      reject(new SQLiteWorkerError("SQLite worker is not running"));
      return;
    }
    const id = this.nextId++;
    this.pending.set(id, { resolve, reject });
    if (timeoutMs !== undefined && timeoutMs > 0) {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.timeouts.delete(id);
        this.terminate();
        reject(new SQLiteWorkerError(`SQLite worker timed out after ${timeoutMs}ms (${op})`));
      }, timeoutMs);
      this.timeouts.set(id, timer);
    }
    this.child.stdin.write(`${JSON.stringify({ id, op, ...(payload as Record<string, unknown> | undefined) })}\n`);
  }

  private pump(): void {
    if (this.busy) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.busy = true;
    next.run();
  }

  private onLine(line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch {
      return;
    }
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    const timer = this.timeouts.get(response.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timeouts.delete(response.id);
    }
    this.pending.delete(response.id);
    this.busy = false;
    if (response.ok) {
      pending.resolve(response);
    } else {
      const message = response.error?.message ?? "SQLite worker reported an error";
      pending.reject(
        new SQLiteWorkerError(message, response.error?.name, response.error?.code, response.error?.errcode),
      );
    }
    this.pump();
  }

  private failAll(error: Error): void {
    for (const timer of this.timeouts.values()) clearTimeout(timer);
    this.timeouts.clear();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const queued of this.queue) queued.reject(error);
    this.queue.length = 0;
    this.busy = false;
  }

  /**
   * Kill the child now; every request in flight and queued is rejected.
   *
   * `child.kill()` alone can leave the child's readline loop alive on some runtimes,
   * so the child's stdin is ended first and the kill is a SIGKILL (R15).
   */
  terminate(): void {
    if (!this.alive) return;
    this.alive = false;
    try {
      this.child.stdin.end();
    } catch {
      // The pipe may already be closed; the kill below still runs.
    }
    this.child.kill("SIGKILL");
    this.failAll(new SQLiteWorkerError("SQLite worker was terminated"));
  }

  /** Whether the child is still running; false after `terminate()` or an exit. */
  isAlive(): boolean {
    return this.alive;
  }

  async exec(sql: string): Promise<void> {
    await this.request("exec", { sql });
  }

  async all(sql: string, params?: readonly unknown[]): Promise<unknown[]> {
    const response = (await this.request("all", { sql, params: params?.map(serializeBind) })) as WorkerResponse;
    return ((response.rows ?? []) as unknown[]).map(deserializeCell);
  }

  async get(sql: string, params?: readonly unknown[]): Promise<unknown> {
    const response = (await this.request("get", { sql, params: params?.map(serializeBind) })) as WorkerResponse;
    return deserializeCell(response.row ?? null);
  }

  async queryRows(sql: string, params: readonly unknown[], timeoutMs?: number): Promise<SQLiteRawRead> {
    const response = (await this.request(
      "query",
      { sql, params: params.map(serializeBind) },
      timeoutMs,
    )) as WorkerResponse;
    const read = response.read ?? { values: [], columns: [], returnsRows: false, changes: 0 };
    return {
      values: read.values.map((row) => row.map(deserializeCell)),
      // The wire turns the child's `undefined` column type into JSON `null`; restore
      // `undefined` so the in-process and worker paths answer the same declared shape.
      columns: read.columns.map(([name, type]) => [name, type ?? undefined] as const),
      returnsRows: read.returnsRows,
      changes: read.changes,
    };
  }

  async inTransaction(): Promise<boolean> {
    const response = (await this.request("inTransaction")) as WorkerResponse;
    return response.value === true;
  }

  async close(): Promise<void> {
    if (!this.alive) return;
    try {
      await this.request("close");
    } finally {
      this.terminate();
    }
  }
}

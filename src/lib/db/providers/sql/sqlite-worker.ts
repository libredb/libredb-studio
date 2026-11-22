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
 * raw rows; every value crosses the line in Studio's value codec
 * (`src/lib/db/value-codec.ts`), in both directions:
 *
 * - the parent encodes bound parameters with `encodeValue`, and decodes every answer
 *   with `decodeValue`, then gives it the in-process driver's shapes: a 64-bit integer
 *   goes through `normalizeSQLiteBigInt`, the ONE place that decides whether it fits a
 *   JavaScript number, and a BLOB becomes a `Buffer`;
 * - the child cannot import the module (it runs from `node -e`, below), so its
 *   bootstrap carries a plain-JavaScript copy (`ser` and `deser`) restricted to what it
 *   binds and reads: 64-bit integers (`i64`), BLOBs (`bytes`), infinities (`nf`) and
 *   the `obj` escape, so a row whose columns are named `$` and `v` stays a row. It
 *   refuses every other tag by name, so a `Date` parameter (`ts`) is answered as a
 *   value the worker cannot bind rather than handed to the driver. The two copies are
 *   held together by round trips through the real child in
 *   `tests/integration/db/sqlite-worker.test.ts`.
 *
 * That is the whole reason this file can stay small: it duplicates no value logic
 * beyond that copy. It only moves values across a boundary the synchronous drivers
 * cannot cross.
 *
 * The handle is ONE connection and requests are SERIALISED: a second request waits
 * for the first, exactly as the single in-process handle did. Cancelling or timing out
 * a statement kills the child, which drops the operating system's file descriptors, and
 * the next statement lazily starts a fresh child and re-applies the PRAGMAs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { logger } from "@/lib/logger";
import { decodeValue, encodeValue, type WireValue } from "@/lib/db/value-codec";
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
  queryRows(sql: string, params: readonly unknown[], timeoutMs?: number, queryId?: string): Promise<SQLiteRawRead>;
  inTransaction(): Promise<boolean>;
  close(): Promise<void>;
}

// ============================================================================
// The wire: Studio's value codec
// ============================================================================

/**
 * Every bound parameter of one call, on the way IN: decimal 64-bit digits become a
 * BigInt first (`toSQLiteBindValue`, the same conversion the in-process drivers apply),
 * then the whole list is encoded at once, so a refusal names the parameter's place
 * (`/0` is the first). Without the first step a decimal string read back from the
 * provider would bind as TEXT and stop matching the INTEGER it was read from.
 */
export function serializeBinds(params: readonly unknown[]): WireValue {
  return encodeValue(params.map(toSQLiteBindValue));
}

/**
 * Give a decoded value the in-process driver's shapes, in place: a BigInt goes through
 * `normalizeSQLiteBigInt` (number when lossless, decimal string otherwise) and a
 * `Uint8Array` becomes a `Buffer` over the same memory. In place is safe here because
 * `decodeValue` built every array and object this walks.
 */
function toInProcessShapes(value: unknown): unknown {
  if (typeof value === "bigint") return normalizeSQLiteBigInt(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) value[index] = toInProcessShapes(value[index]);
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) record[key] = toInProcessShapes(record[key]);
  }
  return value;
}

/** Decode one value the child answered, then give it the in-process driver's shapes. */
export function deserializeCell(value: unknown): unknown {
  return toInProcessShapes(decodeValue(value));
}

/**
 * How long an open waits for another connection's lock, in milliseconds, before it fails with
 * "database is locked". It covers the open's PRAGMAs only and is set back to 0 after them, so a
 * statement still fails at once on another writer's lock. Without it the open failed at once when
 * it met another connection's WAL recovery, a last close's checkpoint, or a reader of a file still
 * under a rollback journal (docs/providers/sqlite.md, "PRAGMAs on connect").
 */
export const SQLITE_OPEN_BUSY_TIMEOUT_MS = 2000;

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
  "// The child's copy of Studio's value codec (src/lib/db/value-codec.ts), restricted to",
  "// what the child binds and reads. Its agreement with the module is held by round trips",
  "// through this child in tests/integration/db/sqlite-worker.test.ts.",
  "function pointerSegment(key) {",
  '  return "/" + String(key).replace(/~/g, "~0").replace(/\\//g, "~1");',
  "}",
  "function refuse(what, path) {",
  '  var error = new Error("The SQLite worker cannot " + what + ", at " + (path === "" ? "the root" : JSON.stringify(path)) + ".");',
  '  error.name = "SQLiteWorkerValueError";',
  "  throw error;",
  "}",
  "function isTagShape(keys) {",
  '  return keys.length === 2 && keys.indexOf("$") !== -1 && keys.indexOf("v") !== -1;',
  "}",
  "function deserRecord(v, keys, path) {",
  "  var out = Object.create(null);",
  "  for (var k = 0; k < keys.length; k++) out[keys[k]] = deser(v[keys[k]], path + pointerSegment(keys[k]));",
  "  return out;",
  "}",
  "function deser(v, path) {",
  '  if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return v;',
  "  if (Array.isArray(v)) return v.map(function (item, index) { return deser(item, path + pointerSegment(index)); });",
  "  var keys = Object.keys(v);",
  "  if (!isTagShape(keys)) return deserRecord(v, keys, path);",
  "  var payload = v.v;",
  '  if (v.$ === "i64" && typeof payload === "string" && /^(?:0|-?[1-9][0-9]*)$/.test(payload)) return BigInt(payload);',
  '  if (v.$ === "bytes" && typeof payload === "string") return new Uint8Array(Buffer.from(payload, "base64"));',
  '  if (v.$ === "nf" && payload === "NaN") return NaN;',
  '  if (v.$ === "nf" && payload === "Infinity") return Infinity;',
  '  if (v.$ === "nf" && payload === "-Infinity") return -Infinity;',
  '  if (v.$ === "obj" && payload !== null && typeof payload === "object" && isTagShape(Object.keys(payload))) return deserRecord(payload, Object.keys(payload), path);',
  '  if (v.$ === "ts") refuse("bind a timestamp (ts) value", path);',
  '  refuse("read a tagged value it does not carry", path);',
  "}",
  "function deserParams(params) {",
  "  return (params || []).map(function (param, index) { return deser(param, pointerSegment(index)); });",
  "}",
  "function ser(v, path) {",
  '  if (v === null || typeof v === "string" || typeof v === "boolean") return v;',
  '  if (typeof v === "number") return isFinite(v) ? (v === 0 ? 0 : v) : { $: "nf", v: String(v) };',
  '  if (typeof v === "bigint") return { $: "i64", v: v.toString() };',
  '  if (v instanceof Uint8Array) return { $: "bytes", v: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };',
  "  if (Array.isArray(v)) return v.map(function (item, index) { return ser(item, path + pointerSegment(index)); });",
  '  if (typeof v !== "object") refuse("read a value of type " + typeof v, path);',
  "  var keys = Object.keys(v);",
  "  var out = Object.create(null);",
  "  for (var k = 0; k < keys.length; k++) out[keys[k]] = ser(v[keys[k]], path + pointerSegment(keys[k]));",
  '  return isTagShape(keys) ? { $: "obj", v: out } : out;',
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
  `  db.exec("PRAGMA busy_timeout = ${SQLITE_OPEN_BUSY_TIMEOUT_MS}");`,
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
  '  db.exec("PRAGMA busy_timeout = 0");',
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
  '    return { values: ser(values, ""), columns: columns, returnsRows: true, changes: 0 };',
  "  }",
  "  // `changes` is `sqlite3_changes()`, which a statement that changes no row leaves as the",
  "  // previous write set it, so node:sqlite handed a DDL statement that count. If",
  "  // `total_changes()` did not move, the statement changed no row. DirectSQLiteHandle",
  "  // does the same.",
  "  var before = totalChanges();",
  "  var info = stmt.run.apply(stmt, params);",
  "  var changes = totalChanges() === before ? 0 : Number(info.changes);",
  "  return { values: [], columns: [], returnsRows: false, changes: changes };",
  "}",
  "function totalChanges() {",
  '  return Number(db.prepare("SELECT total_changes() AS n").get().n);',
  "}",
  "function handle(req) {",
  "  try {",
  '    if (req.op === "ping") return { ok: true };',
  '    if (req.op === "open") { open(req); return { ok: true }; }',
  '    if (req.op === "exec") { db.exec(req.sql); return { ok: true }; }',
  '    if (req.op === "all") { return { ok: true, rows: ser(allRows(req.sql, deserParams(req.params)), "") }; }',
  '    if (req.op === "get") {',
  "      var stmt = db.prepare(req.sql);",
  "      var row = stmt.get.apply(stmt, deserParams(req.params));",
  '      return { ok: true, row: row === undefined ? null : ser(row, "") };',
  "    }",
  '    if (req.op === "query") { return { ok: true, read: query(req.sql, deserParams(req.params)) }; }',
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
  'process.stdin.setEncoding("utf8");',
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
 * and place SQLite's temporary files. `ELECTRON_RUN_AS_NODE` keeps an Electron
 * parent's binary in Node mode: the VS Code extension's backend runs on VS Code's
 * own binary with it set, and the worker spawned from that binary without it starts
 * as the app and dies. None of these keys carries a secret.
 */
const WORKER_ENV_KEYS = [
  "PATH",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "ELECTRON_RUN_AS_NODE",
] as const;

export function workerEnvironment(): NodeJS.ProcessEnv {
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
  private readonly queue: Array<{ run(): void; reject(error: Error): void; key?: string }> = [];
  private busy = false;
  private alive = true;
  /** Whether `terminate()` stopped the child, as opposed to the child exiting on its own. */
  private terminated = false;
  /** The `queryId` of the request the child is executing now; null for internal ops. */
  private runningKey: string | null = null;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    // Manual line buffering rather than `node:readline`: readline pauses the stream,
    // and under `bun test` that pause/resume balance can leave a response undelivered
    // and the provider hung on the child's answer.
    // Decode whole chunks as one stream rather than `buffer += chunk` decoding each
    // chunk alone: a multibyte character split across two 64 KB chunks would otherwise
    // become U+FFFD (the maintainer measured 14 of 50,000 rows corrupted).
    child.stdout.setEncoding("utf8");
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
    child.stdin.on("error", (error) => this.onStreamError("stdin", error));
    child.stdout.on("error", (error) => this.onStreamError("stdout", error));
    child.stderr.on("error", (error) => this.onStreamError("stderr", error));
    child.on("error", (error) => this.failAll(new SQLiteWorkerError(`SQLite worker failed: ${error.message}`)));
    child.on("exit", (code, signal) => {
      this.alive = false;
      // A child the client did not stop on purpose: name the exit code and signal, which
      // a failed write that reached the client first does not carry.
      if (!this.terminated) logger.warn(`[sqlite-worker] child exited (code ${code}, signal ${signal ?? "none"})`);
      this.failAll(new SQLiteWorkerError(`SQLite worker exited (code ${code}, signal ${signal ?? "none"})`));
    });
  }

  /** Start a child and open the handle; rejects with the child's own error on failure. */
  static async start(open: SQLiteWorkerOpen): Promise<SQLiteWorkerClient> {
    const child = spawn(workerExecutable(), ["-e", WORKER_BOOTSTRAP], {
      stdio: ["pipe", "pipe", "pipe"],
      env: workerEnvironment(),
    });
    if (child.pid === undefined) {
      // The spawn failed: the executable is missing or not runnable, or no file descriptor
      // was left for the pipes, which are then not created at all. Node reports the reason
      // as the child's `error` event on the next tick; the listener is attached here, before
      // anything touches a pipe.
      const [error] = (await once(child, "error")) as [Error];
      throw new SQLiteWorkerError(`SQLite worker failed: ${error.message}`);
    }
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
    key?: string,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.queue.push({ run: () => this.send(op, payload, resolve, reject, timeoutMs, key), reject, key });
      this.pump();
    });
  }

  private send(
    op: string,
    payload: unknown,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
    timeoutMs?: number,
    key?: string,
  ): void {
    if (!this.alive) {
      this.busy = false;
      reject(new SQLiteWorkerError("SQLite worker is not running"));
      return;
    }
    const id = this.nextId++;
    this.pending.set(id, { resolve, reject });
    this.runningKey = key ?? null;
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
    this.runningKey = null;
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

  /**
   * A pipe to the child failed. Without a listener the stream's `error` event is thrown
   * out of its event handler; here it is reported as the worker's named error instead.
   *
   * The usual case is a statement still being written when `terminate()` kills the
   * child: the rest of the write meets a closed pipe (EPIPE). The request has already
   * been rejected, by `terminate()` or by the deadline that called it, so this failure
   * is the expected tail of a cancel, a deadline or a disconnect and is logged at debug
   * level. Any other stream failure is unexpected (the child died on its own, or a pipe
   * broke under a live child): it rejects every request with the named error, is logged
   * as a warning, and stops the child, which can no longer be talked to, so the
   * provider's next statement starts a fresh one. That stop is not a `terminate()`, so
   * the child's exit is still logged with its code and signal. Nothing is retried.
   */
  private onStreamError(stream: "stdin" | "stdout" | "stderr", error: Error): void {
    if (this.terminated) {
      logger.debug(`[sqlite-worker] ${stream} failed after terminate(): ${error.message}`);
      return;
    }
    logger.warn(`[sqlite-worker] ${stream} failed: ${error.message}`);
    this.failAll(new SQLiteWorkerError(`SQLite worker ${stream} failed: ${error.message}`));
    this.kill();
  }

  private failAll(error: Error): void {
    for (const timer of this.timeouts.values()) clearTimeout(timer);
    this.timeouts.clear();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const queued of this.queue) queued.reject(error);
    this.queue.length = 0;
    this.busy = false;
    this.runningKey = null;
  }

  /** Whether the statement under `key` is the one the child is executing now. */
  isRunning(key: string): boolean {
    return this.runningKey === key;
  }

  /**
   * Remove a statement still waiting in the queue and reject it, leaving the running
   * statement alone. Returns false when nothing under that key is queued (#1623).
   */
  cancelQueued(key: string): boolean {
    const index = this.queue.findIndex((entry) => entry.key === key);
    if (index === -1) return false;
    const [entry] = this.queue.splice(index, 1);
    entry.reject(new SQLiteWorkerError("SQLite statement was cancelled"));
    return true;
  }

  /** Whether a request is in flight, so a graceful close would wait behind it. */
  hasWork(): boolean {
    return this.busy || this.queue.length > 0;
  }

  /**
   * Kill the child now; every request in flight and queued is rejected.
   *
   * `child.kill()` alone can leave the child's readline loop alive on some runtimes,
   * so the child's stdin is ended first and the kill is a SIGKILL (R15). `end()` on a
   * pipe that is already closed does not throw on Node or Bun, so nothing guards it.
   */
  terminate(): void {
    if (!this.alive) return;
    this.terminated = true;
    this.kill();
    this.failAll(new SQLiteWorkerError("SQLite worker was terminated"));
  }

  /** End the child's stdin and SIGKILL it, leaving the client dead. */
  private kill(): void {
    if (!this.alive) return;
    this.alive = false;
    this.child.stdin.end();
    this.child.kill("SIGKILL");
  }

  /** Whether the child is still running; false after `terminate()` or an exit. */
  isAlive(): boolean {
    return this.alive;
  }

  async exec(sql: string): Promise<void> {
    await this.request("exec", { sql });
  }

  async all(sql: string, params?: readonly unknown[]): Promise<unknown[]> {
    const response = (await this.request("all", { sql, params: params && serializeBinds(params) })) as WorkerResponse;
    return ((response.rows ?? []) as unknown[]).map(deserializeCell);
  }

  async get(sql: string, params?: readonly unknown[]): Promise<unknown> {
    const response = (await this.request("get", { sql, params: params && serializeBinds(params) })) as WorkerResponse;
    return deserializeCell(response.row ?? null);
  }

  async queryRows(
    sql: string,
    params: readonly unknown[],
    timeoutMs?: number,
    queryId?: string,
  ): Promise<SQLiteRawRead> {
    const response = (await this.request(
      "query",
      { sql, params: serializeBinds(params) },
      timeoutMs,
      queryId,
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

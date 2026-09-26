/**
 * Fixtures for the MCP server's tests (#246).
 *
 * A pinned environment, a real seed file, real SQLite and DuckDB files, and patches of a real
 * provider's prototype methods that count, hold or fail a call. A prototype patch reaches every
 * provider the factory builds, because the factory's dynamic import and a test's static import
 * load the same module record, and it leaves no process-wide module replacement behind: every
 * patch is undone by its own restore().
 */
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { getServerAuditBuffer } from "@/lib/audit";
import { clearProviderCache } from "@/lib/db/factory";
import { resetCache } from "@/lib/seed";

const ROOT = resolve(import.meta.dir, "../..");

export const APP_VERSION: string = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string })
  .version;

/**
 * Three values every MCP test file needs, set at its top. getAppVersion() reads the version on
 * each call and next.config.ts is its only injector, so under bun it is absent unless a file sets
 * it. HOSTNAME is fixed so the loopback Host check never depends on the machine. A seed cache
 * TTL of zero makes every seed file a test writes the one the next request reads.
 */
export function pinMcpTestEnvironment(): void {
  process.env.NEXT_PUBLIC_APP_VERSION = APP_VERSION;
  process.env.HOSTNAME = "127.0.0.1";
  process.env.SEED_CACHE_TTL_MS = "0";
}

export interface SeedEntry {
  readonly id: string;
  readonly type: string;
  readonly name?: string;
  readonly database?: string;
  readonly host?: string;
  readonly port?: number;
  readonly environment?: string;
  readonly roles?: readonly string[];
  readonly mcp?: boolean | string | null;
}

/**
 * Writes a JSON seed file and points the loader at it. Every entry carries mcp: true unless it
 * says otherwise, and null writes no mcp key at all. Until the seed schema declares the field
 * it strips the key silently, so these files already carry the opt-in the product requires.
 */
export function writeSeedFile(
  dir: string,
  connections: readonly SeedEntry[],
  defaults?: Record<string, unknown>,
): string {
  const path = join(dir, "seed-connections.json");
  const entries = connections.map(({ mcp = true, roles = ["*"], name, ...rest }) => ({
    ...rest,
    name: name ?? rest.id,
    roles,
    ...(mcp === null ? {} : { mcp }),
  }));
  writeFileSync(path, JSON.stringify({ version: "1", ...(defaults ? { defaults } : {}), connections: entries }));
  process.env.SEED_CONFIG_PATH = path;
  resetCache();
  return path;
}

export function createSqliteFile(path: string, statements: readonly string[]): void {
  const db = new Database(path, { create: true });
  try {
    for (const statement of statements) db.run(statement);
  } finally {
    db.close();
  }
}

/** A file-backed DuckDB database, checkpointed so a read-only handle sees every statement. */
export async function createDuckdbFile(path: string, statements: readonly string[]): Promise<void> {
  const { DuckDBProvider } = await import("@/lib/db/providers/sql/duckdb");
  const writer = new DuckDBProvider({
    id: "fixture-writer",
    name: "fixture writer",
    type: "duckdb",
    database: path,
    createdAt: new Date(),
  });
  await writer.connect();
  try {
    for (const statement of statements) await writer.query(statement);
    await writer.query("CHECKPOINT");
  } finally {
    await writer.disconnect();
  }
}

type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;

function methodOf(prototype: object, name: string): AnyMethod {
  const method = (prototype as Record<string, unknown>)[name];
  if (typeof method !== "function") throw new Error(`${name} is not a method of the patched prototype`);
  return method as AnyMethod;
}

function install(prototype: object, name: string, method: AnyMethod): void {
  (prototype as Record<string, unknown>)[name] = method;
}

export interface MethodGate {
  readonly entered: Promise<void>;
  readonly finished: Promise<void>;
  release(): void;
  restore(): void;
  readonly calls: number;
}

/**
 * Holds every call of the method until release(); entered resolves at the first call, and finished
 * once a held call has run the real method to its end, whether it resolved or rejected.
 */
export function gateMethod(prototype: object, name: string): MethodGate {
  const original = methodOf(prototype, name);
  const entered = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let calls = 0;
  install(prototype, name, async function gated(this: unknown, ...args: unknown[]) {
    calls += 1;
    entered.resolve();
    await opened.promise;
    try {
      return await original.apply(this, args);
    } finally {
      finished.resolve();
    }
  });
  return {
    entered: entered.promise,
    finished: finished.promise,
    release: () => opened.resolve(),
    restore: () => install(prototype, name, original),
    get calls() {
      return calls;
    },
  };
}

export interface MethodCount {
  readonly calls: number;
  restore(): void;
}

export function countMethod(prototype: object, name: string): MethodCount {
  const original = methodOf(prototype, name);
  let calls = 0;
  install(prototype, name, function counted(this: unknown, ...args: unknown[]) {
    calls += 1;
    return original.apply(this, args);
  });
  return {
    get calls() {
      return calls;
    },
    restore: () => install(prototype, name, original),
  };
}

/** The next call rejects with error; every later call runs the real method. */
export function failNextCall(prototype: object, name: string, error: Error): MethodCount {
  const original = methodOf(prototype, name);
  let calls = 0;
  install(prototype, name, async function failingOnce(this: unknown, ...args: unknown[]) {
    calls += 1;
    if (calls === 1) throw error;
    return original.apply(this, args);
  });
  return {
    get calls() {
      return calls;
    },
    restore: () => install(prototype, name, original),
  };
}

/**
 * How long a concurrency test keeps a gate shut after its first entry: long enough for every
 * other concurrent caller to reach the gated method or join the pending call. Releasing at once
 * lets the first call finish before the others reach the factory's cache, which then serves them
 * and hides a missing join.
 */
export const CONCURRENT_HOLD_MS = 100;

export async function holdGate(ms: number = CONCURRENT_HOLD_MS): Promise<void> {
  await new Promise((resolveTick) => setTimeout(resolveTick, ms));
}

/** Polls a condition the server settles asynchronously, and fails with a named timeout. */
export async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`waitFor: the condition did not hold within ${timeoutMs} ms`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
}

export async function resetMcpTestState(): Promise<void> {
  await clearProviderCache();
  resetCache();
  clearRateLimitState();
  getServerAuditBuffer().clear();
}

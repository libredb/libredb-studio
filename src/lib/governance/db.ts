/**
 * The governance pool (spec 6.2, 7.4): Studio's connections to the governance source, for the snapshot loads.
 *
 * One `pg` Pool per process, built on first use from `GOVERNANCE_POSTGRES_URL` with the TLS setting the storage pool
 * gets for the same URL (`src/lib/pg-ssl.ts`), and bounded so that a governance source that hangs never holds a load
 * for long: at most 4 connections, 5 s to connect, a 10 s statement timeout on the server and a 15 s query timeout
 * in the client. Each connection is named `libredb-studio-governance` in `pg_stat_activity`.
 *
 * A database outage must never stop the process. A connection the server drops while it sits idle makes `pg` emit
 * an `error` on the pool, and one dropped while a load holds it emits an `error` on the client, measured as
 * `57P01 terminating connection due to administrator command` from `pg_terminate_backend()`. With no listener either
 * one is an uncaught exception, so both are logged instead, as the storage pool's has been since #298. A client is
 * released with the error of any failure, so `pg-pool` destroys it rather than handing a broken connection to the
 * next load.
 */
import { Pool, type PoolClient } from "pg";
import { logger } from "@/lib/logger";
import { pgSslConfig } from "@/lib/pg-ssl";
import { governancePostgresUrl } from "./config";

/** The pool options of spec 7.4, beside the URL and its TLS setting. */
const POOL_OPTIONS = {
  max: 4,
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
  statement_timeout: 10000,
  keepAlive: true,
  application_name: "libredb-studio-governance",
} as const;

/**
 * Where the pool lives. Next.js bundles instrumentation, which starts the loads, apart from each route handler that
 * may ask for one, so a module-level variable would open one pool per bundle; a global under a registered symbol
 * opens one per process (src/lib/governance/keyring.ts does the same).
 */
const POOL_KEY = Symbol.for("libredb-studio.governance-pool");

type PoolHolder = { [POOL_KEY]?: Pool };

function governancePool(): Pool {
  const holder = globalThis as PoolHolder;
  const open = holder[POOL_KEY];
  if (open !== undefined) return open;
  const connectionString = governancePostgresUrl();
  const pool = new Pool({ connectionString, ssl: pgSslConfig(connectionString), ...POOL_OPTIONS });
  pool.on("error", (error: Error) => {
    logger.error("Governance pool client error", error, { route: "governance/db" });
  });
  holder[POOL_KEY] = pool;
  return pool;
}

function logCheckedOutError(error: Error): void {
  logger.warn("Governance connection error while checked out", { route: "governance/db", error: error.message });
}

/** Runs `run` on a client of the pool and releases the client exactly once, with the error of any failure. */
async function onClient<T>(signal: AbortSignal, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await governancePool().connect();
  let released = false;
  const release = (error?: Error): void => {
    if (released) return;
    released = true;
    client.release(error);
    // pg-pool listens again from the release on, so the client is never without a listener.
    client.removeListener("error", logCheckedOutError);
  };
  // The signal's reason is the error of the deadline. Releasing with it closes the connection at once, so a statement
  // still running fails instead of holding the connection open.
  const onAbort = (): void => release(signal.reason as Error);
  client.on("error", logCheckedOutError);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const result = await run(client);
    release();
    return result;
  } catch (error) {
    release(error as Error);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Runs `run` on a client of the governance pool, and settles with its result or its error, or with the reason of
 * `signal` as soon as it aborts, even while a statement is still running. `run` checks the signal before each
 * statement, so a load stops at the deadline: its client is released with the deadline's error, and a client the pool
 * hands over only after the deadline is released at once, unused.
 */
export function withGovernanceClient<T>(signal: AbortSignal, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([onClient(signal, run), aborted]);
}

/** Ends the pool of this process, if one is open; the next load opens a new one. */
export async function closeGovernancePool(): Promise<void> {
  const holder = globalThis as PoolHolder;
  const open = holder[POOL_KEY];
  if (open === undefined) return;
  delete holder[POOL_KEY];
  await open.end();
}

import {
  createDatabaseProvider,
  findOpenSingleWriterProvider,
  isSingleWriterFileOpen,
  withOneShotTunnel,
} from "@/lib/db/factory";
import { connectPhase } from "@/lib/db/errors";
import type { DatabaseProvider, EditorExecutionContext } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import type { DatabaseConnection, QueryWarning } from "@/lib/types";

/*
 * TEST CONNECTION, WITH NO NEXT IN IT.
 *
 * Two callers share this one implementation: `POST /api/db/test-connection`
 * (`src/app/api/db/test-connection/route.ts`) and the VS Code extension's backend child, whose
 * `connection/test` runs the same steps. Each caller keeps what only it has: the route its session
 * guard, `resolveConnection` and the execution context it derives from the session; and each
 * classifies a rejection itself, since a failed connect rejects with the provider's own error.
 */

/** The caution shown in place of a provider's Test Connection checks that rejected. */
const CHECKS_DID_NOT_FINISH =
  "The extra checks Test Connection runs for this connection did not finish, so a caution they would give may be missing.";

/** What a test that connected answers: a health read with its latency, or a degraded success. */
export type TestConnectionAnswer =
  | { success: true; message: "Connection successful"; latency: number; warnings?: QueryWarning[] }
  | { success: true; degraded: true; message: string; warnings?: QueryWarning[] };

/**
 * The cautions of the probes a provider runs only when a user tests the connection (Test
 * Connection or the dialog's Save), or none when it declares no such probes.
 *
 * The method's contract is cautions, never an error, so a rejection is a defect in the provider
 * and not a fact about the connection: `connect()` already succeeded, and the answer stays a
 * success. The thrown text is logged and not shown, because it was not a caution the provider
 * chose to give, and the user is told in the core's own words that a caution may be missing.
 * A resolution that is not an array is the same defect and gets the same answer.
 *
 * No deadline of its own is put on the call: the provider bounds its probes, as its
 * contract says, the same way `getHealth()` below is awaited unbounded.
 */
async function testConnectionCautions(provider: DatabaseProvider, route: string): Promise<QueryWarning[]> {
  if (!provider.testConnectionWarnings) return [];
  try {
    const found = await provider.testConnectionWarnings();
    // The published type forbids it, but an untyped implementer can resolve something else,
    // and spreading it outside this try would turn a tested connection into a failed one.
    if (!Array.isArray(found)) throw new TypeError("testConnectionWarnings() resolved a value that is not an array");
    return found;
  } catch (error) {
    logger.error("Test Connection checks rejected", error, {
      route,
      provider: provider.type,
    });
    return [{ message: CHECKS_DID_NOT_FINISH }];
  }
}

/** Settles as `work` does, or rejects with the signal's reason when the signal aborts first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Connects to `connection` once, reads its health and closes it, never caching the provider.
 *
 * `execution` is the DuckDB editor file-access posture the caller derived (non-admin DuckDB file
 * access): it opens any handle built here with the right posture and keeps this from borrowing a
 * handle of the other posture below. `route` is the label the rejected-checks log line carries.
 * A failed connect rejects with the provider's error, a `ConnectionError` naming the wait on a
 * deadline; the caller classifies it.
 *
 * `signal` is a deadline of the caller's own, which the route does not set and the VS Code
 * extension's child does (D276). Once it aborts, the test stops waiting for the connect and
 * rejects with the signal's reason, so a one-shot tunnel closes at once, and the provider it built
 * is closed when that connect settles: no provider promises a disconnect during its connect, and
 * one measured there (PostgreSQL, SQL Server) frees nothing sooner.
 */
export async function testConnection(
  connection: DatabaseConnection,
  execution: EditorExecutionContext,
  route: string,
  signal?: AbortSignal,
): Promise<TestConnectionAnswer> {
  // Through the tunnel, never around it (#457). This builds its provider directly rather than
  // through `getOrCreateProvider`, so it does not inherit that path's tunnel handling and has to
  // ask for it. `withOneShotTunnel` owns the tunnel's whole lifetime because nothing here is
  // cached, so no eviction would ever close a pooled one - and every failed test click would
  // strand it.
  return await withOneShotTunnel(connection, async (effective): Promise<TestConnectionAnswer> => {
    // A caller that stopped waiting while the tunnel opened gets nothing built.
    signal?.throwIfAborted();
    /*
      The handle already holding this connection's file, on an engine that admits
      only one (`ProviderCapabilities.singleWriterFile`; #498).

      Building a second provider there does not test the connection - it is refused
      by the exclusive lock the LIVE connection holds, and the route reported that
      as a failed connection test. Since the dialog gates its save on this answer,
      the built-in LibreDB sample could not be edited at all: the modal tested the
      edited copy, hit the sample's own lock, and discarded the edit with a toast
      about a connection error.

      A borrowed handle answers both of this test's questions - the file is open,
      and here is its health - so it is reused. It is NOT this test's to close:
      `borrowed` guards every disconnect below, because closing it would close the
      file under the session that opened it.
    */
    const borrowed = findOpenSingleWriterProvider(effective, execution.allowExternalFileAccess);
    /*
      Nothing to borrow, yet the file is open: a DuckDB handle of the OTHER file-access posture
      holds it (non-admin DuckDB file access). A second read-write handle here would be the one thing this test must
      not open, because closing it checkpoints its own view over the file and removes the
      write-ahead log under the open handle. So the test handle opens read-only, with external
      access off, which is the agent profile's handle: it reads the file beside the writer and
      writes nothing when it closes. Windows refuses any second handle on a file this process
      holds, so there the test reports that refusal (docs/providers/duckdb.md section 3.8).
    */
    const besideWriter = borrowed === null && isSingleWriterFileOpen(effective);
    // Both declared inside the scope so a provider this test opened is always torn
    // down before the tunnel it runs over, on the success and the failure path alike.
    let provider = borrowed;
    /** The connect of a provider this test built, which a close after the caller's abort waits for. */
    let connecting: Promise<void> = Promise.resolve();
    const release = async () => {
      const own = borrowed ? null : provider;
      provider = null;
      if (own) await own.disconnect();
    };
    try {
      if (!provider) {
        const opened = await createDatabaseProvider(
          effective,
          { queryTimeout: 10000 },
          besideWriter ? { readOnly: true } : execution,
        );
        provider = opened;
        // A caller that stopped waiting meanwhile gets no connect started.
        signal?.throwIfAborted();
        // The connection itself: every provider's connect() reaches the server and is
        // refused by a wrong host, port, credential or database - the SQL ones borrow a
        // pooled client, and the HTTP ones send a probe statement. So a connect that
        // returns is the fact this test exists to establish.
        // A deadline met here is a ConnectionError naming the wait (connectPhase), never the query sentence.
        connecting = connectPhase(() => opened.connect());
        await untilAborted(connecting, signal);
      }

      // A connect can succeed onto something other than what was asked for, and the
      // server's own caution is the only sign: Materialize opens a session on a database
      // that does not exist and says so in a startup NOTICE (#1401). Carried on both
      // answers below, so a plain "Connection successful" no longer hides it.
      // Then the probes a provider runs only for this click (Test Connection or the dialog's
      // Save, which posts to the route too), after connectWarnings()'s cautions.
      // Only on a provider this test built: a borrowed handle is the editor's live session,
      // not the connection under test.
      const cautions = [
        ...(provider.connectWarnings?.() ?? []),
        ...(borrowed ? [] : await testConnectionCautions(provider, route)),
      ];
      const warnings = cautions.length > 0 ? { warnings: cautions } : {};

      /*
        The health read is a SECOND fact, and conflating the two is the defect this
        replaced: `getHealth()` is the richest surface a provider has, so a failure
        here is worth telling the user about - but it is not the connection.

        Measured 2026-08-24 against scylladb/scylla:2026.2.4: eight of the Cassandra
        provider's surfaces answer and `getHealth()` threw `Keyspace system_views does
        not exist`, because ScyllaDB has no such keyspace. The route answered
        `success: false`, the dialog gates its save on that answer, and a ScyllaDB
        connection could not be created at all. StarRocks and SingleStore sit on the
        same gate for reasons of their own.

        So a health failure after a successful connect is reported as a degraded
        success, carrying the server's own sentence. `latency` is omitted with it: the
        elapsed time of a read that failed is not a round trip.
      */
      const startTime = Date.now();
      try {
        await provider.getHealth();
      } catch (healthError) {
        await release();

        return {
          success: true,
          degraded: true,
          message: `Connected, but this server answered no health data: ${
            healthError instanceof Error ? healthError.message : String(healthError)
          }`,
          ...warnings,
        };
      }
      const latency = Date.now() - startTime;

      await release();

      return {
        success: true,
        message: "Connection successful",
        latency,
        ...warnings,
      };
    } finally {
      // Only reached when the block above threw before its own release, and never
      // for a borrowed handle - which this test did not open and must not close.
      if (provider && !borrowed) {
        const own = provider;
        const close = async () => {
          try {
            await own.disconnect();
          } catch {
            /* ignore */
          }
        };
        // After the caller's abort the connect may still be pending: the provider is closed once
        // it settles, and the rejection does not wait for that.
        if (signal?.aborted) void connecting.then(close, close);
        else await close();
      }
    }
  });
}

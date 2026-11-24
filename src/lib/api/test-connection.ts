import {
  createDatabaseProvider,
  findOpenSingleWriterProvider,
  isSingleWriterFileOpen,
  withOneShotTunnel,
} from "@/lib/db/factory";
import { deadlineSignal } from "@libredb/provider-sdk/calls";
import { connectBudgetFor } from "@/lib/db/connect-budget";
import { fieldRuleRefusal } from "@/lib/db/connection-field-rules";
import { ConnectionError, connectPhase, DatabaseConfigError, markNotSent, waitedSeconds } from "@/lib/db/errors";
import {
  type ProviderTextScrub,
  providerTextScrub,
  scrubProviderWarnings,
  withheldProviderError,
  withholdProviderError,
} from "@/lib/db/operations/provider-text";
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
 * Both refuse first what the connection dialog refuses, through the same field rule module
 * (`fieldRuleRefusal` in src/lib/db/connection-field-rules.ts).
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
 * A rejection is logged through core's scrub (`scrub`), so a text that holds a credential of the
 * connection is logged as the withheld error.
 *
 * The method's contract is cautions, never an error, so a rejection is a defect in the provider
 * and not a fact about the connection: `connect()` already succeeded, and the answer stays a
 * success. The thrown text is logged and not shown, because it was not a caution the provider
 * chose to give, and the user is told in the core's own words that a caution may be missing.
 * A resolution that is not an array is the same defect and gets the same answer.
 *
 * No deadline of its own is put on the call: the test's deadline bounds it, as it bounds
 * `getHealth()` below.
 */
async function testConnectionCautions(
  provider: DatabaseProvider,
  route: string,
  scrub: ProviderTextScrub,
): Promise<QueryWarning[]> {
  if (!provider.testConnectionWarnings) return [];
  try {
    const found = await provider.testConnectionWarnings();
    // The published type forbids it, but an untyped implementer can resolve something else,
    // and spreading it outside this try would turn a tested connection into a failed one.
    if (!Array.isArray(found)) throw new TypeError("testConnectionWarnings() resolved a value that is not an array");
    return found;
  } catch (error) {
    logger.error("Test Connection checks rejected", withholdProviderError(scrub, error), {
      route,
      provider: provider.type,
    });
    return [{ message: CHECKS_DID_NOT_FINISH }];
  }
}

/**
 * Settles as `work` does, or rejects with `expired()` when `deadline` aborts first; `work` keeps its handlers, so a
 * late rejection is never a detached one.
 */
function untilDeadline<T>(work: Promise<T>, deadline: AbortSignal, expired: () => ConnectionError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onDeadline = () => reject(expired());
    if (deadline.aborted) onDeadline();
    else deadline.addEventListener("abort", onDeadline, { once: true });
    void work.then(resolve, reject).finally(() => deadline.removeEventListener("abort", onDeadline));
  });
}

/** The test's sentence for a test its engine's connect budget of `budgetMs` ended. */
function testDeadlineSentence(budgetMs: number): string {
  return `The connection test got no answer within ${waitedSeconds(budgetMs)}: check the address, the port, the network path and that the server is running.`;
}

/**
 * Connects to `connection` once, reads its health and closes it, never caching the provider.
 *
 * First, before the budget starts, a tunnel opens or anything is built, `connection` is read by its engine's field
 * rules (`fieldRuleRefusal` in src/lib/db/connection-field-rules.ts), the module the connection dialog refuses with
 * before Test Connection and Save post here: a refusal rejects with a `DatabaseConfigError` carrying the rule's
 * sentence, marked `not-sent`, so this path refuses exactly the connections the dialog refuses, with the same sentence,
 * and answers as a provider's own refusal does (docs/providers/CONTRACT.md, clause M-33). A type outside the
 * `DatabaseType` union is refused by name there.
 *
 * `execution` is the DuckDB editor file-access posture the caller derived (non-admin DuckDB file
 * access): it opens any handle built here with the right posture and keeps this from borrowing a
 * handle of the other posture below. `route` is the label the rejected-checks log line carries.
 * A failed connect rejects with the provider's error, a `ConnectionError` naming the wait on a
 * deadline; the caller classifies it.
 *
 * The whole test, the tunnel, the build, the connect, the test-only checks and the health read,
 * answers within its engine's connect budget from `now` (`connectBudgetFor`, src/lib/db/connect-budget.ts;
 * docs/providers/CONTRACT.md, clause C-56). At that deadline it rejects with a `ConnectionError`
 * naming the budget, never a caution or a degraded success: a one-shot tunnel closes at once, and
 * the provider it built is closed once its connect settles, since no provider promises a
 * disconnect during its connect, and one measured there (PostgreSQL, SQL Server) frees nothing
 * sooner; a provider already connected is closed at once.
 *
 * Every provider text the answer carries passes core's scrub of `connection`
 * (`providerTextScrub(connection, "any")`): a caution field and the health failure's sentence that
 * hold a credential of the connection are withheld.
 */
export async function testConnection(
  connection: DatabaseConnection,
  execution: EditorExecutionContext,
  route: string,
  now: number = Date.now(),
): Promise<TestConnectionAnswer> {
  const scrub = providerTextScrub(connection, "any");
  const refusal = fieldRuleRefusal(connection.type, connection);
  if (refusal !== undefined) {
    const refused = new DatabaseConfigError(refusal, connection.type);
    markNotSent(refused);
    throw refused;
  }
  const budget = connectBudgetFor(connection.type);
  const deadline = deadlineSignal(now + budget);
  let late: ConnectionError | undefined;
  const expired = (): ConnectionError => {
    late ??= new ConnectionError(testDeadlineSentence(budget), connection.type);
    return late;
  };
  const within = <T>(work: Promise<T>): Promise<T> => untilDeadline(work, deadline, expired);
  // Through the tunnel, never around it (#457). This builds its provider directly rather than
  // through `getOrCreateProvider`, so it does not inherit that path's tunnel handling and has to
  // ask for it. `withOneShotTunnel` owns the tunnel's whole lifetime because nothing here is
  // cached, so no eviction would ever close a pooled one - and every failed test click would
  // strand it.
  const tested = withOneShotTunnel(connection, async (effective): Promise<TestConnectionAnswer> => {
    // A deadline that passed while the tunnel opened gets nothing built.
    if (deadline.aborted) throw expired();
    /*
      The handle already holding this connection's file, on an engine that admits
      only one (`SINGLE_WRITER_FILE` in src/lib/db/compatibility.ts; #498).

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
    /** The connect of a provider this test built, which a close after the deadline waits for. */
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
        // A deadline that passed meanwhile gets no connect started.
        if (deadline.aborted) throw expired();
        // The connection itself: every provider's connect() reaches the server and is
        // refused by a wrong host, port, credential or database - the SQL ones borrow a
        // pooled client, and the HTTP ones send a probe statement. So a connect that
        // returns is the fact this test exists to establish.
        // A deadline met here is a ConnectionError naming the wait (connectPhase), never the query sentence.
        connecting = connectPhase(() => opened.connect());
        await within(connecting);
      }

      // A connect can succeed onto something other than what was asked for, and the
      // server's own caution is the only sign: Materialize opens a session on a database
      // that does not exist and says so in a startup NOTICE (#1401). Carried on both
      // answers below, so a plain "Connection successful" no longer hides it.
      // Then the probes a provider runs only for this click (Test Connection or the dialog's
      // Save, which posts to the route too), after connectWarnings()'s cautions.
      // Only on a provider this test built: a borrowed handle is the editor's live session,
      // not the connection under test.
      const cautions = scrubProviderWarnings(scrub, [
        ...(provider.connectWarnings?.() ?? []),
        ...(borrowed ? [] : await within(testConnectionCautions(provider, route, scrub))),
      ]);
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
        await within(provider.getHealth());
      } catch (healthError) {
        // The deadline is the test's answer, never a degraded success.
        if (healthError === late) throw healthError;
        await release();

        const withheld = withheldProviderError(scrub, healthError);
        const sentence =
          withheld?.message ?? (healthError instanceof Error ? healthError.message : String(healthError));
        return {
          success: true,
          degraded: true,
          message: `Connected, but this server answered no health data: ${sentence}`,
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
        // After the deadline the connect may still be pending: the provider is closed once
        // it settles, and the rejection does not wait for that.
        if (deadline.aborted) void connecting.then(close, close);
        else await close();
      }
    }
  });
  // The tunnel's own open is inside the deadline too: the answer does not wait for a tunnel still opening.
  return await within(tested);
}

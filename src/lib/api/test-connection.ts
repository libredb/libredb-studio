import {
  findOpenSingleWriterProvider,
  isSingleWriterFileOpen,
  openEngineOnce,
  withOneShotTunnel,
} from "@/lib/db/factory";
import { deadlineSignal } from "@libredb/provider-sdk/calls";
import { isPackageFailure, packageFailureAnswer } from "@/lib/api/package-errors";
import { type HealthWithin, readHealthWithin, readSessionHealthWithin } from "@/lib/api/provider-monitoring";
import { connectionFieldRefusal } from "@/lib/db/connection-field-rules";
import { errorCode, errorKind } from "@/lib/db/error-record";
import { ConnectionError, connectPhase, DatabaseConfigError, markNotSent, waitedSeconds } from "@/lib/db/errors";
import { teardownContractSession } from "@/lib/provider-host/core/contract-session";
import { type OpenedEngine, openedProvider } from "@/lib/provider-host/open-engine";
import {
  connectionTextScrub,
  type ProviderTextScrub,
  scrubProviderWarnings,
  withheldProviderError,
  withholdProviderError,
} from "@/lib/db/operations/provider-text";
import {
  type EngineConnection,
  type EngineRecord,
  legacyConnection,
  legacyProviderType,
} from "@/lib/db/server-catalog";
import type { DatabaseProvider, EditorExecutionContext } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { hostCore } from "@/lib/provider-host/instance";
import { packageConnectBudget } from "@/lib/provider-host/open-context";
import type { QueryWarning } from "@/lib/types";

/*
 * TEST CONNECTION, WITH NO NEXT IN IT.
 *
 * Two callers share this one implementation: `POST /api/db/test-connection`
 * (`src/app/api/db/test-connection/route.ts`) and the VS Code extension's backend child, whose
 * `connection/test` runs the same steps. Each caller keeps what only it has: the route its session
 * guard, `resolveServedConnection` and the execution context it derives from the session; and each
 * classifies a rejection itself, since a failed connect rejects with the provider's own error.
 * Both hand it the connection and the server catalog's record of its engine, and it runs one test
 * for every record: what differs between engines is read from the record's offers and grants, never
 * from who serves the engine. Both refuse first what the connection dialog refuses, through the same
 * field rule module (`connectionFieldRefusal` in src/lib/db/connection-field-rules.ts) over the
 * record's field rules.
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
 * the health read below.
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
 * The sentence of a health read that failed: the error `packageFailureAnswer` answers for it (./package-errors), which
 * logs a package's failure once, read by how the engine's own words reach the client (`grants.ownWords`). Where they
 * are `"scrubbed"` its message passes core's scrub; where they are `"code-only"` a package's failure answers Studio's
 * sentence, naming its code or the rules of an answer the core refused, and any other failure, Studio's own, is raised
 * as itself.
 */
function healthFailureSentence(engine: EngineRecord, error: unknown, scrub: ProviderTextScrub, route: string): string {
  const answered = packageFailureAnswer(engine, "health", error, scrub, route);
  if (engine.grants.ownWords === "scrubbed") {
    const withheld = withheldProviderError(scrub, answered);
    return withheld?.message ?? (answered instanceof Error ? answered.message : String(answered));
  }
  if (!isPackageFailure(engine, error)) throw error;
  return (answered as Error).message;
}

/**
 * Connects to `connection`, of the engine `engine` records, once, reads its health and closes it, never caching what
 * it opened: one test for every engine the server serves (docs/providers/CONTRACT.md, clauses C-56, C-107 and C-112).
 *
 * First, before the budget starts, a tunnel opens or anything is opened, `connection` is read by its engine's field
 * rules (`connectionFieldRefusal` over `engine.fieldRules`, src/lib/db/connection-field-rules.ts), the module the
 * connection dialog refuses with before Test Connection and Save post here: a refusal rejects with a
 * `DatabaseConfigError` carrying the rule's sentence, marked `not-sent`, so this path refuses exactly the connections
 * the dialog refuses, with the same sentence, and answers as a provider's own refusal does (clause M-33).
 *
 * `execution` is the DuckDB editor file-access posture the caller derived (non-admin DuckDB file
 * access): it opens any handle opened here with the right posture and keeps this from borrowing a
 * handle of the other posture below. `route` is the label every log line carries. `failure.logged` is set true when
 * a failure of the open this rejects with was logged here already, as a provider package's (`isPackageFailure`), so a
 * caller that logs the failures it answers writes no second line (the route passes it to `createErrorResponse`).
 *
 * The whole test, the tunnel, the open, the connect, the test-only checks, the health read and the close of a
 * package's session, answers within its engine's connect budget from `now` (`packageConnectBudget`,
 * src/lib/provider-host/open-context.ts; clause C-56). Every step that differs between engines reads the record:
 * - the SSH tunnel, where the record offers one (`offers.sshTunnel`): the test runs inside a one-shot tunnel scope
 *   (`withOneShotTunnel` in src/lib/db/factory.ts), else on the connection itself;
 * - the borrow of a handle already holding the connection's file, where the record grants a single-writer file
 *   (`grants.singleWriterFile`);
 * - the open, through the factory's one-shot open of any record (`openEngineOnce`), which runs the one ordered open
 *   check before the open, and, where the record offers an SSH tunnel, inside the one-shot tunnel scope after the
 *   tunnel opens: a legacy provider built and not connected, which this connects, or a provider package's connected
 *   session;
 * - the connect warnings and test-only cautions, where the record offers them (`offers.testCautions`);
 * - a failure of the open: answered by `packageFailureAnswer` (./package-errors), a package's as a not-sent connection
 *   error in its own words through core's scrub where its record grants them (`grants.ownWords` `"scrubbed"`) and in
 *   Studio's sentence naming its code where it does not, a refusal of what its open answered as the package's defect
 *   naming its rules, logged once as the package's on both grants, while a legacy provider's failure and Studio's own,
 *   a `DatabaseError` or a host defect of Studio's, are raised as themselves;
 * - the words of a health failure, answered by `packageFailureAnswer` (./package-errors), which logs a package's once
 *   as the package's, and read by `grants.ownWords`: `"scrubbed"`, its sentence passes core's scrub of `connection`;
 *   `"code-only"`, a package's is answered with Studio's sentence naming its code, or, for a health answer the host
 *   core refused (`checkHealthAnswer`), naming the rules it broke as the package's defect, while Studio's own failure
 *   is raised as itself.
 * The health read is one host core health call on the session the test holds, a legacy provider's bridged one
 * (`readHealthWithin`, src/lib/api/provider-monitoring.ts; clause C-75) or a package's own (`readSessionHealthWithin`),
 * on the test's own deadline and its deadline signal; a health failure after that deadline is logged by kind and
 * code. At that deadline it rejects with a `ConnectionError` naming the budget, never a caution or a degraded
 * success: a one-shot tunnel closes at once, a provider this test built is closed once its connect settles, since no
 * provider promises a disconnect during its connect, and one measured there (PostgreSQL, SQL Server) frees nothing
 * sooner, a provider already connected is closed at once, and a package's session the package answers after the stop
 * is closed by the host core. A package's session is closed under a cleanup context, waited for at most the
 * teardown's close deadline (`teardownContractSession` in src/lib/provider-host/core/contract-session.ts), a close
 * that fails or is cut logged by kind and code and never changing the answer.
 *
 * Every provider text the answer carries passes core's scrub of `connection` (`connectionTextScrub`): a caution field
 * and the health failure's sentence that hold a credential of the connection are withheld.
 *
 * @throws {DatabaseConfigError} When a field rule or an open check refuses the connection.
 * @throws {ConnectionError} When the open failed or the deadline ended the test.
 */
export async function testConnection(
  connection: EngineConnection,
  engine: EngineRecord,
  execution: EditorExecutionContext,
  route: string,
  failure: { logged: boolean },
  now: number = Date.now(),
): Promise<TestConnectionAnswer> {
  const type = legacyProviderType(engine);
  const scrub = connectionTextScrub(connection, type, "any");
  const refusal = connectionFieldRefusal(engine.fieldRules, connection);
  if (refusal !== undefined) {
    const refused = new DatabaseConfigError(refusal, type);
    markNotSent(refused);
    throw refused;
  }
  const budget = packageConnectBudget(engine);
  const deadline = deadlineSignal(now + budget);
  let late: ConnectionError | undefined;
  const expired = (): ConnectionError => {
    late ??= new ConnectionError(testDeadlineSentence(budget), type);
    return late;
  };
  const within = <T>(work: Promise<T>): Promise<T> => untilDeadline(work, deadline, expired);
  const test = async (effective: EngineConnection): Promise<TestConnectionAnswer> => {
    // A deadline that passed while the tunnel opened gets nothing opened.
    if (deadline.aborted) throw expired();
    /*
      The handle already holding this connection's file, on an engine whose record grants a single-writer file
      (`grants.singleWriterFile`; #498).

      Building a second provider there does not test the connection - it is refused
      by the exclusive lock the LIVE connection holds, and the route reported that
      as a failed connection test. Since the dialog gates its save on this answer,
      the built-in LibreDB sample could not be edited at all: the modal tested the
      edited copy, hit the sample's own lock, and discarded the edit with a toast
      about a connection error.

      A borrowed handle answers both of this test's questions - the file is open,
      and here is its health - so it is reused. It is NOT this test's to close:
      `own` never holds it, because closing it would close the file under the
      session that opened it.
    */
    const singleWriter = engine.grants.singleWriterFile;
    const borrowed = singleWriter ? findOpenSingleWriterProvider(effective, execution.allowExternalFileAccess) : null;
    /*
      Nothing to borrow, yet the file is open: a DuckDB handle of the OTHER file-access posture
      holds it (non-admin DuckDB file access). A second read-write handle here would be the one thing this test must
      not open, because closing it checkpoints its own view over the file and removes the
      write-ahead log under the open handle. So the test handle opens read-only, with external
      access off, which is the agent profile's handle: it reads the file beside the writer and
      writes nothing when it closes. Windows refuses any second handle on a file this process
      holds, so there the test reports that refusal (docs/providers/duckdb.md section 3.8).
    */
    const besideWriter = singleWriter && borrowed === null && isSingleWriterFileOpen(effective);
    /**
     * What this test opened and has not closed yet: declared inside the scope so it is always closed before the
     * tunnel it runs over, on the success and the failure path alike. Never a borrowed handle.
     */
    let own: OpenedEngine | null = null;
    /** The connect of a provider this test opened, which a close after the deadline waits for. */
    let connecting: Promise<void> = Promise.resolve();
    /** Closes the provider this test opened, before the answer; a package's session is closed below. */
    const release = async () => {
      const opened = own;
      if (opened?.form !== "provider") return;
      own = null;
      await opened.provider.disconnect();
    };
    try {
      let held: OpenedEngine;
      if (borrowed) {
        held = { form: "provider", provider: borrowed };
      } else {
        try {
          held = await openEngineOnce(
            effective,
            engine,
            besideWriter ? { readOnly: true } : execution,
            { deadline: now + budget, signal: deadline },
            { queryTimeout: 10_000 },
          );
        } catch (error) {
          // The deadline is the test's answer; a stop it caused is no failure of the engine's.
          if (deadline.aborted) throw expired();
          failure.logged = isPackageFailure(engine, error);
          throw packageFailureAnswer(engine, "open", error, scrub, route);
        }
        own = held;
        // A deadline that passed meanwhile gets no connect started, and what was opened is closed below.
        if (deadline.aborted) throw expired();
        if (held.form === "provider") {
          const opened = held.provider;
          // The connection itself: every provider's connect() reaches the server and is
          // refused by a wrong host, port, credential or database - the SQL ones borrow a
          // pooled client, and the HTTP ones send a probe statement. So a connect that
          // returns is the fact this test exists to establish. A package's open connected already.
          // A deadline met here is a ConnectionError naming the wait (connectPhase), never the query sentence.
          connecting = connectPhase(() => opened.connect());
          await within(connecting);
        }
      }

      // A connect can succeed onto something other than what was asked for, and the
      // server's own caution is the only sign: Materialize opens a session on a database
      // that does not exist and says so in a startup NOTICE (#1401). Carried on both
      // answers below, so a plain "Connection successful" no longer hides it.
      // Then the probes a provider runs only for this click (Test Connection or the dialog's
      // Save, which posts to the route too), after connectWarnings()'s cautions.
      // Only on a provider this test opened: a borrowed handle is the editor's live session,
      // not the connection under test. Only where the record offers them (`offers.testCautions`).
      let cautions: QueryWarning[] = [];
      if (engine.offers.testCautions) {
        const provider = openedProvider(held);
        cautions = scrubProviderWarnings(scrub, [
          ...(provider.connectWarnings?.() ?? []),
          ...(borrowed ? [] : await within(testConnectionCautions(provider, route, scrub))),
        ]);
      }
      const warnings = cautions.length > 0 ? { warnings: cautions } : {};

      /*
        The health read is a SECOND fact, and conflating the two is the defect this
        replaced: health is the richest surface a provider has, so a failure
        here is worth telling the user about - but it is not the connection.

        Measured 2026-08-24 against scylladb/scylla:2026.2.4: eight of the Cassandra
        provider's surfaces answer and `getHealth()` threw `Keyspace system_views does
        not exist`, because ScyllaDB has no such keyspace. The route answered
        `success: false`, the dialog gates its save on that answer, and a ScyllaDB
        connection could not be created at all. StarRocks and SingleStore sit on the
        same gate for reasons of their own.

        So a health failure after a successful connect is reported as a degraded
        success, carrying the server's own sentence where the record's own words pass
        core's scrub, and Studio's sentence naming its code where they do not. `latency`
        is omitted with it: the elapsed time of a read that failed is not a round trip.
      */
      const startTime = Date.now();
      // Started outside the `try` below: a host core not yet installed throws here by name, never a degraded success.
      const reading =
        held.form === "provider"
          ? readHealthWithin(held.provider, now + budget, deadline, route)
          : readSessionHealthWithin(
              hostCore(),
              held.session,
              { deadline: now + budget, signal: deadline, env: held.env },
              route,
            );
      let health: HealthWithin;
      try {
        health = await reading;
      } catch (healthError) {
        await release();
        return {
          success: true,
          degraded: true,
          message: `Connected, but this server answered no health data: ${healthFailureSentence(engine, healthError, scrub, route)}`,
          ...warnings,
        };
      }
      // The deadline is the test's answer, never a degraded success.
      if (health.kind === "ended") throw expired();
      const latency = Date.now() - startTime;

      await release();

      return {
        success: true,
        message: "Connection successful",
        latency,
        ...warnings,
      };
    } finally {
      // Only reached with something to close when the block above threw before its own release, or for a package's
      // session, which is closed here on every path.
      const opened = own;
      if (opened?.form === "provider") {
        const close = async () => {
          try {
            await opened.provider.disconnect();
          } catch {
            /* ignore */
          }
        };
        // After the deadline the connect may still be pending: the provider is closed once
        // it settles, and the rejection does not wait for that.
        if (deadline.aborted) void connecting.then(close, close);
        else await close();
      } else if (opened?.form === "session") {
        const outcome = await teardownContractSession(opened.session, opened.env);
        if (outcome.close !== "done") {
          logger.warn("Test Connection's session of a provider package did not close", {
            route,
            close: outcome.close,
            ...(outcome.close === "failed" && {
              kind: errorKind(outcome.closeError),
              code: errorCode(outcome.closeError),
            }),
          });
        }
      }
    }
  };
  // Through the tunnel, never around it (#457), where the record offers one: `withOneShotTunnel` owns the tunnel's
  // whole lifetime because nothing here is cached, so no eviction would ever close a pooled one - and every failed
  // test click would strand it.
  const tested = engine.offers.sshTunnel
    ? withOneShotTunnel(legacyConnection(engine, connection), test)
    : test(connection);
  // The tunnel's own open is inside the deadline too: the answer does not wait for a tunnel still opening.
  return await within(tested);
}

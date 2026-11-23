/**
 * The legacy bridge (docs/providers/CONTRACT.md, clause C-50): a legacy `DatabaseProvider` served as one session of
 * console execute and cancel, so today's providers run through the host core's console calls. It lives in the calling
 * bundle, beside the accessor, and is built per call by the caller's facade (`runEditorQuery` and `cancelEditorRun` in
 * src/lib/api/editor-query.ts); the bridge and the facade leave together, once every provider is a contract provider.
 *
 * Its calls are declared once: execute honours `params` and `offset` for every engine, so each provider answers both as
 * it always has, its own `OffsetUnsupportedError` included; `console.cancel` is offered exactly when the provider can
 * cancel (`supportsQueryCancel`); `console.endScope` is not offered, since the run's open transaction is ended inside
 * execute, as `runEditorQuery` always ended it, until it moves onto `console.endScope`.
 *
 * Its execute runs today's provider steps: `prepareQuery` on a fresh copy of the caller's own options object (the
 * request's resolved page is the contract's view; the options are what a legacy provider has always received), the
 * probe row past the page (`probePastPage`), `query` with the probe's text, a new array of the request's params, the
 * run id only for a provider that cancels, and a new call scope, `noteAppendedBound` on a failure, and the transaction
 * ender in a `finally`. It keeps the prepared query, the legacy result and the transaction's outcome on `run`, the
 * facade's per-call record, beside whether its cancel was sent, and answers one source per result set, the main rows
 * first.
 *
 * A source reads each legacy row positionally under the result's `fields` and answers it in the form the page budget
 * measures: its value codec form, or, when the codec refuses a cell (`undefined`, a class instance, a `Map`), the JSON
 * form the answer writes for that row, `undefined` as `null`. Which cells the codec refuses is found before encoding,
 * so no `ValueCodecError` is thrown per row; every error measuring throws passes by reference. This is how a row is
 * measured, not how it is answered: the facade answers the legacy rows themselves, by the page's count. A key a row
 * holds outside `fields` is answered and not measured.
 *
 * `pumpLimits` sets the page's row limit once execute answered: the probe limit, one past the page, when the provider
 * applied the page, otherwise every row the provider returned, at least one, so a result the limiter did not bound
 * answers every row as before, bounded by bytes alone.
 */
import {
  BATCH_MAX_BYTES,
  type BatchLimit,
  type CancelAnswer,
  type CancelRequest,
  encodedRowBytes,
  type ExecuteAnswer,
  type ExecuteRequest,
  PAGE_MAX_BYTES,
  type PumpLimits,
  type ResultSource,
  type RowBatch,
  sessionCalls,
  type Warning,
} from "@libredb/provider-sdk/calls";
import { probePastPage } from "@/lib/api/page-probe";
import { type QueryCancelProvider, supportsQueryCancel } from "@/lib/db/query-cancel";
import {
  type DatabaseProvider,
  endsOpenQueryTransactions,
  newQueryCallScope,
  type OpenQueryTransactionOutcome,
  type PreparedQuery,
  type QueryPrepareOptions,
} from "@/lib/db/types";
import { noteAppendedBound } from "@/lib/db/utils/query-limiter";
import type { ConsoleSession } from "@/lib/provider-host/core/console";
import type { QueryResult, QueryWarning } from "@/lib/types";

/**
 * What one bridged execute left for the facade: the prepared query, the legacy result and the transaction's end, and
 * whether the session's cancel was sent.
 */
export interface LegacyRun {
  prepared?: PreparedQuery;
  result?: QueryResult;
  openTransaction: OpenQueryTransactionOutcome;
  cancelSent: boolean;
}

/** What a bridged execute that answered left: its prepared query, its legacy result and its transaction's end. */
export interface AnsweredRun {
  readonly prepared: PreparedQuery;
  readonly result: QueryResult;
  readonly openTransaction: OpenQueryTransactionOutcome;
}

/** A bridged session, the run its execute fills, and the page limits read from that run. */
export interface BridgedConsole {
  readonly session: ConsoleSession;
  readonly run: LegacyRun;
  /**
   * What the execute that answered left, for the facade to answer from.
   *
   * @throws {Error} When execute has not answered, a host defect.
   */
  readonly answered: () => AnsweredRun;
  /**
   * The pump's limits for the answer execute gave.
   *
   * @throws {Error} When execute has not answered, a host defect.
   */
  readonly pumpLimits: (answer: ExecuteAnswer) => PumpLimits;
}

/** A legacy warning as the contract's `Warning`. */
function contractWarning(warning: QueryWarning): Warning {
  return {
    message: warning.message,
    ...(warning.code === undefined ? {} : { code: warning.code }),
    ...(warning.severity === undefined ? {} : { severity: warning.severity }),
  };
}

/** A row and its size, in the form the page budget measures. */
interface MeasuredRow {
  readonly row: readonly unknown[];
  readonly size: number;
}

/** The value codec's integer range (docs/providers/CONTRACT.md, "Values"): a bigint outside it is refused. */
const MIN_I64 = -(BigInt(2) ** BigInt(63));
const MAX_U64 = BigInt(2) ** BigInt(64) - BigInt(1);

/**
 * Whether the value codec refuses `value`, found without encoding it, so a refused row costs no thrown
 * `ValueCodecError` (a MongoDB result read under its union of fields has an undefined cell in every document that lacks
 * a field). The codec's domain, read the way `encodeValue` reads it: strings, booleans, numbers, bigints in its integer
 * range, null, arrays without holes, `Uint8Array`s, valid `Date`s and plain objects, each array element and own
 * enumerable property in the domain too. tests/unit/lib/provider-host/legacy-bridge-measure.test.ts holds it to the
 * codec's own answer for every kind.
 */
function outsideCodec(value: unknown): boolean {
  switch (typeof value) {
    case "string":
    case "boolean":
    case "number":
      return false;
    case "bigint":
      return value < MIN_I64 || value > MAX_U64;
    case "undefined":
    case "function":
    case "symbol":
      return true;
  }
  if (value === null) return false;
  // Indexed, not `some`, which skips a hole: a hole reads as `undefined`, refused as the codec refuses the hole.
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (outsideCodec(value[index])) return true;
    }
    return false;
  }
  if (value instanceof Uint8Array) return false;
  if (value instanceof Date) return Number.isNaN(value.getTime());
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return true;
  return Object.values(value as object).some((member) => outsideCodec(member));
}

/**
 * `row` read positionally under `fields`, in its value codec form, or in its JSON form when the codec refuses a cell.
 *
 * @throws Any error reading or measuring the row throws, by reference.
 */
function measuredRow(fields: readonly string[], row: Readonly<Record<string, unknown>>): MeasuredRow {
  const cells = fields.map((field) => row[field]);
  if (!outsideCodec(cells)) return { row: cells, size: encodedRowBytes(cells) };
  const json = JSON.parse(JSON.stringify(cells)) as readonly unknown[];
  return { row: json, size: encodedRowBytes(json) };
}

/** A result source over a legacy result set's rows, answering each in its measured form. */
function legacySource(
  fields: readonly string[],
  rows: readonly Readonly<Record<string, unknown>>[],
  rowCount?: number,
): ResultSource {
  let at = 0;
  let closed = false;
  return Object.freeze({
    columns: Object.freeze(fields.map((name) => Object.freeze({ name }))),
    ...(rowCount === undefined ? {} : { rowCount }),
    async next(limit: BatchLimit): Promise<RowBatch> {
      if (closed) throw new Error("The bridged result source was closed, so it answers no more batches.");
      const batch: (readonly unknown[])[] = [];
      let bytes = 0;
      while (at < rows.length && batch.length < limit.maxRows) {
        const measured = measuredRow(fields, rows[at] as Readonly<Record<string, unknown>>);
        if (batch.length > 0 && bytes + measured.size > limit.maxBytes) break;
        batch.push(measured.row);
        bytes += measured.size;
        at += 1;
        if (bytes >= limit.maxBytes) break;
      }
      return { rows: batch, done: at >= rows.length };
    },
    async close(): Promise<void> {
      closed = true;
    },
  });
}

/**
 * `provider` served as one session of console execute and cancel, its execute run with a copy of `options`, the
 * caller's own page options.
 */
export function bridgedConsole(provider: DatabaseProvider, options: QueryPrepareOptions): BridgedConsole {
  const canceller: QueryCancelProvider | undefined = supportsQueryCancel(provider) ? provider : undefined;
  const run: LegacyRun = { openTransaction: "none", cancelSent: false };

  async function execute(request: ExecuteRequest): Promise<ExecuteAnswer> {
    const { statement } = request;
    const ownOptions: QueryPrepareOptions = { ...options };
    const prepared = provider.prepareQuery(statement, ownOptions);
    run.prepared = prepared;
    // The statement that runs asks for a row past the page (#1440); see `probePastPage`.
    const probe = probePastPage(provider, statement, ownOptions, prepared);
    const params = request.params === undefined ? undefined : [...request.params];
    const cancelId = canceller === undefined ? undefined : request.runId;
    // A SINGLE STATEMENT CAN LEAVE A TRANSACTION OPEN, SO THIS RUN ENDS IT (D74).
    //
    // MEASURED 2026-09-15 against PostgreSQL 18.4 through the query route with the real
    // provider and the real process-wide cache: a lone `BEGIN` answered 200 and released
    // its pooled client in status `T`, and the next request on the same cached provider,
    // which is any other signed-in user of that stored connection, ran its `CREATE TABLE`
    // inside that stranger's transaction, answered 200, and an independent reader saw no
    // such table. Driven the other way the loss is loud: a `BEGIN` followed by a statement
    // naming a missing relation leaves the client in `E` and the next request answers 500.
    //
    // This `finally` was tried once before and REVERTED, because the ender it calls named
    // one shared pointer: it rolled back whichever client anybody had recorded last, which
    // cost a concurrent `/api/db/multi-query` script its committed `CREATE TABLE` and an
    // interactive `POST /api/db/transaction` session its own. D87 fixed that in the
    // provider, where the borrowed client is in scope, and the `scope` minted here is what
    // names this run's own session: nothing this run did not run on can be ended.
    //
    // It is a `finally` and not a line after the call because the statement that poisons a
    // client is usually the one that threw, and the answer must not be able to leave by
    // a path that skips this.
    const scope = newQueryCallScope();
    let result: QueryResult;
    try {
      result = await provider.query(probe.query, params, cancelId, scope);
    } catch (error) {
      // An error that names the bound the limiter added says so, rather than pointing into text the user never wrote.
      throw noteAppendedBound(error, statement, probe.query);
    } finally {
      if (endsOpenQueryTransactions(provider)) run.openTransaction = await provider.endOpenQueryTransaction(scope);
    }
    run.result = result;
    const others = (result.resultSets ?? []).slice(1).map((set) => legacySource(set.fields, set.rows));
    return {
      results: [legacySource(result.fields, result.rows, result.rowCount), ...others],
      warnings: (result.warnings ?? []).map((warning) => contractWarning(warning)),
      executionTimeMs: result.executionTime,
      pageApplied: prepared.wasLimited,
      ...(result.pagination?.wasLimited === true ? { boundApplied: true as const } : {}),
      ...(result.explainPlan === undefined ? {} : { explainPlan: result.explainPlan }),
    };
  }

  const calls = sessionCalls(
    {
      console: {
        execute: { honours: ["params", "offset"] },
        cancel: canceller === undefined ? "not-offered" : "offered",
        endScope: "not-offered",
      },
    },
    undefined,
  );

  function answered(): AnsweredRun {
    const { prepared, result, openTransaction } = run;
    if (prepared === undefined || result === undefined) {
      throw new Error("The bridge's run was read before its execute answered, a defect of the host.");
    }
    return { prepared, result, openTransaction };
  }

  function pumpLimits(): PumpLimits {
    const { prepared, result } = answered();
    const maxRows = prepared.wasLimited ? prepared.limit + 1 : Math.max(1, result.rows.length);
    return { maxRows, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES };
  }

  return {
    session: Object.freeze({
      calls,
      execute,
      ...(canceller === undefined
        ? {}
        : {
            cancel: async (request: CancelRequest): Promise<CancelAnswer> => {
              run.cancelSent = true;
              return { cancelled: await canceller.cancelQuery(request.runId) };
            },
          }),
    }),
    run,
    answered,
    pumpLimits,
  };
}

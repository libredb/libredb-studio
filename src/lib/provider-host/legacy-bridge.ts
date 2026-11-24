/**
 * The legacy bridge (docs/providers/CONTRACT.md, clause C-50): a legacy `DatabaseProvider` served as one session of
 * console execute, cancel, endScope and transaction, so today's providers run through the host core's console calls. It lives in
 * the calling bundle, beside the accessor, and is built per call by the caller's facade (`runEditorQuery` and
 * `cancelEditorRun` in src/lib/api/editor-query.ts, the transaction calls in src/lib/api/editor-transaction.ts); the
 * bridge and the facades leave together, once every provider is a contract provider.
 *
 * Its calls are declared once: execute honours `params` and `offset` for every engine, so each provider answers both as
 * it always has, its own `OffsetUnsupportedError` included; `console.cancel` is offered exactly when the provider can
 * cancel (`supportsQueryCancel`); `console.endScope` is offered exactly when the provider ends the transactions its
 * query path left open (`endsOpenQueryTransactions`), and its `endScope` runs the provider's `endOpenQueryTransaction`
 * with the request's scope and answers its outcome; `console.transaction` is offered exactly when the provider holds a
 * transaction session (`isTransactionProvider`). The bridge is the one caller of a provider's ender: the caller that
 * minted a run's scope ends it through the host core's endScope call (clause C-60).
 *
 * Its transaction call runs the provider's own method for the action: `beginTransaction` with `requireReportedState`
 * as the transaction route has always passed it, answering `stateReported` exactly when the provider answered a result,
 * `commitTransaction`, `rollbackTransaction`, or nothing for `state`. Every answer's session state is the provider's
 * `isInTransaction()` read after the call, so it is `in-transaction` or `not-in-transaction` and never a state the
 * bridge kept. A statement sent with `transaction` runs `prepareQuery`, the probe and `queryInTransaction` with the
 * probe's text and a new array of the request's params, with no run id, no scope and no ender, since it runs on the
 * transaction's own connection, and answers the state read after it. A provider's error passes by reference.
 *
 * Its execute runs today's provider steps: `prepareQuery` on a fresh copy of the caller's own options object (the
 * request's resolved page is the contract's view; the options are what a legacy provider has always received), the
 * probe row past the page (`probePastPage`), `query` with the probe's text, a new array of the request's params, the
 * run id only for a provider that cancels, and the request's scope, absent when the request carries none, and
 * `noteAppendedBound` on a failure; it ends nothing itself. It keeps the prepared query and the legacy result on `run`,
 * the facade's per-call record, beside whether its cancel was sent, and answers one source per result set, the main
 * rows first.
 *
 * A source reads each legacy row positionally under the result's `fields`, in the form the page budget measures: its
 * value codec form, or, when the codec refuses a cell (`undefined`, a class instance, a `Map`), the JSON form the
 * answer writes for that row, `undefined` as `null`. It sizes that array with the measure of the pull that asks for it,
 * `limit.measure`, and answers that same array, so the pump takes the size its measure recorded and each row is
 * encoded once. Which cells the codec refuses is found before encoding, so no `ValueCodecError` is thrown per row;
 * every error measuring throws passes by reference. This is how a row is measured, not how it is answered: the facade
 * answers the legacy rows themselves, by the page's count. A key a row holds outside `fields` is answered and not
 * measured.
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
  type EndScopeAnswer,
  type EndScopeRequest,
  type ExecuteAnswer,
  type ExecuteRequest,
  PAGE_MAX_BYTES,
  type PumpLimits,
  type ResultSource,
  type RowBatch,
  sessionCalls,
  type TransactionAnswer,
  type TransactionRequest,
  type Warning,
} from "@libredb/provider-sdk/calls";
import type { SessionState } from "@libredb/provider-sdk/errors";
import { probePastPage } from "@/lib/api/page-probe";
import { type QueryCancelProvider, supportsQueryCancel } from "@/lib/db/query-cancel";
import {
  type DatabaseProvider,
  endsOpenQueryTransactions,
  isTransactionProvider,
  type PreparedQuery,
  type QueryPrepareOptions,
  type TransactionProvider,
} from "@/lib/db/types";
import { noteAppendedBound } from "@/lib/db/utils/query-limiter";
import type { ConsoleSession } from "@/lib/provider-host/core/console";
import type { QueryResult, QueryWarning } from "@/lib/types";

/**
 * What one bridged execute left for the facade: the prepared query and the legacy result, and whether the session's
 * cancel was sent.
 */
export interface LegacyRun {
  prepared?: PreparedQuery;
  result?: QueryResult;
  cancelSent: boolean;
}

/** What a bridged execute that answered left: its prepared query and its legacy result. */
export interface AnsweredRun {
  readonly prepared: PreparedQuery;
  readonly result: QueryResult;
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
 * @throws Any error reading the row or writing its JSON form throws, by reference.
 */
function rowForm(fields: readonly string[], row: Readonly<Record<string, unknown>>): readonly unknown[] {
  const cells = fields.map((field) => row[field]);
  if (!outsideCodec(cells)) return cells;
  return JSON.parse(JSON.stringify(cells)) as readonly unknown[];
}

/** A result source over a legacy result set's rows, each in its measured form, sized with its pull's measure. */
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
        const row = rowForm(fields, rows[at] as Readonly<Record<string, unknown>>);
        const size = limit.measure(row);
        if (batch.length > 0 && bytes + size > limit.maxBytes) break;
        batch.push(row);
        bytes += size;
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

/** The session state a legacy transaction provider reports now: its `isInTransaction()`, read once. */
function sessionStateOf(provider: TransactionProvider): SessionState {
  return provider.isInTransaction() ? "in-transaction" : "not-in-transaction";
}

/** The execute answer over a legacy `result` its `prepared` query produced: one source per result set. */
function answerOf(result: QueryResult, prepared: PreparedQuery): ExecuteAnswer {
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

/** Runs `request`'s action on `provider` and answers the session state read after it. */
async function legacyTransaction(
  provider: TransactionProvider,
  request: TransactionRequest,
): Promise<TransactionAnswer> {
  if (request.action === "begin") {
    // `void` from a provider that reads no transaction state when it opens one: it reports nothing either way.
    const opened = await provider.beginTransaction({ requireReportedState: request.requireReportedState === true });
    return { sessionState: sessionStateOf(provider), ...(opened ? { stateReported: opened.stateReported } : {}) };
  }
  if (request.action === "commit") await provider.commitTransaction();
  if (request.action === "rollback") await provider.rollbackTransaction();
  return { sessionState: sessionStateOf(provider) };
}

/**
 * `provider` served as one session of console execute, cancel and transaction, its execute run with a copy of
 * `options`, the caller's own page options.
 */
export function bridgedConsole(provider: DatabaseProvider, options: QueryPrepareOptions): BridgedConsole {
  const canceller: QueryCancelProvider | undefined = supportsQueryCancel(provider) ? provider : undefined;
  const transactional: TransactionProvider | undefined = isTransactionProvider(provider) ? provider : undefined;
  const ender = endsOpenQueryTransactions(provider) ? provider : undefined;
  const run: LegacyRun = { cancelSent: false };

  async function execute(request: ExecuteRequest): Promise<ExecuteAnswer> {
    const { statement } = request;
    const ownOptions: QueryPrepareOptions = { ...options };
    const prepared = provider.prepareQuery(statement, ownOptions);
    run.prepared = prepared;
    // The statement that runs asks for a row past the page (#1440); see `probePastPage`.
    const probe = probePastPage(provider, statement, ownOptions, prepared);
    const params = request.params === undefined ? undefined : [...request.params];
    if (Object.hasOwn(request, "transaction")) {
      // On the transaction's own connection, which the transaction's own calls end: no run id, no scope, no ender.
      if (transactional === undefined) {
        throw new Error(
          "The bridge was sent a statement inside a transaction for a provider that holds no transaction session, a defect of the host.",
        );
      }
      let inTransaction: QueryResult;
      try {
        inTransaction = await transactional.queryInTransaction(probe.query, params);
      } catch (error) {
        throw noteAppendedBound(error, statement, probe.query);
      }
      run.result = inTransaction;
      return { ...answerOf(inTransaction, prepared), sessionState: sessionStateOf(transactional) };
    }
    const cancelId = canceller === undefined ? undefined : request.runId;
    let result: QueryResult;
    try {
      result = await provider.query(probe.query, params, cancelId, request.scope);
    } catch (error) {
      // An error that names the bound the limiter added says so, rather than pointing into text the user never wrote.
      throw noteAppendedBound(error, statement, probe.query);
    }
    run.result = result;
    return answerOf(result, prepared);
  }

  const calls = sessionCalls(
    {
      console: {
        execute: { honours: ["params", "offset"] },
        cancel: canceller === undefined ? "not-offered" : "offered",
        endScope: ender === undefined ? "not-offered" : "offered",
        transaction: transactional === undefined ? "not-offered" : "offered",
      },
    },
    undefined,
  );

  function answered(): AnsweredRun {
    const { prepared, result } = run;
    if (prepared === undefined || result === undefined) {
      throw new Error("The bridge's run was read before its execute answered, a defect of the host.");
    }
    return { prepared, result };
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
      ...(ender === undefined
        ? {}
        : {
            endScope: async (request: EndScopeRequest): Promise<EndScopeAnswer> => ({
              openTransaction: await ender.endOpenQueryTransaction(request.scope),
            }),
          }),
      ...(transactional === undefined
        ? {}
        : { transaction: (request: TransactionRequest) => legacyTransaction(transactional, request) }),
    }),
    run,
    answered,
    pumpLimits,
  };
}

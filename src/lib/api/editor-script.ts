import {
  type CallContext,
  checkConsoleFacet,
  type EndScopeAnswer,
  type ExecuteRequest,
} from "@libredb/provider-sdk/calls";
import {
  callContext,
  endEditorScope,
  executeDeadlineFor,
  executeViewsFor,
  hostPorts,
  lateScopeEnd,
  pageBound,
} from "@/lib/api/editor-query";
import type { UnansweredCall } from "@/lib/api/editor-transaction";
import type { ConsoleTarget, ScriptUnitForm, SessionTarget } from "@/lib/api/session-target";
import type { ProviderTextScrub } from "@/lib/db/operations/provider-text";
import { newQueryCallScope, type QueryPrepareOptions } from "@/lib/db/types";
import { refusalError, stopError } from "@/lib/provider-host/access";
import type { ExecuteRecord, HostCallPorts, RefusedRecord, StoppedRecord } from "@/lib/provider-host/core/console";
import type { HostCore } from "@/lib/provider-host/core/host-core";
import { hostCore } from "@/lib/provider-host/instance";
import type { ExecutionUnit } from "@/lib/sql/statement-splitter";
import type { QueryResult } from "@/lib/types";

/*
 * THE EDITOR'S SCRIPT ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clauses C-83, C-84, C-53 and C-60).
 *
 * `openEditorScript` is the caller facade of a script of `POST /api/db/multi-query`: every unit of the script runs
 * through one host core console execute, one unit at a time, each on the unit form its console target states
 * (`ConsoleTarget.scriptUnit` in ./session-target): the bridge's script unit session for a legacy provider
 * (`bridgedScriptUnit`, clause C-50), and the session itself for a provider package's, whose unit's rows exist only in
 * its page. Each unit is counted on the cache entry its session lives in until its page record was released.
 *
 * The process's host core is read when the script opens, synchronously, after the connection opened and before any
 * unit, so a script opened before the install throws `HostCoreBootOrderError` before any promise and is never taken
 * for a unit's failure. Each unit's request is fresh: its text, every row for every unit but the last and the request's
 * page for the last, the request's `queryId` as its run id, and the script's scope on a session that offers
 * `console.endScope`. Each unit's context is fresh too: the unit's own deadline, the target's statement timeout plus
 * `EXECUTE_SLACK_MS` from the unit's start (`executeDeadlineFor`), a signal that aborts at it or when the request's
 * signal aborts first, and the target's declared environment.
 *
 * The host pumps each unit's first result within its 32 MiB page, waiting for the core's large-page slot when the page
 * needs more than one batch (clause C-53): the page is the host's measure and wait, never a cut. The unit's answer is
 * built by the caller's builder from the unit's result, a legacy provider's by reference, every row, and the page
 * record is released once, in a `finally`, after the builder ran or threw. So a row larger than one page is the unit's
 * `StudioByteBudgetRefusal`, outcome unknown, and nothing is cut, as is a provider package's page the host cut by
 * bytes: a script's answer has no field to say where a cut fell (backlog D920).
 *
 * A unit is never answered by a rejection: its outcome is the builder's value or the unit's error, which the route
 * answers inside the script's answer as a provider's error always was. A stop is answered by the editor's views
 * (`executeViewsFor`): `QueryCancelledError` when the request left, `StudioTimeoutRefusal` in the editor's sentence for
 * the statement, the slot, the page or the other results; the core sends the stopped run's cancel where the session
 * offers `console.cancel`, and a later failure is logged under the script's route by kind and code, the engine's
 * cancellation answer after that cancel not logged (`hostPorts`). A unit started after the request left is refused
 * before its call, not-sent, and reaches no provider. A provider's error passes as the same object.
 *
 * The scope is the facade's: minted when the script opens, only where the target's session offers
 * `console.endScope`, sent with every unit, and ended once after the last unit the script ran, through
 * `endEditorScope` on the target under a cleanup context of its own (clause C-60): at once when that unit answered or
 * failed, and, when Studio stopped waiting for it, once its call settled, in the background, its failure or stop logged by kind and
 * code (`lateScopeEnd`), the script answered with no `openTransaction`. A script none of whose units reached its
 * provider ends none.
 *
 * THE EDITOR'S SCRIPT INSIDE A TRANSACTION (clause C-84). `openTransactionScript` is the caller facade of a script of
 * `POST /api/db/transaction`: every unit runs through one host core console execute sent with `transaction`, one unit at
 * a time, each on the unit form its console target states (`ConsoleTarget.transactionScriptUnit` in ./session-target):
 * the bridge's transaction script unit session for a legacy provider (`bridgedTransactionScriptUnit`, clause C-50),
 * which sends the unit's text as the transaction route always sent it, and the session itself for a provider package's,
 * whose unit's rows exist only in its page, so a page the host cut by bytes is the unit's `StudioByteBudgetRefusal`.
 * Each unit is counted on the cache entry its session lives in until its page record was released. The core is read
 * when the script opens, as above.
 * Each request is fresh: the unit's text, every row for every unit but the last and the request's page for the last,
 * and `transaction`, with no run id, since Studio sends no cancel inside a transaction, and no scope, since a
 * transaction is ended by its own COMMIT or ROLLBACK. Each context is fresh, the unit's own deadline and a signal that
 * aborts at it or with the request's, and each page is pumped, answered and released as above, through the same unit
 * call (`callUnit`).
 *
 * A unit's outcome follows the single statement's rule (`runInTransaction` in src/lib/api/editor-transaction.ts):
 * the builder's value; the unit's error, a provider's by reference or a refusal before the call, not-sent; or
 * `unanswered`, its state unknown, for a stop, in the editor's views, and for a refusal after the call, such as a row
 * larger than one page, each with `settled` for when the call itself has settled. Nothing is cancelled, so a stopped
 * unit goes on in the database, and its later failure is logged under the script's route by kind and code. The facade
 * reads no session state: the route reads the state after the script, C-58.
 */

/** A script of execution units, split under its engine's grammar, and the request it runs for. */
export interface EditorScriptRun {
  /** The units in the script's order. */
  readonly units: readonly ExecutionUnit[];
  /** The page bounds as sent, already passed by `pageOptionError`. */
  readonly options: QueryPrepareOptions;
  /** The id a provider tracks each unit's run under and a cancel names it by. */
  readonly queryId?: string;
  /** The request's signal: a unit whose request left is stopped, and no further unit starts. */
  readonly signal: AbortSignal;
  /** The label a late failure, a failed cancel, a failed end and a provider package's warnings are logged under. */
  readonly route: string;
  /** Core's scrub of the connection, which a provider package's unit warnings are answered through. */
  readonly scrub: ProviderTextScrub;
}

/** How one unit ended: the builder's answer, or the unit's error, by reference. */
export type ScriptUnitOutcome<T> =
  | { readonly kind: "answered"; readonly value: T }
  | { readonly kind: "failed"; readonly error: unknown };

/** What the end of a script's scope answers: the provider ends nothing of its query path, or the end's outcome. */
export type EditorScopeEnd =
  | { readonly offered: false }
  | { readonly offered: true; readonly openTransaction: EndScopeAnswer["openTransaction"] };

/** A script opened on its provider: each unit run in turn, and the script's scope ended once after them. */
export interface EditorScript {
  /**
   * Runs unit `index` from its start `now`, and answers `build`'s value over the provider's result, or the unit's
   * error. The promise never rejects.
   *
   * @throws {Error} Synchronously, for an index outside the script, a defect of the caller.
   */
  runUnit<T>(index: number, build: (result: QueryResult) => T, now?: number): Promise<ScriptUnitOutcome<T>>;
  /**
   * Ends the script's scope once, after the last unit it ran, and answers the end's outcome.
   *
   * @throws The provider's error by reference; `StudioTimeoutRefusal` naming the end when its cleanup deadline stopped
   * it, outcome unknown; a host defect for a refusal.
   */
  end(): Promise<EditorScopeEnd>;
}

/** What the script's runs have left for its end: whether any unit reached its provider, and the last unit's stop. */
interface ScriptProgress {
  called: boolean;
  stopped?: StoppedRecord;
}

/** What every unit of one script runs with: the host core, the console target, the script, its scope and progress. */
interface ScriptRunState {
  readonly core: HostCore;
  readonly target: ConsoleTarget;
  readonly script: EditorScriptRun;
  readonly scope: string | undefined;
  readonly progress: ScriptProgress;
}

/** The answer of a unit's execute: the record of a refusal or a stop, or the builder's value or the unit's error. */
type UnitCall<T> = RefusedRecord | StoppedRecord | ScriptUnitOutcome<T>;

/** The marks of a unit's call on the cache entry its session lives in. */
type UnitMarks = Pick<SessionTarget<unknown>, "started" | "ended">;

/**
 * Runs one unit's execute through `core` on `unit`'s session and builds its answer with `build` from the unit's result
 * (`unit.answered`), releasing the page record once after the builder ran or threw. The call is counted on the entry
 * its session lives in (`marks`) from its start until its page record was released, or until the call a stop answered
 * has settled, so the entry is not swept while its page is read. A refusal or a stop is answered as its record, and
 * the execute's, the result's or the builder's throw as the unit's error, by reference.
 */
async function callUnit<T>(
  core: HostCore,
  unit: ScriptUnitForm,
  marks: UnitMarks,
  request: ExecuteRequest,
  ctx: CallContext,
  ports: HostCallPorts,
  build: (result: QueryResult) => T,
): Promise<UnitCall<T>> {
  marks.started();
  let record: ExecuteRecord | undefined;
  try {
    record = await core.executeCall(unit.session, request, ctx, unit.pumpLimits, ports);
    if (record.kind !== "page") return record;
    try {
      return { kind: "answered", value: build(unit.answered(record)) };
    } finally {
      record.release();
    }
  } catch (error) {
    return { kind: "failed", error };
  } finally {
    marks.ended(record);
  }
}

/** Runs unit `index` of the script through the host core on the unit form its console target states for it. */
async function runScriptUnit<T>(
  { core, target, script, scope, progress }: ScriptRunState,
  index: number,
  build: (result: QueryResult) => T,
  now: number,
): Promise<ScriptUnitOutcome<T>> {
  const unit = script.units[index] as ExecutionUnit;
  const last = index === script.units.length - 1;
  const { scrub, route } = script;
  const form = target.scriptUnit(
    last ? { unit, lastUnitOptions: script.options, scrub, route } : { unit, scrub, route },
  );
  const request: ExecuteRequest = {
    statement: unit.sql,
    page: last ? pageBound(script.options) : { unlimited: true },
    ...(script.queryId === undefined ? {} : { runId: script.queryId }),
    ...(scope === undefined ? {} : { scope }),
  };
  const timeout = target.timeout();
  const views = executeViewsFor(timeout, script.signal);
  const call = await callUnit(
    core,
    form,
    target,
    request,
    callContext(executeDeadlineFor(timeout, now), script.signal, target.env),
    hostPorts(route, form.cancelSent),
    build,
  );
  progress.called ||= call.kind !== "refused" || call.called;
  if (call.kind === "refused") return { kind: "failed", error: refusalError(call, views.view) };
  if (call.kind === "stopped") {
    progress.stopped = call;
    return { kind: "failed", error: stopError(call.reason, views.stopView(call)) };
  }
  return call;
}

/**
 * Opens `script` on `target`, a console target the caller opened under the editor's posture: reads the host core and
 * mints the script's scope where the target's session offers `console.endScope`.
 *
 * @throws {HostCoreBootOrderError} Synchronously, before the host core is installed, before any call.
 */
export function openEditorScript(target: ConsoleTarget, script: EditorScriptRun): EditorScript {
  const core = hostCore();
  const ends = checkConsoleFacet(target.session.calls, "endScope").length === 0;
  const scope = ends ? newQueryCallScope() : undefined;
  const progress: ScriptProgress = { called: false };
  const state: ScriptRunState = { core, target, script, scope, progress };
  return {
    runUnit(index, build, now = Date.now()) {
      if (script.units[index] === undefined) {
        throw new Error(
          `The editor's script was asked for its unit at index ${index}, and it holds ${script.units.length}, a defect of the caller.`,
        );
      }
      return runScriptUnit(state, index, build, now);
    },
    async end() {
      if (scope === undefined) return { offered: false };
      if (!progress.called) return { offered: true, openTransaction: "none" };
      const { stopped } = progress;
      if (stopped === undefined) {
        return { offered: true, openTransaction: await endEditorScope(target, scope, script.signal, script.route) };
      }
      stopped.settled
        .then(() => endEditorScope(target, scope, script.signal, script.route))
        .then(() => undefined, lateScopeEnd(script.route));
      return { offered: true, openTransaction: "none" };
    },
  };
}

/** A script of execution units inside the caller's transaction, and the request it runs for. */
export interface TransactionScriptRun {
  /** The units in the script's order. */
  readonly units: readonly ExecutionUnit[];
  /** The page bounds as sent, already passed by `pageOptionError`. */
  readonly options: QueryPrepareOptions;
  /** The request's signal: a unit whose request left is stopped, and no further unit starts. */
  readonly signal: AbortSignal;
  /** The label a late failure is logged under. */
  readonly route: string;
}

/**
 * How one unit inside a transaction ended: the builder's answer; the unit's error, by reference, after which the
 * session's state can be read; or unanswered, its state unknown until `settled` resolves.
 */
export type TransactionUnitOutcome<T> =
  | { readonly kind: "answered"; readonly value: T }
  | { readonly kind: "failed"; readonly error: unknown }
  | UnansweredCall;

/** A script opened inside its provider's transaction: each unit run in turn. */
export interface TransactionScript {
  /**
   * Runs unit `index` from its start `now`, and answers `build`'s value over the provider's result, the unit's error,
   * or the unit Studio stopped waiting for. The promise never rejects.
   *
   * @throws {Error} Synchronously, for an index outside the script, a defect of the caller.
   */
  runUnit<T>(index: number, build: (result: QueryResult) => T, now?: number): Promise<TransactionUnitOutcome<T>>;
}

/** Runs unit `index` of `run` through `core` on the unit form `target` states for it. */
async function runTransactionUnit<T>(
  core: HostCore,
  target: ConsoleTarget,
  run: TransactionScriptRun,
  index: number,
  build: (result: QueryResult) => T,
  now: number,
): Promise<TransactionUnitOutcome<T>> {
  const unit = run.units[index] as ExecutionUnit;
  const last = index === run.units.length - 1;
  const form = target.transactionScriptUnit(last ? { unit, lastUnitOptions: run.options } : { unit });
  const request: ExecuteRequest = {
    statement: unit.sql,
    page: last ? pageBound(run.options) : { unlimited: true },
    transaction: true,
  };
  const timeout = target.timeout();
  const views = executeViewsFor(timeout, run.signal);
  const call = await callUnit(
    core,
    form,
    target,
    request,
    callContext(executeDeadlineFor(timeout, now), run.signal, target.env),
    hostPorts(run.route),
    build,
  );
  if (call.kind === "refused") {
    const error = refusalError(call, views.view);
    return call.called ? { kind: "unanswered", error, settled: Promise.resolve() } : { kind: "failed", error };
  }
  if (call.kind === "stopped") {
    return { kind: "unanswered", error: stopError(call.reason, views.stopView(call)), settled: call.settled };
  }
  return call;
}

/**
 * Opens `run` inside the transaction `target`'s session holds, a console target the caller opened under the editor's
 * posture: reads the host core.
 *
 * @throws {HostCoreBootOrderError} Synchronously, before the host core is installed, before any call.
 */
export function openTransactionScript(target: ConsoleTarget, run: TransactionScriptRun): TransactionScript {
  const core = hostCore();
  return {
    runUnit(index, build, now = Date.now()) {
      if (run.units[index] === undefined) {
        throw new Error(
          `The editor's script inside a transaction was asked for its unit at index ${index}, and it holds ${run.units.length}, a defect of the caller.`,
        );
      }
      return runTransactionUnit(core, target, run, index, build, now);
    },
  };
}

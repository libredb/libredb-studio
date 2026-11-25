import { checkConsoleFacet, type EndScopeAnswer, type ExecuteRequest } from "@libredb/provider-sdk/calls";
import {
  callContext,
  endEditorScope,
  executeDeadline,
  executeViews,
  hostPorts,
  lateScopeEnd,
  pageBound,
} from "@/lib/api/editor-query";
import { type DatabaseProvider, newQueryCallScope, type QueryPrepareOptions } from "@/lib/db/types";
import { refusalError, stopError } from "@/lib/provider-host/access";
import type { StoppedRecord } from "@/lib/provider-host/core/console";
import type { HostCore } from "@/lib/provider-host/core/host-core";
import { hostCore } from "@/lib/provider-host/instance";
import { bridgedConsole, bridgedScriptUnit } from "@/lib/provider-host/legacy-bridge";
import type { ExecutionUnit } from "@/lib/sql/statement-splitter";
import type { DatabaseType, QueryResult } from "@/lib/types";

/*
 * THE EDITOR'S SCRIPT ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clauses C-83, C-53 and C-60).
 *
 * `openEditorScript` is the caller facade of a script of `POST /api/db/multi-query`: every unit of the script runs
 * through one host core console execute, one unit at a time, each on a script unit session of its own that the legacy
 * bridge serves (`bridgedScriptUnit`, clause C-50), so a native provider serves the script through the contract alone.
 *
 * The process's host core is read when the script opens, synchronously, after the connection opened and before any
 * unit, so a script opened before the install throws `HostCoreBootOrderError` before any promise and is never taken
 * for a unit's failure. Each unit's request is fresh: its text, every row for every unit but the last and the request's
 * page for the last, the request's `queryId` as its run id, and the script's scope on a session that offers
 * `console.endScope`. Each unit's context is fresh too: the unit's own deadline, the connection's statement timeout
 * plus `EXECUTE_SLACK_MS` from the unit's start (`executeDeadline`), and a signal that aborts at it or when the
 * request's signal aborts first.
 *
 * The host pumps each unit's first result within its 32 MiB page, waiting for the core's large-page slot when the page
 * needs more than one batch (clause C-53): the page is the host's measure and wait, never a cut. The unit's answer is
 * built by the caller's builder from the provider's result by reference, every row, and the page record is released
 * once, in a `finally`, after the builder ran or threw. So a row larger than one page is the unit's
 * `StudioByteBudgetRefusal`, outcome unknown, and nothing is cut: a script's answer has no field to say where a cut
 * fell (BACKLOG D920).
 *
 * A unit is never answered by a rejection: its outcome is the builder's value or the unit's error, which the route
 * answers inside the script's answer as a provider's error always was. A stop is answered by the editor's views
 * (`executeViews`): `QueryCancelledError` when the request left, `StudioTimeoutRefusal` in the editor's sentence for
 * the statement, the slot, the page or the other results; the core sends the stopped run's cancel where the session
 * offers `console.cancel`, and a later failure is logged under the script's route by kind and code, the engine's
 * cancellation answer after that cancel not logged (`hostPorts`). A unit started after the request left is refused
 * before its call, not-sent, and reaches no provider. A provider's error passes as the same object.
 *
 * The scope is the facade's: minted when the script opens, only for a provider whose session offers
 * `console.endScope`, sent with every unit, and ended once after the last unit the script ran, through
 * `endEditorScope` under a cleanup context of its own (clause C-60): at once when that unit answered or failed, and,
 * when Studio stopped waiting for it, once its call settled, in the background, its failure or stop logged by kind and
 * code (`lateScopeEnd`), the script answered with no `openTransaction`. A script none of whose units reached its
 * provider ends none.
 */

/** A script of execution units, split under its connection's dialect, and the request it runs for. */
export interface EditorScriptRun {
  /** The units in the script's order. */
  readonly units: readonly ExecutionUnit[];
  /** The connection's dialect, which the last unit's last statement is read under. */
  readonly dialect: DatabaseType;
  /** The page bounds as sent, already passed by `pageOptionError`. */
  readonly options: QueryPrepareOptions;
  /** The id a provider tracks each unit's run under and a cancel names it by. */
  readonly queryId?: string;
  /** The request's signal: a unit whose request left is stopped, and no further unit starts. */
  readonly signal: AbortSignal;
  /** The label a late failure, a failed cancel and a failed end are logged under. */
  readonly route: string;
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

/** What every unit of one script runs with: the host core, the provider, the script, its scope and its progress. */
interface ScriptRunState {
  readonly core: HostCore;
  readonly provider: DatabaseProvider;
  readonly script: EditorScriptRun;
  readonly scope: string | undefined;
  readonly progress: ScriptProgress;
}

/** Runs unit `index` of the script through the host core on a script unit session of its own. */
async function runScriptUnit<T>(
  { core, provider, script, scope, progress }: ScriptRunState,
  index: number,
  build: (result: QueryResult) => T,
  now: number,
): Promise<ScriptUnitOutcome<T>> {
  const unit = script.units[index] as ExecutionUnit;
  const last = index === script.units.length - 1;
  const bridged = bridgedScriptUnit(
    provider,
    last ? { unit, tailBound: { dialect: script.dialect, options: script.options } } : { unit },
  );
  const request: ExecuteRequest = {
    statement: unit.sql,
    page: last ? pageBound(script.options) : { unlimited: true },
    ...(script.queryId === undefined ? {} : { runId: script.queryId }),
    ...(scope === undefined ? {} : { scope }),
  };
  const views = executeViews(provider, script.signal);
  try {
    const record = await core.executeCall(
      bridged.session,
      request,
      callContext(executeDeadline(provider, now), script.signal),
      bridged.pumpLimits,
      hostPorts(script.route, bridged.cancelSent),
    );
    progress.called ||= record.kind !== "refused" || record.called;
    if (record.kind === "refused") return { kind: "failed", error: refusalError(record, views.view) };
    if (record.kind === "stopped") {
      progress.stopped = record;
      return { kind: "failed", error: stopError(record.reason, views.stopView(record)) };
    }
    try {
      return { kind: "answered", value: build(bridged.answered()) };
    } finally {
      record.release();
    }
  } catch (error) {
    progress.called = true;
    return { kind: "failed", error };
  }
}

/**
 * Opens `script` on `provider`, a provider the caller opened under the editor's posture: reads the host core and mints
 * the script's scope where the provider's session offers `console.endScope`.
 *
 * @throws {HostCoreBootOrderError} Synchronously, before the host core is installed, before any call.
 */
export function openEditorScript(provider: DatabaseProvider, script: EditorScriptRun): EditorScript {
  const core = hostCore();
  const ends = checkConsoleFacet(bridgedConsole(provider, {}).session.calls, "endScope").length === 0;
  const scope = ends ? newQueryCallScope() : undefined;
  const progress: ScriptProgress = { called: false };
  const state: ScriptRunState = { core, provider, script, scope, progress };
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
        return { offered: true, openTransaction: await endEditorScope(provider, scope, script.signal, script.route) };
      }
      stopped.settled
        .then(() => endEditorScope(provider, scope, script.signal, script.route))
        .then(() => undefined, lateScopeEnd(script.route));
      return { offered: true, openTransaction: "none" };
    },
  };
}

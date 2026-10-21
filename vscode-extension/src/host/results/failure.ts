// Part 4's error table: how a run's or a page read's error reaches the Results view, by class and code only.
import type * as vscode from "vscode";
import type { RunFailure } from "../../results-protocol";
import { BackendError, BackendExitedError } from "../backend-client";

/**
 * Part 4's error table: QUERY_CANCELLED is cancelled, BackendExitedError is backendExited, any other BackendError
 * is an error with its message, details.detail when that is a string, and fixStatement; anything else is an error
 * with its message, and its stack goes to the log when one is given. A run's failure is logged by
 * LogResultsPresenter, so only a page read, which no log presenter sees, passes a log: one stack line per failure.
 * No key holds undefined, since postMessage clones an undefined value and the webview's guard refuses it.
 */
export function toRunFailure(error: unknown, log?: Pick<vscode.LogOutputChannel, "error">): RunFailure {
  if (error instanceof BackendError && error.code === "QUERY_CANCELLED") {
    return { kind: "cancelled" };
  }
  if (error instanceof BackendExitedError) {
    return { kind: "backendExited", exitCode: error.exitCode, signal: error.signal };
  }
  if (error instanceof BackendError) {
    const failure: RunFailure = { kind: "error", message: error.message };
    const detail = detailOf(error.details);
    if (detail !== undefined) failure.detail = detail;
    if (error.fixStatement !== undefined) failure.fixStatement = error.fixStatement;
    return failure;
  }
  if (error instanceof Error) {
    log?.error(`A run failed: ${error.message}\n${error.stack}`);
    return { kind: "error", message: error.message };
  }
  const message = String(error);
  log?.error(`A run failed: ${message}`);
  return { kind: "error", message };
}

/** details.detail when details is a plain object and its detail a string (the PostgreSQL LINE excerpt). */
function detailOf(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const { detail } = details as { detail?: unknown };
  return typeof detail === "string" ? detail : undefined;
}

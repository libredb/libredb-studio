// The one error notification of a command that fails before a run (part 3, "The run": "Commands that fail before a
// run show one error notification with the backend's sentence and Show Log").
import type * as vscode from "vscode";
import { BackendError, BackendExitedError } from "../backend-client";
import { CredentialsNotGivenError } from "../connections/connection-source";
import { SHOW_LOG } from "../connections/add-connection-ui";

export interface FailureDeps {
  readonly window: Pick<typeof vscode.window, "showErrorMessage">;
  readonly log: Pick<vscode.LogOutputChannel, "error">;
  /** executeCommand(COMMANDS.showLog) */
  showLog(): Thenable<unknown>;
}

/**
 * A declined secret prompt shows nothing, since the person chose not to open; a declined Enter Credentials shows the
 * open's refusal, since that open did fail; any other Error shows its message with Show Log, and an error that is
 * neither a backend answer nor a lost backend has its stack logged.
 */
export function reportCommandFailure(deps: FailureDeps, error: unknown): void {
  if (error instanceof CredentialsNotGivenError && error.refusal === undefined) return;
  const shown = error instanceof CredentialsNotGivenError ? error.refusal : error;
  if (shown instanceof Error && !(shown instanceof BackendError) && !(shown instanceof BackendExitedError)) {
    deps.log.error(`${shown.message}\n${shown.stack}`);
  }
  const message = shown instanceof Error ? shown.message : String(shown);
  void deps.window.showErrorMessage(message, SHOW_LOG).then((choice) => {
    if (choice === SHOW_LOG) void deps.showLog();
  });
}

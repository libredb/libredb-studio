// The question the person answers before a statement the run gate asks about runs (FND-5 slice 6e): the modal that
// shows the statement, then, where the offer asks for a typed value, one input box. The backend child mints the token
// and checks the typed value again; this module only asks, and keeps nothing past the answer it returns.
import type * as vscode from "vscode";
import type { RunConfirmationOffer } from "@/lib/api/run-confirmation";

export const RUN_ANYWAY = "Run Anyway";

/** What the question shows: the connection the statement runs on, the statement, and the child's offer. */
export interface ConfirmationAsk {
  readonly connectionName: string;
  readonly statement: string;
  readonly offer: RunConfirmationOffer;
}

/** What a confirmed question answers: the offer's token, and the value typed where the offer asks for one. */
export interface ConfirmationAnswer {
  readonly token: string;
  readonly typed?: string;
}

/** A run whose question the person declined: the run ends as cancelled and nothing more is sent. */
export class RunNotConfirmedError extends Error {
  constructor() {
    super("The statement was not run: its confirmation was declined.");
    this.name = "RunNotConfirmedError";
  }
}

/**
 * Asks the modal and, for a typed ask, the input box, whose validateInput refuses every value but the expected one,
 * compared exactly. Answers the token and the typed value, or undefined when the modal or the input box is dismissed.
 * `token` closes the input box when the run is cancelled while it is open.
 */
export async function askToRun(
  window: Pick<typeof vscode.window, "showWarningMessage" | "showInputBox">,
  ask: ConfirmationAsk,
  token?: vscode.CancellationToken,
): Promise<ConfirmationAnswer | undefined> {
  const choice = await window.showWarningMessage(
    `This statement may change data, database objects, or permissions. Review it before running it on ${ask.connectionName}.`,
    { modal: true, detail: ask.statement },
    RUN_ANYWAY,
  );
  if (choice !== RUN_ANYWAY) return undefined;
  const typedAsk = ask.offer.typedConfirmation;
  if (typedAsk === null) return { token: ask.offer.token };
  const { expected } = typedAsk;
  const prompt =
    typedAsk.type === "connection-name"
      ? `Type the connection's name, ${expected}, to run this statement.${
          typedAsk.targets.length === 0 ? "" : ` It reaches ${typedAsk.targets.join(", ")}.`
        }`
      : `Type ${expected} to run this statement.`;
  const typed = await window.showInputBox(
    {
      prompt,
      ignoreFocusOut: true,
      validateInput: (value) => (value === expected ? undefined : `Type ${expected} exactly.`),
    },
    token,
  );
  if (typed === undefined) return undefined;
  return { token: ask.offer.token, typed };
}

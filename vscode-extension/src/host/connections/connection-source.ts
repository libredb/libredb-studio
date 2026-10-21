// Where the backend client reads a connection at open (part 2, "Reading at open"): the profile joined to its secrets
// from SecretStorage, a secret this machine lacks asked for in a masked box, and Enter Credentials after an open the
// server refused. What the person types is stored only once connection/open has succeeded, and no typed value
// outlives the read it belongs to.
import type * as vscode from "vscode";
import type { BackendError, ConnectionSource, SourcedConnection } from "../backend-client";
import { type ConnectionStore, UnknownConnectionError } from "./connection-store";
import { pathLabel } from "./field-prompts";
import { type ProfileEntry, toWireConnection } from "./profile";

export const MISSING_SECRET_PROMPT =
  "Not stored on this machine. LibreDB stores it in VS Code's secret storage once the connection opens.";
export const REASK_PROMPT = "LibreDB replaces the stored value in VS Code's secret storage once the connection opens.";
export const ENTER_CREDENTIALS = "Enter Credentials";

/**
 * An open the person declined, by Escape in a secret prompt or by declining Enter Credentials (builder's call 12).
 * refusal is the open's error when the decline answered Enter Credentials, so a caller can still show why it failed.
 */
export class CredentialsNotGivenError extends Error {
  constructor(
    connectionName: string,
    readonly refusal?: BackendError,
  ) {
    super(`No credentials were given for ${connectionName}, so it stays not connected.`);
    this.name = "CredentialsNotGivenError";
  }
}

export interface SourceDeps {
  readonly store: Pick<ConnectionStore, "get" | "revision" | "readSecrets" | "storeSecrets">;
  readonly window: Pick<typeof vscode.window, "showInputBox" | "showErrorMessage">;
  readonly workspace: Pick<typeof vscode.workspace, "isTrusted">;
}

export class ProfileConnectionSource implements ConnectionSource {
  constructor(private readonly deps: SourceDeps) {}

  revision(connectionId: string): number {
    return this.deps.store.revision(connectionId);
  }

  /** The stored secrets, each missing one asked for; Escape rejects CredentialsNotGivenError with nothing stored. */
  async read(connectionId: string): Promise<SourcedConnection> {
    // Taken before any prompt: an edit while the person types leaves this open stale, so the next request reopens.
    const revision = this.deps.store.revision(connectionId);
    const entry = this.entry(connectionId);
    const { values, missing } = await this.deps.store.readSecrets(connectionId);
    const typed = await this.ask(entry.name, missing, MISSING_SECRET_PROMPT);
    return this.sourced(entry, revision, { ...values, ...typed }, typed);
  }

  /** After an open answered AUTH_ERROR or CONNECTION_ERROR: undefined when the profile lists no secretFields, else every listed path asked again. */
  async reask(connectionId: string, error: BackendError): Promise<SourcedConnection | undefined> {
    const revision = this.deps.store.revision(connectionId);
    const entry = this.entry(connectionId);
    const paths = entry.secretFields ?? [];
    if (paths.length === 0) return undefined;
    const choice = await this.deps.window.showErrorMessage(
      error.message,
      dialogOptions(error.fixStatement),
      ENTER_CREDENTIALS,
    );
    if (choice !== ENTER_CREDENTIALS) throw new CredentialsNotGivenError(entry.name, error);
    const typed = await this.ask(entry.name, paths, REASK_PROMPT, error);
    return this.sourced(entry, revision, typed, typed);
  }

  private entry(connectionId: string): ProfileEntry {
    const entry = this.deps.store.get(connectionId);
    if (entry === undefined) throw new UnknownConnectionError(connectionId);
    return entry;
  }

  /** One masked box per path, in order; Escape in any of them declines the open, carrying the refusal a reask answers. */
  private async ask(
    name: string,
    paths: readonly string[],
    prompt: string,
    refusal?: BackendError,
  ): Promise<Record<string, string>> {
    const typed: Record<string, string> = {};
    for (const path of paths) {
      // oxlint-disable-next-line no-await-in-loop -- one box at a time: the person answers each before the next opens.
      const value = await this.deps.window.showInputBox({
        title: `${name}: ${pathLabel(path)}`,
        prompt,
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) throw new CredentialsNotGivenError(name, refusal);
      typed[path] = value;
    }
    return typed;
  }

  private sourced(
    entry: ProfileEntry,
    revision: number,
    secrets: Readonly<Record<string, string>>,
    typed: Readonly<Record<string, string>>,
  ): SourcedConnection {
    return {
      params: {
        connection: toWireConnection(entry, secrets),
        posture: { allowExternalFileAccess: this.deps.workspace.isTrusted },
      },
      revision,
      // The client calls this once connection/open has succeeded, never otherwise.
      opened: async () => {
        if (Object.values(typed).some((value) => value !== "")) await this.deps.store.storeSecrets(entry.id, typed);
      },
    };
  }
}

/** A modal dialog, with the fix statement as its detail when the answer carried one. */
function dialogOptions(fixStatement: string | undefined): vscode.MessageOptions {
  return fixStatement === undefined ? { modal: true } : { modal: true, detail: fixStatement };
}

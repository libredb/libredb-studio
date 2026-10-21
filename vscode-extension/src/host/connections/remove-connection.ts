// Remove Connection and the release of a connection edited elsewhere (part 2, "Remove and refresh"): Remove asks, then
// cancels the connection's runs, closes it where it is open, removes it from the setting and deletes its secrets; a
// connection another window changed or removed gets the same release with no question and no secret deletion. No step
// calls the backend link's connection(), so neither starts a child.
import type * as vscode from "vscode";
import { OPEN_USER_SETTINGS } from "./add-connection-ui";
import { type ConnectionStore, SettingWriteError } from "./connection-store";
import type { ProfileEntry, ProfileItem } from "./profile";

export const REMOVE = "Remove";
export const REMOVE_DETAIL =
  "Its secrets are deleted from this machine's secret storage. Editors bound to it stay open, unbound.";

/** Remove's steps 2 and 3; BackendClient implements both. */
export interface ConnectionRelease {
  cancelRuns(connectionId: string): void;
  closeIfOpen(connectionId: string): Promise<void>;
}

/** Remove's step 4: unbinds the connection's editors and cancels their runs. */
export interface EditorRelease {
  releaseConnection(connectionId: string): void;
  /** Cancels every editor run on the connection, preparing or sent, and keeps the editors' bindings. */
  cancelRuns(connectionId: string): void;
}

export interface RemoveDeps {
  readonly store: Pick<ConnectionStore, "list" | "remove">;
  readonly client: ConnectionRelease;
  readonly editors: EditorRelease;
  readonly window: Pick<typeof vscode.window, "showQuickPick" | "showWarningMessage" | "showErrorMessage">;
  readonly log: Pick<vscode.LogOutputChannel, "warn">;
  /** executeCommand("workbench.action.openSettingsJson") */
  openUserSettings(): Thenable<unknown>;
}

/** user@host:port/database from the fields present, for the palette's description; needs no backend. */
export function describeEntry(entry: ProfileEntry): string {
  const { user, host, port, database } = entry;
  return [
    user ? `${user}@` : "",
    host ?? "",
    port === undefined ? "" : `:${port}`,
    database ? `/${database}` : "",
  ].join("");
}

/**
 * libredb.removeConnection. target is a command argument carrying a string connectionId (PR 9's node), or undefined for
 * the palette pick; answers whether it removed one.
 */
export async function removeConnection(deps: RemoveDeps, target?: unknown): Promise<boolean> {
  const id = target === undefined ? await pickId(deps) : idOfTarget(target);
  // Removing an id that is not there does nothing.
  const item = deps.store.list().find((each) => idOf(each) === id);
  if (id === undefined || item === undefined) return false;
  const name = item.kind === "valid" ? item.entry.name : (item.name ?? id);
  const choice = await deps.window.showWarningMessage(
    `Remove the connection ${name}?`,
    { modal: true, detail: REMOVE_DETAIL },
    REMOVE,
  );
  if (choice !== REMOVE) return false;
  await release(deps.client, deps.log, id, "before its removal");
  deps.editors.releaseConnection(id);
  let removal: Awaited<ReturnType<ConnectionStore["remove"]>>;
  try {
    removal = await deps.store.remove(id);
  } catch (error) {
    // The not-an-array refusal is a SettingWriteError too; the secrets stay with the entry that stays.
    if (!(error instanceof SettingWriteError)) throw error;
    void deps.window.showErrorMessage(error.message, OPEN_USER_SETTINGS).then((answer) => {
      if (answer === OPEN_USER_SETTINGS) void deps.openUserSettings();
    });
    return false;
  }
  const { undeletedKeys } = removal;
  for (const key of undeletedKeys) {
    deps.log.warn(`Could not delete ${key} from VS Code's secret storage: it stays on this machine.`);
  }
  if (undeletedKeys.length > 0) {
    void deps.window.showWarningMessage(
      `LibreDB removed ${name}, but could not delete ${undeletedKeys.length} of its secrets from VS Code's secret storage. The LibreDB log names them.`,
    );
  }
  return removal.removed;
}

/**
 * The edit rule's host half: steps 2 and 3 of Remove, with no question and no secret deletion, for each id a store
 * change reports removed or changed, and step 4 for a removed id once its close settled; an edited profile keeps its
 * editors.
 */
export function releaseOnChange(
  store: Pick<ConnectionStore, "onDidChange">,
  client: ConnectionRelease,
  log: Pick<vscode.LogOutputChannel, "warn">,
  editors: EditorRelease,
): vscode.Disposable {
  return store.onDidChange(({ removed, changed }) => {
    for (const id of removed) {
      void release(client, log, id, "after libredb.connections changed").then(() => editors.releaseConnection(id));
    }
    for (const id of changed) {
      // A run prepared against the old profile must not reopen on the edited one (criterion 20).
      editors.cancelRuns(id);
      void release(client, log, id, "after libredb.connections changed");
    }
  });
}

/** Cancels the connection's runs and closes it where it is open; a failed close is logged, as the record is already forgotten. */
async function release(
  client: ConnectionRelease,
  log: Pick<vscode.LogOutputChannel, "warn">,
  id: string,
  when: string,
): Promise<void> {
  client.cancelRuns(id);
  try {
    await client.closeIfOpen(id);
  } catch (error) {
    log.warn(`Closing ${id} ${when} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The palette: every listed item with a usable id, an invalid one with its reason (builder's call 8). */
async function pickId(deps: RemoveDeps): Promise<string | undefined> {
  const ids = new Map<vscode.QuickPickItem, string>();
  for (const item of deps.store.list()) {
    const id = idOf(item);
    if (id === undefined) continue;
    const pickItem: vscode.QuickPickItem =
      item.kind === "valid"
        ? { label: item.entry.name, description: describeEntry(item.entry) }
        : { label: item.name ?? id, description: "invalid", detail: item.reason };
    ids.set(pickItem, id);
  }
  const chosen = await deps.window.showQuickPick([...ids.keys()], {
    placeHolder: "Choose the connection to remove",
  });
  return chosen === undefined ? undefined : ids.get(chosen);
}

function idOfTarget(target: unknown): string {
  if (typeof target === "object" && target !== null && "connectionId" in target) {
    const { connectionId } = target;
    if (typeof connectionId === "string") return connectionId;
  }
  throw new Error("libredb.removeConnection takes a connection node or nothing.");
}

function idOf(item: ProfileItem): string | undefined {
  return item.kind === "valid" ? item.entry.id : item.id;
}

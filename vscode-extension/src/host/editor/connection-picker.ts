// The connection and catalog pickers of New Query, Run and Change Connection (part 3, "New Query" step 1, "Change
// Connection" steps 3 and 4, "What text Run sends" steps 2 and 4).
import type * as vscode from "vscode";
import { declaredLevels } from "@/lib/db/object-kinds";
import type { BackendApi, ProviderDescription } from "../../protocol";
import type { ConnectionStore } from "../connections/connection-store";
import type { EngineIcons } from "../tree/icons";

export const UNBIND = "Unbind this editor";
export const NO_CONNECTIONS = "Add a LibreDB connection first.";
export const ADD_CONNECTION = "Add Connection";

export interface PickerDeps {
  readonly store: Pick<ConnectionStore, "list">;
  readonly icons: Pick<EngineIcons, "label">;
  readonly window: Pick<typeof vscode.window, "showQuickPick" | "showInformationMessage">;
  /** executeCommand(COMMANDS.addConnection) */
  addConnection(): Thenable<unknown>;
}

/** A pick item and the answer it stands for: a profile id, or UNBIND. */
interface ConnectionItem extends vscode.QuickPickItem {
  readonly answer: string;
}

/**
 * A valid profile's id, UNBIND when offered and chosen, or undefined when dismissed or when no profile is valid, which
 * offers Add Connection instead of an empty pick.
 */
export async function pickConnection(
  deps: PickerDeps,
  options: { readonly placeHolder: string; readonly current?: string; readonly offerUnbind?: boolean },
): Promise<string | typeof UNBIND | undefined> {
  const items: ConnectionItem[] = [];
  for (const item of deps.store.list()) {
    if (item.kind !== "valid") continue;
    const { id, name, type } = item.entry;
    items.push({ label: name, description: id === options.current ? "current" : deps.icons.label(type), answer: id });
  }
  if (items.length === 0) {
    void deps.window.showInformationMessage(NO_CONNECTIONS, ADD_CONNECTION).then((choice) => {
      if (choice === ADD_CONNECTION) void deps.addConnection();
    });
    return undefined;
  }
  const shown: vscode.QuickPickItem[] = options.offerUnbind ? [...items, { label: UNBIND }] : items;
  const chosen = await deps.window.showQuickPick(shown, { placeHolder: options.placeHolder });
  if (chosen === undefined) return undefined;
  // A profile's item carries its id; the Unbind item carries none, so a profile named like it still answers its id.
  return "answer" in chosen ? (chosen as ConnectionItem).answer : UNBIND;
}

export interface CatalogDeps {
  readonly client: Pick<BackendApi, "listContainers">;
  readonly window: Pick<typeof vscode.window, "showQuickPick">;
}

/** The catalog step: listContainers({ connectionId }) names in a QuickPick titled "Choose a <first level's label>". */
export async function pickCatalog(
  deps: CatalogDeps,
  connectionId: string,
  description: ProviderDescription,
): Promise<string | undefined> {
  const containers = await deps.client.listContainers({ connectionId });
  const level = declaredLevels(description.capabilities)[0];
  const chosen = await deps.window.showQuickPick(
    containers.map(({ name }) => ({ label: name })),
    { title: `Choose a ${level.label}` },
  );
  return chosen?.label;
}

// The Add Connection quick input (part 2, "The add-connection flow"): a thin adapter after the shape of VS Code's
// MultiStepInput sample that renders each step of AddConnectionFlow with a fresh QuickPick or InputBox, and turns the
// person's answers and the backend's replies into the flow's inputs. It decides nothing the flow decides.
import * as vscode from "vscode";
import type { BackendApi, EngineCatalog } from "../../protocol";
import { BackendError, BackendExitedError } from "../backend-client";
import { BackendUnavailableError } from "../backend-supervisor";
import {
  AddConnectionFlow,
  type FlowInput,
  type FlowItem,
  type FlowStep,
  MORE_OPTIONS_TOOLTIP,
} from "./add-connection-flow";
import { type ConnectionStore, SecretStoreError, SettingWriteError } from "./connection-store";

export const OPEN_USER_SETTINGS = "Open User Settings";
export const SHOW_LOG = "Show Log";

export interface AddConnectionDeps {
  readonly client: Pick<BackendApi, "parsePastedConnection" | "testConnection">;
  /** cachedCatalog(() => client.listEngines({})) */
  readonly catalog: () => Promise<EngineCatalog>;
  readonly store: Pick<ConnectionStore, "list" | "add">;
  readonly window: Pick<
    typeof vscode.window,
    "createQuickPick" | "createInputBox" | "showWarningMessage" | "showErrorMessage"
  >;
  readonly workspace: Pick<typeof vscode.workspace, "isTrusted">;
  /** executeCommand("libredb.showLog") */
  showLog(): Thenable<unknown>;
  /** executeCommand("workbench.action.openSettingsJson") */
  openUserSettings(): Thenable<unknown>;
  /** newLocalId (src/lib/ids.ts) */
  newId(): string;
  now(): Date;
}

/** The first catalogue the backend answers, kept for the activation; a failed load is not kept (part 2: it changes only with a new VSIX). */
export function cachedCatalog(load: () => Promise<EngineCatalog>): () => Promise<EngineCatalog> {
  let catalog: EngineCatalog | undefined;
  return async () => {
    catalog ??= await load();
    return catalog;
  };
}

/** libredb.addConnection: answers the saved id, or undefined when the person ended the flow or the backend could not list the engines. */
export async function addConnection(deps: AddConnectionDeps): Promise<string | undefined> {
  const session = new Session(deps);
  try {
    return await session.run();
  } catch (error) {
    // The supervisor has already shown why the backend cannot answer (builder's call 11).
    if (error instanceof BackendUnavailableError) return undefined;
    throw error;
  } finally {
    session.close();
  }
}

type Item = vscode.QuickPickItem & { readonly id: string };
type Shown = vscode.QuickPick<Item> | vscode.InputBox;
type PickStep = Extract<FlowStep, { kind: "pick" }>;
type InputStep = Extract<FlowStep, { kind: "input" }>;

const MORE_OPTIONS: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("settings-gear"),
  tooltip: MORE_OPTIONS_TOOLTIP,
};

/** One run of the flow: the input on screen, and the wait for the person's answer on it. */
class Session {
  /** The input on screen; a hide of any other is the adapter's own doing. */
  private current: Shown | undefined;
  /** The engine pick, shown busy before the catalogue, which the engine step fills. */
  private waiting: vscode.QuickPick<Item> | undefined;
  /** Set once the catalogue is in. */
  private flow!: AddConnectionFlow;
  /** Resolves the wait for the person's answer on the input on screen. */
  private answer: ((input: FlowInput) => void) | undefined;
  /** The token of the connection/test in flight, which Escape cancels. */
  private testing: vscode.CancellationTokenSource | undefined;
  /** Resolved when the person ends the flow, which ends every wait at once. */
  private readonly ending = Promise.withResolvers<undefined>();
  private ended = false;

  constructor(private readonly deps: AddConnectionDeps) {}

  async run(): Promise<string | undefined> {
    const engines = this.createPick();
    engines.title = "Add Connection";
    engines.busy = true;
    engines.ignoreFocusOut = true;
    this.waiting = engines;
    this.present(engines);
    // Starts the child on first use (part 1, lazy start).
    const catalog = await this.load();
    if (catalog === undefined || this.ended) return undefined;
    const listed = this.deps.store.list();
    const ids = new Set(listed.map((item) => (item.kind === "valid" ? item.entry.id : item.id)));
    let id = this.deps.newId();
    while (ids.has(id)) id = this.deps.newId();
    this.flow = new AddConnectionFlow({
      catalog,
      id,
      savedNames: listed.flatMap((item) => {
        const name = item.kind === "valid" ? item.entry.name : item.name;
        return name === undefined ? [] : [name];
      }),
      now: () => this.deps.now(),
    });
    for (let step = this.flow.step; ; ) {
      let input: FlowInput | undefined;
      switch (step.kind) {
        case "pick":
          input = await this.pick(step);
          break;
        case "input":
          input = await this.box(step);
          break;
        case "parse":
          input = await this.parse(step.text);
          break;
        case "test":
          input = await this.test(step);
          break;
        case "dialog":
          input = await this.dialog(step);
          break;
        case "save":
          return await this.save(step);
      }
      // An Escape that came after the answer still ends the flow.
      if (input === undefined || this.ended) return undefined;
      step = this.flow.advance(input);
    }
  }

  /** Disposes the input on screen; its hide is the adapter's own doing. */
  close(): void {
    const current = this.current;
    this.current = undefined;
    current?.dispose();
  }

  /** The catalogue; undefined once the person ended the flow, or once a failure other than an unavailable backend has been shown. */
  private async load(): Promise<EngineCatalog | undefined> {
    try {
      return await this.until(this.deps.catalog());
    } catch (error) {
      if (error instanceof BackendUnavailableError) throw error;
      this.close();
      void this.deps.window
        .showErrorMessage(`LibreDB could not list the database engines: ${messageOf(error)}`, SHOW_LOG)
        .then((choice) => {
          if (choice === SHOW_LOG) void this.deps.showLog();
        });
      return undefined;
    }
  }

  private async pick(step: PickStep): Promise<FlowInput | undefined> {
    const pick = this.waiting ?? this.createPick();
    this.waiting = undefined;
    this.frame(pick, step);
    pick.placeholder = step.placeholder;
    pick.items = step.items.map(toItem);
    pick.busy = false;
    this.present(pick);
    return await this.wait();
  }

  private async box(step: InputStep): Promise<FlowInput | undefined> {
    const box = this.deps.window.createInputBox();
    this.frame(box, step);
    box.prompt = step.prompt;
    box.placeholder = step.placeholder;
    box.value = step.value;
    box.password = step.password;
    box.validationMessage = step.validationMessage;
    box.onDidChangeValue((value) => {
      if (box === this.current) box.validationMessage = this.flow.validate(value);
    });
    // An accept the check refuses stays on the box with the check's sentence.
    box.onDidAccept(() => {
      if (box !== this.current) return;
      const refusal = this.flow.validate(box.value);
      if (refusal === undefined) this.settle({ kind: "accept", value: box.value });
      else box.validationMessage = refusal;
    });
    this.watch(box);
    this.present(box);
    return await this.wait();
  }

  /** The paste box stays on screen, busy, while the child reads the text. */
  private async parse(text: string): Promise<FlowInput | undefined> {
    const box = this.current as vscode.InputBox;
    box.busy = true;
    const answer = await this.until(this.deps.client.parsePastedConnection({ text }));
    box.busy = false;
    return answer === undefined ? undefined : { kind: "parsed", answer };
  }

  /** A busy pick while connection/test runs; its hide (Escape) cancels the test and ends the flow. */
  private async test(step: Extract<FlowStep, { kind: "test" }>): Promise<FlowInput | undefined> {
    const pick = this.createPick();
    this.frame(pick, step);
    pick.placeholder = step.placeholder;
    pick.busy = true;
    pick.enabled = false;
    this.present(pick);
    const source = new vscode.CancellationTokenSource();
    this.testing = source;
    try {
      const posture = { allowExternalFileAccess: this.deps.workspace.isTrusted };
      const answer = await this.until(
        this.deps.client.testConnection({ connection: step.connection, posture }, source.token),
      );
      return answer === undefined ? undefined : { kind: "tested", outcome: { kind: "answered", answer } };
    } catch (error) {
      // The answer to a test the person cancelled.
      if (this.ended) return undefined;
      if (!(error instanceof BackendError || error instanceof BackendExitedError)) throw error;
      const fixStatement = error instanceof BackendError ? error.fixStatement : undefined;
      return { kind: "tested", outcome: { kind: "failed", message: error.message, fixStatement } };
    } finally {
      this.testing = undefined;
      source.dispose();
    }
  }

  /** A modal dialog, shown alone: the busy test pick is closed first. Escape answers undefined. */
  private async dialog(step: Extract<FlowStep, { kind: "dialog" }>): Promise<FlowInput> {
    this.close();
    const options: vscode.MessageOptions =
      step.detail === undefined ? { modal: true } : { modal: true, detail: step.detail };
    const choice =
      step.severity === "warning"
        ? await this.deps.window.showWarningMessage(step.message, options, ...step.buttons)
        : await this.deps.window.showErrorMessage(step.message, options, ...step.buttons);
    return { kind: "dialog", choice };
  }

  /** Secrets, then the setting; a failure the person can fix is shown, and the flow ends with nothing saved. */
  private async save(step: Extract<FlowStep, { kind: "save" }>): Promise<string | undefined> {
    try {
      await this.deps.store.add(step.entry, step.secrets);
    } catch (error) {
      if (error instanceof SecretStoreError) {
        void this.deps.window.showErrorMessage(error.message);
        return undefined;
      }
      if (!(error instanceof SettingWriteError)) throw error;
      void this.deps.window.showErrorMessage(error.message, OPEN_USER_SETTINGS).then((choice) => {
        if (choice === OPEN_USER_SETTINGS) void this.deps.openUserSettings();
      });
      return undefined;
    }
    return step.entry.id;
  }

  private createPick(): vscode.QuickPick<Item> {
    const pick = this.deps.window.createQuickPick<Item>();
    pick.onDidAccept(() => {
      const [item] = pick.selectedItems;
      if (pick === this.current && item !== undefined) this.settle({ kind: "pick", id: item.id });
    });
    this.watch(pick);
    return pick;
  }

  /** Escape ends the flow; Back and More Options answer the step. */
  private watch(input: Shown): void {
    input.onDidHide(() => {
      if (input === this.current) this.end();
    });
    input.onDidTriggerButton((button) => {
      if (input === this.current) {
        this.settle(button === vscode.QuickInputButtons.Back ? { kind: "back" } : { kind: "moreOptions" });
      }
    });
  }

  private frame(
    input: Shown,
    step: { title: string; step?: number; totalSteps?: number; back?: boolean; moreOptions?: boolean },
  ): void {
    input.title = step.title;
    input.step = step.step;
    input.totalSteps = step.totalSteps;
    input.ignoreFocusOut = true;
    input.buttons = [
      ...(step.back === true ? [vscode.QuickInputButtons.Back] : []),
      ...(step.moreOptions === true ? [MORE_OPTIONS] : []),
    ];
  }

  /** Shows the input, then disposes the one before it, whose hide is then not the person's. */
  private present(input: Shown): void {
    if (input === this.current) return;
    const previous = this.current;
    this.current = input;
    input.show();
    previous?.dispose();
  }

  /** The person's answer on the input on screen, or undefined once they end the flow. */
  private wait(): Promise<FlowInput | undefined> {
    return this.until(
      new Promise<FlowInput>((resolve) => {
        this.answer = resolve;
      }),
    );
  }

  /** The work's answer, or undefined once the person ends the flow first; a later settlement of the work is ignored. */
  private until<T>(work: Promise<T>): Promise<T | undefined> {
    return Promise.race([work, this.ending.promise]);
  }

  private settle(input: FlowInput): void {
    const answer = this.answer;
    this.answer = undefined;
    answer?.(input);
  }

  /** The person hid the input on screen (Escape): the flow ends, a test in flight is cancelled, and nothing is saved. */
  private end(): void {
    this.ended = true;
    this.testing?.cancel();
    this.ending.resolve(undefined);
  }
}

function toItem({ id, label, description, detail, separator }: FlowItem): Item {
  return separator === true
    ? { id, label, kind: vscode.QuickPickItemKind.Separator }
    : { id, label, description, detail };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

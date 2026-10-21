/**
 * Scripted QuickPick and InputBox doubles: the inputs a quick input flow creates show here, and a test plays the person
 * on the one on screen, choosing an item by its label, typing or accepting a value, pressing a button or pressing
 * Escape.
 * Typed against @types/vscode and importing nothing from vscode at runtime, so the unit leg's fake window and the e2e
 * leg can both create their inputs here; each set of doubles is built with the Back button object of the module it
 * stands in for.
 * Like VS Code, it shows one quick input at a time: showing one hides the one on screen, and disposing a visible input
 * hides it first, each hide firing onDidHide.
 */
import type * as vscode from "vscode";

/** vscode.QuickPickItemKind.Separator, whose enum is a runtime value of the real module. */
const SEPARATOR = -1 as vscode.QuickPickItemKind;

/** A minimal event emitter: listeners run in the order they subscribed, each until its Disposable is disposed. */
class Emitter<T> {
  private listeners: ((event: T) => unknown)[] = [];

  readonly event: vscode.Event<T> = (listener, thisArgs?, disposables?) => {
    const bound = (event: T) => listener.call(thisArgs, event);
    this.listeners.push(bound);
    const disposable = {
      dispose: () => {
        this.listeners = this.listeners.filter((each) => each !== bound);
      },
    };
    disposables?.push(disposable);
    return disposable;
  };

  fire(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  dispose(): void {
    this.listeners = [];
  }
}

abstract class ScriptedInput implements vscode.QuickInput {
  title: string | undefined;
  step: number | undefined;
  totalSteps: number | undefined;
  enabled = true;
  busy = false;
  ignoreFocusOut = false;
  value = "";
  placeholder: string | undefined;
  prompt: string | undefined;
  buttons: readonly vscode.QuickInputButton[] = [];
  /** Shown, and neither hidden nor disposed since. */
  visible = false;
  disposed = false;
  private readonly hides = new Emitter<void>();
  private readonly accepts = new Emitter<void>();
  private readonly values = new Emitter<string>();
  private readonly triggers = new Emitter<vscode.QuickInputButton>();
  readonly onDidHide = this.hides.event;
  readonly onDidAccept = this.accepts.event;
  readonly onDidChangeValue = this.values.event;
  readonly onDidTriggerButton = this.triggers.event;

  constructor(private readonly screen: ScriptedQuickInputs) {}

  show(): void {
    if (this.disposed) throw new Error("A disposed quick input was shown.");
    if (this.visible) return;
    this.visible = true;
    this.screen.showing(this);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.hides.fire();
  }

  dispose(): void {
    this.hide();
    this.disposed = true;
    for (const emitter of [this.hides, this.accepts, this.values, this.triggers]) emitter.dispose();
  }

  /** The person types: the value changes and onDidChangeValue fires. */
  typed(value: string): void {
    this.value = value;
    this.values.fire(value);
  }

  /** The person presses Enter. */
  accepted(): void {
    if (!this.enabled) throw new Error("A quick input that is not enabled takes no Enter.");
    this.accepts.fire();
  }

  /** The person presses one of the title buttons. */
  pressed(button: vscode.QuickInputButton): void {
    if (!this.buttons.includes(button)) throw new Error("The quick input on screen has no such button.");
    this.triggers.fire(button);
  }
}

export class ScriptedQuickPick<T extends vscode.QuickPickItem> extends ScriptedInput implements vscode.QuickPick<T> {
  items: readonly T[] = [];
  canSelectMany = false;
  matchOnDescription = false;
  matchOnDetail = false;
  keepScrollPosition?: boolean;
  activeItems: readonly T[] = [];
  selectedItems: readonly T[] = [];
  readonly onDidTriggerItemButton = new Emitter<vscode.QuickPickItemButtonEvent<T>>().event;
  readonly onDidChangeActive = new Emitter<readonly T[]>().event;
  readonly onDidChangeSelection = new Emitter<readonly T[]>().event;
}

export class ScriptedInputBox extends ScriptedInput implements vscode.InputBox {
  valueSelection: readonly [number, number] | undefined;
  password = false;
  validationMessage: string | vscode.InputBoxValidationMessage | undefined;
}

export type ScriptedQuickInput = ScriptedQuickPick<vscode.QuickPickItem> | ScriptedInputBox;

export class ScriptedQuickInputs {
  /** Every input shown, in the order shown. */
  readonly shown: ScriptedQuickInput[] = [];
  /** How many of shown next() has answered. */
  private answered = 0;
  private waiting: (() => void) | undefined;
  private onScreen: ScriptedInput | undefined;

  constructor(private readonly backButton: vscode.QuickInputButton) {}

  createQuickPick<T extends vscode.QuickPickItem>(): vscode.QuickPick<T> {
    return new ScriptedQuickPick<T>(this);
  }

  createInputBox(): vscode.InputBox {
    return new ScriptedInputBox(this);
  }

  /** Called by show(): the input on screen is hidden first, as VS Code shows one quick input at a time. */
  showing(input: ScriptedInput): void {
    const before = this.onScreen;
    this.onScreen = input;
    before?.hide();
    this.shown.push(input as ScriptedQuickInput);
    this.waiting?.();
  }

  /** The next input shown that next() has not answered yet, once it is shown. */
  async next(): Promise<ScriptedQuickInput> {
    while (this.answered === this.shown.length) {
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
    this.waiting = undefined;
    const input = this.shown[this.answered];
    this.answered += 1;
    return input;
  }

  async nextPick(): Promise<ScriptedQuickPick<vscode.QuickPickItem>> {
    const input = await this.next();
    if (!(input instanceof ScriptedQuickPick)) throw new Error("The next input shown is not a quick pick.");
    return input;
  }

  async nextBox(): Promise<ScriptedInputBox> {
    const input = await this.next();
    if (!(input instanceof ScriptedInputBox)) throw new Error("The next input shown is not an input box.");
    return input;
  }

  /** The input on screen. */
  get current(): ScriptedQuickInput {
    const input = this.onScreen;
    if (input === undefined || !input.visible) throw new Error("No quick input is on screen.");
    return input as ScriptedQuickInput;
  }

  /** Chooses the item of this label in the pick on screen and presses Enter; a separator is never chosen. */
  choose(label: string): void {
    const pick = this.current;
    if (!(pick instanceof ScriptedQuickPick)) throw new Error("No quick pick is on screen.");
    const item = pick.items.find((each) => each.label === label && each.kind !== SEPARATOR);
    if (item === undefined) throw new Error(`The quick pick on screen has no item labelled ${label}.`);
    pick.activeItems = [item];
    pick.selectedItems = [item];
    pick.accepted();
  }

  /** Types the value into the input box on screen, replacing its value. */
  type(value: string): void {
    this.box().typed(value);
  }

  /** Types the value into the input box on screen and presses Enter. */
  accept(value: string): void {
    const box = this.box();
    box.typed(value);
    box.accepted();
  }

  /** Presses a title button of the input on screen. */
  press(button: vscode.QuickInputButton): void {
    this.current.pressed(button);
  }

  /** Presses the Back button of the input on screen. */
  back(): void {
    this.press(this.backButton);
  }

  /** Presses Escape: the input on screen hides. */
  escape(): void {
    this.current.hide();
  }

  /** Forgets every input, for the next test. */
  reset(): void {
    this.shown.length = 0;
    this.answered = 0;
    this.waiting = undefined;
    this.onScreen = undefined;
  }

  private box(): ScriptedInputBox {
    const box = this.current;
    if (!(box instanceof ScriptedInputBox)) throw new Error("No input box is on screen.");
    return box;
  }
}

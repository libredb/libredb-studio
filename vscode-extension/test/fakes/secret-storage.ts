/**
 * A `vscode.SecretStorage` over a Map, for the unit leg: it records each store and delete in a log a test may share
 * with `FakeSetting`'s writes, fails the keys a test names, and plays another window's changes.
 * It keeps its own listener list rather than the fake module's `EventEmitter`, because `fakeExtensionContext()` in
 * `./vscode.ts` constructs one and the two modules would import each other.
 */
import type * as vscode from "vscode";

/** One step of the log a `MemorySecretStorage` and a `FakeSetting` share: a secret stored or deleted, or a setting written. */
export type Op = ["store" | "delete", string] | ["write"];

export class MemorySecretStorage implements vscode.SecretStorage {
  /** The stored secrets by key; a test may seed it directly, which logs and fires nothing. */
  readonly values = new Map<string, string>();
  /**
   * Whether `onDidChange` fires for this storage's own store and delete before their promise settles, VS Code's order
   * (its main thread fires the change before it answers), or never.
   */
  events: "before-settle" | "none" = "before-settle";
  private readonly storeFailures = new Map<string, string>();
  private readonly deleteFailures = new Map<string, string>();
  private listeners: ((event: vscode.SecretStorageChangeEvent) => unknown)[] = [];

  constructor(
    /** Each store and delete as it is called, failed ones included. */
    readonly log: Op[] = [],
  ) {}

  readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = (listener, thisArgs?, disposables?) => {
    const bound = (event: vscode.SecretStorageChangeEvent) => listener.call(thisArgs, event);
    this.listeners.push(bound);
    const disposable = {
      dispose: () => {
        this.listeners = this.listeners.filter((each) => each !== bound);
      },
    };
    disposables?.push(disposable);
    return disposable;
  };

  /** Another window's writes: they change the stored value and always fire `onDidChange`. */
  readonly external = {
    store: (key: string, value: string): void => {
      this.values.set(key, value);
      this.fire(key);
    },
    delete: (key: string): void => {
      this.values.delete(key);
      this.fire(key);
    },
  };

  /** Every later `store` of the key rejects with an Error of this message and stores nothing. */
  failStore(key: string, message: string): void {
    this.storeFailures.set(key, message);
  }

  /** Every later `delete` of the key rejects with an Error of this message and deletes nothing. */
  failDelete(key: string, message: string): void {
    this.deleteFailures.set(key, message);
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()];
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.log.push(["store", key]);
    const failure = this.storeFailures.get(key);
    if (failure !== undefined) throw new Error(failure);
    this.values.set(key, value);
    if (this.events === "before-settle") this.fire(key);
  }

  async delete(key: string): Promise<void> {
    this.log.push(["delete", key]);
    const failure = this.deleteFailures.get(key);
    if (failure !== undefined) throw new Error(failure);
    this.values.delete(key);
    if (this.events === "before-settle") this.fire(key);
  }

  private fire(key: string): void {
    for (const listener of [...this.listeners]) listener({ key });
  }
}

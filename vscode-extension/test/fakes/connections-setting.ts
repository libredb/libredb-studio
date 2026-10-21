/**
 * The `libredb.connections` setting as a `ConnectionsSetting` the unit leg controls: a raw value a test can change with
 * or without an event, every value written, and a write that fails once.
 */
import type * as vscode from "vscode";
import type { ConnectionsSetting } from "../../src/host/connections/connection-store";
import { EventEmitter } from "./vscode";
import type { Op } from "./secret-storage";

export class FakeSetting implements ConnectionsSetting {
  /** Each value written, in order; a failed write adds nothing. */
  readonly writes: unknown[] = [];
  /** Whether a write fires onDidChange before it settles, as VS Code does for its own update, or never. */
  events: "before-settle" | "none" = "none";
  private nextWriteFailure: string | undefined;
  private readonly changes = new EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this.changes.event;

  constructor(
    /** The raw setting: assigning it fires nothing, as another window's write this window has not seen yet. */
    public value: unknown,
    /** Where each write is logged as ["write"], in one sequence with a MemorySecretStorage's stores and deletes. */
    readonly log: Op[] = [],
  ) {}

  read(): unknown {
    return this.value;
  }

  /** Logs the write, then either rejects with the failure failNextWrite set, or takes the value. */
  async write(value: readonly unknown[]): Promise<void> {
    this.log.push(["write"]);
    const failure = this.nextWriteFailure;
    if (failure !== undefined) {
      this.nextWriteFailure = undefined;
      throw new Error(failure);
    }
    this.writes.push(value);
    this.value = value;
    if (this.events === "before-settle") this.changes.fire();
  }

  /** The next write rejects with an Error of this message and changes nothing. */
  failNextWrite(message: string): void {
    this.nextWriteFailure = message;
  }

  /** Sets the value and fires onDidChange: a hand edit, or a Settings Sync update. */
  edit(value: unknown): void {
    this.value = value;
    this.changes.fire();
  }
}

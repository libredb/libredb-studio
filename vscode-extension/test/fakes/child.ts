import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/** A JSON-RPC request as the host side sends it over the IPC channel. */
export interface FakeRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

/** What the fake child does with one request: answer it, refuse it, or leave it unanswered. */
export type Serve = (
  request: FakeRequest,
) => { result: unknown } | { error: { code: number; message: string; data?: unknown } } | "never";

let nextPid = 4000;

/**
 * A stand-in for a ChildProcess forked with an IPC channel, which the test drives: its answers through `serve`, its
 * notifications through `notified`, its output through `stdout` and `stderr`, and its end through `exit`.
 */
export class FakeChild extends EventEmitter {
  readonly pid = nextPid++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every message the host sent, in order. */
  readonly received: unknown[] = [];
  /** Every signal `kill` was called with, in order; the child does not end until the test calls `exit`. */
  readonly killed: (NodeJS.Signals | number)[] = [];
  connected = true;
  serve: Serve = () => "never";
  notified: (method: string) => void = () => {};

  /** IPCMessageWriter's call: records the message, then answers a request on a later turn as `serve` says. */
  send(message: unknown, _handle?: unknown, _options?: unknown, callback?: (error: Error | null) => void): boolean {
    this.received.push(message);
    callback?.(null);
    const { id, method } = message as Partial<FakeRequest>;
    if (method !== undefined && id === undefined) this.notified(method);
    if (method !== undefined && id !== undefined) {
      const answer = this.serve(message as FakeRequest);
      if (answer !== "never") this.reply({ id, ...answer });
    }
    return true;
  }

  /** Emits a response as the child would write it, on a later turn. */
  reply(response: { id: number | string } & ({ result: unknown } | { error: unknown })): void {
    setImmediate(() => this.emit("message", { jsonrpc: "2.0", ...response }));
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killed.push(signal);
    return true;
  }

  /** Ends the child as Node reports an end: exit, then disconnect, then close. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.connected = false;
    this.emit("exit", code, signal);
    this.emit("disconnect");
    this.emit("close", code, signal);
  }

  /** The method of every request and notification the host sent, in order. */
  methods(): string[] {
    return this.received.map((message) => (message as Partial<FakeRequest>).method ?? "<response>");
  }
}

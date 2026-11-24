import {
  createMessageConnection,
  IPCMessageReader,
  IPCMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { type BackendFactory, createHandlers, registerHandlers } from "./handlers";

/** The part of Node's `process` the child uses, so the unit leg can inject its own. */
export interface BackendProcess {
  readonly versions: NodeJS.ProcessVersions;
  readonly platform: string;
  readonly arch: string;
  /** Present only when the host forked the child with an IPC channel. */
  readonly send?: NodeJS.Process["send"];
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: "disconnect", listener: () => void): unknown;
  exit(code: number): never;
}

export const NO_IPC_CHANNEL = "The LibreDB backend needs the IPC channel its host forks it with.";

/** How long the child waits for its pools to close once its host has gone (part 1 criterion 13 allows 3 s). */
export const DISCONNECT_CLOSE_MS = 2000;

/** What made the child close its pools: its host closing the channel, or a signal. */
export type CloseTrigger = "disconnect" | "SIGTERM" | "SIGINT";

const CLOSE_TRIGGER_WORDS: Readonly<Record<CloseTrigger, string>> = {
  disconnect: "after its host went away",
  SIGTERM: "on SIGTERM",
  SIGINT: "on SIGINT",
};

/** The stderr line of a close that failed, followed by its error. */
export const closeFailedLine = (trigger: CloseTrigger): string =>
  `The LibreDB backend could not close its connections ${CLOSE_TRIGGER_WORDS[trigger]}:`;

/** The stderr line of a close that was still running at DISCONNECT_CLOSE_MS, when the child exits without it. */
export const closeCutLine = (trigger: CloseTrigger): string =>
  `The LibreDB backend exits with its connections not closed ${CLOSE_TRIGGER_WORDS[trigger]}: the close did not finish within ${DISCONNECT_CLOSE_MS} ms.`;

const CUT = Symbol("cut");

/**
 * Closes every pool, waiting at most DISCONNECT_CLOSE_MS, then exits 0. A close that fails, or that is still running
 * at the deadline, writes one stderr line naming what started it.
 */
async function closeThenExit(proc: BackendProcess, factory: BackendFactory, trigger: CloseTrigger): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof CUT>((resolve) => {
    timer = setTimeout(() => resolve(CUT), DISCONNECT_CLOSE_MS);
  });
  try {
    if ((await Promise.race([factory.clearProviderCache(), deadline])) === CUT) console.error(closeCutLine(trigger));
  } catch (error) {
    console.error(closeFailedLine(trigger), error);
  } finally {
    clearTimeout(timer);
  }
  proc.exit(0);
}

/**
 * Serves the protocol on the IPC channel, and closes every pool and exits 0 once the host closes that channel or the
 * child receives SIGTERM or SIGINT, whichever comes first; a later one starts no second close. Importing the provider
 * factory adds no signal listener, so the child registers its own.
 */
export function startBackend(proc: BackendProcess, factory: BackendFactory, nodeFloor: string): MessageConnection {
  if (proc.send === undefined) throw new Error(NO_IPC_CHANNEL);
  // IPCMessageReader and IPCMessageWriter read only on() and send() of the process they are given, which
  // BackendProcess declares, so this is the one place the narrower type stands in for Node's process.
  const ipc = proc as unknown as NodeJS.Process;
  const connection = createMessageConnection(new IPCMessageReader(ipc), new IPCMessageWriter(ipc));
  const { versions, platform, arch } = proc;
  registerHandlers(connection, createHandlers(factory, { versions, platform, arch, nodeFloor }), (code) =>
    proc.exit(code),
  );
  // Open pool sockets would keep the child alive after its host is gone; the body sits on its own line so the
  // line-granular coverage gate sees whether a test closes the channel or signals the child.
  let closing: Promise<void> | undefined;
  const close = (trigger: CloseTrigger): void => {
    closing ??= closeThenExit(proc, factory, trigger);
  };
  proc.once("disconnect", () => close("disconnect"));
  // `on`, not `once`: with no listener left, a second signal would end the child by Node's default before the close.
  proc.on("SIGTERM", () => close("SIGTERM"));
  proc.on("SIGINT", () => close("SIGINT"));
  connection.listen();
  return connection;
}

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

export const DISCONNECT_CLOSE_FAILED = "The LibreDB backend could not close its connections after its host went away:";

/** Closes every pool, waiting at most DISCONNECT_CLOSE_MS, then exits 0 as the factory's signal handler does. */
async function closeThenExit(proc: BackendProcess, factory: BackendFactory): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, DISCONNECT_CLOSE_MS);
  });
  try {
    await Promise.race([factory.clearProviderCache(), deadline]);
  } catch (error) {
    console.error(DISCONNECT_CLOSE_FAILED, error);
  } finally {
    clearTimeout(timer);
  }
  proc.exit(0);
}

/** Serves the protocol on the IPC channel, and closes every pool and exits 0 once the host closes that channel. */
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
  // line-granular coverage gate sees whether a test closes the channel.
  proc.once("disconnect", () => {
    void closeThenExit(proc, factory);
  });
  connection.listen();
  return connection;
}

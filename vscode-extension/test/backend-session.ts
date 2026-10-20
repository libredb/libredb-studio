import type { ChildProcess } from "node:child_process";
import {
  createMessageConnection,
  IPCMessageReader,
  IPCMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { type InitializeResult, METHODS, PROTOCOL_VERSION } from "../src/protocol";

/** A forked child and the protocol connection over its IPC channel, shared by the integration and e2e legs. */
export interface BackendSession {
  readonly child: ChildProcess;
  readonly connection: MessageConnection;
  stdout(): string;
  stderr(): string;
  /** Rejects "child exited <code or signal> before answering: <stderr>" when the child ends first. */
  initialize(protocolVersion?: number): Promise<InitializeResult>;
}

/**
 * Opens the protocol connection on a child forked with an IPC channel.
 * It reads both pipes for as long as the child runs, so a chatty child never blocks on a full one, and a missing or
 * crashing dist/backend.js fails the handshake at once with its own error instead of at Mocha's timeout.
 */
export function openSession(child: ChildProcess): BackendSession {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const connection = createMessageConnection(new IPCMessageReader(child), new IPCMessageWriter(child));
  connection.listen();
  return {
    child,
    connection,
    stdout: () => stdout,
    stderr: () => stderr,
    initialize(protocolVersion = PROTOCOL_VERSION) {
      return new Promise<InitializeResult>((resolve, reject) => {
        const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
          reject(new Error(`child exited ${code ?? signal} before answering: ${stderr.trim()}`));
          connection.dispose();
        };
        child.once("close", onClose);
        connection.sendRequest<InitializeResult>(METHODS.initialize, { protocolVersion }).then(
          (answer) => {
            child.off("close", onClose);
            resolve(answer);
          },
          (error: unknown) => {
            child.off("close", onClose);
            reject(error);
          },
        );
      });
    },
  };
}

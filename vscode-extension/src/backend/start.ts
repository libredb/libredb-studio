/** The part of Node's `process` the child uses, so the unit leg can inject its own. */
export interface BackendProcess {
  readonly versions: NodeJS.ProcessVersions;
  /** Present only when the host forked the child with an IPC channel. */
  readonly send?: (message: unknown) => boolean;
  once(event: "disconnect", listener: () => void): unknown;
  exit(code: number): never;
}

/** The child's one message until PR 5: the versions of the runtime it was forked on. */
export interface RuntimeAnswer {
  versions: NodeJS.ProcessVersions;
}

export const NO_IPC_CHANNEL = "The LibreDB backend needs the IPC channel its host forks it with.";

/** Answers the runtime's versions over the IPC channel and exits 0 once the host closes it. */
export function startBackend(proc: BackendProcess): void {
  if (proc.send === undefined) throw new Error(NO_IPC_CHANNEL);
  const answer: RuntimeAnswer = { versions: proc.versions };
  proc.send(answer);
  // The body sits on its own line so the line-granular coverage gate sees whether a test closes the channel.
  proc.once("disconnect", () => {
    proc.exit(0);
  });
}

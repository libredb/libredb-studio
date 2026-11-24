/**
 * A host core that records every execute call made through it, installed in place of a test file's own core for one
 * run and put back after it: the session's read-only policy, the request and the context of each call, and the kind of
 * each record the calls answered, in the order they answered.
 *
 * The file installs its own core first (`installHostCore(createHostCore(), "test")`); the recording core wraps it, so
 * every call still runs on that core.
 */
import type { CallContext, ExecuteRequest } from "@libredb/provider-sdk/calls";
import type { HostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, hostCore, installHostCore } from "@/lib/provider-host/instance";

export interface RecordedExecute {
  readonly readOnlyStatements: boolean;
  readonly request: ExecuteRequest;
  readonly ctx: CallContext;
}

export interface HostCoreRecord {
  readonly executes: readonly RecordedExecute[];
  /** The kind of each record the execute calls answered, or `rejected` for a call that rejected. */
  readonly kinds: readonly string[];
}

/** Runs `run` with the recording core installed, and puts the installed core back however `run` ends. */
export async function withRecordingHostCore<T>(run: (record: HostCoreRecord) => Promise<T>): Promise<T> {
  const executes: RecordedExecute[] = [];
  const kinds: string[] = [];
  const real = hostCore();
  const recording: HostCore = {
    ...real,
    executeCall: (session, request, ctx, limits, ports) => {
      executes.push({ readOnlyStatements: session.readOnlyStatements, request, ctx });
      const answered = real.executeCall(session, request, ctx, limits, ports);
      void answered.then(
        (answer) => kinds.push(answer.kind),
        () => kinds.push("rejected"),
      );
      return answered;
    },
  };
  forgetHostCore();
  installHostCore(recording, "test");
  try {
    return await run({ executes, kinds });
  } finally {
    forgetHostCore();
    installHostCore(real, "test");
  }
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentLedgerEntry } from "@/lib/agent/run-store";
import type { AgentRunMode, AgentRunWorkflowType } from "@/lib/agent/types";
import { foldLedgerEntries, parseLedgerLine, type AgentRunTimeline } from "./timeline";

/**
 * Starts one run and follows its ledger (#329 T10a).
 *
 * The run's history is read from `GET /api/agent/runs/[runId]/stream`, which is
 * newline-delimited JSON: one ledger entry per line, everything already recorded
 * first and then everything that follows. Two consequences shape this hook:
 *
 *  - **The timeline is folded from the ledger, never from what `POST` returned.**
 *    The start response is only how the run id is learned; every status this hook
 *    reports comes from the entries themselves, so the rail says what the durable
 *    record says and not what a request once believed.
 *  - **Bytes do not arrive in whole lines.** The reader keeps the trailing partial
 *    line and joins it to the next chunk. A line it cannot read is skipped rather
 *    than fatal (`parseLedgerLine`), so a newer server's entry kind does not tear
 *    down a timeline the user is reading.
 *
 * Following is aborted when the rail goes away. Nothing here retries: a reconnect
 * has to resume at the ledger's own cursor, and the route does not expose that index
 * yet (handed forward from T9).
 */

export interface AgentRunStartInput {
  readonly mode: AgentRunMode;
  /**
   * What the run is FOR. Optional here as it is in the route: omitting it opens an
   * investigation. The server decides from the value it PERSISTS, so this is a
   * request rather than a setting — nothing the browser sends later can change it.
   */
  readonly workflowType?: AgentRunWorkflowType;
  readonly objective: string;
  readonly connectionId: string;
}

export interface AgentRunFollower {
  /** Set once the server has opened a run; null before the first start. */
  readonly runId: string | null;
  /** A start is in flight, or its ledger is still open. */
  readonly isBusy: boolean;
  /**
   * A stop has been asked for and the server has not refused it. Distinct from
   * the ledger's own `stopRequested`: this covers the window before the request
   * has been recorded, and it is cleared again if the ask fails, so a refused stop
   * leaves the user able to ask once more.
   */
  readonly isStopping: boolean;
  readonly timeline: AgentRunTimeline;
  /** The app's own words about why the last attempt did not continue. */
  readonly error: string | null;
  readonly start: (input: AgentRunStartInput) => Promise<void>;
  /**
   * Asks the run to stop. It is an ASK: the run's own loop ends it at its next
   * checkpoint (T7a), so nothing here reports the run as stopped — the ledger
   * does that, through the entry the request writes.
   */
  readonly cancel: () => Promise<void>;
}

interface StartResponse {
  readonly runId?: unknown;
  readonly error?: unknown;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAgentRun(): AgentRunFollower {
  const [runId, setRunId] = useState<string | null>(null);
  const [entries, setEntries] = useState<readonly AgentLedgerEntry[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const follow = useCallback(async (id: string, signal: AbortSignal): Promise<void> => {
    const res = await fetch(`/api/agent/runs/${encodeURIComponent(id)}/stream`, { signal });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as StartResponse;
      throw new Error(
        typeof body.error === "string" ? body.error : `The run's timeline could not be read (${res.status})`,
      );
    }
    // A response with no body is not an error: nothing to read, and the run stays
    // exactly as visible as the ledger made it.
    if (res.body === null) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    const append = (lines: readonly string[]): void => {
      const parsed = lines.map(parseLedgerLine).filter((entry): entry is AgentLedgerEntry => entry !== null);
      if (parsed.length > 0) setEntries((prev) => [...prev, ...parsed]);
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      // The last element is whatever came after the final newline: either an empty
      // string, or the beginning of a line whose remainder is in the next chunk.
      pending = lines.pop() ?? "";
      append(lines);
    }

    // A final line need not be newline-terminated to be a line, so whatever is left
    // is offered to the parser rather than dropped. `decode()` with no argument
    // flushes any partial multi-byte character the last chunk ended on.
    append([pending + decoder.decode()]);
  }, []);

  const start = useCallback(
    async (input: AgentRunStartInput): Promise<void> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsBusy(true);
      setIsStopping(false);
      setError(null);
      setEntries([]);
      setRunId(null);

      let openedRunId: string;
      try {
        const res = await fetch("/api/agent/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        const body = (await res.json().catch(() => ({}))) as StartResponse;
        if (!res.ok) {
          throw new Error(typeof body.error === "string" ? body.error : `The run could not be started (${res.status})`);
        }
        if (typeof body.runId !== "string") {
          throw new Error("The server opened a run without naming it");
        }
        openedRunId = body.runId;
      } catch (startError) {
        if (!controller.signal.aborted) {
          setError(messageFor(startError));
          setIsBusy(false);
        }
        return;
      }

      setRunId(openedRunId);

      try {
        await follow(openedRunId, controller.signal);
      } catch (followError) {
        // An abort is this component going away, not a failure to report.
        if (!controller.signal.aborted) setError(messageFor(followError));
      } finally {
        if (!controller.signal.aborted) setIsBusy(false);
      }
    },
    [follow],
  );

  const cancel = useCallback(async (): Promise<void> => {
    if (runId === null) return;

    setIsStopping(true);
    setError(null);
    try {
      // Carried on the same signal as the stream it belongs to, so a rail that
      // goes away does not leave a request behind. It does NOT abort that
      // controller: aborting is how this component stops following a run, and a
      // stop request is the opposite — the run is expected to keep reporting until
      // its loop reaches a checkpoint.
      const res = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}`, {
        method: "DELETE",
        signal: abortRef.current?.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as StartResponse;
        throw new Error(typeof body.error === "string" ? body.error : `The run could not be stopped (${res.status})`);
      }
      // Nothing is set on success. The request wrote a ledger entry, and the
      // stream is what delivers it — so what the rail shows is what the durable
      // record says rather than what this call hoped for.
    } catch (cancelError) {
      if (abortRef.current?.signal.aborted !== true) {
        setError(messageFor(cancelError));
        setIsStopping(false);
      }
    }
  }, [runId]);

  return { runId, isBusy, isStopping, timeline: foldLedgerEntries(entries), error, start, cancel };
}

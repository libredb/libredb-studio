"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAgentModelCapability } from "@/lib/agent/capability-labels";
// Type-only, so nothing of the probe — or of the AI SDK it runs — reaches this bundle.
import type { AgentModelCapability } from "@/lib/agent/capability-probe";
import type { AgentLedgerEntry } from "@/lib/agent/run-store";
import type {
  AgentRunFailureReason,
  AgentRunMode,
  AgentRunWorkflowReading,
  AgentRunWorkflowSource,
  AgentRunWorkflowType,
  AgentThreadContext,
} from "@/lib/agent/types";
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
  /**
   * HOW that workflow was decided — the server read it out of the objective, or a
   * person named it. Optional here as it is in the route, where absent means the
   * caller named it.
   *
   * It changes nothing about what the run DOES; `selectAgentTools` never sees it. It
   * is sent because the surface owes the user a different sentence in each case, and
   * because that sentence has to survive a reload, which only a field on the run
   * record can do.
   */
  readonly workflowSource?: AgentRunWorkflowSource;
  /**
   * How that reading went, when one was made — and `"unrecorded"` when none was, which
   * is what a caller naming its own workflow sends. Optional here as it is in the
   * route, where absent means the same thing.
   *
   * It changes nothing about what the run DOES either. It is sent because the sentence
   * the surface owes differs between a workflow a classifier NAMED and one it fell
   * back to, and only the run record carries that across a reload.
   */
  readonly workflowReading?: AgentRunWorkflowReading;
  /**
   * Whether the run may also run its answer in the caller's editor. A request, like
   * the two above: the server PERSISTS it on the run record, and nothing sent later
   * can widen a run that is already open.
   */
  readonly autoExecute?: boolean;
  /**
   * The run whose CONVERSATION this one continues, when the user asks a follow-up.
   *
   * A request, like the fields above, and a weaker one than they are: the server
   * derives the conversation from that run's own ledger and persists it, so nothing
   * the browser remembers is trusted into the prompt — and a run it cannot reach opens
   * anyway, carrying no conversation and saying so. Naming it never risks the question.
   */
  readonly previousRunId?: string;
  readonly objective: string;
  readonly connectionId: string;
}

export interface AgentRunFollower {
  /** Set once the server has opened a run; null before the first start. */
  readonly runId: string | null;
  /**
   * The conversation the server said this run belongs to, or null before the first
   * start. What the rail renders comes from here rather than from anything it
   * inferred: the thread has one writer, and it is the route.
   */
  readonly thread: AgentThreadContext | null;
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
  /**
   * WHICH refusal `error` is, when the server named one, and `null` otherwise.
   *
   * Only for a refused START, and only for a code this build has words for. It exists
   * because a surface may already be explaining the same fact for itself — the rail's
   * amber engine card is, verbatim — and a second copy of that explanation in an error
   * line is not an error message (#513). A reader that ignores this field renders `error`
   * and is correct, which is why it is a code beside the sentence rather than a
   * replacement for it.
   */
  readonly errorCode: AgentStartRefusalCode | null;
  /**
   * The one start failure that is a verdict about the MODEL rather than about the
   * attempt (#331 T4). Set only for the capability gate's `422`; every other refused
   * start, and every failure of a run that did open, stays in `error` or in the
   * ledger's own failure reason.
   *
   * It carries the mode it was raised for, because it is not true of every mode: the
   * gate admits planning without probing at all. A surface offering both modes must
   * check that field before showing this — see `AgentRail`.
   */
  readonly refusal: AgentModelRefusal | null;
  readonly start: (input: AgentRunStartInput) => Promise<void>;
  /**
   * Asks the run to stop. It is an ASK: the run's own loop ends it at its next
   * checkpoint (T7a), so nothing here reports the run as stopped — the ledger
   * does that, through the entry the request writes.
   *
   * @returns whether the SERVER ACCEPTED the request, which is a narrower fact than
   *          the run having stopped and is the only one this call can establish. It
   *          answers rather than throwing because the Stop control has nothing to do
   *          with the answer — the failure is already reported through `error` — while
   *          a caller that stops one run in order to open another must not proceed on
   *          a stop that did not happen. Resolving unconditionally is what let that
   *          caller leave two runs executing against the same connection (#407 review).
   */
  readonly cancel: () => Promise<boolean>;
}

interface StartResponse {
  readonly runId?: unknown;
  readonly error?: unknown;
  readonly refused?: unknown;
  readonly missing?: unknown;
  readonly disproved?: unknown;
  readonly thread?: unknown;
}

/**
 * The start-refusal codes this build has words for (`route.ts`, `badRequest`).
 *
 * `Extract` rather than a bare literal so the wire value cannot drift from the name the
 * same fact travels under as an `AgentRunFailureReason`: with two independent literals,
 * renaming the union member broke `timeline.ts` and `runtime.ts` and left both ends of
 * THIS wire silently on the old string.
 *
 * Exported because the surface that acts on it has to be able to name it: `AgentRail`
 * compares against this rather than against a string of its own.
 */
export type AgentStartRefusalCode = Extract<AgentRunFailureReason, "engine-unsupported">;

/** Typed rather than compared inline, so the RUNTIME string is extracted from the union too. */
const ENGINE_UNSUPPORTED_CODE: AgentStartRefusalCode = "engine-unsupported";

/**
 * What `errorCode` may hold, checked at runtime and not only declared.
 *
 * A value outside the list is not shown AS A CODE: it is dropped here and the refusal
 * renders as the server's own sentence, which is the right answer to a refusal this build
 * has no words for. What that guarantees is the TYPE of `errorCode` — no surface added
 * later can read a code out of it that this build cannot name. It is not what keeps the
 * wrong paragraph off the screen today: the rail compares against its own
 * `ENGINE_UNSUPPORTED_CODE` as well, and the two checks are in SERIES, so widening either
 * one alone changes nothing that renders (both measured, 2026-08-27). Driven by "an
 * unknown code never reaches errorCode" in `tests/components/agent/AgentRail.test.tsx`,
 * which reaches for the hook rather than the rail for exactly that reason.
 */
const isStartRefusalCode = (value: unknown): value is AgentStartRefusalCode => value === ENGINE_UNSUPPORTED_CODE;

/**
 * The conversation the SERVER says this run belongs to.
 *
 * Read off the start response rather than assembled here, because the thread has one
 * writer and it is the route: what the rail renders — the steps, and whether
 * continuing one was declined — has to be what was actually recorded on the run,
 * never what the browser asked for.
 */
function readThread(value: unknown): AgentThreadContext | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.threadId !== "string" || typeof candidate.text !== "string") return null;
  if (!Array.isArray(candidate.steps)) return null;
  const steps = candidate.steps.filter(
    (step): step is { runId: string; objective: string } =>
      typeof step === "object" &&
      step !== null &&
      typeof (step as Record<string, unknown>).runId === "string" &&
      typeof (step as Record<string, unknown>).objective === "string",
  );
  const declined = candidate.declined;
  return {
    threadId: candidate.threadId,
    steps,
    text: candidate.text,
    // Every code the header may carry is admitted here, and an unrecognised one is
    // dropped. Dropping is the safe half only as long as this list is complete: a code
    // the server writes and this narrowing does not know leaves the rail with no
    // `declined` at all, so a continuation that was refused renders no notice rather
    // than the wrong one. That is how `"repointed"` had to be added here as well as to
    // the union (#512).
    ...(declined === "unavailable" || declined === "disabled" || declined === "error" || declined === "repointed"
      ? { declined }
      : {}),
  };
}

/**
 * What the capability gate established about the configured model.
 *
 * `message` is the server's own sentence: it names the model and quotes what the
 * endpoint said, neither of which crosses the wire in any other field. `missing` is the
 * structured half, so a surface can state the shortfall in its own words instead of
 * parsing that sentence back apart.
 */
export interface AgentModelRefusal {
  readonly message: string;
  /** Empty when the server named a shortfall this build has no words for; never invented. */
  readonly missing: readonly AgentModelCapability[];
  /**
   * The subset of `missing` the probe WATCHED fail, as against what it never got to see.
   *
   * The two are not interchangeable outside the run that was refused. An endpoint that
   * refused the tool request establishes nothing about streaming; one that answered a
   * streamed request with a buffered body establishes that it does not stream, and a
   * toolless run over it would produce silence. Both arrive as `missing: [..."streaming"]`,
   * so a surface offering the user another mode reads this field, never `missing`
   * (#331 T4 review, `capability-probe.ts`).
   */
  readonly disproved: readonly AgentModelCapability[];
  /**
   * The mode the refused start asked for, and the only mode this verdict is about.
   *
   * The gate probes a model because an AGENT run needs tools; planning is toolless by
   * contract and returns `allowed` on its first line (`capability-gate.ts`), so it is
   * never probed and never refused. A verdict left standing over a mode it was never
   * about would be a false statement, which is why it is recorded rather than assumed.
   */
  readonly mode: AgentRunMode;
}

/**
 * The status the capability gate refuses with. 422 rather than 400 because the request
 * was well-formed and it is the server's own configuration that cannot honour it
 * (`src/app/api/agent/runs/route.ts`).
 */
const CAPABILITY_REFUSED_STATUS = 422;

/**
 * Carries the verdict out through the same exit the other start failures take, so the
 * rule about what may be reported after an abort is written once. Its `message` is the
 * server's sentence, which is also what `messageFor` would produce: a reader that loses
 * the `instanceof` below degrades to the generic line rather than to nothing.
 */
class ModelRefusedError extends Error {
  readonly refusal: AgentModelRefusal;

  constructor(refusal: AgentModelRefusal) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

/**
 * Carries a named refusal out through the same exit as the unnamed ones, so nothing
 * about what may be reported after an abort is written twice.
 *
 * A subclass rather than a second `setState` at the throw site for the same reason
 * `ModelRefusedError` is one: the `catch` below is the single place that knows whether
 * the request was abandoned. Its `message` is the server's sentence, so a reader that
 * loses the `instanceof` still shows the paragraph rather than nothing.
 */
class StartRefusedError extends Error {
  readonly code: AgentStartRefusalCode;

  constructor(message: string, code: AgentStartRefusalCode) {
    super(message);
    this.code = code;
  }
}

/** Names this build has words for, and nothing else: an unknown one is dropped, never shown. */
function readCapabilities(value: unknown): readonly AgentModelCapability[] {
  return Array.isArray(value) ? value.filter(isAgentModelCapability) : [];
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAgentRun(): AgentRunFollower {
  const [runId, setRunId] = useState<string | null>(null);
  const [thread, setThread] = useState<AgentThreadContext | null>(null);
  const [entries, setEntries] = useState<readonly AgentLedgerEntry[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<AgentStartRefusalCode | null>(null);
  const [refusal, setRefusal] = useState<AgentModelRefusal | null>(null);
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
      setErrorCode(null);
      // A verdict is about the model that was configured when it was reached; an
      // operator who changed it and started again is owed the new answer, not the old one.
      setRefusal(null);
      setEntries([]);
      setRunId(null);

      let openedRunId: string;
      let openedThread: AgentThreadContext | null = null;
      try {
        const res = await fetch("/api/agent/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        const body = (await res.json().catch(() => ({}))) as StartResponse;
        if (!res.ok) {
          const said = typeof body.error === "string" ? body.error : `The run could not be started (${res.status})`;
          // The status is what makes this a verdict, not the words. Only the capability
          // gate answers 422, and it answers it only for an incapability it POSITIVELY
          // established: a bad key, a quota, a 5xx or a dropped socket all open a run and
          // are reported by the drive in its own vocabulary, so nothing that merely went
          // wrong can be read here as a statement about the model.
          if (res.status === CAPABILITY_REFUSED_STATUS) {
            throw new ModelRefusedError({
              message: said,
              missing: readCapabilities(body.missing),
              disproved: readCapabilities(body.disproved),
              mode: input.mode,
            });
          }
          // A code the server named, when this build knows it. It rides beside the
          // sentence rather than replacing it: a surface that has no use for the code
          // renders `error` and is right (#513).
          if (isStartRefusalCode(body.refused)) throw new StartRefusedError(said, body.refused);
          throw new Error(said);
        }
        if (typeof body.runId !== "string") {
          throw new Error("The server opened a run without naming it");
        }
        openedRunId = body.runId;
        openedThread = readThread(body.thread);
      } catch (startError) {
        if (!controller.signal.aborted) {
          if (startError instanceof ModelRefusedError) setRefusal(startError.refusal);
          else {
            setError(messageFor(startError));
            if (startError instanceof StartRefusedError) setErrorCode(startError.code);
          }
          setIsBusy(false);
        }
        return;
      }

      setRunId(openedRunId);
      setThread(openedThread);

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

  const cancel = useCallback(async (): Promise<boolean> => {
    // Nothing is open, so nothing was stopped. Answered `false` rather than `true`:
    // the value is read by a caller deciding whether the run it wanted stopped is
    // gone, and "there was no run" is not that.
    if (runId === null) return false;

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
      return true;
    } catch (cancelError) {
      if (abortRef.current?.signal.aborted !== true) {
        setError(messageFor(cancelError));
        setIsStopping(false);
      }
      // Including the abort: this component going away is not a stop the server
      // accepted, and a caller waiting on one is owed the same "no" either way.
      return false;
    }
  }, [runId]);

  /*
    Memoised on the entries alone, which is the whole of the fold's input. Without
    it the fold re-walked the entire accumulated ledger on every render of the rail
    rather than on every new event — a multiplier that cost nothing while a run was
    sixteen turns and is worth removing now that a drive may take sixty turns and
    spend forty-two statements — `data-analysis`, which is the largest row in
    `AGENT_WORKFLOW_BUDGETS` and the one to size this against. (It was written
    against `database-assessment`'s forty-eight and forty-five, which understated the
    ceiling by a quarter the moment the analysis row landed.) What it does not remove
    is the fold's O(n) work per
    new entry, which is O(n squared) over a run's life; that is measured as fine at
    these sizes and is not optimised on a list nobody has seen be slow.
  */
  const timeline = useMemo(() => foldLedgerEntries(entries), [entries]);

  return { runId, thread, isBusy, isStopping, timeline, error, errorCode, refusal, start, cancel };
}

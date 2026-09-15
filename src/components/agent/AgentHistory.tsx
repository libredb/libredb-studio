"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, LoaderCircle, RotateCw } from "lucide-react";
import { appFetch } from "@/lib/config/base-path";
import { AGENT_HISTORY_PAGE_DEFAULT } from "@/lib/agent/execution-policy";
import type { AgentConversationSummary, AgentRunRecord } from "@/lib/agent/types";

/**
 * The run history panel (#830): the finished conversations this session can
 * reopen, newest first, and the report of any one step, read back on demand.
 *
 * It is deliberately a sibling of the live rail rather than part of `useAgentRun`:
 * the live hook follows ONE run's ledger stream, while this reads the list route
 * and the per-run route. Sharing the hook would entangle two different lifetimes
 * — a list the user opens and closes, and a run whose stream must never be torn
 * down by a history panel closing.
 *
 * Everything rendered here is read back through the route, which scopes the list
 * to the session: a user can only ever see their own runs, and a reopened report
 * is the same `GET /api/agent/runs/{runId}` the rail's owner check guards.
 */

interface HistoryWire {
  readonly conversations?: unknown;
  readonly nextCursor?: unknown;
}

interface ReportView {
  readonly claims: readonly string[];
  readonly closing: readonly string[];
  readonly answerSql: readonly string[];
  readonly planSql: readonly string[];
}

type LoadState = "idle" | "loading" | "ready" | "error";

const STATUS_LABELS: Readonly<Record<AgentConversationSummary["steps"][number]["status"], string>> = {
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** The run's report, as the history panel shows it: what it claimed and what it concluded. */
export function reportOf(record: AgentRunRecord): ReportView {
  const claims: string[] = [];
  const closing: string[] = [];
  const answerSql: string[] = [];
  const planSql: string[] = [];
  for (const event of record.events) {
    if (event.kind === "report-composed") {
      for (const claim of event.claims) claims.push(claim.claim);
    } else if (event.kind === "closing-statement") {
      closing.push(event.text);
    } else if (event.kind === "answer-composed") {
      answerSql.push(event.sql);
    } else if (event.kind === "plan-statement-drafted") {
      planSql.push(event.sql);
    }
  }
  return { claims, closing, answerSql, planSql };
}

function isConversationStep(value: unknown): value is AgentConversationSummary["steps"][number] {
  if (typeof value !== "object" || value === null) return false;
  const step = value as Record<string, unknown>;
  return (
    typeof step.runId === "string" &&
    typeof step.objective === "string" &&
    typeof step.workflowType === "string" &&
    typeof step.mode === "string" &&
    typeof step.status === "string" &&
    (typeof step.answered === "boolean" || step.answered === null) &&
    typeof step.connectionId === "string" &&
    typeof step.createdAtMs === "number" &&
    typeof step.updatedAtMs === "number"
  );
}

function isConversationSummary(value: unknown): value is AgentConversationSummary {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;
  return (
    typeof summary.threadId === "string" && Array.isArray(summary.steps) && summary.steps.every(isConversationStep)
  );
}

/** Narrows the list route's payload; an off-shape line is skipped, not trusted. */
function readConversations(payload: unknown): readonly AgentConversationSummary[] {
  if (typeof payload !== "object" || payload === null) return [];
  const wire = payload as HistoryWire;
  if (!Array.isArray(wire.conversations)) return [];
  return wire.conversations.filter(isConversationSummary);
}

/** The list route's next cursor; absent or off-shape means there is no next page. */
function readNextCursor(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const wire = payload as HistoryWire;
  return typeof wire.nextCursor === "string" ? wire.nextCursor : null;
}

/** A stable, locale-agnostic rendering of a finish timestamp for the list. */
function formatTimestamp(atMs: number): string {
  const date = new Date(atMs);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function StatusBadge({ status }: { readonly status: AgentConversationSummary["steps"][number]["status"] }) {
  const tone =
    status === "succeeded"
      ? "text-fg-muted border-hairline-strong"
      : status === "failed"
        ? "text-hue-rose-alt border-hue-rose-alt/30"
        : "text-warning/80 border-warning/30";
  return (
    <span className={`rounded border px-1 py-px text-[0.5625rem] leading-none ${tone}`}>{STATUS_LABELS[status]}</span>
  );
}

export function AgentHistory() {
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<readonly AgentConversationSummary[]>([]);
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);
  const [report, setReport] = useState<{ readonly runId: string; readonly view: ReportView } | null>(null);
  const [loadingReport, setLoadingReport] = useState<string | null>(null);

  // The cursor for the page after the current one. State rather than a ref:
  // whether to offer "Load more" is RENDERED, so it has to be reactive — a ref
  // read during render is exactly the access the compiler lint refuses.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const loadingMore = useRef(false);
  // The run id of the most recently requested report. `openReport` checks this
  // before applying a response, so a slow reply to an earlier request cannot
  // overwrite the report the user just asked for (the A/B race).
  const latestReportRequest = useRef<string | null>(null);

  const load = async (cursor: string | null, append: boolean): Promise<void> => {
    if (loadingMore.current) return;
    loadingMore.current = true;
    setState((current) => (current === "ready" ? current : "loading"));
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(AGENT_HISTORY_PAGE_DEFAULT) });
      if (cursor !== null) params.set("cursor", cursor);
      const res = await appFetch(`/api/agent/runs?${params}`);
      const payload = (await res.json()) as unknown;
      if (!res.ok) {
        const message =
          typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : "The run history could not be read.";
        setError(message);
        setState("error");
        return;
      }
      const page = readConversations(payload);
      setNextCursor(readNextCursor(payload));
      setConversations((current) => (append ? [...current, ...page] : page));
      setState("ready");
    } catch {
      setError("The run history could not be read.");
      setState("error");
    } finally {
      loadingMore.current = false;
    }
  };

  useEffect(() => {
    void load(null, false);
    // The list is loaded once per mount; a fresh conversation finishes while the
    // panel is open only after a run this rail drove, and the user refreshes the
    // panel with the reload control rather than racing their own run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openReport = async (runId: string): Promise<void> => {
    latestReportRequest.current = runId;
    setLoadingReport(runId);
    setReport(null);
    // The error line is shared by the list loader and the report loader, so a
    // fresh open clears the previous report's failure sentence before this one
    // is read — a report that failed once must not stand over the healthy one
    // now being opened.
    setError(null);
    const isCurrent = (): boolean => latestReportRequest.current === runId;
    try {
      const res = await appFetch(`/api/agent/runs/${encodeURIComponent(runId)}`);
      const payload = (await res.json()) as unknown;
      if (!res.ok) {
        if (isCurrent()) setError("That run could not be reopened.");
        return;
      }
      if (typeof payload !== "object" || payload === null || !("record" in payload)) {
        if (isCurrent()) setError("That run could not be reopened.");
        return;
      }
      const record = (payload as { record?: unknown }).record as AgentRunRecord | undefined;
      if (record === undefined || !Array.isArray(record.events)) {
        if (isCurrent()) setError("That run could not be reopened.");
        return;
      }
      if (isCurrent()) setReport({ runId, view: reportOf(record) });
    } catch {
      if (isCurrent()) setError("That run could not be reopened.");
    } finally {
      // A newer request is now in flight; its own completion clears the loader.
      if (isCurrent()) setLoadingReport(null);
    }
  };

  const toggleThread = (threadId: string, latestRunId: string): void => {
    if (expandedThreadId === threadId) {
      setExpandedThreadId(null);
      setReport(null);
      return;
    }
    setExpandedThreadId(threadId);
    void openReport(latestRunId);
  };

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium text-fg-secondary">History</h2>
        <button
          type="button"
          data-testid="agent-history-reload"
          aria-label="Reload run history"
          disabled={state === "loading"}
          onClick={() => void load(null, false)}
          className="p-1 rounded text-fg-tertiary hover:bg-fill hover:text-fg transition-colors disabled:opacity-40"
        >
          <RotateCw strokeWidth={1.5} className="w-3 h-3" />
        </button>
      </div>

      {state === "loading" && conversations.length === 0 && (
        <p data-testid="agent-history-loading" className="flex items-center gap-1 text-[0.625rem] text-fg-muted">
          <LoaderCircle strokeWidth={1.5} className="w-3 h-3 animate-spin" aria-hidden="true" />
          Loading your runs.
        </p>
      )}

      {/*
        Shown whenever there is a sentence to show, whatever the list's state: the
        list loader and the report loader both write `error`, and only the former
        also flips `state` — a report that cannot be reopened must be said while
        the list it failed on is still on screen.
      */}
      {error !== null && (
        <p data-testid="agent-history-error" className="text-[0.625rem] text-hue-rose-alt">
          {error}
        </p>
      )}

      {state !== "loading" && conversations.length === 0 && state !== "error" && (
        <p data-testid="agent-history-empty" className="text-[0.625rem] text-fg-subtle">
          No finished runs yet. Start a run and it will appear here once it ends.
        </p>
      )}

      {conversations.length > 0 && (
        <ol data-testid="agent-history-list" className="space-y-1">
          {conversations.map((conversation) => {
            const latest = conversation.steps[conversation.steps.length - 1];
            if (latest === undefined) return null;
            const expanded = expandedThreadId === conversation.threadId;
            return (
              <li key={conversation.threadId} className="rounded border border-hairline bg-sunken/40">
                <button
                  type="button"
                  data-testid={`agent-history-item-${conversation.threadId}`}
                  aria-expanded={expanded}
                  onClick={() => toggleThread(conversation.threadId, latest.runId)}
                  className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-fill"
                >
                  <ChevronRight
                    strokeWidth={1.5}
                    className={`mt-0.5 w-3 h-3 shrink-0 text-fg-subtle transition-transform ${expanded ? "rotate-90" : ""}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.6875rem] text-fg-secondary">{latest.objective}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[0.5625rem] text-fg-subtle">
                      <StatusBadge status={latest.status} />
                      {latest.answered === true && <span className="text-fg-subtle">answered</span>}
                      <span>
                        {conversation.steps.length} step{conversation.steps.length === 1 ? "" : "s"} ·{" "}
                        {formatTimestamp(latest.updatedAtMs)}
                      </span>
                    </span>
                  </span>
                </button>

                {expanded && (
                  <div className="border-t border-hairline px-2 py-1.5 space-y-1.5">
                    <ol className="space-y-0.5">
                      {conversation.steps.map((step, index) => (
                        <li key={step.runId} className="flex gap-1 text-[0.625rem] text-fg-muted">
                          <span className="text-fg-subtle">{index + 1}.</span>
                          <button
                            type="button"
                            data-testid={`agent-history-step-${step.runId}`}
                            onClick={() => void openReport(step.runId)}
                            className="min-w-0 flex-1 text-left break-words hover:text-fg-secondary transition-colors"
                          >
                            {step.objective}
                          </button>
                        </li>
                      ))}
                    </ol>

                    {loadingReport !== null && (
                      <p className="flex items-center gap-1 text-[0.625rem] text-fg-muted">
                        <LoaderCircle strokeWidth={1.5} className="w-3 h-3 animate-spin" aria-hidden="true" />
                        Reading the report.
                      </p>
                    )}

                    {report !== null && loadingReport === null && (
                      <div data-testid="agent-history-report" className="space-y-1">
                        {report.view.claims.length > 0 && (
                          <ol className="space-y-0.5">
                            {report.view.claims.map((claim, index) => (
                              <li key={`${report.runId}-claim-${index}`} className="text-[0.625rem] text-fg-secondary">
                                <span className="text-fg-subtle">Claim {index + 1}:</span> {claim}
                              </li>
                            ))}
                          </ol>
                        )}
                        {report.view.answerSql.length > 0 && (
                          <pre className="overflow-x-auto rounded bg-sunken px-2 py-1 text-[0.625rem] font-mono text-fg-secondary whitespace-pre-wrap">
                            {report.view.answerSql.join("\n")}
                          </pre>
                        )}
                        {report.view.planSql.length > 0 && (
                          <pre className="overflow-x-auto rounded bg-sunken px-2 py-1 text-[0.625rem] font-mono text-fg-secondary whitespace-pre-wrap">
                            {report.view.planSql.join("\n")}
                          </pre>
                        )}
                        {report.view.closing.length > 0 && (
                          <p className="text-[0.625rem] text-fg-muted">{report.view.closing.join(" ")}</p>
                        )}
                        {report.view.claims.length === 0 &&
                          report.view.answerSql.length === 0 &&
                          report.view.planSql.length === 0 &&
                          report.view.closing.length === 0 && (
                            <p className="text-[0.625rem] text-fg-subtle">This run recorded no report.</p>
                          )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {nextCursor !== null && conversations.length > 0 && state === "ready" && (
        <button
          type="button"
          data-testid="agent-history-more"
          onClick={() => void load(nextCursor, true)}
          className="w-full rounded px-2 py-1 text-[0.625rem] text-brand-bright hover:bg-fill transition-colors"
        >
          Load more
        </button>
      )}
    </div>
  );
}

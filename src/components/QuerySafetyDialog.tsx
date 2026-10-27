"use client";

import { appFetch } from "@/lib/config/base-path";
import { ApiErrorCode } from "@/lib/api/error-codes";
import React, { useState, useEffect, useMemo, useRef } from "react";
import { ShieldAlert, ShieldCheck, TriangleAlert, LoaderCircle, Play, X, Info } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TypedConfirmField } from "@/components/typed-confirm";
import { useReturnFocus } from "@/hooks/use-return-focus";
import { QUERY_SAFETY_ANALYSIS_TIMEOUT_MS } from "@/lib/llm/query-safety";
import { cn } from "@/lib/utils";
import { vocabularySendsToModel, vocabularyTypedConfirmation } from "@/lib/db/destructive-commands";
import type { TypedConfirmationAsk } from "@/lib/db/types";
import { readsSqlText, resolveSqlGrammar } from "@/lib/sql/grammar";
import { hasLoneCarriageReturnInLineComment, hasUnterminatedSpan } from "@/lib/sql/spans";
import type { DatabaseType } from "@/lib/types";

// The gate lives in `@/lib/sql/dangerous-query` so the VS Code extension's child, which bundles no component, asks
// the same question; both names stay importable from here.
export { isDangerousQuery, writesUnderGrammar } from "@/lib/sql/dangerous-query";

interface SafetyAnalysis {
  riskLevel: "safe" | "low" | "medium" | "high" | "critical";
  summary: string;
  warnings: {
    type: string;
    severity: string;
    message: string;
    detail: string;
  }[];
  affectedRows: string;
  cascadeEffects: string;
  recommendation: string;
}

interface QuerySafetyDialogProps {
  isOpen: boolean;
  query: string;
  schemaContext: string;
  databaseType?: string;
  /**
   * The name of the connection the statement is about to run on, which a typed confirmation of the connection asks
   * for (#1089, section 5.5). Optional because this dialog is published: a caller that passes none, or an empty one,
   * gets a refusal in place of the typed field and a disabled Proceed button, never a throw.
   */
  connectionName?: string;
  onClose: () => void;
  onProceed: () => void;
  /**
   * Optional API adapter: when provided, bypasses the built-in /api/ai/query-safety fetch. `signal` aborts when the
   * dialog stops waiting (the person skipped the analysis, the wait ran out, or the dialog closed); an adapter that
   * honours it stops its own request, and an answer that arrives after it is ignored either way.
   */
  onAnalyzeSafety?: (params: { query: string; schemaContext: string; signal?: AbortSignal }) => Promise<SafetyAnalysis>;
}

function parseSafetyResponse(text: string): SafetyAnalysis | null {
  try {
    const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (match) {
      return JSON.parse(match[1].trim());
    }
    // Try parsing the entire text as JSON
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

/**
 * Said in place of the typed field when the vocabulary asks for the connection's name and the caller gave none, or
 * an empty one (#1089, section 5.5).
 */
const MISSING_CONNECTION_NAME =
  "This statement is confirmed by typing the connection's name, which this editor did not provide, so it cannot run from here.";

/**
 * Said where the vocabulary keeps the statement from the AI analysis, beside the dialog's own local sentence
 * (#1089, E10): the classification that opened this dialog is the editor's, and nothing was sent to be judged.
 */
const LOCAL_CLASSIFICATION =
  "This editor checked the statement itself: statements for this engine are not sent to an AI provider for a risk analysis.";

/**
 * The text a typed ask is compared with: the ask's own text, or the connection's name, or undefined where the ask is
 * the name and there is none to type, which the dialog answers with MISSING_CONNECTION_NAME.
 */
function typedConfirmationText(ask: TypedConfirmationAsk, connectionName: string | undefined): string | undefined {
  if (ask.type === "text") return ask.text;
  // An empty name is no name: an exact comparison would let an empty field confirm it.
  return connectionName === "" ? undefined : connectionName;
}

/**
 * Why the dialog stopped waiting for the AI analysis before it answered: the person chose to skip it, or it did not
 * finish within QUERY_SAFETY_ANALYSIS_TIMEOUT_MS. Either way Execute no longer waits on it.
 */
type AnalysisStopped = "skipped" | "timed-out";

const ANALYSIS_STOPPED_NOTICE: Record<AnalysisStopped, { title: string; detail: string }> = {
  "timed-out": {
    title: "AI analysis could not be completed",
    detail: `The AI safety analysis did not finish within ${QUERY_SAFETY_ANALYSIS_TIMEOUT_MS / 1000} seconds and was stopped. Review the statement yourself before running it.`,
  },
  skipped: {
    title: "AI analysis skipped",
    detail: "The AI analysis was stopped before it answered. Review the statement yourself before running it.",
  },
};

const RISK_CONFIG = {
  safe: {
    color: "text-hue-emerald",
    bg: "bg-hue-emerald-tint/10",
    border: "border-hue-emerald-tint/20",
    icon: ShieldCheck,
    label: "Safe",
  },
  low: {
    color: "text-hue-blue",
    bg: "bg-hue-blue-tint/10",
    border: "border-hue-blue-tint/20",
    icon: ShieldCheck,
    label: "Low Risk",
  },
  medium: {
    color: "text-hue-amber",
    bg: "bg-hue-amber-tint/10",
    border: "border-hue-amber-tint/20",
    icon: TriangleAlert,
    label: "Medium Risk",
  },
  high: {
    color: "text-hue-orange",
    bg: "bg-hue-orange-tint/10",
    border: "border-hue-orange-tint/20",
    icon: ShieldAlert,
    label: "High Risk",
  },
  critical: {
    color: "text-hue-red",
    bg: "bg-hue-red-tint/10",
    border: "border-hue-red-tint/20",
    icon: ShieldAlert,
    label: "Critical Risk",
  },
};

export function QuerySafetyDialog({
  isOpen,
  query,
  schemaContext,
  databaseType,
  connectionName,
  onClose,
  onProceed,
  onAnalyzeSafety,
}: QuerySafetyDialogProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<SafetyAnalysis | null>(null);
  const [rawResponse, setRawResponse] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState<AnalysisStopped | null>(null);
  // The analysis in flight, so Skip, the wait running out and closing the dialog can all stop it.
  const analysisRun = useRef<AbortController | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const skipButton = useRef<HTMLButtonElement>(null);
  // Whether the typed confirmation's field matches (#1089, section 5.5). The field reports it when it mounts and on
  // every change, so each opening starts from false: the field's own state lives inside the dialog content.
  const [typedMatches, setTypedMatches] = useState(false);
  // Radix hands focus back only to an AlertDialogTrigger, and the editor opens this dialog without
  // one, so the dialog keeps what had focus when it opened and puts focus back there on close.
  const returnFocus = useReturnFocus();

  /**
   * Whether the client-side reading that opened this dialog could not resolve part
   * of the statement (#297).
   *
   * Recomputed here rather than passed in: the gate is a pure function of the text
   * and the dialect, both of which this component already has, and a new required
   * prop would be a breaking change for the published package. `databaseType`
   * arrives as a plain string from the host application, and a value that is not one
   * of the types this project knows resolves to the compatibility default - the
   * same answer a dialect-less call gets everywhere else in `src/lib/sql`.
   *
   * Memoised because the analysis stream re-renders this component per chunk while
   * the query text does not change, and the scan is linear in that text.
   */
  const unreadableRun = useMemo(() => {
    const type = databaseType as DatabaseType | undefined;
    // Asked first: a SQL span reader's verdict about text that is not SQL is not
    // evidence of anything, and saying "could not be read" about a Mongo document
    // that reads fine is the false alarm this notice exists to avoid.
    const grammar = resolveSqlGrammar(type);
    return (
      readsSqlText(type) && (hasUnterminatedSpan(query, grammar) || hasLoneCarriageReturnInLineComment(query, grammar))
    );
  }, [query, databaseType]);

  // What this engine's vocabulary asks the person to type before the statement runs, read from the table the gate
  // that opened this dialog read, so the two cannot disagree about a statement (#1089, section 5.5).
  const typedAsk = useMemo(
    () => vocabularyTypedConfirmation(databaseType as DatabaseType | undefined, query),
    [query, databaseType],
  );
  const typedExpected = typedAsk === undefined ? undefined : typedConfirmationText(typedAsk, connectionName);
  // Proceed waits for the analysis and for an exact match, and a refusal in place of the field is never a match,
  // whatever was typed before it replaced the field. The wait for the analysis is bounded: Skip ends it at once and
  // QUERY_SAFETY_ANALYSIS_TIMEOUT_MS ends it anyway, so a slow or hung model can no longer hold every write back.
  const proceedBlocked = isAnalyzing || (typedAsk !== undefined && (typedExpected === undefined || !typedMatches));
  // False keeps the statement on this device (#1089, E10).
  const sendsToModel = vocabularySendsToModel(databaseType as DatabaseType | undefined);

  // Declared above the effect that calls it: react-compiler
  // (react-hooks/immutability) rejects reading a `const` binding from a position
  // earlier than its declaration. Pure code motion - no hook order changes.
  const analyzeQuery = async () => {
    const run = new AbortController();
    analysisRun.current = run;
    const { signal } = run;
    const timer = setTimeout(() => stopWaiting(run, "timed-out"), QUERY_SAFETY_ANALYSIS_TIMEOUT_MS);
    setIsAnalyzing(true);
    setError(null);
    setStopped(null);

    try {
      let filteredSchema = "";
      if (schemaContext) {
        try {
          const tables = JSON.parse(schemaContext);
          filteredSchema = tables
            .slice(0, 30)
            .map((t: { name: string; rowCount?: number; columns?: { name: string; type: string }[] }) => {
              const cols =
                t.columns
                  ?.slice(0, 8)
                  .map((c) => `${c.name} (${c.type})`)
                  .join(", ") || "";
              return `${t.name} (${t.rowCount || 0} rows): ${cols}`;
            })
            .join("\n");
        } catch {
          filteredSchema = schemaContext.substring(0, 2000);
        }
      }

      if (onAnalyzeSafety) {
        // Platform adapter: use callback instead of fetch
        const result = await onAnalyzeSafety({ query, schemaContext: filteredSchema, signal });
        if (signal.aborted) return;
        setAnalysis(result);
      } else {
        // Default: existing fetch behavior
        const response = await appFetch("/api/ai/query-safety", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, schemaContext: filteredSchema, databaseType }),
          signal,
        });

        if (!response.ok) {
          const errData = await response.json();
          // AI is optional; an unconfigured provider still leaves the local confirmation in place.
          if (errData.code === ApiErrorCode.LLM_UNCONFIGURED) return;
          throw new Error(errData.error || "Analysis failed");
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No reader");

        let fullResponse = "";
        while (true) {
          const { done, value } = await reader.read();
          // A run stopped while a chunk was on its way: what it streamed is no longer shown.
          if (signal.aborted) return;
          if (done) break;
          fullResponse += new TextDecoder().decode(value);
          setRawResponse(fullResponse);
        }

        const parsed = parseSafetyResponse(fullResponse);
        if (parsed && !signal.aborted) {
          setAnalysis(parsed);
        }
      }
    } catch (err) {
      // An aborted run was stopped on purpose, and the reason is already on screen.
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      clearTimeout(timer);
      // A run that was stopped already said so, and a newer run may be the one in flight now.
      if (analysisRun.current === run) {
        analysisRun.current = null;
        setIsAnalyzing(false);
      }
    }
  };

  /**
   * Stops waiting for `run`, the analysis in flight: aborts its request, drops what it streamed so far (half a
   * verdict is not one) and says why Execute no longer waits for it. A run that already ended is left alone.
   */
  function stopWaiting(run: AbortController, why: AnalysisStopped) {
    if (analysisRun.current !== run) return;
    analysisRun.current = null;
    run.abort();
    // The Skip button leaves with the wait it ended. Focus that was on it goes to Cancel, where the dialog put it
    // on opening, rather than to the Execute button this just enabled.
    if (document.activeElement === skipButton.current) cancelButton.current?.focus();
    setIsAnalyzing(false);
    setRawResponse("");
    setStopped(why);
  }

  const skipAnalysis = () => {
    if (analysisRun.current) stopWaiting(analysisRun.current, "skipped");
    // A click does not always focus the button it lands on (Safari, a pointer that moved), so Cancel takes focus
    // here whatever had it.
    cancelButton.current?.focus();
  };

  useEffect(() => {
    // A vocabulary that keeps its statements on this device posts nothing and calls no adapter (#1089, E10).
    if (isOpen && query && sendsToModel) {
      analyzeQuery();
    }
    return () => {
      // Closing the dialog, or a new statement, ends the wait for this one: its request stops too.
      analysisRun.current?.abort();
      analysisRun.current = null;
      // The aborted run's own `finally` no longer owns the spinner, so it is cleared here: the dialog stays
      // mounted between openings, and the next one may post nothing at all.
      setIsAnalyzing(false);
      setAnalysis(null);
      setRawResponse("");
      setError(null);
      setStopped(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, query, sendsToModel]);

  const risk = analysis ? RISK_CONFIG[analysis.riskLevel] || RISK_CONFIG.medium : null;
  const RiskIcon = risk?.icon || ShieldAlert;

  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent
        className="p-0 gap-0 bg-overlay border border-hairline-strong rounded-xl shadow-2xl overflow-hidden"
        {...returnFocus}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-hairline">
          <div className="flex items-center gap-2">
            <ShieldAlert strokeWidth={1.5} className="w-3.5 h-3.5 text-warning" />
            <AlertDialogTitle className="text-xs font-medium text-fg">Query Safety Check</AlertDialogTitle>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="p-1 rounded hover:bg-fill text-fg-muted"
          >
            <X strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-5 py-3 bg-surface border-b border-hairline">
          <AlertDialogDescription asChild>
            <pre className="text-xs font-mono text-fg-tertiary whitespace-pre-wrap max-h-24 overflow-auto">
              {query.length > 300 ? query.substring(0, 300) + "..." : query}
            </pre>
          </AlertDialogDescription>
        </div>

        <div className="px-5 py-4 max-h-80 overflow-auto">
          {/*
            Said before the analysis and kept beside it: the reason this dialog
            opened is the client-side reading, and a risk verdict produced from text
            whose reading stopped early may not describe what the statement does.
          */}
          {unreadableRun && (
            <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-warning-tint/10 border border-warning-tint/20">
              <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 mt-0.5 shrink-0 text-warning" />
              <div>
                <span className="text-xs font-medium text-warning">Part of this statement could not be read</span>
                <p className="text-xs text-fg-tertiary mt-0.5">
                  A quoted, commented or bracketed run in it never closes (or its closing quote sits behind a backslash,
                  or a comment holds a lone carriage return, which dialects read differently), so nothing written after
                  that point could be checked. It may hide a write, which is why you are being asked.
                </p>
              </div>
            </div>
          )}

          {!sendsToModel && <p className="mb-3 text-xs text-fg-tertiary">{LOCAL_CLASSIFICATION}</p>}

          {isAnalyzing && (
            <div className="flex items-center justify-center gap-2 py-8 text-fg-muted">
              <LoaderCircle strokeWidth={1.5} className="w-5 h-5 animate-spin" />
              <span className="text-xs">Analyzing query safety...</span>
            </div>
          )}

          {/*
            A live region (an output is role="status") mounted for as long as the dialog is, so a screen reader
            hears why the Execute button just became usable: a region inserted together with its text is often
            not announced at all.
          */}
          <output className="block">
            {stopped && (
              <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-warning-tint/10 border border-warning-tint/20">
                <Info strokeWidth={1.5} className="w-3.5 h-3.5 mt-0.5 shrink-0 text-warning" />
                <div>
                  <span className="text-xs font-medium text-warning">{ANALYSIS_STOPPED_NOTICE[stopped].title}</span>
                  <p className="text-xs text-fg-tertiary mt-0.5">{ANALYSIS_STOPPED_NOTICE[stopped].detail}</p>
                </div>
              </div>
            )}
          </output>

          {error && (
            <div className="bg-danger-tint/10 border border-danger-tint/20 rounded-lg p-3 text-xs text-danger">
              {error}
            </div>
          )}

          {analysis && risk && (
            <div className="space-y-3">
              <div className={cn("flex items-center gap-2 px-3 py-2 rounded-lg", risk.bg, "border", risk.border)}>
                <RiskIcon className={cn("w-5 h-5", risk.color)} />
                <div>
                  <span className={cn("text-xs font-medium", risk.color)}>{risk.label}</span>
                  <p className="text-xs text-fg-tertiary mt-0.5">{analysis.summary}</p>
                </div>
              </div>

              {analysis.warnings?.length > 0 && (
                <div className="space-y-2">
                  {analysis.warnings.map((w, i) => (
                    <div
                      key={i}
                      className={cn(
                        "px-3 py-2 rounded-lg border text-xs",
                        w.severity === "critical"
                          ? "bg-danger-tint/5 border-danger-tint/20"
                          : w.severity === "warning"
                            ? "bg-warning-tint/5 border-warning-tint/20"
                            : "bg-brand-tint/5 border-brand-tint/20",
                      )}
                    >
                      <p className="font-medium text-fg-secondary">{w.message}</p>
                      <p className="text-fg-muted mt-0.5">{w.detail}</p>
                    </div>
                  ))}
                </div>
              )}

              {analysis.affectedRows && analysis.affectedRows !== "none" && (
                <div className="text-xs">
                  <span className="text-fg-muted">Affected rows: </span>
                  <span className="text-fg-secondary font-mono">{analysis.affectedRows}</span>
                </div>
              )}

              {analysis.cascadeEffects && analysis.cascadeEffects !== "none" && (
                <div className="text-xs">
                  <span className="text-fg-muted">Cascade effects: </span>
                  <span className="text-fg-secondary">{analysis.cascadeEffects}</span>
                </div>
              )}

              {analysis.recommendation && (
                <div className="bg-surface rounded-lg p-3 border border-hairline">
                  <p className="text-xs font-medium text-fg-muted mb-1">Recommendation</p>
                  <p className="text-xs text-fg-secondary">{analysis.recommendation}</p>
                </div>
              )}
            </div>
          )}

          {!isAnalyzing && !analysis && rawResponse && !error && (
            <div className="text-xs text-fg-tertiary whitespace-pre-wrap">{rawResponse}</div>
          )}
          {!isAnalyzing && !analysis && !rawResponse && !error && (
            <p className="text-xs text-fg-tertiary">
              This statement may change data, database objects, or permissions. Review the query before proceeding.
            </p>
          )}
        </div>

        {/*
          The typed confirmation the vocabulary asks for (#1089, section 5.5), right above the Proceed button it holds
          disabled until the typed value matches exactly. The field keeps what was typed in its own state, inside this
          content, which unmounts on close, so every opening starts empty; it is keyed by the text it compares with,
          so a new ask starts empty too.
        */}
        {typedAsk !== undefined && (
          <div className="px-5 py-3 border-t border-hairline space-y-3">
            {typedAsk.type === "connection-name" && (
              <div>
                <p className="text-xs text-fg-muted">Targets</p>
                <ul className="mt-1 space-y-0.5">
                  {typedAsk.targets.map((target, index) => (
                    // oxlint-disable-next-line react/no-array-index-key -- the ask's own fixed list, never reordered, and a target may repeat.
                    <li key={index} className="text-xs font-mono text-fg-secondary whitespace-pre-wrap break-all">
                      {target}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {typedExpected === undefined ? (
              <p className="text-xs text-danger">{MISSING_CONNECTION_NAME}</p>
            ) : (
              <TypedConfirmField
                key={typedExpected}
                expected={typedExpected}
                match="exact"
                onMatchChange={setTypedMatches}
              />
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-hairline bg-surface">
          {isAnalyzing && (
            <button
              ref={skipButton}
              type="button"
              onClick={skipAnalysis}
              className="mr-auto px-3 py-2 rounded-lg text-xs font-medium text-fg-tertiary hover:bg-fill hover:text-fg-secondary transition-colors"
            >
              Skip analysis
            </button>
          )}
          <AlertDialogCancel
            ref={cancelButton}
            className="h-auto border-0 bg-fill px-4 py-2 text-xs font-medium text-fg-tertiary shadow-none transition-colors hover:bg-fill-strong dark:bg-fill dark:hover:bg-fill-strong hover:text-fg-tertiary rounded-lg"
          >
            <span>Cancel</span>
          </AlertDialogCancel>
          <button
            onClick={onProceed}
            disabled={proceedBlocked}
            className={cn(
              "px-4 py-2 rounded-lg text-white text-xs font-medium transition-colors flex items-center gap-1.5",
              analysis?.riskLevel === "critical" || analysis?.riskLevel === "high"
                ? "bg-danger-solid hover:bg-danger-solid-hover"
                : "bg-brand-solid hover:bg-brand-solid-hover",
              proceedBlocked && "opacity-50 cursor-not-allowed",
            )}
          >
            <Play strokeWidth={1.5} className="w-3 h-3 fill-current" />
            {analysis?.riskLevel === "critical"
              ? "Execute Anyway"
              : analysis?.riskLevel === "high"
                ? "Proceed with Caution"
                : "Execute Query"}
          </button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

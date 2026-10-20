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
import {
  isDestructiveNonSqlQuery,
  vocabularyDecidesAlone,
  vocabularySendsToModel,
  vocabularyTypedConfirmation,
} from "@/lib/db/destructive-commands";
import type { TypedConfirmationAsk } from "@/lib/db/types";
import {
  conditionalFormInCode,
  conditionalFormOperates,
  hasConfirmCodeForm,
  sequenceInCode,
  wordsFollow,
} from "@/lib/sql/confirm-forms";
import { readsSqlText, resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import { hasUnterminatedSpan, readSqlSpan } from "@/lib/sql/spans";
import { splitStatements } from "@/lib/sql/statement-splitter";
import { findCodeWord, readSqlWord } from "@/lib/sql/words";
import type { DatabaseType } from "@/lib/types";

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
    return readsSqlText(type) && hasUnterminatedSpan(query, resolveSqlGrammar(type));
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
                  which dialects read differently), so nothing written after that point could be checked. It may hide a
                  write, which is why you are being asked.
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

/**
 * Statements whose own keyword is enough to want a confirmation: they change or delete rows,
 * remove objects or change who may reach them.
 *
 * The same vocabulary the six anchored patterns here used to spell out, now tested
 * against one reading of the statement instead of re-derived per keyword. `MERGE` joined it
 * later: it updates, deletes or inserts rows on every engine that has it, whichever `WHEN`
 * branches it carries, so it is shared vocabulary rather than a form each grammar row declares.
 */
const DANGEROUS_KEYWORDS = new Set(["DELETE", "DROP", "TRUNCATE", "ALTER", "GRANT", "REVOKE", "UPDATE", "MERGE"]);

/**
 * The words that open a procedural block or a branch of one rather than a statement of
 * their own, in PL/SQL, T-SQL and SQLite trigger bodies. A statement read with one of
 * these as its keyword is the block, and what it does is written after it.
 */
const CONTROL_FLOW_KEYWORDS = new Set([
  "BEGIN",
  "DECLARE",
  "IF",
  "ELSE",
  "ELSIF",
  "THEN",
  "WHILE",
  "LOOP",
  "FOR",
  "EXCEPTION",
  "WHEN",
]);

/**
 * The data-modifying words a CTE body can carry besides `UPDATE`.
 *
 * The same set `DATA_MODIFYING` names in `src/lib/explain/select-prefix.ts`
 * (`INSERT`, `UPDATE`, `DELETE`, `MERGE`), minus `UPDATE`: that one stays the
 * `UPDATE … SET` pair below, because a bare `UPDATE` is a cursor lock as often
 * as it is a write. These three need no following word.
 */
const CTE_DATA_MODIFYING = ["INSERT", "DELETE", "MERGE"] as const;

/**
 * The words the legacy `EXPLAIN [ANALYZE | ANALYSE] [VERBOSE]` spelling takes, in either order.
 * `ANALYSE` is PostgreSQL's British spelling of the option that executes.
 */
const EXPLAIN_KEYWORD_OPTIONS = new Set(["ANALYZE", "ANALYSE", "VERBOSE"]);

/** The option names that execute the explained statement when they are enabled. */
const ANALYZE_OPTIONS = new Set(["ANALYZE", "ANALYSE"]);

/**
 * Parenthesised values that turn `ANALYZE` off. No value, and any other value (`true`, `on`, `1`), leaves it on:
 * PostgreSQL's `defGetBoolean` reads an absent argument as true.
 */
const ANALYZE_OFF = new Set(["FALSE", "OFF", "0"]);

/** Whether a `confirmExemptForms` form led by `keyword` starts at the keyword that ends at `end`. */
function exemptFormAt(text: string, keyword: string, end: number, grammar: SqlGrammar): boolean {
  return (grammar.confirmExemptForms ?? []).some(
    (form) => form[0].toUpperCase() === keyword && wordsFollow(text, end, form.slice(1), grammar),
  );
}

/**
 * Whether a procedural block's code writes, as far as its words can say.
 *
 * Any dangerous keyword in the block's code counts, except two shapes that only look like
 * one: a T-SQL variable (`@alter`, `@delete`) and a cursor's `FOR UPDATE` lock clause.
 * Dynamic SQL counts whatever its text says, because the text is a literal the reader
 * cannot see into: `EXECUTE IMMEDIATE 'DROP TABLE t PURGE'` drops a table, and Oracle
 * used to refuse the block it sits in when the runner cut it at its first `;` (#1312).
 * A dialect's own `confirmForms` count the same way, anywhere in the block's code.
 */
function blockWrites(text: string, grammar: SqlGrammar): boolean {
  if ((grammar.confirmForms ?? []).some((form) => sequenceInCode(text, form, grammar))) return true;
  if ((grammar.confirmFormsWhen ?? []).some((form) => conditionalFormInCode(text, form, grammar))) return true;

  const execute = findCodeWord(text, "EXECUTE", 0, grammar);
  if (execute !== null && findCodeWord(text, "IMMEDIATE", execute.end, grammar) !== null) return true;
  if (findCodeWord(text, "DBMS_SQL", 0, grammar) !== null) return true;

  for (const word of DANGEROUS_KEYWORDS) {
    let found = findCodeWord(text, word, 0, grammar);
    while (found !== null) {
      const before = text.slice(0, found.start);
      const variable = before.endsWith("@");
      const lockClause = word === "UPDATE" && /\bFOR\s+$/i.test(before);
      if (!variable && !lockClause && !exemptFormAt(text, word, found.end, grammar)) return true;
      found = findCodeWord(text, word, found.end, grammar);
    }
  }
  return false;
}

/**
 * The first index at or after `from` past white space and comments, the text Spark's lexer hides from its parser.
 * White space is every character JavaScript's `\s` matches, which holds every one Spark's lexer counts (U+00A0 and
 * U+3000 among them), and every character at or below U+0020, which Spark's `String.trim` of an unquoted key removes.
 */
function pastHiddenText(text: string, from: number, grammar: SqlGrammar): number {
  let i = from;
  while (i < text.length) {
    const span = readSqlSpan(text, i, grammar);
    if (
      span !== null &&
      (span.kind === "whitespace" || span.kind === "line-comment" || span.kind === "block-comment")
    ) {
      i = span.end;
    } else if (text[i] <= " " || /\s/.test(text[i])) {
      i++;
    } else {
      break;
    }
  }
  return i;
}

/**
 * The session key a SET or RESET names, read past white space and comments (`pastHiddenText`), and the index after
 * it; the key is `""` where none follows. A key in backticks, or in double quotes where Spark reads double quotes as
 * identifier quotes (`spark.sql.ansi.enabled` and `spark.sql.ansi.doubleQuotedIdentifiers` both on), is one token, as
 * Spark's `configKey` rule reads it: the inner text of the closed run, a doubled quote collapsed to one, and nothing
 * after the closing quote. Studio reads double quotes that way under every setting, so such a key asks whether or not
 * the session reads it as a key. Any other key is the code text up to `=`, white space, `;` or the end: Spark reads it
 * as the raw text up to `=`, trimmed by `String.trim`, which removes every character at or below U+0020, so each of
 * those ends the key here.
 */
function configKeyAfter(text: string, from: number, grammar: SqlGrammar): { key: string; end: number } {
  const start = pastHiddenText(text, from, grammar);
  const quote = text[start];
  const span = readSqlSpan(text, start, grammar);
  if (span?.kind === "quoted-identifier" && span.terminated && (quote === "`" || quote === '"')) {
    return { key: text.slice(start + 1, span.end - 1).replaceAll(quote + quote, quote), end: span.end };
  }
  let end = start;
  while (end < text.length && text[end] > " " && !/[=\s;]/.test(text[end])) end++;
  return { key: text.slice(start, end), end };
}

/**
 * Whether a SET or RESET names a key of `grammar.confirmConfigKeys`, or is a RESET of every key. A SET asks only when
 * `=` follows the key, past white space and comments: without it, the SET only shows the key's value.
 */
function configKeyAsks(
  text: string,
  reading: NonNullable<ReturnType<typeof readOperativeKeyword>>,
  grammar: SqlGrammar,
): boolean {
  const keys = grammar.confirmConfigKeys;
  if (keys === undefined || (reading.keyword !== "SET" && reading.keyword !== "RESET")) return false;
  const { key: named, end } = configKeyAfter(text, reading.end, grammar);
  if (named === "") return reading.keyword === "RESET";
  if (reading.keyword === "SET" && text[pastHiddenText(text, end, grammar)] !== "=") return false;
  const key = named.toLowerCase();
  return keys.some((entry) => {
    const wanted = entry.toLowerCase();
    return wanted.endsWith(".") ? key.startsWith(wanted) : key === wanted;
  });
}

/** One token of a parenthesised EXPLAIN option list. */
interface ExplainOptionToken {
  /** A word is upper-cased; a string is its contents; a number is its digits. */
  text: string;
  end: number;
  kind: "word" | "number" | "comma" | "string" | "other";
}

/**
 * The next option-list token at or after `from` and before `limit`, or null at the closing paren.
 *
 * Strings and comments are spans, so a word written inside one is not an option: `EXPLAIN ('ANALYZE')` does not
 * execute, and `ANALYZE 'false'` is the off value rather than the word `false` somewhere later.
 */
function readExplainOptionToken(
  text: string,
  from: number,
  limit: number,
  grammar: SqlGrammar,
): ExplainOptionToken | null {
  const i = pastHiddenText(text, from, grammar);
  if (i >= limit) return null;
  if (text[i] === ",") return { text: ",", end: i + 1, kind: "comma" };
  const word = readSqlWord(text, i);
  if (word !== null) return { text: word.text, end: word.end, kind: "word" };
  if (text[i] >= "0" && text[i] <= "9") {
    let end = i;
    while (end < limit && text[end] >= "0" && text[end] <= "9") end++;
    return { text: text.slice(i, end), end, kind: "number" };
  }
  const span = readSqlSpan(text, i, grammar);
  if (span?.kind === "string") return { text: text.slice(i + 1, span.end - 1), end: span.end, kind: "string" };
  const end = span === null ? i + 1 : span.end;
  return { text: text.slice(i, end), end, kind: "other" };
}

/**
 * The index past the `)` that closes the paren at `open`, or `-1` when it never closes.
 *
 * Literals and comments are skipped whole, so a `)` inside `EXPLAIN (ANALYZE ')')` cannot end the option list.
 */
function endOfParenthesised(text: string, open: number, grammar: SqlGrammar): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const span = readSqlSpan(text, i, grammar);
    if (span !== null) {
      i = span.end;
      continue;
    }
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * Whether a parenthesised option list enables ANALYZE.
 *
 * `false`, `off` and `0` turn that option off, and an option with no value is on. Any enabled `ANALYZE` executes,
 * even when another is off, which asks rather than missing a `DELETE`.
 */
function explainOptionsExecute(text: string, open: number, close: number, grammar: SqlGrammar): boolean {
  const limit = close - 1;
  let execute = false;
  let i = open + 1;
  while (i < limit) {
    const name = readExplainOptionToken(text, i, limit, grammar);
    if (name === null) break;
    i = name.end;
    if (name.kind !== "word") continue;
    const value = readExplainOptionToken(text, i, limit, grammar);
    if (value !== null && value.kind !== "comma") i = value.end;
    if (!ANALYZE_OPTIONS.has(name.text)) continue;
    const setting = value === null || value.kind === "comma" ? null : value.text.toUpperCase();
    if (setting === null || !ANALYZE_OFF.has(setting)) execute = true;
  }
  return execute;
}

/**
 * The statement after `EXPLAIN`'s options when ANALYZE will execute it, or null when ANALYZE is absent or off.
 *
 * The legacy spelling is a run of `ANALYZE`/`ANALYSE`/`VERBOSE`. The parenthesised spelling is `EXPLAIN ( … )`.
 * Anything else — a plain `EXPLAIN`, `EXPLAIN VERBOSE`, `ANALYZE false` — only plans, and null is what tells the
 * caller not to ask.
 */
function stripExplainOptions(text: string, from: number, grammar: SqlGrammar): string | null {
  const start = pastHiddenText(text, from, grammar);
  if (text[start] === "(") {
    const close = endOfParenthesised(text, start, grammar);
    if (close < 0) return null;
    return explainOptionsExecute(text, start, close, grammar) ? text.slice(close) : null;
  }

  let at = start;
  let analyze = false;
  for (;;) {
    const wordAt = pastHiddenText(text, at, grammar);
    const word = readSqlWord(text, wordAt);
    if (word === null || !EXPLAIN_KEYWORD_OPTIONS.has(word.text)) break;
    if (ANALYZE_OPTIONS.has(word.text)) analyze = true;
    at = word.end;
  }
  return analyze ? text.slice(at) : null;
}

/**
 * Whether ONE statement's own code asks for a confirmation, read under `grammar`.
 *
 * Its own function because the caller below asks the question twice over different
 * text: the whole editor buffer, and then each fragment the multi-statement route
 * will run. Re-deriving the two keyword tests per call site is how the gate and the
 * runner drifted apart in the first place.
 *
 * Exported for the grammar-level tests in `tests/components/QuerySafetyDialog.test.tsx`, which read a row's forms
 * before any shipped row declares them; `isDangerousQuery` is the gate.
 */
export function writesUnderGrammar(text: string, grammar: SqlGrammar): boolean {
  const reading = readOperativeKeyword(text, grammar);
  const keyword = reading?.keyword;

  // PostgreSQL's EXPLAIN executes the explained statement only when ANALYZE is on
  // (`EXPLAIN ANALYZE DELETE`, `EXPLAIN (ANALYZE, BUFFERS) UPDATE`). The operative
  // keyword is EXPLAIN, which is not itself dangerous, so without this the DELETE
  // runs unconfirmed (#1863). A plain EXPLAIN, or ANALYZE set to false, off or 0,
  // only plans: returning here, instead of falling through, is what keeps an
  // `UPDATE … SET` inside a plan from asking. The remaining text is read as its own
  // statement, so a data-modifying CTE under the EXPLAIN asks too. CockroachDB
  // shares this grammar.
  if (reading !== null && reading.keyword === "EXPLAIN" && grammar.explainExecutesWithAnalyze === true) {
    const inner = stripExplainOptions(text, reading.end, grammar);
    return inner !== null && writesUnderGrammar(inner, grammar);
  }

  if (
    reading !== null &&
    DANGEROUS_KEYWORDS.has(reading.keyword) &&
    !exemptFormAt(text, reading.keyword, reading.end, grammar)
  ) {
    return true;
  }

  // The dialect's own forms: a keyword sequence that operates the statement, and a form found anywhere in its code.
  // Both are absent on every row that does not declare them, so no other dialect's verdict moves.
  if (
    reading !== null &&
    (grammar.confirmForms ?? []).some(
      (form) => form[0].toUpperCase() === reading.keyword && wordsFollow(text, reading.end, form.slice(1), grammar),
    )
  ) {
    return true;
  }
  // A session key the dialect names: SET or RESET of it changes how every later statement of the session reads.
  if (reading !== null && configKeyAsks(text, reading, grammar)) return true;
  if (
    reading !== null &&
    (grammar.confirmFormsWhen ?? []).some((form) =>
      conditionalFormOperates(text, reading.keyword, reading.end, form, grammar),
    )
  ) {
    return true;
  }
  if (hasConfirmCodeForm(text, grammar)) return true;

  // A statement led by a control-flow word, or by a `<<label>>` no keyword reading
  // passes, does what the words AFTER it say: `BEGIN DELETE FROM emp; END;` is a PL/SQL
  // block that deletes, and `IF @@ROWCOUNT > 0 DELETE FROM t` a T-SQL statement that
  // does. Its own keyword is `BEGIN` or `IF`, so for these the dangerous words are looked
  // for anywhere in the statement's CODE (#1312). Before procedural bodies were a grammar
  // fact the runner cut such a block at its first `;` and Oracle refused the fragment, so
  // nothing ran unasked; now the whole block runs, and the gate has to read into it.
  const labelled = keyword === undefined && text.trimStart().startsWith("<<");
  if ((labelled || (keyword !== undefined && CONTROL_FLOW_KEYWORDS.has(keyword))) && blockWrites(text, grammar)) {
    return true;
  }

  // A write the statement's own keyword does not report. PostgreSQL's data-modifying
  // CTE is OPERATED by its SELECT (`WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`),
  // so the keyword test above answers for the SELECT and the write sits in the list.
  // The words that can ride there are `DATA_MODIFYING` in `src/lib/explain/select-prefix.ts`:
  // INSERT, UPDATE, DELETE and MERGE. UPDATE is the unanchored `UPDATE … SET` pair, which
  // already asks for that form and for a later statement in a script. DELETE, MERGE and
  // INSERT count only when the statement leads with WITH, its list can be typed, and the
  // word sits in that list — before the keyword that operates the statement. A plain
  // SELECT whose code names one of them does not ask. An unclosed list
  // (`WITH t AS (DELETE FROM x`) stays silent: the shape cannot be crossed and no dialect
  // accepts the text. A `#` the dialect-less reader cannot place stays silent too, which
  // is the pinned reading of `WITH t AS ( #- … ) SELECT … ) DELETE`; naming MySQL makes
  // the `DELETE` the operative keyword instead. Both probes read CODE (`findCodeWord`),
  // so a quoted or commented word does not ask. CockroachDB connections are the postgres
  // type-id and share this grammar, so the same statements ask there too (#1862).
  if (readLeadingKeyword(text, grammar)?.keyword === "WITH" && reading !== null) {
    for (const word of CTE_DATA_MODIFYING) {
      const found = findCodeWord(text, word, 0, grammar);
      if (found !== null && found.start < reading.start) return true;
    }
  }
  const update = findCodeWord(text, "UPDATE", 0, grammar);
  return update !== null && findCodeWord(text, "SET", update.end, grammar) !== null;
}

/**
 * Detect if a query is potentially dangerous and should trigger safety analysis.
 *
 * This gates the confirmation dialog on BOTH execution paths - `use-query-execution`
 * standalone and the embedded `use-query-adapter` - so it is the last check before a
 * destructive statement runs.
 *
 * It used to re-derive the leading-keyword test with its own anchored patterns
 * (`/^\s*DROP\b/i`, …), which tolerate whitespace but not a comment, so
 * `-- cleanup\nDROP TABLE users` executed with no confirmation at all (#294) - the
 * same blindness this project has now removed from the query limiter (#275) and the
 * multi-statement route (#281). Reading the shared primitive instead means the
 * dialog and the limiter agree about where a statement starts, and a `WITH` whose CTE
 * list only precedes a write (`WITH x AS (…) DELETE FROM …`) is now recognised too.
 *
 * Text the reading cannot resolve ASKS (#297). A run that never closes hides
 * whatever is written inside it - `SELECT '\';` followed by a write is the case,
 * because the two dialect readings of `'\'` end the string in different places and
 * `spans.ts` declines to guess - so reading the code words finds nothing after it
 * and every keyword test above answers false. Every other reader in `src/lib/sql/`
 * errs toward not ACTING on such text, which is the safe direction for them (their
 * mistake is a row bound appended to a write). Here the costs are reversed: a false
 * prompt costs one click, silence costs an unconfirmed destructive statement. So
 * this predicate treats an unresolvable run as a reason to ask, and the dialog says
 * that is why it is asking rather than describing a risk it could not assess.
 *
 * The accepted cost, pinned by tests rather than left to be discovered: `spans.ts`
 * reports an undeterminable literal for any closing quote behind an ODD backslash
 * run, so a legitimate PostgreSQL literal ending in a backslash prompts every time.
 * A statement whose runs all resolve does NOT prompt merely for carrying a
 * backslash. Naming the dialect narrows this further where a dialect resolves the
 * text (#292, #295): Oracle's `q'{it's}'` and ClickHouse's `[[1,2],[3,4]]` are
 * closed runs under their own grammars and unresolvable under a reader without them.
 *
 * For MongoDB and Redis, whose text is not SQL, there is nothing here to read, and
 * this predicate answered false for them outright - so a Redis `FLUSHALL` or `DEL`
 * and a MongoDB `deleteMany` ran with no confirmation at all, on both execution
 * paths, while the same intent on every SQL engine asked (S8). Their vocabulary now
 * comes from `@/lib/db/destructive-commands`, one table per type read by one
 * function, and it names only what each provider can actually dispatch. PromQL's and
 * Kafka's rows in the same table name nothing and are the whole answer: neither has a
 * write path (#1085 and #1088, section 2), and read as SQL a metric named `update` or
 * `delete` was a write.
 *
 * `databaseType` is the connection the statement is about to run on, and both
 * call sites hold one (#292). It decides the characters the engines read
 * differently: a write written after a `#` is commented out in MySQL and the
 * statement's own code in PostgreSQL, and a `#` comment inside a CTE list used to
 * hide the `)` that closes it - so a `DELETE` after the list ran with no
 * confirmation at all. Omitting it keeps the dialect-less reading.
 */
export function isDangerousQuery(query: string, databaseType?: DatabaseType): boolean {
  const grammar = resolveSqlGrammar(databaseType);

  // Asked FIRST because it is the only question here whose answer does not depend
  // on reading the statement: where a run never closes, every keyword test below
  // is reading text that stops early, so their `false` is "not found" rather than
  // "not there".
  //
  // Only where the text IS SQL, though. Both execution paths ask about whatever is
  // in the editor, so this predicate is handed MongoDB documents, Redis commands, PromQL
  // expressions, Kafka read requests and etcdctl commands as well, and an escaped quote that a SQL
  // span reader cannot resolve closes perfectly in the grammar those are written in. For MongoDB and
  // Redis the keyword tests below still run: narrowing this rule is not switching the
  // gate off.
  if (readsSqlText(databaseType) && hasUnterminatedSpan(query, grammar)) return true;

  // A type whose own vocabulary is the whole answer is not read as SQL at all, and
  // PromQL, Kafka and etcd are those types. A PromQL expression can start with a metric name the
  // server's data chooses, `update`, `delete` and `drop` are legal names, and the keyword
  // test below read the tree's own selector for such a metric as a write, about text that
  // only ever reaches a query endpoint that cannot write (#1085, section 2); a Kafka read
  // request names a topic, which can carry those names too, and can only read it (#1088,
  // section 2); an etcd command names keys, which can be spelled like any SQL keyword, and the
  // etcd provider's guard.ts reads it with the parser the provider runs (#1089, section 5.5).
  // Which types decide alone is a fact of the same table, not a type test here.
  if (vocabularyDecidesAlone(databaseType)) return isDestructiveNonSqlQuery(query, databaseType);

  if (writesUnderGrammar(query, grammar)) return true;

  /*
    The editor text is not always what runs. A buffer holding more than one
    statement takes `/api/db/multi-query`, which SPLITS it and runs the fragments
    one by one, and this predicate read only the whole text - so a write in any
    fragment but the first was invisible to it: the operative keyword of
    `SELECT 1; DROP TABLE users` is SELECT.

    Measured on MySQL, where the entry's shape is not even hypothetical:
    `/* a /* b *\/ ; DROP TABLE s1.users; -- *\/ SELECT 1` really does drop the
    table there (MySQL reads block comments flat), and the whole-text reading found
    no operative keyword at all because the first code character is the `;`.

    So the gate asks about exactly what the runner will run: the same splitter,
    under the same grammar. Only for SQL text - the multi-statement route is a SQL
    route and a `;` in a Mongo document or a Redis command separates nothing, so
    splitting there could only invent fragments to prompt about (#427).
  */
  // Where the text is not SQL, its own vocabulary decides. This used to be a bare
  // `return false`, which is why a Redis `FLUSHALL` and a Mongo `deleteMany` ran with
  // no confirmation at all while a `DELETE FROM` on every SQL engine asked (S8). The
  // facts are a table in `@/lib/db/destructive-commands`, not a type test written
  // here: this file already learned that lesson for the span rule above.
  if (!readsSqlText(databaseType)) return isDestructiveNonSqlQuery(query, databaseType);
  // One exception to "exactly what the runner will run": a procedural body is ONE
  // statement to the runner (#1312), and its operative keyword is `BEGIN`, `DECLARE` or
  // `CREATE`, none of which asks. The writes inside it are still writes, so the gate keeps
  // reading the body's own `;`-separated statements, which is what it read before bodies
  // were a fact at all. The spans and the separator lines stay the dialect's.
  const statementsInsideBodies = { ...grammar, script: { ...grammar.script, blocks: "none" as const } };
  return splitStatements(query, statementsInsideBodies).some((statement) => writesUnderGrammar(statement.sql, grammar));
}

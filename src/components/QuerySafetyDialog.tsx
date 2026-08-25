"use client";

import React, { useState, useEffect, useMemo } from "react";
import { ShieldAlert, ShieldCheck, TriangleAlert, LoaderCircle, Play, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isDestructiveNonSqlQuery } from "@/lib/db/destructive-commands";
import { readsSqlText, resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import { hasUnterminatedSpan } from "@/lib/sql/spans";
import { splitStatements } from "@/lib/sql/statement-splitter";
import { findCodeWord } from "@/lib/sql/words";
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
  onClose: () => void;
  onProceed: () => void;
  /** Optional API adapter: when provided, bypasses the built-in /api/ai/query-safety fetch. */
  onAnalyzeSafety?: (params: { query: string; schemaContext: string }) => Promise<SafetyAnalysis>;
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

const RISK_CONFIG = {
  safe: {
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
    icon: ShieldCheck,
    label: "Safe",
  },
  low: {
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/20",
    icon: ShieldCheck,
    label: "Low Risk",
  },
  medium: {
    color: "text-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    icon: TriangleAlert,
    label: "Medium Risk",
  },
  high: {
    color: "text-orange-400",
    bg: "bg-orange-500/10",
    border: "border-orange-500/20",
    icon: ShieldAlert,
    label: "High Risk",
  },
  critical: {
    color: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/20",
    icon: ShieldAlert,
    label: "Critical Risk",
  },
};

export function QuerySafetyDialog({
  isOpen,
  query,
  schemaContext,
  databaseType,
  onClose,
  onProceed,
  onAnalyzeSafety,
}: QuerySafetyDialogProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<SafetyAnalysis | null>(null);
  const [rawResponse, setRawResponse] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (isOpen && query) {
      analyzeQuery();
    }
    return () => {
      setAnalysis(null);
      setRawResponse("");
      setError(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, query]);

  const analyzeQuery = async () => {
    setIsAnalyzing(true);
    setError(null);

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
        const result = await onAnalyzeSafety({ query, schemaContext: filteredSchema });
        setAnalysis(result);
      } else {
        // Default: existing fetch behavior
        const response = await fetch("/api/ai/query-safety", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, schemaContext: filteredSchema, databaseType }),
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || "Analysis failed");
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No reader");

        let fullResponse = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullResponse += new TextDecoder().decode(value);
          setRawResponse(fullResponse);
        }

        const parsed = parseSafetyResponse(fullResponse);
        if (parsed) {
          setAnalysis(parsed);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsAnalyzing(false);
    }
  };

  if (!isOpen) return null;

  const risk = analysis ? RISK_CONFIG[analysis.riskLevel] || RISK_CONFIG.medium : null;
  const RiskIcon = risk?.icon || ShieldAlert;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-overlay border border-hairline-strong rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-hairline">
          <div className="flex items-center gap-2">
            <ShieldAlert strokeWidth={1.5} className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-xs font-medium text-fg">Query Safety Check</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-fill text-fg-muted">
            <X strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-5 py-3 bg-surface border-b border-hairline">
          <pre className="text-xs font-mono text-fg-tertiary whitespace-pre-wrap max-h-24 overflow-auto">
            {query.length > 300 ? query.substring(0, 300) + "..." : query}
          </pre>
        </div>

        <div className="px-5 py-4 max-h-80 overflow-auto">
          {/*
            Said before the analysis and kept beside it: the reason this dialog
            opened is the client-side reading, and a risk verdict produced from text
            whose reading stopped early may not describe what the statement does.
          */}
          {unreadableRun && (
            <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-400" />
              <div>
                <span className="text-xs font-medium text-amber-400">Part of this statement could not be read</span>
                <p className="text-xs text-fg-tertiary mt-0.5">
                  A quoted, commented or bracketed run in it never closes (or its closing quote sits behind a backslash,
                  which dialects read differently), so nothing written after that point could be checked. It may hide a
                  write, which is why you are being asked.
                </p>
              </div>
            </div>
          )}

          {isAnalyzing && (
            <div className="flex items-center justify-center gap-2 py-8 text-fg-muted">
              <LoaderCircle strokeWidth={1.5} className="w-5 h-5 animate-spin" />
              <span className="text-xs">Analyzing query safety...</span>
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs text-red-400">{error}</div>
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
                          ? "bg-red-500/5 border-red-500/20"
                          : w.severity === "warning"
                            ? "bg-amber-500/5 border-amber-500/20"
                            : "bg-blue-500/5 border-blue-500/20",
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
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-hairline bg-surface">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-fill text-fg-tertiary text-xs font-medium hover:bg-fill-strong transition-colors"
          >
            <span>Cancel</span>
          </button>
          <button
            onClick={onProceed}
            disabled={isAnalyzing}
            className={cn(
              "px-4 py-2 rounded-lg text-white text-xs font-medium transition-colors flex items-center gap-1.5",
              analysis?.riskLevel === "critical" || analysis?.riskLevel === "high"
                ? "bg-red-600 hover:bg-red-500"
                : "bg-blue-600 hover:bg-blue-500",
              isAnalyzing && "opacity-50 cursor-not-allowed",
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
      </div>
    </div>
  );
}

/**
 * Statements whose own keyword is enough to want a confirmation: they delete rows,
 * remove objects or change who may reach them.
 *
 * The same vocabulary the six anchored patterns here used to spell out, now tested
 * against one reading of the statement instead of re-derived per keyword.
 */
const DANGEROUS_KEYWORDS = new Set(["DELETE", "DROP", "TRUNCATE", "ALTER", "GRANT", "REVOKE", "UPDATE"]);

/**
 * Whether ONE statement's own code asks for a confirmation, read under `grammar`.
 *
 * Its own function because the caller below asks the question twice over different
 * text: the whole editor buffer, and then each fragment the multi-statement route
 * will run. Re-deriving the two keyword tests per call site is how the gate and the
 * runner drifted apart in the first place.
 */
function writesUnderGrammar(text: string, grammar: SqlGrammar): boolean {
  const keyword = readOperativeKeyword(text, grammar)?.keyword;
  if (keyword !== undefined && DANGEROUS_KEYWORDS.has(keyword)) return true;

  // A write the statement's own keyword does not report: PostgreSQL's data-modifying
  // CTE is OPERATED by its SELECT (`WITH x AS (UPDATE … SET …) SELECT * FROM x`), so
  // this probe stays unanchored deliberately. It reads the statement's CODE rather
  // than its text, so a read that merely quotes or comments the two words - which
  // the pattern before it treated as a write - no longer asks for a confirmation.
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
 * For the two types whose text is not SQL there is nothing here to read, and this
 * predicate answered false for them outright - so a Redis `FLUSHALL` or `DEL` and a
 * MongoDB `deleteMany` ran with no confirmation at all, on both execution paths,
 * while the same intent on every SQL engine asked (S8). Their vocabulary now comes
 * from `@/lib/db/destructive-commands`, one table per type read by one function, and
 * it names only what those two providers can actually dispatch.
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
  // in the editor, so this predicate is handed MongoDB documents and Redis commands
  // as well, and an escaped quote that a SQL span reader cannot resolve closes
  // perfectly in the grammar those are written in. The keyword tests below still
  // run: narrowing this rule is not switching the gate off.
  if (readsSqlText(databaseType) && hasUnterminatedSpan(query, grammar)) return true;

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
  return splitStatements(query, grammar).some((statement) => writesUnderGrammar(statement.sql, grammar));
}

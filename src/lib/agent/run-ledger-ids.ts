/**
 * The one check of the two engine-bound ids a run header persists (FND-1): the statement language the run is written in
 * and the goal rule it is judged by. A header naming one this build does not hold, or holds only as retired, is refused
 * by name when its ledger is read (`AgentRunUnavailableError` in `run-store.ts`), so no record this build folds carries
 * an id it cannot resolve. An absent id keeps its meaning: an absent language reads as `sql` and an absent verifier as
 * the variant's.
 *
 * Server-side: the verifier set is read from the goal rules, which are server modules.
 */
import { quoteTypeId } from "@/lib/db/type-id";
import { hasGoalRule, RETIRED_GOAL_VERIFIERS } from "./goal-verifier";
import { isAgentStatementLanguage, RETIRED_STATEMENT_LANGUAGES } from "./languages/client";

export type AgentRunHeaderField = "statementLanguage" | "verifier";

/** Why a run header cannot be read by this build: which field, whether its id is unknown or retired, and the sentence. */
export interface AgentRunHeaderRefusal {
  readonly field: AgentRunHeaderField;
  readonly reason: "unknown" | "retired";
  /** The id as the header holds it, unquoted. */
  readonly id: string;
  /** What the run's owner is told, with the id quoted by `quoteTypeId`. */
  readonly sentence: string;
}

/**
 * The ids a header is checked against. A parameter, as `workflowAvailability` takes its tables, so the retired-language
 * refusal, which no shipped id produces yet, can be pinned.
 */
export interface AgentRunHeaderVocabulary {
  readonly isLanguage: (id: string) => boolean;
  readonly retiredLanguages: ReadonlySet<string>;
  readonly isVerifier: (id: string) => boolean;
  readonly retiredVerifiers: ReadonlySet<string>;
}

/** This build's vocabulary. */
export const RUN_HEADER_VOCABULARY: AgentRunHeaderVocabulary = Object.freeze({
  isLanguage: isAgentStatementLanguage,
  retiredLanguages: RETIRED_STATEMENT_LANGUAGES,
  isVerifier: hasGoalRule,
  retiredVerifiers: RETIRED_GOAL_VERIFIERS,
});

/** The noun each field is named by, in the sentence and in the store's error message. */
export const RUN_HEADER_FIELD_NOUN: Readonly<Record<AgentRunHeaderField, string>> = Object.freeze({
  statementLanguage: "statement language",
  verifier: "goal rule",
});

const SUBJECT: Readonly<Record<AgentRunHeaderField, string>> = Object.freeze({
  statementLanguage: "This run was recorded in the statement language",
  verifier: "This run is judged by the goal rule",
});

/** How this build holds a refused id, after "which this LibreDB Studio". */
export const RUN_HEADER_REASON_VERB: Readonly<Record<AgentRunHeaderRefusal["reason"], string>> = Object.freeze({
  unknown: "does not have",
  retired: "has retired",
});

const KEPT = "The run is kept as it was, and this LibreDB Studio does not open, drive, stop or replay it.";

function refusalOf(
  field: AgentRunHeaderField,
  id: string | undefined,
  isLive: (id: string) => boolean,
  retired: ReadonlySet<string>,
): AgentRunHeaderRefusal | null {
  if (id === undefined || isLive(id)) return null;
  const reason = retired.has(id) ? "retired" : "unknown";
  return {
    field,
    reason,
    id,
    sentence: `${SUBJECT[field]} ${quoteTypeId(id)}, which this LibreDB Studio ${RUN_HEADER_REASON_VERB[reason]}. ${KEPT}`,
  };
}

/**
 * Why `header` cannot be read by this build, or `null` when it can. The language is checked first, so a header that
 * names two refused ids is named by its language. An id is looked up exactly: no trimming, no case folding.
 */
export function runHeaderRefusal(
  header: { readonly statementLanguage?: string; readonly verifier?: string },
  vocabulary: AgentRunHeaderVocabulary = RUN_HEADER_VOCABULARY,
): AgentRunHeaderRefusal | null {
  return (
    refusalOf("statementLanguage", header.statementLanguage, vocabulary.isLanguage, vocabulary.retiredLanguages) ??
    refusalOf("verifier", header.verifier, vocabulary.isVerifier, vocabulary.retiredVerifiers)
  );
}

/**
 * The one check of the ids a run header persists that this build resolves against its own vocabulary (FND-1): the
 * statement language the run is written in, the workflow it was opened for, and the goal rule it is judged by. A header
 * naming one this build does not hold, or holds only as retired, is refused by name when its ledger is read
 * (`AgentRunUnavailableError` in `run-store.ts`), so no record this build folds carries an id it cannot resolve.
 *
 * What each id is resolved by decides what is checked:
 *  - the language, in every mode, because the planning deliverable and the agent variant are both read from it;
 *  - the workflow, in every mode, because the planning deliverable is read from it; an agent-mode run also reads its
 *    variant, the workflow on the run's language, for its tools, objective and verifier, so that pair must exist;
 *  - the verifier, in agent mode only, because a plan is judged by the planning rule whatever its header names
 *    (`goalFor` in `goal-verifier.ts`).
 *
 * An absent id keeps its meaning: an absent language reads as `sql`, an absent workflow as
 * `DEFAULT_AGENT_WORKFLOW_TYPE`, and an absent verifier as the variant's, which the variant check makes resolvable.
 *
 * Server-side: the verifier set is read from the goal rules, which are server modules.
 */
import { quoteTypeId } from "@/lib/db/type-id";
import { type AgentStatementLanguageId, agentVariant } from "./agent-manifest";
import { hasGoalRule, RETIRED_GOAL_VERIFIERS } from "./goal-verifier";
import { isAgentStatementLanguage, RETIRED_STATEMENT_LANGUAGES, statementFamilyOf } from "./languages/client";
import { AGENT_WORKFLOW_PRESENTS_ANSWER, type AgentRunWorkflowType, DEFAULT_AGENT_WORKFLOW_TYPE } from "./types";

export type AgentRunHeaderField = "statementLanguage" | "workflowType" | "verifier";

/** Why a run header cannot be read by this build: which field, whether its id is unknown or retired, and the sentence. */
export interface AgentRunHeaderRefusal {
  readonly field: AgentRunHeaderField;
  readonly reason: "unknown" | "retired";
  /** The id as the header holds it, unquoted. */
  readonly id: string;
  /**
   * What is refused, as a noun phrase with every id quoted by `quoteTypeId`: `the statement language "cobol"`, or, for a
   * workflow this build holds but not on the run's language, `the workflow "data-analysis" in the statement language
   * "rediscli"`. The store's error message and the sentence both name the refusal by it.
   */
  readonly named: string;
  /** What the run's owner is told. */
  readonly sentence: string;
}

/** The header fields `runHeaderRefusal` reads. `mode` is required because it decides which ids are resolved. */
export interface AgentRunHeaderIds {
  readonly mode: string;
  readonly statementLanguage?: string;
  readonly workflowType?: string;
  readonly verifier?: string;
}

/**
 * The ids a header is checked against. A parameter, as `workflowAvailability` takes its tables, so the retired-language
 * refusal, which no shipped id produces yet, can be pinned.
 */
export interface AgentRunHeaderVocabulary {
  readonly isLanguage: (id: string) => boolean;
  readonly retiredLanguages: ReadonlySet<string>;
  readonly isWorkflow: (id: string) => boolean;
  /** Whether an agent-mode run of `workflow` on `language` has a variant; asked only of a live language and workflow. */
  readonly hasVariant: (language: string | undefined, workflow: string) => boolean;
  readonly isVerifier: (id: string) => boolean;
  readonly retiredVerifiers: ReadonlySet<string>;
}

/** This build's vocabulary. */
export const RUN_HEADER_VOCABULARY: AgentRunHeaderVocabulary = Object.freeze({
  isLanguage: isAgentStatementLanguage,
  retiredLanguages: RETIRED_STATEMENT_LANGUAGES,
  // `Object.hasOwn`, for the reason `agentVariant` gives: a workflow such as `toString` is read from a ledger, and the
  // inherited method is not a workflow.
  isWorkflow: (id: string) => Object.hasOwn(AGENT_WORKFLOW_PRESENTS_ANSWER, id),
  hasVariant: (language: string | undefined, workflow: string) =>
    agentVariant(language as AgentStatementLanguageId | undefined, workflow as AgentRunWorkflowType) !== undefined,
  isVerifier: hasGoalRule,
  retiredVerifiers: RETIRED_GOAL_VERIFIERS,
});

/** The noun each field is named by. */
const FIELD_NOUN: Readonly<Record<AgentRunHeaderField, string>> = Object.freeze({
  statementLanguage: "statement language",
  workflowType: "workflow",
  verifier: "goal rule",
});

const SUBJECT: Readonly<Record<AgentRunHeaderField, string>> = Object.freeze({
  statementLanguage: "This run was recorded in",
  workflowType: "This run is for",
  verifier: "This run is judged by",
});

/** How this build holds a refused id, after "which this LibreDB Studio". */
export const RUN_HEADER_REASON_VERB: Readonly<Record<AgentRunHeaderRefusal["reason"], string>> = Object.freeze({
  unknown: "does not have",
  retired: "has retired",
});

const KEPT = "The run is kept as it was, and this LibreDB Studio does not open, drive, stop or replay it.";

function refusal(
  field: AgentRunHeaderField,
  reason: AgentRunHeaderRefusal["reason"],
  id: string,
  context = "",
): AgentRunHeaderRefusal {
  const named = `the ${FIELD_NOUN[field]} ${quoteTypeId(id)}${context}`;
  return {
    field,
    reason,
    id,
    named,
    sentence: `${SUBJECT[field]} ${named}, which this LibreDB Studio ${RUN_HEADER_REASON_VERB[reason]}. ${KEPT}`,
  };
}

function refusalOf(
  field: AgentRunHeaderField,
  id: string | undefined,
  isLive: (id: string) => boolean,
  retired: ReadonlySet<string>,
): AgentRunHeaderRefusal | null {
  if (id === undefined || isLive(id)) return null;
  return refusal(field, retired.has(id) ? "retired" : "unknown", id);
}

function workflowRefusal(
  header: AgentRunHeaderIds,
  vocabulary: AgentRunHeaderVocabulary,
): AgentRunHeaderRefusal | null {
  const workflow = header.workflowType ?? DEFAULT_AGENT_WORKFLOW_TYPE;
  if (!vocabulary.isWorkflow(workflow)) return refusal("workflowType", "unknown", workflow);
  if (header.mode === "planning" || vocabulary.hasVariant(header.statementLanguage, workflow)) return null;
  const language = statementFamilyOf(header.statementLanguage as AgentStatementLanguageId | undefined);
  return refusal("workflowType", "unknown", workflow, ` in the statement language ${quoteTypeId(language)}`);
}

/**
 * Why `header` cannot be read by this build, or `null` when it can. The language is checked first, then the workflow,
 * then the verifier, so a header that names two refused ids is named by the first, and the variant is asked for only
 * with a language this build holds. An id is looked up exactly: no trimming, no case folding.
 */
export function runHeaderRefusal(
  header: AgentRunHeaderIds,
  vocabulary: AgentRunHeaderVocabulary = RUN_HEADER_VOCABULARY,
): AgentRunHeaderRefusal | null {
  return (
    refusalOf("statementLanguage", header.statementLanguage, vocabulary.isLanguage, vocabulary.retiredLanguages) ??
    workflowRefusal(header, vocabulary) ??
    (header.mode === "planning"
      ? null
      : refusalOf("verifier", header.verifier, vocabulary.isVerifier, vocabulary.retiredVerifiers))
  );
}

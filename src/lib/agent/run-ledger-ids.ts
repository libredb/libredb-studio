/**
 * The one check of the ids a run header persists that this build resolves against its own vocabulary (FND-1): the
 * statement language the run is written in, the workflow it was opened for, the goal rule it is judged by, and the
 * engine of the connection it was opened on. A header
 * naming one this build does not hold, or holds only as retired, is refused by name when its ledger is read
 * (`AgentRunUnavailableError` in `run-store.ts`), so no record this build folds carries an id it cannot resolve.
 *
 * What each id is resolved by decides what is checked:
 *  - the language, in every mode, because the planning deliverable and the agent variant are both read from it;
 *  - the workflow, in every mode, because the planning deliverable is read from it; an agent-mode run also reads its
 *    variant, the workflow on the run's language, for its tools, objective and verifier, so that pair must exist;
 *  - the verifier, in agent mode only, because a plan is judged by the planning rule whatever its header names
 *    (`goalFor` in `goal-verifier.ts`);
 *  - the engine, in every mode, because tool selection and the curated readings are read from Studio's grant of its
 *    agent readings, its engine record's `grants.agentReadings`; an agent-mode operations run also needs the engine to
 *    offer agent mode at least one reading, since its reading tool would otherwise have nothing to offer, so that pair
 *    is refused the way a workflow with no variant on its language is.
 *
 * An engine is live while the installed server catalog serves its record, a legacy engine's or a provider package's
 * (`serverEngine`), and is read with nothing installed as the legacy engines. One the catalog no longer serves, a
 * package removed since the run started or a package refused at boot, is refused by name as unknown: its run stays in
 * its ledger as it was, history, and this build opens no new step of it. No engine is retired, so an engine is only
 * ever live or unknown.
 *
 * A statement language is live while the installed server catalog composes it (`servedClientPacks` in
 * `languages/server.ts`): a module language always, a language declared as data while a served record's grant names
 * its data, and with nothing installed the legacy records' languages. One the catalog no longer composes, its package
 * removed or its row no longer granting it under its data's digest, is refused by name as unknown, its run kept as
 * history; Studio's own retired languages are refused as retired. The variant of an agent-mode run's workflow is read
 * from the same registry.
 *
 * An absent id keeps its meaning: an absent language reads as `sql`, an absent workflow as
 * `DEFAULT_AGENT_WORKFLOW_TYPE`, an absent verifier as the variant's, which the variant check makes resolvable, and an
 * absent engine as a run recorded before the field, offered the six curated readings it was opened with.
 *
 * Server-side: the verifier set is read from the goal rules, which are server modules.
 */
import { servedEngineRecord, serverEngine } from "@/lib/db/server-catalog";
import { quoteTypeId } from "@/lib/db/type-id";
import { type AgentStatementLanguageId, agentVariant } from "./agent-manifest";
import { hasGoalRule, RETIRED_GOAL_VERIFIERS } from "./goal-verifier";
import { RETIRED_STATEMENT_LANGUAGES, statementFamilyOf } from "./languages/client";
import { servedClientPacks } from "./languages/server";
import { AGENT_WORKFLOW_PRESENTS_ANSWER, type AgentRunWorkflowType, DEFAULT_AGENT_WORKFLOW_TYPE } from "./types";

export type AgentRunHeaderField = "statementLanguage" | "workflowType" | "verifier" | "engine";

/** Why a run header cannot be read by this build: which field, whether its id is unknown or retired, and the sentence. */
export interface AgentRunHeaderRefusal {
  readonly field: AgentRunHeaderField;
  /**
   * `unknown` also covers an agent-mode `workflowType` this build holds whose variant is missing on the run's language,
   * or an agent-mode `operations` run on an engine that offers agent mode no reading: `id` is then a workflow this build
   * has, and the language or engine that makes the pair unresolvable is carried in `named` and in the sentence, not in
   * `field`, `reason` or `id`. A log line that gives only the field and the reason is
   * resolved by reading the ledger's header, which names both.
   */
  readonly reason: "unknown" | "retired";
  /** The id as the header holds it, unquoted. */
  readonly id: string;
  /**
   * What is refused, as a noun phrase with every id quoted by `quoteTypeId`: `the statement language "cobol"`, or, for a
   * workflow this build holds but not on the run's language, `the workflow "data-analysis" in the statement language
   * "rediscli"`, or on the run's engine, `the workflow "operations" on the engine "mqtt"`. The store's error message and the sentence both name the refusal by it.
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
  readonly engine?: string;
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
  /** Whether the installed server catalog serves the engine's record, a legacy engine's or a provider package's. */
  readonly isEngine: (id: string) => boolean;
  /**
   * Whether the engine offers agent mode at least one curated reading; asked only of an id `isEngine` holds. Read from
   * the engine record's `grants.agentReadings`, which the lookup cannot refuse for an id `isEngine` holds.
   */
  readonly hasReading: (engine: string) => boolean;
}

/** This build's vocabulary, its languages and their variants read from the installed catalog when it is asked. */
export const RUN_HEADER_VOCABULARY: AgentRunHeaderVocabulary = Object.freeze({
  isLanguage: (id: string) => Object.hasOwn(servedClientPacks(), id),
  retiredLanguages: RETIRED_STATEMENT_LANGUAGES,
  // `Object.hasOwn`, for the reason `agentVariant` gives: a workflow such as `toString` is read from a ledger, and the
  // inherited method is not a workflow.
  isWorkflow: (id: string) => Object.hasOwn(AGENT_WORKFLOW_PRESENTS_ANSWER, id),
  hasVariant: (language: string | undefined, workflow: string) =>
    agentVariant(
      language as AgentStatementLanguageId | undefined,
      workflow as AgentRunWorkflowType,
      servedClientPacks(),
    ) !== undefined,
  isVerifier: hasGoalRule,
  retiredVerifiers: RETIRED_GOAL_VERIFIERS,
  isEngine: (id: string) => serverEngine(id).kind === "served",
  hasReading: (engine: string) => servedEngineRecord(engine).grants.agentReadings.length > 0,
});

/** The noun each field is named by. */
const FIELD_NOUN: Readonly<Record<AgentRunHeaderField, string>> = Object.freeze({
  statementLanguage: "statement language",
  workflowType: "workflow",
  verifier: "goal rule",
  engine: "engine",
});

const SUBJECT: Readonly<Record<AgentRunHeaderField, string>> = Object.freeze({
  statementLanguage: "This run was recorded in",
  workflowType: "This run is for",
  verifier: "This run is judged by",
  engine: "This run was recorded on",
});

/** How this build holds a refused id, after "which this LibreDB Studio". */
export const RUN_HEADER_REASON_VERB: Readonly<Record<AgentRunHeaderRefusal["reason"], string>> = Object.freeze({
  unknown: "does not have",
  retired: "has retired",
});

const KEPT = "The run is kept as it was, and this LibreDB Studio does not open, drive, stop or replay it.";

/**
 * The refusal of `id`. `held` is the clause after the named id; by default it says how this build holds the id, and a
 * refusal whose id this build does hold passes the clause that says what is missing instead.
 */
function refusal(
  field: AgentRunHeaderField,
  reason: AgentRunHeaderRefusal["reason"],
  id: string,
  context = "",
  held = `which this LibreDB Studio ${RUN_HEADER_REASON_VERB[reason]}`,
): AgentRunHeaderRefusal {
  const named = `the ${FIELD_NOUN[field]} ${quoteTypeId(id)}${context}`;
  return {
    field,
    reason,
    id,
    named,
    sentence: `${SUBJECT[field]} ${named}, ${held}. ${KEPT}`,
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
 * The refusal of an engine the installed catalog serves no record of, or of an agent-mode operations run on an engine
 * that offers agent mode no curated reading, or `null`.
 */
function engineRefusal(header: AgentRunHeaderIds, vocabulary: AgentRunHeaderVocabulary): AgentRunHeaderRefusal | null {
  const { engine } = header;
  if (engine === undefined) return null;
  if (!vocabulary.isEngine(engine)) return refusal("engine", "unknown", engine);
  const workflow = header.workflowType ?? DEFAULT_AGENT_WORKFLOW_TYPE;
  if (header.mode === "planning" || workflow !== "operations" || vocabulary.hasReading(engine)) return null;
  // This build has the operations workflow on other engines, so the sentence names what this engine lacks rather than
  // saying the build does not have the workflow.
  return refusal(
    "workflowType",
    "unknown",
    workflow,
    ` on the engine ${quoteTypeId(engine)}`,
    "and that engine offers no agent reading in this LibreDB Studio",
  );
}

/**
 * Why `header` cannot be read by this build, or `null` when it can. The language is checked first, then the workflow,
 * then the verifier, then the engine, so a header that names two refused ids is named by the first, the variant is
 * asked for only with a language this build holds, and the readings only of an engine this build holds. An id is looked up exactly: no trimming, no case folding.
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
      : refusalOf("verifier", header.verifier, vocabulary.isVerifier, vocabulary.retiredVerifiers)) ??
    engineRefusal(header, vocabulary)
  );
}

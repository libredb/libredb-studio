/**
 * What the server does differently for each statement language agent mode reads in.
 *
 * Server only. `agent-manifest.ts` holds the facts a browser may read (which engine speaks which language, which
 * workflows a language offers, the copy the rail shows); the server packs hold the behaviour that must stay on the
 * server: the statement text a model's argument is read as, the descriptor a model-written read is evaluated under,
 * the repair ledger's identity of one call, and the advice a refused read carries back. The adapters reach
 * `node:crypto`, which is why they are separate modules and why nothing a client component imports may reach them.
 *
 * The record is total over `AgentStatementLanguageId`, so a later language does not compile until it registers its
 * pack here. A language id the record does not hold can still arrive from a ledger, and reaching one is a named
 * error rather than a quiet fall back to SQL: a statement fingerprinted as SQL, or refused with a SQL sentence, is a
 * wrong answer that looks like a right one.
 */
import type { AgentStatementLanguageId } from "../agent-manifest";
import { mergeDisjoint } from "../disjoint-merge";
import type { AgentRunWorkflowType } from "../types";
import { INFLUXQL_SERVER_PACK } from "./influxql/server";
import { KUBECTL_SERVER_PACK } from "./kubectl/server";
import { LIBREDBKV_SERVER_PACK } from "./libredbkv/server";
import { MONGO_SERVER_PACK } from "./mongo/server";
import { WEAVIATEAPI_SERVER_PACK } from "./weaviateapi/server";
import { QDRANTAPI_SERVER_PACK } from "./qdrantapi/server";
import type { AgentLanguageServerAdapter, AgentLanguageServerPack, EvidenceToolName } from "./pack";
import { SQL_STATEMENT_DEFINITIONS } from "./sql/definitions";
import { SQL_RECOMMEND_CHANGE } from "./sql/recommendation";
import { SQL_SERVER_PACK } from "./sql/server";

/**
 * The language a curated call is fingerprinted and refused in. Its `operations:` or `objects:` key is no statement in
 * any language, so it reads the default family's adapter and advice whatever the run's language.
 */
export const CURATED_CALL_LANGUAGE = "sql" as const satisfies AgentStatementLanguageId;

const SERVER_PACKS: Readonly<Record<AgentStatementLanguageId, AgentLanguageServerPack>> = Object.freeze({
  sql: SQL_SERVER_PACK,
  kubectl: KUBECTL_SERVER_PACK,
  mongo: MONGO_SERVER_PACK,
  libredbkv: LIBREDBKV_SERVER_PACK,
  influxql: INFLUXQL_SERVER_PACK,
  weaviateapi: WEAVIATEAPI_SERVER_PACK,
  qdrantapi: QDRANTAPI_SERVER_PACK,
} satisfies Record<AgentStatementLanguageId, AgentLanguageServerPack>);

/** The server pack for `language`, or a named error when the id is not a language this server knows. */
export function languageServerPack(language: AgentStatementLanguageId): AgentLanguageServerPack {
  const pack = Object.hasOwn(SERVER_PACKS, language) ? SERVER_PACKS[language] : undefined;
  if (pack === undefined) throw new Error(`no server adapter for ${language}`);
  return pack;
}

/** The server adapter for `language`, or the same named error as `languageServerPack`. */
export function languageServer(language: AgentStatementLanguageId): AgentLanguageServerAdapter {
  return languageServerPack(language).adapter;
}

/**
 * The default family's statement-tool definitions: `inspect_schema`, `run_read_query`, `inspect_plan` and
 * `profile_table`. `AGENT_TOOL_DEFINITIONS` spreads them first, and every family's `toolOverrides` replace them by name.
 */
export const REFERENCE_STATEMENT_DEFINITIONS = SQL_STATEMENT_DEFINITIONS;

/**
 * The default family's `recommend_change` definition and the statement card it offers. `AGENT_TOOL_DEFINITIONS` holds
 * the definition, and `recommendChangeTool` reads a call with the card wherever the offered definition is this one:
 * every workflow whose family's `toolOverrides` leave `recommend_change` alone.
 */
export const REFERENCE_RECOMMEND_CHANGE = SQL_RECOMMEND_CHANGE;
export const REFERENCE_RECOMMENDATION_CARD = SQL_SERVER_PACK.recommendationCard;

/**
 * Every pack's base definitions, the tools only one language offers. Global by tool name, because
 * `AGENT_TOOL_DEFINITIONS` spreads it where those tools always stood, and a name two packs both define fails at load.
 */
export const LANGUAGE_BASE_DEFINITIONS = mergeDisjoint(
  [
    SQL_SERVER_PACK.baseDefinitions,
    KUBECTL_SERVER_PACK.baseDefinitions,
    MONGO_SERVER_PACK.baseDefinitions,
    LIBREDBKV_SERVER_PACK.baseDefinitions,
    INFLUXQL_SERVER_PACK.baseDefinitions,
    WEAVIATEAPI_SERVER_PACK.baseDefinitions,
    QDRANTAPI_SERVER_PACK.baseDefinitions,
  ],
  "LANGUAGE_BASE_DEFINITIONS",
);

/**
 * The tool rules by language, then by workflow: each pack's own record, the very object it holds. The SQL record
 * is total. A language holds rules for the workflows it has a variant of, and no more: `systemPrompt` throws for an
 * agent-mode run whose language has none, which `requiredVariant` would already have refused. `operations` sends no
 * statement in any language, so every pack holds the SQL rules for it, `OPERATIONS_TOOL_RULE` in `shared.ts`.
 *
 * Exported so `tests/unit/lib/agent/tool-offer-census.test.ts` can hold every rule to the tools its variant offers:
 * a rule naming a tool the run does not hold costs the run a turn on "there is no tool called ..." (#350).
 */
export const WORKFLOW_TOOL_RULES: Readonly<
  Record<AgentStatementLanguageId, Readonly<Partial<Record<AgentRunWorkflowType, string>>>>
> = Object.freeze({
  sql: SQL_SERVER_PACK.workflowToolRules,
  kubectl: KUBECTL_SERVER_PACK.workflowToolRules,
  mongo: MONGO_SERVER_PACK.workflowToolRules,
  libredbkv: LIBREDBKV_SERVER_PACK.workflowToolRules,
  influxql: INFLUXQL_SERVER_PACK.workflowToolRules,
  weaviateapi: WEAVIATEAPI_SERVER_PACK.workflowToolRules,
  qdrantapi: QDRANTAPI_SERVER_PACK.workflowToolRules,
} satisfies Record<AgentStatementLanguageId, Partial<Record<AgentRunWorkflowType, string>>>);

/**
 * Every pack's shortfall notices. Global by shortfall, because a resumed run is judged by its persisted verdict
 * whatever its language, and a shortfall two packs both speak for fails at load.
 */
export const LANGUAGE_SHORTFALL_NOTICES = mergeDisjoint(
  [
    SQL_SERVER_PACK.shortfallNotices,
    KUBECTL_SERVER_PACK.shortfallNotices,
    MONGO_SERVER_PACK.shortfallNotices,
    LIBREDBKV_SERVER_PACK.shortfallNotices,
    INFLUXQL_SERVER_PACK.shortfallNotices,
    WEAVIATEAPI_SERVER_PACK.shortfallNotices,
    QDRANTAPI_SERVER_PACK.shortfallNotices,
  ],
  "LANGUAGE_SHORTFALL_NOTICES",
);

/**
 * What a run is told the moment it holds a usage reading. kubectl is the one pack that supplies it, which
 * `tests/unit/lib/agent/languages.test.ts` holds, so the run loop reads it here.
 */
export const LANGUAGE_USAGE_BAR_NOTICE: string = KUBECTL_SERVER_PACK.usageBarNotice;

/**
 * The bar's trigger: the evidence tool whose reading, once it lands as that tool's event, makes the bar due. Supplied
 * by the pack that supplies the notice, so the run loop names no tool of its own for it.
 */
export const LANGUAGE_USAGE_BAR_TOOL: EvidenceToolName = KUBECTL_SERVER_PACK.usageBarTool;

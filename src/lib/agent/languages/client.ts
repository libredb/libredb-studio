/**
 * The statement language packs' client facets (#1821): what a browser bundle may hold of each language.
 *
 * Client tier. `agent-manifest.ts`, `posture.ts` and every reader of a pack's evidence events, the rail's timeline
 * among them, read it, so it reaches no server module: each `<id>/client.ts`
 * imports only the leaves `workflow-tool-sets.ts` and `execution-policy.ts`. The whole pack in `index.ts` holds the
 * very objects this record holds, which `tests/unit/lib/agent/languages.test.ts` asserts.
 *
 * The record is total over `AgentStatementLanguageId`, so a later language does not compile until it registers its
 * client facet here. Its keys are declared in the order the projections in `agent-manifest.ts` list them.
 */
import type { AgentStatementLanguageId } from "../agent-manifest";
import { mergeDisjoint } from "../disjoint-merge";
import type { AgentRunEvent } from "../types";
import { KUBECTL_CLIENT_PACK } from "./kubectl/client";
import { INFLUXQL_CLIENT_PACK } from "./influxql/client";
import { WEAVIATEAPI_CLIENT_PACK } from "./weaviateapi/client";
import { QDRANTAPI_CLIENT_PACK } from "./qdrantapi/client";
import { CYPHER_CLIENT_PACK } from "./cypher/client";
import { MILVUSRPC_CLIENT_PACK } from "./milvusrpc/client";
import { REDISCLI_CLIENT_PACK } from "./rediscli/client";
import { ETCDCTL_CLIENT_PACK } from "./etcdctl/client";
import { OXIACLI_CLIENT_PACK } from "./oxiacli/client";
import { RABBITREAD_CLIENT_PACK } from "./rabbitread/client";
import { KAFKAREAD_CLIENT_PACK } from "./kafkaread/client";
import { S3API_CLIENT_PACK } from "./s3api/client";
import { FSQUERY_CLIENT_PACK } from "./fsquery/client";
import { SNMPGET_CLIENT_PACK } from "./snmpget/client";
import { NETCONFRPC_CLIENT_PACK } from "./netconfrpc/client";
import { LIBREDBKV_CLIENT_PACK } from "./libredbkv/client";
import { MONGO_CLIENT_PACK } from "./mongo/client";
import type {
  AgentEvidenceEventSpec,
  AgentEvidenceEventSpecs,
  AgentLanguageClientPack,
  AgentPackEvidenceEvent,
  AgentPackReadingDenyCode,
  AgentPackShortfall,
  AgentPackVariantRequirement,
  AgentVariantRequirementSpec,
} from "./pack";
import { SQL_CLIENT_PACK } from "./sql/client";

/**
 * The language a run record without one reads as. `persistedRunFacts` leaves `statementLanguage` off the record for a
 * SQL engine, for a ledger older than statement languages and for an engine with no family, and each of those runs
 * reads the SQL pack. It is also the family whose variant record is total over `AgentRunWorkflowType`.
 */
export const DEFAULT_STATEMENT_LANGUAGE = "sql" as const satisfies AgentStatementLanguageId;

/**
 * The family a run reads: its persisted language, or `DEFAULT_STATEMENT_LANGUAGE` when the record holds none. The one
 * place an absent language is read. The id is not validated, so an unknown one fails where its resolver names it.
 */
export function statementFamilyOf(language: AgentStatementLanguageId | undefined): AgentStatementLanguageId {
  return language ?? DEFAULT_STATEMENT_LANGUAGE;
}

const CLIENT_PACKS: Readonly<Record<AgentStatementLanguageId, AgentLanguageClientPack>> = Object.freeze({
  sql: SQL_CLIENT_PACK,
  kubectl: KUBECTL_CLIENT_PACK,
  mongo: MONGO_CLIENT_PACK,
  libredbkv: LIBREDBKV_CLIENT_PACK,
  influxql: INFLUXQL_CLIENT_PACK,
  weaviateapi: WEAVIATEAPI_CLIENT_PACK,
  qdrantapi: QDRANTAPI_CLIENT_PACK,
  cypher: CYPHER_CLIENT_PACK,
  milvusrpc: MILVUSRPC_CLIENT_PACK,
  rediscli: REDISCLI_CLIENT_PACK,
  etcdctl: ETCDCTL_CLIENT_PACK,
  oxiacli: OXIACLI_CLIENT_PACK,
  rabbitread: RABBITREAD_CLIENT_PACK,
  kafkaread: KAFKAREAD_CLIENT_PACK,
  s3api: S3API_CLIENT_PACK,
  fsquery: FSQUERY_CLIENT_PACK,
  snmpget: SNMPGET_CLIENT_PACK,
  netconfrpc: NETCONFRPC_CLIENT_PACK,
} satisfies Record<AgentStatementLanguageId, AgentLanguageClientPack>);

/** The client facet for `language`. The record is total, so a typed id always has one. */
export function languageClientPack(language: AgentStatementLanguageId): AgentLanguageClientPack {
  return CLIENT_PACKS[language];
}

/**
 * One member of every client facet, keyed by language in the order the packs are declared, frozen. A null pick stays
 * an own key, so a language with nothing to say is still listed.
 */
export function projectClientPacks<Value>(
  pick: (pack: AgentLanguageClientPack) => Value,
): Readonly<Record<AgentStatementLanguageId, Value>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(CLIENT_PACKS).map(([id, pack]) => [id, pick(pack)])) as Record<
      AgentStatementLanguageId,
      Value
    >,
  );
}

/**
 * Every pack's evidence events, keyed by kind: what the ledger admits beside the core's kinds, what the timeline and a
 * resumed run say of each, and which a claim may cite. Global by kind, because a ledger line names its kind and not its
 * language, so a kind two packs both declare fails at load; and total over `AgentPackEvidenceEvent`, so a kind a pack
 * adds to its events does not compile until the pack declares it.
 */
export const AGENT_EVIDENCE_EVENTS = mergeDisjoint(
  [
    SQL_CLIENT_PACK.evidenceEvents,
    KUBECTL_CLIENT_PACK.evidenceEvents,
    MONGO_CLIENT_PACK.evidenceEvents,
    LIBREDBKV_CLIENT_PACK.evidenceEvents,
    INFLUXQL_CLIENT_PACK.evidenceEvents,
    WEAVIATEAPI_CLIENT_PACK.evidenceEvents,
    QDRANTAPI_CLIENT_PACK.evidenceEvents,
    CYPHER_CLIENT_PACK.evidenceEvents,
    MILVUSRPC_CLIENT_PACK.evidenceEvents,
    REDISCLI_CLIENT_PACK.evidenceEvents,
    ETCDCTL_CLIENT_PACK.evidenceEvents,
    OXIACLI_CLIENT_PACK.evidenceEvents,
    RABBITREAD_CLIENT_PACK.evidenceEvents,
    KAFKAREAD_CLIENT_PACK.evidenceEvents,
    S3API_CLIENT_PACK.evidenceEvents,
    FSQUERY_CLIENT_PACK.evidenceEvents,
    SNMPGET_CLIENT_PACK.evidenceEvents,
    NETCONFRPC_CLIENT_PACK.evidenceEvents,
  ],
  "AGENT_EVIDENCE_EVENTS",
) satisfies AgentEvidenceEventSpecs<AgentPackEvidenceEvent>;

/**
 * What the timeline says of every shortfall a pack's verifiers report, keyed by shortfall. Global, because a verdict
 * names its shortfall and not its language, so a shortfall two packs both declare fails at load; and total over
 * `AgentPackShortfall`, so a shortfall a pack adds does not compile until the pack says it.
 */
export const AGENT_PACK_SHORTFALL_SENTENCES = mergeDisjoint(
  [
    SQL_CLIENT_PACK.shortfallSentences,
    KUBECTL_CLIENT_PACK.shortfallSentences,
    MONGO_CLIENT_PACK.shortfallSentences,
    LIBREDBKV_CLIENT_PACK.shortfallSentences,
    INFLUXQL_CLIENT_PACK.shortfallSentences,
    WEAVIATEAPI_CLIENT_PACK.shortfallSentences,
    QDRANTAPI_CLIENT_PACK.shortfallSentences,
    CYPHER_CLIENT_PACK.shortfallSentences,
    MILVUSRPC_CLIENT_PACK.shortfallSentences,
    REDISCLI_CLIENT_PACK.shortfallSentences,
    ETCDCTL_CLIENT_PACK.shortfallSentences,
    OXIACLI_CLIENT_PACK.shortfallSentences,
    RABBITREAD_CLIENT_PACK.shortfallSentences,
    KAFKAREAD_CLIENT_PACK.shortfallSentences,
    S3API_CLIENT_PACK.shortfallSentences,
    FSQUERY_CLIENT_PACK.shortfallSentences,
    SNMPGET_CLIENT_PACK.shortfallSentences,
    NETCONFRPC_CLIENT_PACK.shortfallSentences,
  ],
  "AGENT_PACK_SHORTFALL_SENTENCES",
) satisfies Record<AgentPackShortfall, string>;

/** What the timeline calls every reading refusal a pack raises, keyed by code, global and total as the shortfalls are. */
export const AGENT_PACK_READING_REFUSAL_HEADLINES = mergeDisjoint(
  [
    SQL_CLIENT_PACK.readingRefusalHeadlines,
    KUBECTL_CLIENT_PACK.readingRefusalHeadlines,
    MONGO_CLIENT_PACK.readingRefusalHeadlines,
    LIBREDBKV_CLIENT_PACK.readingRefusalHeadlines,
    INFLUXQL_CLIENT_PACK.readingRefusalHeadlines,
    WEAVIATEAPI_CLIENT_PACK.readingRefusalHeadlines,
    QDRANTAPI_CLIENT_PACK.readingRefusalHeadlines,
    CYPHER_CLIENT_PACK.readingRefusalHeadlines,
    MILVUSRPC_CLIENT_PACK.readingRefusalHeadlines,
    REDISCLI_CLIENT_PACK.readingRefusalHeadlines,
    ETCDCTL_CLIENT_PACK.readingRefusalHeadlines,
    OXIACLI_CLIENT_PACK.readingRefusalHeadlines,
    RABBITREAD_CLIENT_PACK.readingRefusalHeadlines,
    KAFKAREAD_CLIENT_PACK.readingRefusalHeadlines,
    S3API_CLIENT_PACK.readingRefusalHeadlines,
    FSQUERY_CLIENT_PACK.readingRefusalHeadlines,
    SNMPGET_CLIENT_PACK.readingRefusalHeadlines,
    NETCONFRPC_CLIENT_PACK.readingRefusalHeadlines,
  ],
  "AGENT_PACK_READING_REFUSAL_HEADLINES",
) satisfies Record<AgentPackReadingDenyCode, string>;

/**
 * Every variant requirement a pack names, with the engines it holds on and its refusal, global and total as the
 * shortfalls are. `agent-manifest.ts` reads it beside the requirements the core derives.
 */
export const AGENT_PACK_REQUIREMENTS = mergeDisjoint(
  [
    SQL_CLIENT_PACK.requirements,
    KUBECTL_CLIENT_PACK.requirements,
    MONGO_CLIENT_PACK.requirements,
    LIBREDBKV_CLIENT_PACK.requirements,
    INFLUXQL_CLIENT_PACK.requirements,
    WEAVIATEAPI_CLIENT_PACK.requirements,
    QDRANTAPI_CLIENT_PACK.requirements,
    CYPHER_CLIENT_PACK.requirements,
    MILVUSRPC_CLIENT_PACK.requirements,
    REDISCLI_CLIENT_PACK.requirements,
    ETCDCTL_CLIENT_PACK.requirements,
    OXIACLI_CLIENT_PACK.requirements,
    RABBITREAD_CLIENT_PACK.requirements,
    KAFKAREAD_CLIENT_PACK.requirements,
    S3API_CLIENT_PACK.requirements,
    FSQUERY_CLIENT_PACK.requirements,
    SNMPGET_CLIENT_PACK.requirements,
    NETCONFRPC_CLIENT_PACK.requirements,
  ],
  "AGENT_PACK_REQUIREMENTS",
) satisfies Record<AgentPackVariantRequirement, AgentVariantRequirementSpec>;

/** A ledger event a pack declares, rather than one of the core's own kinds. */
export type AgentPackEvidenceRunEvent = Extract<AgentRunEvent, AgentPackEvidenceEvent>;

/** Whether `event` is of a kind a pack declares. Every core reader asks this before it reads one of the core's kinds. */
export function isPackEvidenceEvent(event: AgentRunEvent): event is AgentPackEvidenceRunEvent {
  return Object.hasOwn(AGENT_EVIDENCE_EVENTS, event.kind);
}

/** The declaration of a pack evidence event's kind. Keyed by the event's own kind, so it reads that kind's fields. */
export function evidenceEventSpec(event: AgentPackEvidenceEvent): AgentEvidenceEventSpec<AgentPackEvidenceEvent> {
  return AGENT_EVIDENCE_EVENTS[event.kind] as AgentEvidenceEventSpec<AgentPackEvidenceEvent>;
}

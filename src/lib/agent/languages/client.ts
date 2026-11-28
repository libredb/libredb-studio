/**
 * The statement language packs' client facets (#1821): what a browser bundle may hold of each language.
 *
 * Client tier. `agent-manifest.ts`, `posture.ts` and every reader of a pack's evidence events, the rail's timeline
 * among them, read it, so it reaches no server module: each `<id>/client.ts`
 * imports only the leaves `workflow-tool-sets.ts` and `execution-policy.ts`. The whole pack in `index.ts` holds the
 * very objects this record holds, which `tests/unit/lib/agent/languages.test.ts` asserts.
 *
 * A registry of client facets (`AgentClientPacks`) holds every module language (`AgentModuleLanguageId`,
 * `MODULE_CLIENT_PACKS`), so a later module language does not compile until it registers its client facet here, and
 * then the languages declared as data it composes. The browser's registry, `BUNDLED_CLIENT_PACKS`, adds every language
 * the bundled declarations state agent data for, read from the statement language projection
 * (`BUNDLED_STATEMENT_LANGUAGE_DATA`) in its id order, the engines that state none left out, and composed from its data
 * by `declared-client.ts`: the browser's composition of the bundled declarations (`DECLARED_AGENT_LANGUAGES`), kept
 * until the browser reads a provider package's language, since a browser cannot read the server's engine catalog. Its
 * keys are declared in the order the projections in `agent-manifest.ts` list them, the module languages first.
 *
 * The registries in `server.ts`, `index.ts` and `mcp.ts` compose their declared languages from the server's installed
 * catalog instead, through the same two composers here, `composeDeclaredLanguages(servedLanguageData())`
 * (src/lib/db/operations/served-language-data.ts) and `declaredClientPack`; the server's registry of client facets is
 * `servedClientPacks` in `server.ts`. Both composers are memoized, the first per array of data and the second per agent
 * part, so every server registry reading one catalog reads one branded list, and the browser's registry and the
 * server's hold one client facet for one declared data object: a legacy engine's record holds the projection's own
 * data, so its declared language's facet is the one the browser's registry holds.
 *
 * It is also where an engine's granted statement language meets a registry: `grantedAgentStatementLanguage` reads the
 * `statementLanguage` grant of the engine it is handed, an engine record on the server or a legacy engine's grants in
 * the browser (`legacyAgentEngine` of `agent-manifest.ts`), against the registry its caller hands, the server's or the
 * browser's, so the manifest and the engine registry read the grant through it, no reader picks a registry for its
 * caller, and no table of Studio's is keyed by an engine here.
 */
import type { StatementLanguageData } from "@libredb/provider-sdk/manifest";
import type { EngineGrants } from "@/lib/db/claim-grants";
import { BUNDLED_STATEMENT_LANGUAGE_DATA } from "@/lib/db/engine-catalog/statement-language.generated";
import type { AgentModuleLanguageId, AgentStatementLanguageId } from "../agent-manifest";
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
import { S3API_CLIENT_PACK } from "./s3api/client";
import { FSQUERY_CLIENT_PACK } from "./fsquery/client";
import { SNMPGET_CLIENT_PACK } from "./snmpget/client";
import { NETCONFRPC_CLIENT_PACK } from "./netconfrpc/client";
import { MODBUSREAD_CLIENT_PACK } from "./modbusread/client";
import { PROMQL_CLIENT_PACK } from "./promql/client";
import { OPCUAREAD_CLIENT_PACK } from "./opcuaread/client";
import { MTCONNECTREAD_CLIENT_PACK } from "./mtconnectread/client";
import { MQTTREAD_CLIENT_PACK } from "./mqttread/client";
import { SPARKPLUGREAD_CLIENT_PACK } from "./sparkplugread/client";
import { LIBREDBKV_CLIENT_PACK } from "./libredbkv/client";
import { MONGO_CLIENT_PACK } from "./mongo/client";
import { composeDeclaredClientPack, type DeclaredAgentLanguage, declaredAgentLanguages } from "./declared-client";
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
 * place an absent language is read. The id is not validated here: a ledger whose header names a language the server's
 * registry does not hold is refused when it is read (`runHeaderRefusal` in `run-ledger-ids.ts`), so such an id never
 * reaches a record, and a caller that passes one fails where its resolver names it.
 */
export function statementFamilyOf(language: AgentStatementLanguageId | undefined): AgentStatementLanguageId {
  return language ?? DEFAULT_STATEMENT_LANGUAGE;
}

/**
 * The statement languages Studio has retired: ids a run header may carry from an earlier release, whose pack this build
 * no longer holds. A header naming one is refused when its ledger is read, as retired rather than as unknown.
 *
 * Retiring a language means removing its pack while its id stays here, so the ledgers that name it keep being named.
 * A change that removes a language's pack adds its id to this set in the same change; the census in
 * `tests/unit/lib/agent/run-ledger-ids.test.ts` fails until it does. No language has been retired yet (measured over
 * the history of `AgentStatementLanguageId`), so the set is empty.
 */
export const RETIRED_STATEMENT_LANGUAGES: ReadonlySet<string> = new Set<string>();

/**
 * The module languages' client facets, by language, in the order every registry lists them: the part the browser's
 * registry and the server's share, each declared language composed after them.
 */
export const MODULE_CLIENT_PACKS = Object.freeze({
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
  s3api: S3API_CLIENT_PACK,
  fsquery: FSQUERY_CLIENT_PACK,
  snmpget: SNMPGET_CLIENT_PACK,
  netconfrpc: NETCONFRPC_CLIENT_PACK,
  modbusread: MODBUSREAD_CLIENT_PACK,
  promql: PROMQL_CLIENT_PACK,
  opcuaread: OPCUAREAD_CLIENT_PACK,
  mtconnectread: MTCONNECTREAD_CLIENT_PACK,
  mqttread: MQTTREAD_CLIENT_PACK,
  sparkplugread: SPARKPLUGREAD_CLIENT_PACK,
} satisfies Record<AgentModuleLanguageId, AgentLanguageClientPack>);

/** Each composition of `composeDeclaredLanguages`, by the array of data it was composed from. */
const DECLARED_LANGUAGES = new WeakMap<
  readonly NonNullable<StatementLanguageData>[],
  readonly DeclaredAgentLanguage[]
>();

/**
 * The agent languages `data` states, in its order, each name branded (`declaredAgentLanguages`), composed once per
 * array: a declared name a module language holds, or one two data share, fails here by name.
 *
 * @throws {Error} Naming the language, where a declared name is a module language's or two data state one name.
 */
export function composeDeclaredLanguages(
  data: readonly NonNullable<StatementLanguageData>[],
): readonly DeclaredAgentLanguage[] {
  let languages = DECLARED_LANGUAGES.get(data);
  if (languages === undefined) {
    languages = declaredAgentLanguages(data, Object.keys(MODULE_CLIENT_PACKS));
    DECLARED_LANGUAGES.set(data, languages);
  }
  return languages;
}

/** Each declared language's client facet, by the agent part it was composed from. */
const DECLARED_CLIENT_PACKS = new WeakMap<DeclaredAgentLanguage["agent"], AgentLanguageClientPack>();

/**
 * The client facet of declared language `language`, composed from its text once per agent part
 * (`composeDeclaredClientPack`), so the browser's registry and the server's hold one facet for one data object.
 */
export function declaredClientPack(language: DeclaredAgentLanguage): AgentLanguageClientPack {
  let pack = DECLARED_CLIENT_PACKS.get(language.agent);
  if (pack === undefined) {
    pack = composeDeclaredClientPack(language.agent.text);
    DECLARED_CLIENT_PACKS.set(language.agent, pack);
  }
  return pack;
}

/**
 * The languages the bundled declarations state agent data for, in their order: the browser's composition, read once
 * at load from the projection.
 */
export const DECLARED_AGENT_LANGUAGES: readonly DeclaredAgentLanguage[] = composeDeclaredLanguages(
  Object.values(BUNDLED_STATEMENT_LANGUAGE_DATA).filter((data) => data !== null),
);

/**
 * The client facet of every statement language one registry holds, by language, the module languages first: the
 * browser's composition of the bundled declarations (`BUNDLED_CLIENT_PACKS`) or the server's, composed from its
 * installed catalog (`servedClientPacks` in `server.ts`). Every reader below that resolves a language is handed one, so
 * no reader picks a registry for its caller.
 */
export type AgentClientPacks = Readonly<Record<AgentStatementLanguageId, AgentLanguageClientPack>>;

/**
 * The browser's registry: the module languages and the languages the bundled declarations state, composed at load. It
 * is kept until the browser reads the server's catalog (M7); the server never reads it, and reads `servedClientPacks`
 * in `server.ts` instead (`tests/unit/lib/agent/served-language-facts.test.ts` holds that no server module imports it).
 */
export const BUNDLED_CLIENT_PACKS: AgentClientPacks = Object.freeze({
  ...MODULE_CLIENT_PACKS,
  ...Object.fromEntries(DECLARED_AGENT_LANGUAGES.map((language) => [language.id, declaredClientPack(language)])),
});

const LIVE_STATEMENT_LANGUAGES: ReadonlySet<string> = new Set(Object.keys(BUNDLED_CLIENT_PACKS));

/**
 * Whether `value` is exactly one of the statement languages the browser's composition holds a pack for, a module
 * language or one the bundled declarations state as data. A prototype key is not one.
 */
export function isAgentStatementLanguage(value: string): value is AgentStatementLanguageId {
  return LIVE_STATEMENT_LANGUAGES.has(value);
}

/**
 * The agent's statement language for `engine`'s granted statement language `granted`: `granted` itself where it is
 * null or a language `packs` holds, a module language or one the registry composed from data. A grant reads a language
 * as a name of the register's form, not as Studio's list, so this is the one place a granted name meets the agent's
 * packs, and the registry the caller hands decides which languages exist: the server's, composed from its installed
 * catalog, or the browser's. An engine's register row, a legacy engine's or a package's, grants only a language Studio
 * reviewed, and the server's registry composes every language a served record's grant names its data for, so a name
 * with no pack is a host defect.
 *
 * @throws {Error} Naming the engine and the language, where `packs` holds no pack for `granted`.
 */
export function agentLanguageOfGrant(
  engine: string,
  granted: string | null,
  packs: AgentClientPacks,
): AgentStatementLanguageId | null {
  if (granted === null || Object.hasOwn(packs, granted)) return granted as AgentStatementLanguageId | null;
  throw new Error(
    `${engine} is granted the statement language ${JSON.stringify(granted)}, for which agent mode holds no pack`,
  );
}

/**
 * The agent's statement language for `engine`: the `statementLanguage` grant its grants hold, an engine record's or a
 * legacy engine's, read as the agent's language against `packs` (`agentLanguageOfGrant`), or null where the grant is
 * null.
 *
 * @throws {Error} Naming the engine and the language, where `packs` holds no pack for the granted language.
 */
export function grantedAgentStatementLanguage(
  engine: {
    readonly id: string;
    readonly grants: Pick<EngineGrants, "statementLanguage">;
  },
  packs: AgentClientPacks,
): AgentStatementLanguageId | null {
  return agentLanguageOfGrant(engine.id, engine.grants.statementLanguage, packs);
}

/**
 * The client facet for `language` in the browser's composition. The record holds every module language and every
 * declared one, and a declared id is only ever branded for a language the record holds, so a typed id always has one.
 */
export function languageClientPack(language: AgentStatementLanguageId): AgentLanguageClientPack {
  return BUNDLED_CLIENT_PACKS[language];
}

/**
 * One member of every client facet of the browser's composition, keyed by language in the order the packs are
 * declared, frozen. A null pick stays an own key, so a language with nothing to say is still listed.
 */
export function projectClientPacks<Value>(
  pick: (pack: AgentLanguageClientPack) => Value,
): Readonly<Record<AgentStatementLanguageId, Value>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(BUNDLED_CLIENT_PACKS).map(([id, pack]) => [id, pick(pack)])) as Record<
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
    S3API_CLIENT_PACK.evidenceEvents,
    FSQUERY_CLIENT_PACK.evidenceEvents,
    SNMPGET_CLIENT_PACK.evidenceEvents,
    NETCONFRPC_CLIENT_PACK.evidenceEvents,
    MODBUSREAD_CLIENT_PACK.evidenceEvents,
    PROMQL_CLIENT_PACK.evidenceEvents,
    OPCUAREAD_CLIENT_PACK.evidenceEvents,
    MTCONNECTREAD_CLIENT_PACK.evidenceEvents,
    MQTTREAD_CLIENT_PACK.evidenceEvents,
    SPARKPLUGREAD_CLIENT_PACK.evidenceEvents,
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
    S3API_CLIENT_PACK.shortfallSentences,
    FSQUERY_CLIENT_PACK.shortfallSentences,
    SNMPGET_CLIENT_PACK.shortfallSentences,
    NETCONFRPC_CLIENT_PACK.shortfallSentences,
    MODBUSREAD_CLIENT_PACK.shortfallSentences,
    PROMQL_CLIENT_PACK.shortfallSentences,
    OPCUAREAD_CLIENT_PACK.shortfallSentences,
    MTCONNECTREAD_CLIENT_PACK.shortfallSentences,
    MQTTREAD_CLIENT_PACK.shortfallSentences,
    SPARKPLUGREAD_CLIENT_PACK.shortfallSentences,
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
    S3API_CLIENT_PACK.readingRefusalHeadlines,
    FSQUERY_CLIENT_PACK.readingRefusalHeadlines,
    SNMPGET_CLIENT_PACK.readingRefusalHeadlines,
    NETCONFRPC_CLIENT_PACK.readingRefusalHeadlines,
    MODBUSREAD_CLIENT_PACK.readingRefusalHeadlines,
    PROMQL_CLIENT_PACK.readingRefusalHeadlines,
    OPCUAREAD_CLIENT_PACK.readingRefusalHeadlines,
    MTCONNECTREAD_CLIENT_PACK.readingRefusalHeadlines,
    MQTTREAD_CLIENT_PACK.readingRefusalHeadlines,
    SPARKPLUGREAD_CLIENT_PACK.readingRefusalHeadlines,
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
    S3API_CLIENT_PACK.requirements,
    FSQUERY_CLIENT_PACK.requirements,
    SNMPGET_CLIENT_PACK.requirements,
    NETCONFRPC_CLIENT_PACK.requirements,
    MODBUSREAD_CLIENT_PACK.requirements,
    PROMQL_CLIENT_PACK.requirements,
    OPCUAREAD_CLIENT_PACK.requirements,
    MTCONNECTREAD_CLIENT_PACK.requirements,
    MQTTREAD_CLIENT_PACK.requirements,
    SPARKPLUGREAD_CLIENT_PACK.requirements,
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

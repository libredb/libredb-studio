/**
 * The statement language packs, whole (#1821): the resolver the run loop (`investigation.ts`) reads.
 *
 * Execution tier. A pack's execution facet runs through the audited call in `tools.ts`, so this module sits above
 * `tools.ts`, and only the run loop imports it. `tools.ts` reads the server facet alone, through `languageServerPack`
 * in `server.ts`, which returns the very object a pack here holds.
 *
 * The record holds every module language (`AgentModuleLanguageId`), so a later module language does not compile until
 * it registers its pack here, and then every language the installed server catalog grants a served engine as data
 * (`servedLanguageData` in src/lib/db/operations/served-language-data.ts), whole: the client facet the server reads
 * for it (`serverLanguageClientPack`) and the server facet `server.ts` holds, and an execution facet with no tool arm
 * and no evidence tool, since a declared language's variants offer the read and the report only. The record is
 * composed after boot, on its first read, once per installed catalog, and every read refuses a read made while boot
 * has begun and not yet installed the catalog, or after a boot that ended by an error, with the accessor's named
 * errors. A language id the record does not hold can still arrive from a ledger, and reaching one is a named error
 * rather than a quiet fall back to SQL.
 */
import { servedLanguageData } from "@/lib/db/operations/served-language-data";
import type { AgentModuleLanguageId, AgentStatementLanguageId } from "../agent-manifest";
import { mergeDisjoint } from "../disjoint-merge";
import { INFLUXQL_PACK } from "./influxql/index";
import { KUBECTL_PACK } from "./kubectl/index";
import { LIBREDBKV_PACK } from "./libredbkv/index";
import { MONGO_PACK } from "./mongo/index";
import { WEAVIATEAPI_PACK } from "./weaviateapi/index";
import { QDRANTAPI_PACK } from "./qdrantapi/index";
import { CYPHER_PACK } from "./cypher/index";
import { MILVUSRPC_PACK } from "./milvusrpc/index";
import { REDISCLI_PACK } from "./rediscli/index";
import { ETCDCTL_PACK } from "./etcdctl/index";
import { OXIACLI_PACK } from "./oxiacli/index";
import { RABBITREAD_PACK } from "./rabbitread/index";
import { S3API_PACK } from "./s3api/index";
import { FSQUERY_PACK } from "./fsquery/index";
import { SNMPGET_PACK } from "./snmpget/index";
import { NETCONFRPC_PACK } from "./netconfrpc/index";
import { MODBUSREAD_PACK } from "./modbusread/index";
import { PROMQL_PACK } from "./promql/index";
import { OPCUAREAD_PACK } from "./opcuaread/index";
import { MTCONNECTREAD_PACK } from "./mtconnectread/index";
import { MQTTREAD_PACK } from "./mqttread/index";
import { SPARKPLUGREAD_PACK } from "./sparkplugread/index";
import { composeDeclaredLanguages } from "./client";
import type { DeclaredAgentLanguage } from "./declared-client";
import type { AgentEvidenceTool, AgentLanguagePack, EvidenceToolName, LanguageToolArms } from "./pack";
import { languageServerPack, serverLanguageClientPack } from "./server";
import { SQL_PACK } from "./sql/index";

const MODULE_PACKS = Object.freeze({
  sql: SQL_PACK,
  kubectl: KUBECTL_PACK,
  mongo: MONGO_PACK,
  libredbkv: LIBREDBKV_PACK,
  influxql: INFLUXQL_PACK,
  weaviateapi: WEAVIATEAPI_PACK,
  qdrantapi: QDRANTAPI_PACK,
  cypher: CYPHER_PACK,
  milvusrpc: MILVUSRPC_PACK,
  rediscli: REDISCLI_PACK,
  etcdctl: ETCDCTL_PACK,
  oxiacli: OXIACLI_PACK,
  rabbitread: RABBITREAD_PACK,
  s3api: S3API_PACK,
  fsquery: FSQUERY_PACK,
  snmpget: SNMPGET_PACK,
  netconfrpc: NETCONFRPC_PACK,
  modbusread: MODBUSREAD_PACK,
  promql: PROMQL_PACK,
  opcuaread: OPCUAREAD_PACK,
  mtconnectread: MTCONNECTREAD_PACK,
  mqttread: MQTTREAD_PACK,
  sparkplugread: SPARKPLUGREAD_PACK,
} satisfies Record<AgentModuleLanguageId, AgentLanguagePack>);

/** The packs of one installed catalog, and their tool arms by language. */
interface ServedPacks {
  readonly packs: Readonly<Record<AgentStatementLanguageId, AgentLanguagePack>>;
  readonly arms: Readonly<Record<AgentStatementLanguageId, LanguageToolArms>>;
}

/** Each composition, by the branded list of declared languages it was composed from. */
const SERVED_PACKS = new WeakMap<readonly DeclaredAgentLanguage[], ServedPacks>();

/**
 * The packs of the installed catalog: the module languages', then each served declared language's, its registered
 * facets and no tool arm or evidence tool; composed once per installed catalog.
 *
 * @throws {AgentLanguageCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {AgentLanguageCatalogBootUnfinishedError} After a boot that ended by an error before it installed the
 *   server's engine catalog.
 * @throws {Error} Naming the language, where a granted name is a module language's or two served engines state it.
 */
function servedPacks(): ServedPacks {
  const declared = composeDeclaredLanguages(servedLanguageData());
  let served = SERVED_PACKS.get(declared);
  if (served === undefined) {
    const packs: Readonly<Record<string, AgentLanguagePack>> = Object.fromEntries(
      declared.map(({ id }) => [
        id,
        Object.freeze({
          id,
          client: serverLanguageClientPack(id),
          server: languageServerPack(id),
          execution: Object.freeze({ arms: Object.freeze({}), evidenceTools: Object.freeze({}) }),
        }),
      ]),
    );
    served = Object.freeze({
      packs: Object.freeze({ ...MODULE_PACKS, ...packs }),
      arms: Object.freeze({
        ...MODULE_TOOL_ARMS,
        ...Object.fromEntries(Object.entries(packs).map(([id, pack]) => [id, pack.execution.arms])),
      }),
    });
    SERVED_PACKS.set(declared, served);
  }
  return served;
}

/**
 * The pack for `language`, or a named error when the id is not a language this server knows.
 *
 * @throws {AgentLanguageCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {AgentLanguageCatalogBootUnfinishedError} After a boot that ended by an error before it installed the
 *   server's engine catalog.
 */
export function agentLanguagePack(language: AgentStatementLanguageId): AgentLanguagePack {
  const { packs } = servedPacks();
  const pack = Object.hasOwn(packs, language) ? packs[language] : undefined;
  if (pack === undefined) throw new Error(`no language pack for ${language}`);
  return pack;
}

/**
 * Every pack's tool arms by language, the same objects the packs hold, a served declared language's after the module
 * languages', composed once per installed catalog. Read by the offer census.
 *
 * @throws {AgentLanguageCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {AgentLanguageCatalogBootUnfinishedError} After a boot that ended by an error before it installed the
 *   server's engine catalog.
 */
export function languageToolArms(): Readonly<Record<AgentStatementLanguageId, LanguageToolArms>> {
  return servedPacks().arms;
}

/** The module languages' tool arms by language, the same objects their packs hold. */
const MODULE_TOOL_ARMS = Object.freeze({
  sql: SQL_PACK.execution.arms,
  kubectl: KUBECTL_PACK.execution.arms,
  mongo: MONGO_PACK.execution.arms,
  libredbkv: LIBREDBKV_PACK.execution.arms,
  influxql: INFLUXQL_PACK.execution.arms,
  weaviateapi: WEAVIATEAPI_PACK.execution.arms,
  qdrantapi: QDRANTAPI_PACK.execution.arms,
  cypher: CYPHER_PACK.execution.arms,
  milvusrpc: MILVUSRPC_PACK.execution.arms,
  rediscli: REDISCLI_PACK.execution.arms,
  etcdctl: ETCDCTL_PACK.execution.arms,
  oxiacli: OXIACLI_PACK.execution.arms,
  rabbitread: RABBITREAD_PACK.execution.arms,
  s3api: S3API_PACK.execution.arms,
  fsquery: FSQUERY_PACK.execution.arms,
  snmpget: SNMPGET_PACK.execution.arms,
  netconfrpc: NETCONFRPC_PACK.execution.arms,
  modbusread: MODBUSREAD_PACK.execution.arms,
  promql: PROMQL_PACK.execution.arms,
  opcuaread: OPCUAREAD_PACK.execution.arms,
  mtconnectread: MTCONNECTREAD_PACK.execution.arms,
  mqttread: MQTTREAD_PACK.execution.arms,
  sparkplugread: SPARKPLUGREAD_PACK.execution.arms,
} satisfies Record<AgentModuleLanguageId, LanguageToolArms>);

/**
 * Every pack's evidence tools. Global by tool name, because the run loop dispatches a call by its name before it
 * reads the run's language, and a name two packs both hold fails at load.
 */
export const AGENT_EVIDENCE_TOOLS: Readonly<Record<EvidenceToolName, AgentEvidenceTool>> = mergeDisjoint(
  [
    SQL_PACK.execution.evidenceTools,
    KUBECTL_PACK.execution.evidenceTools,
    MONGO_PACK.execution.evidenceTools,
    LIBREDBKV_PACK.execution.evidenceTools,
    INFLUXQL_PACK.execution.evidenceTools,
    WEAVIATEAPI_PACK.execution.evidenceTools,
    QDRANTAPI_PACK.execution.evidenceTools,
    CYPHER_PACK.execution.evidenceTools,
    MILVUSRPC_PACK.execution.evidenceTools,
    REDISCLI_PACK.execution.evidenceTools,
    ETCDCTL_PACK.execution.evidenceTools,
    OXIACLI_PACK.execution.evidenceTools,
    RABBITREAD_PACK.execution.evidenceTools,
    S3API_PACK.execution.evidenceTools,
    FSQUERY_PACK.execution.evidenceTools,
    SNMPGET_PACK.execution.evidenceTools,
    NETCONFRPC_PACK.execution.evidenceTools,
    MODBUSREAD_PACK.execution.evidenceTools,
    PROMQL_PACK.execution.evidenceTools,
    OPCUAREAD_PACK.execution.evidenceTools,
    MTCONNECTREAD_PACK.execution.evidenceTools,
    MQTTREAD_PACK.execution.evidenceTools,
    SPARKPLUGREAD_PACK.execution.evidenceTools,
  ],
  "AGENT_EVIDENCE_TOOLS",
);

/**
 * The statement language packs, whole (#1821): the resolver the run loop (`investigation.ts`) reads.
 *
 * Execution tier. A pack's execution facet runs through the audited call in `tools.ts`, so this module sits above
 * `tools.ts`, and only the run loop imports it. `tools.ts` reads the server facet alone, through `languageServerPack`
 * in `server.ts`, which returns the very object a pack here holds.
 *
 * The record is total over `AgentStatementLanguageId`, so a later language does not compile until it registers its
 * pack here. A language id the record does not hold can still arrive from a ledger, and reaching one is a named error
 * rather than a quiet fall back to SQL.
 */
import type { AgentStatementLanguageId } from "../agent-manifest";
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
import { KAFKAREAD_PACK } from "./kafkaread/index";
import { S3API_PACK } from "./s3api/index";
import { FSQUERY_PACK } from "./fsquery/index";
import { SNMPGET_PACK } from "./snmpget/index";
import { NETCONFRPC_PACK } from "./netconfrpc/index";
import { MODBUSREAD_PACK } from "./modbusread/index";
import type { AgentEvidenceTool, AgentLanguagePack, EvidenceToolName, LanguageToolArms } from "./pack";
import { SQL_PACK } from "./sql/index";

const PACKS: Readonly<Record<AgentStatementLanguageId, AgentLanguagePack>> = Object.freeze({
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
  kafkaread: KAFKAREAD_PACK,
  s3api: S3API_PACK,
  fsquery: FSQUERY_PACK,
  snmpget: SNMPGET_PACK,
  netconfrpc: NETCONFRPC_PACK,
  modbusread: MODBUSREAD_PACK,
} satisfies Record<AgentStatementLanguageId, AgentLanguagePack>);

/** The pack for `language`, or a named error when the id is not a language this server knows. */
export function agentLanguagePack(language: AgentStatementLanguageId): AgentLanguagePack {
  const pack = Object.hasOwn(PACKS, language) ? PACKS[language] : undefined;
  if (pack === undefined) throw new Error(`no language pack for ${language}`);
  return pack;
}

/** Every pack's tool arms by language, the same objects the packs hold. Read by the offer census. */
export const LANGUAGE_TOOL_ARMS: Readonly<Record<AgentStatementLanguageId, LanguageToolArms>> = Object.freeze({
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
  kafkaread: KAFKAREAD_PACK.execution.arms,
  s3api: S3API_PACK.execution.arms,
  fsquery: FSQUERY_PACK.execution.arms,
  snmpget: SNMPGET_PACK.execution.arms,
  netconfrpc: NETCONFRPC_PACK.execution.arms,
  modbusread: MODBUSREAD_PACK.execution.arms,
} satisfies Record<AgentStatementLanguageId, LanguageToolArms>);

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
    KAFKAREAD_PACK.execution.evidenceTools,
    S3API_PACK.execution.evidenceTools,
    FSQUERY_PACK.execution.evidenceTools,
    SNMPGET_PACK.execution.evidenceTools,
    NETCONFRPC_PACK.execution.evidenceTools,
    MODBUSREAD_PACK.execution.evidenceTools,
  ],
  "AGENT_EVIDENCE_TOOLS",
);

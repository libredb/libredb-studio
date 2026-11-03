/**
 * What each statement language says to an MCP client: its MCP facet, one per language, as data.
 *
 * A facet holds what only its language knows about its MCP statement tool: the tool's name and title, the statement
 * argument's own input field, whether the tool takes a `database` key, its paging mode, whether the language's engines
 * hold any table, its description, the words its refusals and cut results are phrased in, and where they apply, the
 * least timeout its reads need and whether its answers carry the provider's warnings. `src/lib/mcp/` builds
 * every statement tool from this registry and names no language; neither this module nor any facet imports from
 * `src/lib/mcp/`, since the MCP module depends on the language packs and never the reverse.
 *
 * The record is total over `AgentStatementLanguageId`, as `SERVER_PACKS` in `server.ts` is, so a language that joins
 * agent mode does not compile until it declares its facet: a tool, or null while it has none. The tool names MCP's own
 * unions (the audit actions, `list_connections`' `read_tool`, the route's schema map) are derived from it.
 */
import type { z } from "zod";
import type { AgentStatementLanguageId } from "../agent-manifest";
import { CYPHER_MCP_FACET } from "./cypher/mcp";
import { ETCDCTL_MCP_FACET } from "./etcdctl/mcp";
import { KAFKAREAD_MCP_FACET } from "./kafkaread/mcp";
import { KUBECTL_MCP_FACET } from "./kubectl/mcp";
import { LIBREDBKV_MCP_FACET } from "./libredbkv/mcp";
import { MILVUSRPC_MCP_FACET } from "./milvusrpc/mcp";
import { MONGO_MCP_FACET } from "./mongo/mcp";
import { MQTTREAD_MCP_FACET } from "./mqttread/mcp";
import { MTCONNECTREAD_MCP_FACET } from "./mtconnectread/mcp";
import { QDRANTAPI_MCP_FACET } from "./qdrantapi/mcp";
import { RABBITREAD_MCP_FACET } from "./rabbitread/mcp";
import { REDISCLI_MCP_FACET } from "./rediscli/mcp";
import { SNMPGET_MCP_FACET } from "./snmpget/mcp";
import { SPARKPLUGREAD_MCP_FACET } from "./sparkplugread/mcp";
import { SQL_MCP_FACET } from "./sql/mcp";
import { WEAVIATEAPI_MCP_FACET } from "./weaviateapi/mcp";

/** What the MCP module hands a facet's description: the served engines' names and the shared result limits. */
export interface AgentLanguageMcpServed {
  readonly engines: string;
  /** The result limits every statement tool shares, as one clause with no closing full stop. */
  readonly limits: string;
}

/** What a tool fenced by its language's own admission says about a cut result, a refusal and an oversized row. */
export interface AgentLanguageMcpWords {
  /** How a byte-cut result fits more rows, as the opening of a clause: "Project fewer fields". */
  readonly fewerFields: string;
  /**
   * How to read past the `shown` rows a cut result of `statement` returned, as the end of a sentence that starts "To ".
   * `cut` names the cap that cut it, so advice that only a row cut can take, such as a higher max_rows, is left out of a
   * byte cut.
   */
  readonly readPast: (shown: number, cut: "max_rows" | "result_bytes", statement: string) => string;
  /** The answer when even the first row does not fit the result cap. */
  readonly rowOverCap: string;
  /** What a refused statement never reached, as a noun phrase: "the cluster", "the database". */
  readonly reached: string;
}

interface AgentLanguageMcpFacetBase {
  readonly tool: string;
  readonly title: string;
  /** The input field the statement arrives in, under the language's own argument name. */
  readonly statementInput: z.ZodType;
  /** True where the tool takes a `database` key: an engine of this language names a catalog per call. */
  readonly takesDatabase: boolean;
  /** True where an input key the tool does not name is refused, rather than dropped. */
  readonly strictInput: boolean;
  /**
   * True where this language's engines hold no object inspect_schema lists, so inspect_schema refuses them by name and
   * points to this tool rather than answering an empty page.
   */
  readonly holdsNoTables: boolean;
  /** The description up to the untrusted-content notice the MCP module closes every statement tool's with. */
  readonly describe: (served: AgentLanguageMcpServed) => string;
  /**
   * The least `timeout_ms` the tool takes, where its engine's read cannot be answered in less than the shared least of
   * 500 ms, and why, as the end of the sentence that refuses a smaller one before anything is acquired.
   */
  readonly leastTimeout?: { readonly ms: number; readonly why: string };
  /**
   * True where every warning the provider gives on this language's answers is Studio's own sentence, naming no stored
   * value, and one an answer must carry (a read's window and why it cannot be complete), so the warnings reach the
   * client as the answer's `notes`. Absent, a warning stays off the answer, and the description says what it would.
   */
  readonly answersWarnings?: true;
  /**
   * True where a connection's database setting is, on this language's engines, a stored value rather than a catalog's
   * name (a topic filter, a group id), so list_connections leaves it out of the connection's row. Absent, the row
   * carries it.
   */
  readonly withholdsDatabase?: true;
}

/**
 * A language's MCP facet. A tool pages with offset only under the MCP module's own read-only statement fence, whose
 * refusals and cut-result texts are shared; a tool fenced by the language's own admission takes no offset and speaks
 * its own words.
 */
export type AgentLanguageMcpFacet = AgentLanguageMcpFacetBase &
  (
    | { readonly paging: "offset"; readonly fence: "read-only-statement" }
    | { readonly paging: "none"; readonly fence: "language-admission"; readonly words: AgentLanguageMcpWords }
  );

/** Each statement language's MCP facet, or null where the language has no MCP tool. */
export const AGENT_LANGUAGE_MCP_FACETS = Object.freeze({
  sql: SQL_MCP_FACET,
  kubectl: KUBECTL_MCP_FACET,
  mongo: MONGO_MCP_FACET,
  libredbkv: LIBREDBKV_MCP_FACET,
  // No MCP statement tool yet: MCP read stays closed on InfluxDB until a change of its own declares one and opens it.
  influxql: null,
  weaviateapi: WEAVIATEAPI_MCP_FACET,
  qdrantapi: QDRANTAPI_MCP_FACET,
  cypher: CYPHER_MCP_FACET,
  milvusrpc: MILVUSRPC_MCP_FACET,
  rediscli: REDISCLI_MCP_FACET,
  etcdctl: ETCDCTL_MCP_FACET,
  // No MCP statement tool yet: MCP read stays closed on Oxia until a change of its own declares one and opens it.
  oxiacli: null,
  rabbitread: RABBITREAD_MCP_FACET,
  kafkaread: KAFKAREAD_MCP_FACET,
  // No MCP statement tool yet: MCP read stays closed on S3 until a change of its own declares one and opens it.
  s3api: null,
  // No MCP statement tool yet: MCP read stays closed on Firestore until a change of its own declares one and opens it.
  fsquery: null,
  snmpget: SNMPGET_MCP_FACET,
  // No MCP statement tool yet: MCP read stays closed on NETCONF until a change of its own declares one and opens it.
  netconfrpc: null,
  // No MCP statement tool yet: MCP read stays closed on Modbus until a change of its own declares one and opens it.
  modbusread: null,
  // No MCP statement tool yet: MCP read stays closed on Prometheus until a change of its own declares one and opens it.
  promql: null,
  // No MCP statement tool yet: MCP read stays closed on OPC UA until a change of its own declares one and opens it.
  opcuaread: null,
  mtconnectread: MTCONNECTREAD_MCP_FACET,
  mqttread: MQTTREAD_MCP_FACET,
  sparkplugread: SPARKPLUGREAD_MCP_FACET,
} satisfies Record<AgentStatementLanguageId, AgentLanguageMcpFacet | null>);

/** A facet some language declares, with its tool's name as a literal. */
export type AgentLanguageMcpDeclaredFacet = NonNullable<(typeof AGENT_LANGUAGE_MCP_FACETS)[AgentStatementLanguageId]>;

/** The statement tools' names, from the facets: each is an MCP tool and an audit action of its own. */
export type AgentLanguageMcpTool = AgentLanguageMcpDeclaredFacet["tool"];

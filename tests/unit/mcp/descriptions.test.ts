/**
 * What an MCP client reads before it calls anything (#246): the tool descriptions, which a
 * client may cut at 2,048 characters, so each says first what the tool does; the instructions,
 * at most 512 characters, which carry only server-wide facts; and the engine sentence, derived
 * from the one engine list rather than written out.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_EXECUTION_ENGINES, namedList } from "@/lib/agent/engine-support";
import { AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import { AGENT_LANGUAGE_MCP_FACETS, type AgentLanguageMcpFacet } from "@/lib/agent/languages/mcp";
import { getDBConfig } from "@/lib/db-ui-config";
import { MCP_EXPOSABLE, MCP_STATEMENT_READ } from "@/lib/db/compatibility";
import { MQTT_COMPLETENESS } from "@/lib/db/providers/keyvalue/mqtt/agent-read";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { MCP_INSTRUCTIONS } from "@/lib/mcp/server";
import { INSPECT_SCHEMA_DESCRIPTION, InspectSchemaInputSchema } from "@/lib/mcp/tools/inspect-schema";
import { LIST_CONNECTIONS_DESCRIPTION } from "@/lib/mcp/tools/list-connections";
import { mcpStatementArm, servingStatementArms } from "@/lib/mcp/tools/statement-arms";
import { RUN_READ_QUERY_DESCRIPTION, RUN_READ_QUERY_ENGINES, RUN_READ_QUERY_TYPES } from "../../helpers/run-read-query";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { handlerServe, legacyPost, readJsonRpc } from "../../helpers/mcp-harness";
import { servedEngineSeeds } from "../../helpers/mcp-served-seeds";

pinMcpTestEnvironment();

const RUN_KUBECTL_READ_ARM = mcpStatementArm("run_kubectl_read");
const RUN_MONGO_COMMAND_ARM = mcpStatementArm("run_mongo_command");
const RUN_LIBREDB_READ_ARM = mcpStatementArm("run_libredb_read");
const RUN_QDRANT_READ_ARM = mcpStatementArm("run_qdrant_read");
const RUN_MILVUS_READ_ARM = mcpStatementArm("run_milvus_read");
const RUN_MQTT_READ_ARM = mcpStatementArm("run_mqtt_read");
const RUN_SPARKPLUG_READ_ARM = mcpStatementArm("run_sparkplug_read");
const RUN_SNMP_READ_ARM = mcpStatementArm("run_snmp_read");
const RUN_OPCUA_READ_ARM = mcpStatementArm("run_opcua_read");
const RUN_ETCD_READ_ARM = mcpStatementArm("run_etcd_read");
const RUN_RABBITMQ_READ_ARM = mcpStatementArm("run_rabbitmq_read");
const RUN_KAFKA_READ_ARM = mcpStatementArm("run_kafka_read");
const RUN_REDIS_READ_ARM = mcpStatementArm("run_redis_read");

afterEach(async () => {
  await resetMcpTestState();
});

const seedDir = mkdtempSync(path.join(tmpdir(), "libredb-mcp-descriptions-"));

afterAll(() => {
  rmSync(seedDir, { recursive: true, force: true });
});

interface ListedTool {
  readonly name: string;
  readonly inputSchema: {
    readonly properties?: Record<string, { minimum?: number; maximum?: number; default?: number }>;
  };
}

/**
 * What a token that reaches every served engine lists, every registered tool among it. GOVERNANCE_SOURCE is cleared
 * while it lists, so a developer's environment never decides which connections are available.
 */
async function listedTools(): Promise<readonly ListedTool[]> {
  const governance = process.env.GOVERNANCE_SOURCE;
  delete process.env.GOVERNANCE_SOURCE;
  try {
    writeSeedFile(seedDir, servedEngineSeeds(seedDir));
    const reply = await readJsonRpc(await handlerServe()(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" })));
    return reply.result?.tools ?? [];
  } finally {
    if (governance === undefined) delete process.env.GOVERNANCE_SOURCE;
    else process.env.GOVERNANCE_SOURCE = governance;
  }
}

const METADATA_DESCRIPTIONS = [
  ["list_connections", LIST_CONNECTIONS_DESCRIPTION, "List the database connections"],
  ["inspect_schema", INSPECT_SCHEMA_DESCRIPTION, "List the tables of one connection"],
] as const;
/** Every statement tool this build registers, which a client reads beside the metadata tools. */
const STATEMENT_ARMS = servingStatementArms().map((arm) => [arm.tool, arm] as const);

describe("the tool descriptions", () => {
  test.each(METADATA_DESCRIPTIONS)(
    "%s fits 2,048 characters and says first what it does",
    (_name, description, opening) => {
      expect(description.length).toBeLessThanOrEqual(2_048);
      expect(description.startsWith(opening)).toBe(true);
    },
  );

  test.each(STATEMENT_ARMS)(
    "%s fits 2,048 characters and says first that it runs one read-only statement",
    (_tool, arm) => {
      expect(arm.description.length).toBeLessThanOrEqual(2_048);
      expect(arm.description).toMatch(/^Run one read-only /);
    },
  );

  // The labels are read here from the display records, not from the arm's engines, which the description interpolates.
  test.each(STATEMENT_ARMS)("%s names the engines it serves by their labels", (_tool, arm) => {
    expect(arm.description).toContain(`Runs on ${namedList(arm.types.map((type) => getDBConfig(type).label))}`);
  });

  test.each(STATEMENT_ARMS)("%s quotes database content, so it ends with the notice", (_tool, arm) => {
    expect(arm.description.endsWith(MCP_UNTRUSTED_NOTICE)).toBe(true);
  });

  test("inspect_schema ends with the notice, and list_connections carries none", () => {
    expect(INSPECT_SCHEMA_DESCRIPTION.endsWith(MCP_UNTRUSTED_NOTICE)).toBe(true);
    expect(LIST_CONNECTIONS_DESCRIPTION).not.toContain(MCP_UNTRUSTED_NOTICE);
  });

  test("run_read_query names the engines it serves, from the one list its handler gates on", () => {
    expect(RUN_READ_QUERY_ENGINES).toBe(namedList(RUN_READ_QUERY_TYPES.map((type) => getDBConfig(type).label)));
    expect(RUN_READ_QUERY_DESCRIPTION).toContain(
      `Runs on ${RUN_READ_QUERY_ENGINES}; other engines refuse it, and list_connections' read_tool names the tool that reads each connection.`,
    );
    expect(RUN_READ_QUERY_DESCRIPTION).not.toContain("use inspect_schema there");
  });

  // The engines left out are derived from the records rather than listed, so an engine that later opens MCP read, or
  // joins agent mode with its MCP read row false, moves between these sets without editing this file.
  test("an execution engine the records keep out of this tool is neither served nor named", () => {
    const withheld = AGENT_EXECUTION_ENGINES.filter(
      (candidate) =>
        !MCP_EXPOSABLE[candidate] || !MCP_STATEMENT_READ[candidate] || AGENT_STATEMENT_LANGUAGE[candidate] !== "sql",
    );
    // Not vacuous while any execution engine is kept out; today Kubernetes and MongoDB are.
    expect(withheld.length).toBeGreaterThan(0);
    for (const type of withheld) {
      expect(RUN_READ_QUERY_TYPES).not.toContain(type);
      expect(RUN_READ_QUERY_ENGINES).not.toContain(getDBConfig(type).label);
    }
  });

  test("run_mongo_command names MongoDB, the one engine its handler gates on, and says it takes no offset", () => {
    expect(RUN_MONGO_COMMAND_ARM.description).toContain("Runs on MongoDB; other engines refuse it.");
    expect(RUN_MONGO_COMMAND_ARM.description).toContain("this tool takes no offset");
  });

  test("run_kubectl_read names Kubernetes, the one engine its handler gates on, and says what it masks", () => {
    expect(RUN_KUBECTL_READ_ARM.description).toContain("Runs on Kubernetes; other engines refuse it.");
    expect(RUN_KUBECTL_READ_ARM.description).toContain("a Secret's name in every field defined to hold one");
    expect(RUN_KUBECTL_READ_ARM.description).not.toContain("wherever it appears");
    expect(RUN_KUBECTL_READ_ARM.description).toContain(
      "Free-text status, event and log messages are not masked, so a Secret's name or a value an application printed can reach you there.",
    );
    expect(RUN_KUBECTL_READ_ARM.description).toContain("this tool takes no offset");
  });

  test("run_libredb_read names LibreDB, the one engine its handler gates on, and says what it never answers", () => {
    expect(RUN_LIBREDB_READ_ARM.description).toContain("Runs on LibreDB; other engines refuse it.");
    expect(RUN_LIBREDB_READ_ARM.description).toContain("The file's own internal catalog keys are never answered.");
    expect(RUN_LIBREDB_READ_ARM.description).toContain("this tool takes no offset");
  });

  test("run_qdrant_read names Qdrant, the one engine its handler gates on, and says its answers are metadata only", () => {
    expect(RUN_QDRANT_READ_ARM.description).toContain("Runs on Qdrant; other engines refuse it.");
    expect(RUN_QDRANT_READ_ARM.description).toContain("names, counts and flags only, never a stored payload or vector");
    expect(RUN_QDRANT_READ_ARM.description).toContain("this tool takes no offset");
  });

  test("run_mqtt_read names MQTT, says it answers totals only, carries the completeness sentence and its least timeout", () => {
    expect(RUN_MQTT_READ_ARM.description).toContain("Runs on MQTT; other engines refuse it.");
    expect(RUN_MQTT_READ_ARM.description).toContain("answers totals only");
    expect(RUN_MQTT_READ_ARM.description).toContain("never a topic name");
    expect(RUN_MQTT_READ_ARM.description).toContain(MQTT_COMPLETENESS);
    expect(RUN_MQTT_READ_ARM.description).toContain("The first call on a connection opens two broker sessions");
    expect(RUN_MQTT_READ_ARM.description).toContain("a later call opens the read alone");
    expect(RUN_MQTT_READ_ARM.description).toContain("timeout_ms must be at least 5000");
    expect(RUN_MQTT_READ_ARM.description).toContain("inspect_schema refuses an MQTT connection");
    expect(RUN_MQTT_READ_ARM.description).toContain("this tool takes no offset");
  });

  test("run_sparkplug_read names Sparkplug B, says it names no id, carries the completeness sentence and its least timeout", () => {
    expect(RUN_SPARKPLUG_READ_ARM.description).toContain("Runs on Sparkplug B; other engines refuse it.");
    expect(RUN_SPARKPLUG_READ_ARM.description).toContain("answers totals only");
    expect(RUN_SPARKPLUG_READ_ARM.description).toContain("never a metric name or value and never the id it named");
    expect(RUN_SPARKPLUG_READ_ARM.description).toContain(
      "an edge node or device not seen in the window may still exist, and no answer says one is online, offline or absent",
    );
    expect(RUN_SPARKPLUG_READ_ARM.description).toContain("The first call on a connection opens two broker sessions");
    expect(RUN_SPARKPLUG_READ_ARM.description).toContain("a later call opens the read alone");
    expect(RUN_SPARKPLUG_READ_ARM.description).toContain("timeout_ms must be at least 5000");
    expect(RUN_SPARKPLUG_READ_ARM.description).toContain("inspect_schema lists no group, edge node or device");
    expect(RUN_SPARKPLUG_READ_ARM.description).toContain("this tool takes no offset");
  });

  test("run_snmp_read names SNMP, says what it withholds and why its notes say so, that the community is no principal, and takes no offset", () => {
    expect(RUN_SNMP_READ_ARM.description).toContain("Runs on SNMP; other engines refuse it.");
    expect(RUN_SNMP_READ_ARM.description).toContain("the running processes (hrSWRun, 1.3.6.1.2.1.25.4)");
    expect(RUN_SNMP_READ_ARM.description).toContain(
      "the commands the agent runs and what they print (1.3.6.1.4.1.8072.1.3, 1.3.6.1.4.1.2021.8 and 1.3.6.1.4.1.2021.2.1.103)",
    );
    expect(RUN_SNMP_READ_ARM.description).toContain(
      "Cisco's copy tables (1.3.6.1.4.1.9.9.96 and 1.3.6.1.4.1.9.9.10.1.2.1)",
    );
    expect(RUN_SNMP_READ_ARM.description).toContain("the answer's notes name each and why");
    expect(RUN_SNMP_READ_ARM.description).toContain("The community is no principal");
    expect(RUN_SNMP_READ_ARM.description).toContain("none inside a withheld subtree");
    expect(RUN_SNMP_READ_ARM.description).toContain("this tool takes no offset");
  });

  test("run_opcua_read names OPC UA, its three reads, the units, the read roots and the two facts an answer reveals", () => {
    const description = RUN_OPCUA_READ_ARM.description;
    expect(description.length).toBeLessThanOrEqual(2_048);
    expect(description).toContain("Runs on OPC UA; other engines refuse it.");
    expect(description).toContain('{"read": ["ns=3;s=SlowUInt1", ...]}');
    expect(description).toContain('{"history": "<node id>"');
    expect(description).toContain('{"browse": "<node id>"}');
    expect(description).toContain("Each value carries its engineering units and EU range, or no units published");
    expect(description).toContain("never assume a unit");
    expect(description).toContain("It reads only beneath the read roots the connection's operator declared");
    expect(description).toContain('{"browse": "i=85"} lists them');
    expect(description).toContain(
      "answers exactly as a node the server does not hold (statusCode BadNodeIdUnknown, no value), and nothing is sent for it",
    );
    expect(description).toContain("a browse of a node says how many of its references lead outside, naming none");
    expect(description).toContain("a value whose units property lies outside answers that its units were not read");
    expect(description).toContain("The session's identity is no boundary");
    expect(description).toContain("inspect_schema refuses an OPC UA connection");
    expect(description).toContain("Only Browse, BrowseNext, Read and HistoryRead are sent");
    expect(description).toContain("this tool takes no offset");
    expect(description).not.toContain("ithheld");
  });

  test("run_milvus_read names Milvus, the one engine its handler gates on, says what it never reads, and takes no offset", () => {
    expect(RUN_MILVUS_READ_ARM.description).toContain("Runs on Milvus; other engines refuse it.");
    expect(RUN_MILVUS_READ_ARM.description).toContain("never a stored field value or vector");
    expect(RUN_MILVUS_READ_ARM.description).toContain("this tool takes no offset");
  });

  test("run_etcd_read names etcd, the one engine its handler gates on, and says its answers are metadata only", () => {
    expect(RUN_ETCD_READ_ARM.description).toContain("Runs on etcd; other engines refuse it.");
    expect(RUN_ETCD_READ_ARM.description).toContain("names, counts and sizes only");
    expect(RUN_ETCD_READ_ARM.description).toContain("this tool takes no offset");
  });

  test("run_kafka_read names Apache Kafka, the one engine its handler gates on, says what it never reads, and pages with after", () => {
    expect(RUN_KAFKA_READ_ARM.description).toContain("Runs on Apache Kafka; other engines refuse it.");
    expect(RUN_KAFKA_READ_ARM.description).toContain("no record's key, value, headers or timestamp is ever fetched");
    expect(RUN_KAFKA_READ_ARM.description).toContain("this tool takes no offset");
    expect(RUN_KAFKA_READ_ARM.description).toContain('page inside the request with "limit" and "after"');
  });

  test("run_rabbitmq_read names RabbitMQ, the one engine its handler gates on, and says what it withholds", () => {
    expect(RUN_RABBITMQ_READ_ARM.description).toContain("Runs on RabbitMQ; other engines refuse it.");
    expect(RUN_RABBITMQ_READ_ARM.description).toContain(
      "a message's body, headers, properties and routing key are withheld",
    );
    expect(RUN_RABBITMQ_READ_ARM.description).toContain("this tool takes no offset");
  });

  test("run_redis_read names Redis, the one engine its handler gates on, and says its answer never repeats the key", () => {
    expect(RUN_REDIS_READ_ARM.description).toContain("Runs on Redis; other engines refuse it.");
    expect(RUN_REDIS_READ_ARM.description).toContain(
      "Key names count as stored values, so the answer is one row of counts, types and sizes that never repeats the key",
    );
    expect(RUN_REDIS_READ_ARM.description).toContain("this tool takes no offset");
  });

  test("inspect_schema says an engine with no tables refuses it, and where to read it instead", () => {
    expect(INSPECT_SCHEMA_DESCRIPTION).toContain(
      "Works on every engine that holds tables. An engine whose objects are not tables refuses it, and the refusal names the tool that reads it, as list_connections' read_tool does.",
    );
    expect(INSPECT_SCHEMA_DESCRIPTION).not.toContain("Works on every engine.");
    // Shared copy names no engine: the refusal names the engine's own tool.
    expect(INSPECT_SCHEMA_DESCRIPTION).not.toContain("Kubernetes");
  });

  test("names no statement form, because the forms differ by engine and the refusal names them", () => {
    expect(RUN_READ_QUERY_DESCRIPTION).not.toContain("VALUES");
    expect(RUN_READ_QUERY_DESCRIPTION).not.toContain("TABLE");
    expect(RUN_READ_QUERY_DESCRIPTION).toContain(
      "A SELECT runs on every engine it serves; a refused statement's answer names what else that engine takes.",
    );
    // Elasticsearch parses a WITH and reads a name it defines as an index, so no WITH is promised for every engine.
    expect(RUN_READ_QUERY_DESCRIPTION).not.toContain("WITH");
  });

  test("list_connections says it works on every engine, and inspect_schema on every engine that holds tables", () => {
    expect(INSPECT_SCHEMA_DESCRIPTION).toContain("Works on every engine that holds tables.");
    expect(LIST_CONNECTIONS_DESCRIPTION).toContain("Works for every engine.");
  });

  test("inspect_schema says, in static words, that sampled columns are left out", () => {
    expect(INSPECT_SCHEMA_DESCRIPTION).toContain(
      "Columns an engine only inferred from sampled data are left out, so a table may hold fields this list does not show.",
    );
  });
});

describe("timeout_ms", () => {
  test("every listed tool but list_connections takes it, and inspect_schema's bounds are run_read_query's", async () => {
    const tools = await listedTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(
      tools.filter((tool) => tool.inputSchema.properties?.timeout_ms === undefined).map((tool) => tool.name),
    ).toEqual(["list_connections"]);
    const bounds = (name: string) => {
      const timeout = tools.find((tool) => tool.name === name)?.inputSchema.properties?.timeout_ms;
      return { minimum: timeout?.minimum, maximum: timeout?.maximum };
    };
    // run_read_query's facet raises no least, so its bounds are the shared ones.
    expect((AGENT_LANGUAGE_MCP_FACETS.sql as AgentLanguageMcpFacet).leastTimeout).toBeUndefined();
    expect(bounds("inspect_schema")).toEqual(bounds("run_read_query"));
    expect(bounds("inspect_schema")).toEqual({ minimum: 500, maximum: 30_000 });
    expect(tools.find((tool) => tool.name === "inspect_schema")?.inputSchema.properties?.timeout_ms?.default).toBe(
      30_000,
    );
  });
});

describe("inspect_schema's own words", () => {
  test("describe include_foreign_keys with its cap and its hedge", () => {
    expect(InspectSchemaInputSchema.shape.include_foreign_keys.description).toBe(
      "Also return each table's foreign keys, at most 25, each as column, referenced_table and referenced_column, with foreign_keys_omitted counting the rest, or unavailable on an engine Studio reads no foreign keys on. A composite key comes back as one row per column pair, since no constraint name is returned, and an empty list may also mean the connection's login cannot see the keys.",
    );
  });

  test("describe include_schema_names with its bound and its level rule", () => {
    expect(InspectSchemaInputSchema.shape.include_schema_names.description).toBe(
      "Also return schema_names, the names schema can take here, in the engine's order: at most 100 names and 4 KiB of JSON, with schema_names_omitted counting the rest, and no name cut. Where the engine has a level above schemas, they are the ones under the container the session is in, or else the first listed; a connection with no schema level answers unavailable.",
    );
  });
});

describe("the instructions", () => {
  test("fit 512 characters and carry neither the notice nor a read-only claim", () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    expect(MCP_INSTRUCTIONS).not.toContain(MCP_UNTRUSTED_NOTICE);
    expect(MCP_INSTRUCTIONS.toLowerCase()).not.toContain("read-only");
  });

  test("send a statement to the tool a connection's read_tool names, not to one tool for every engine", () => {
    expect(MCP_INSTRUCTIONS).toContain("then run a read with the tool its read_tool names");
    expect(MCP_INSTRUCTIONS).not.toContain("run SQL with run_read_query");
  });

  test("reach a legacy client in the InitializeResult", async () => {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "descriptions-test", version: "1.0.0" },
      },
    };
    const result = (await readJsonRpc(await handlerServe()(legacyPost(initialize, { version: null })))).result;
    expect(result?.instructions).toBe(MCP_INSTRUCTIONS);
  });
});

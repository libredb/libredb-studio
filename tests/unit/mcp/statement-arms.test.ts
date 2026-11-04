/**
 * The MCP statement arms: one per statement language, total over the language ids, each built from its language's MCP
 * facet, reading its engines from the one served-engine resolver, and each non-SQL arm reading and fencing its statement
 * with the agent's own adapter, so an MCP client meets the agent's sentences. Every tool-name list MCP keeps is derived
 * from the arms.
 */
import { describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { AGENT_LANGUAGE_COPY, AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import {
  AGENT_LANGUAGE_MCP_FACETS,
  type AgentLanguageMcpFacet,
  type AgentLanguageMcpTool,
} from "@/lib/agent/languages/mcp";
import { languageServer } from "@/lib/agent/languages/server";
import { MCP_STATEMENT_READ, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { relationKindIds } from "@/lib/db/object-kinds";
import type { McpToolAction } from "@/lib/mcp/audit";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { MCP_TOOL_INPUT_SCHEMAS, type McpToolName } from "@/lib/mcp/tools";
import { ListedConnectionSchema } from "@/lib/mcp/tools/list-connections";
import { classifyReadQueryFailure } from "@/lib/mcp/tools/read-query-limits";
import { RUN_READ_QUERY_DESCRIPTION, RUN_READ_QUERY_TYPES } from "../../helpers/run-read-query";
import { registerStatementTools } from "@/lib/mcp/tools/run-statement";
import { mcpStatementEngines } from "@/lib/mcp/tools/served-engines";
import {
  MCP_STATEMENT_ARMS,
  type McpStatementTool,
  mcpStatementArm,
  mcpStatementToolFor,
  mcpTablelessReadTool,
  mcpWithholdsDatabase,
  servingStatementArms,
} from "@/lib/mcp/tools/statement-arms";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

const ARMS = Object.values(MCP_STATEMENT_ARMS).flatMap((arm) => (arm === null ? [] : [arm]));
const RUN_READ_QUERY_ARM = mcpStatementArm("run_read_query");
const RUN_KUBECTL_READ_ARM = mcpStatementArm("run_kubectl_read");
const RUN_MONGO_COMMAND_ARM = mcpStatementArm("run_mongo_command");
const RUN_LIBREDB_READ_ARM = mcpStatementArm("run_libredb_read");
const RUN_QDRANT_READ_ARM = mcpStatementArm("run_qdrant_read");
const RUN_ETCD_READ_ARM = mcpStatementArm("run_etcd_read");
const RUN_KAFKA_READ_ARM = mcpStatementArm("run_kafka_read");
const RUN_RABBITMQ_READ_ARM = mcpStatementArm("run_rabbitmq_read");
const RUN_CYPHER_READ_ARM = mcpStatementArm("run_cypher_read");
const RUN_REDIS_READ_ARM = mcpStatementArm("run_redis_read");
const RUN_WEAVIATE_READ_ARM = mcpStatementArm("run_weaviate_read");
const RUN_MTCONNECT_READ_ARM = mcpStatementArm("run_mtconnect_read");
const RUN_MILVUS_READ_ARM = mcpStatementArm("run_milvus_read");
const RUN_MQTT_READ_ARM = mcpStatementArm("run_mqtt_read");
const RUN_SPARKPLUG_READ_ARM = mcpStatementArm("run_sparkplug_read");
const RUN_SNMP_READ_ARM = mcpStatementArm("run_snmp_read");
const RUN_OPCUA_READ_ARM = mcpStatementArm("run_opcua_read");
const RUN_S3_READ_ARM = mcpStatementArm("run_s3_read");
const RunKubectlReadInputSchema = RUN_KUBECTL_READ_ARM.inputSchema;
const RunReadQueryInputSchema = RUN_READ_QUERY_ARM.inputSchema;
const RunMongoCommandInputSchema = RUN_MONGO_COMMAND_ARM.inputSchema;
const RunLibredbReadInputSchema = RUN_LIBREDB_READ_ARM.inputSchema;
const RunQdrantReadInputSchema = RUN_QDRANT_READ_ARM.inputSchema;
const RunRabbitmqReadInputSchema = RUN_RABBITMQ_READ_ARM.inputSchema;
const RunCypherReadInputSchema = RUN_CYPHER_READ_ARM.inputSchema;
const RunRedisReadInputSchema = RUN_REDIS_READ_ARM.inputSchema;
const RunMtconnectReadInputSchema = RUN_MTCONNECT_READ_ARM.inputSchema;
const RunS3ReadInputSchema = RUN_S3_READ_ARM.inputSchema;

/** True only when `A` and `B` are the same union, member for member. */
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** The tools every engine shares, which no language's facet declares. */
const SHARED_TOOLS = ["list_connections", "inspect_schema"] as const;

describe("MCP_STATEMENT_ARMS", () => {
  test("is total over the statement languages, and keyed by the language each arm reads", () => {
    expect(Object.keys(MCP_STATEMENT_ARMS).sort()).toEqual(Object.keys(AGENT_LANGUAGE_COPY).sort());
    for (const [language, arm] of Object.entries(MCP_STATEMENT_ARMS)) {
      if (arm !== null) expect(arm.language).toBe(language as (typeof arm)["language"]);
    }
  });

  test("every declared facet has its arm, keyed by the facet's language and named by the facet's tool", () => {
    for (const [language, facet] of Object.entries(AGENT_LANGUAGE_MCP_FACETS)) {
      if (facet === null) continue;
      const arm = MCP_STATEMENT_ARMS[language as keyof typeof MCP_STATEMENT_ARMS];
      expect(arm?.tool).toBe(facet.tool);
      expect(arm?.language).toBe(language as never);
    }
  });

  test("the tool names are distinct, run_<word>_<read|query|command> shaped, a word a digit may end, and none is a metadata tool's", () => {
    const tools = ARMS.map((arm) => arm.tool);
    expect(new Set(tools).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool).toMatch(/^run_[a-z][a-z0-9]*_(?:read|query|command)$/);
      expect(SHARED_TOOLS as readonly string[]).not.toContain(tool);
    }
  });

  test("a language with no MCP tool yet has no arm, and its engine no read tool", () => {
    const idle = Object.entries(AGENT_LANGUAGE_MCP_FACETS).filter(([, facet]) => facet === null);
    expect(idle).not.toEqual([]);
    for (const [language] of idle) {
      expect(MCP_STATEMENT_ARMS[language as keyof typeof MCP_STATEMENT_ARMS]).toBeNull();
      for (const type of SHIPPED_DATABASE_TYPES.filter((shipped) => AGENT_STATEMENT_LANGUAGE[shipped] === language))
        expect(mcpStatementToolFor(type)).toBeNull();
    }
  });

  test("is built from the languages' MCP facets, one arm per declared facet, in the registry's order", () => {
    expect(Object.keys(MCP_STATEMENT_ARMS)).toEqual(Object.keys(AGENT_LANGUAGE_MCP_FACETS));
    for (const [language, facet] of Object.entries(AGENT_LANGUAGE_MCP_FACETS)) {
      const arm = MCP_STATEMENT_ARMS[language as keyof typeof MCP_STATEMENT_ARMS];
      expect(arm === null).toBe(facet === null);
      if (facet === null) continue;
      expect(arm?.tool).toBe(facet?.tool);
      expect(arm?.title).toBe(facet?.title);
      expect(arm?.paging).toBe(facet?.paging);
      expect(arm?.holdsNoTables).toBe(facet?.holdsNoTables);
      expect(arm?.inputSchema.shape[arm.argument]).toBe(facet?.statementInput as never);
      expect(Object.hasOwn(arm?.inputSchema.shape ?? {}, "database")).toBe(facet?.takesDatabase);
    }
  });

  test("takes the shared least timeout, 500 ms, unless its facet declares one, and refuses below it in its words", () => {
    for (const arm of ARMS) {
      const facet = AGENT_LANGUAGE_MCP_FACETS[arm.language] as AgentLanguageMcpFacet;
      const least = facet.leastTimeout?.ms ?? 500;
      const timeoutIssues = (timeout_ms: number) =>
        (arm.inputSchema.safeParse({ connection_id: "seed:c", timeout_ms }).error?.issues ?? [])
          .filter((issue) => issue.path.join(".") === "timeout_ms")
          .map((issue) => issue.message);
      expect(timeoutIssues(least)).toEqual([]);
      expect(timeoutIssues(least - 1)).toHaveLength(1);
      if (facet.leastTimeout !== undefined) {
        expect(timeoutIssues(least - 1)).toEqual([
          `timeout_ms must be at least ${least} for ${arm.tool}: ${facet.leastTimeout.why}`,
        ]);
      }
    }
    expect(
      ARMS.filter((arm) => (AGENT_LANGUAGE_MCP_FACETS[arm.language] as AgentLanguageMcpFacet).leastTimeout).map(
        (arm) => arm.tool,
      ),
    ).toEqual(["run_mqtt_read", "run_sparkplug_read"]);
  });

  test("carries the provider's warnings as notes only where its facet says they are Studio's own sentences", () => {
    for (const arm of ARMS) {
      const facet = AGENT_LANGUAGE_MCP_FACETS[arm.language] as AgentLanguageMcpFacet;
      expect(arm.answersWarnings).toBe(facet.answersWarnings === true);
    }
    // The window tools say what a window cannot; SNMP names the withheld subtrees a read stepped over or answered; S3
    // says a pinned connection's bucket list holds its one bucket; OPC UA lists the read roots and counts a member's
    // references that lead outside them.
    for (const arm of [
      RUN_MQTT_READ_ARM,
      RUN_SPARKPLUG_READ_ARM,
      RUN_SNMP_READ_ARM,
      RUN_S3_READ_ARM,
      RUN_OPCUA_READ_ARM,
    ])
      expect(arm.answersWarnings).toBe(true);
    expect(RUN_READ_QUERY_ARM.answersWarnings).toBe(false);
    expect(RUN_ETCD_READ_ARM.answersWarnings).toBe(false);
  });

  test("leaves a connection's database setting out of list_connections only where its facet says it is a stored value", () => {
    for (const arm of ARMS) {
      const facet = AGENT_LANGUAGE_MCP_FACETS[arm.language] as AgentLanguageMcpFacet;
      expect(arm.withholdsDatabase).toBe(facet.withholdsDatabase === true);
    }
    expect(ARMS.filter((arm) => arm.withholdsDatabase).map((arm) => arm.tool)).toEqual([
      "run_mqtt_read",
      "run_sparkplug_read",
    ]);
    expect(mcpWithholdsDatabase("mqtt")).toBe(true);
    expect(mcpWithholdsDatabase("sparkplug")).toBe(true);
    expect(mcpWithholdsDatabase("postgres")).toBe(false);
    expect(mcpWithholdsDatabase("spark")).toBe(false);
  });

  test("finds an arm by its tool, and names the tool no language declares", () => {
    for (const arm of ARMS) expect(mcpStatementArm(arm.tool)).toBe(arm);
    expect(() => mcpStatementArm("run_nothing" as McpStatementTool)).toThrow("no MCP statement arm for run_nothing");
  });

  test.each(ARMS.map((arm) => [arm.tool, arm] as const))(
    "%s takes the agent's own argument and reads its engines from the resolver",
    (_tool, arm) => {
      expect(arm.argument).toBe(AGENT_LANGUAGE_COPY[arm.language].argument);
      expect(arm.inputSchema.shape).toHaveProperty(arm.argument);
      expect(arm.types).toEqual(mcpStatementEngines(arm.language));
      for (const type of arm.types) expect(AGENT_STATEMENT_LANGUAGE[type]).toBe(arm.language);
    },
  );

  test.each(ARMS.map((arm) => [arm.tool, arm] as const))(
    "%s registers the schema the route validates against",
    (tool, arm) => {
      expect(MCP_TOOL_INPUT_SCHEMAS[tool]).toBe(arm.inputSchema as never);
    },
  );

  test.each(ARMS.map((arm) => [arm.tool, arm] as const))(
    "%s describes itself in 2,048 characters, names its engines and ends with the notice",
    (_tool, arm) => {
      expect(arm.description.length).toBeLessThanOrEqual(2_048);
      expect(arm.description).toContain(`Runs on ${arm.engines}`);
      expect(arm.description.endsWith(MCP_UNTRUSTED_NOTICE)).toBe(true);
    },
  );
});

/**
 * MCP writes no tool name by hand: the audit actions, the route's schema map and `list_connections`' `read_tool` are
 * all derived from the arms, so a language that declares a facet reaches every one of them and edits none.
 */
describe("the tool names MCP keeps are the arms' own", () => {
  test("the statement tools are the facets' tools, and the audit actions are those and the shared tools", () => {
    const statementTools: SameUnion<McpStatementTool, AgentLanguageMcpTool> = true;
    const actions: SameUnion<McpToolAction, (typeof SHARED_TOOLS)[number] | AgentLanguageMcpTool> = true;
    const names: SameUnion<McpToolName, McpToolAction> = true;
    expect([statementTools, actions, names]).toEqual([true, true, true]);
  });

  test("list_connections' read_tool takes exactly the arms' tools, in record order", () => {
    expect(ListedConnectionSchema.shape.read_tool.unwrap().options).toEqual(ARMS.map((arm) => arm.tool));
  });

  test("the route's schema map holds the shared tools, then exactly the arms' tools, in record order", () => {
    expect(Object.keys(MCP_TOOL_INPUT_SCHEMAS)).toEqual([...SHARED_TOOLS, ...ARMS.map((arm) => arm.tool)]);
  });
});

describe("the SQL arm", () => {
  test("is run_read_query as SQL clients knew it: sql, offset paging, the SQL fence", () => {
    expect(RUN_READ_QUERY_ARM.argument).toBe("sql");
    expect(RUN_READ_QUERY_ARM.paging).toBe("offset");
    expect(RUN_READ_QUERY_ARM.types).toBe(RUN_READ_QUERY_TYPES);
    expect(RUN_READ_QUERY_ARM.description).toBe(RUN_READ_QUERY_DESCRIPTION);
    expect(RUN_READ_QUERY_ARM.inputSchema.shape).toHaveProperty("offset");
    expect(RUN_READ_QUERY_ARM.canonicalize("SELECT 1")).toBe("SELECT 1");
    expect(RUN_READ_QUERY_ARM.canonicalize({ sql: "SELECT 1" })).toBeNull();
    expect(RUN_READ_QUERY_ARM.fence("SELECT 1", "sqlite")).toBeNull();
    expect(RUN_READ_QUERY_ARM.fence("DROP TABLE users", "sqlite")).toStartWith(
      "The statement was refused before it reached the database (",
    );
    expect(RUN_READ_QUERY_ARM.tooLarge("SELECT 1", "sqlite")).toEqual({});
    // Elasticsearch SQL has no OFFSET, so its row refusal does not tell the client to page with offset.
    expect(RUN_READ_QUERY_ARM.tooLarge("SELECT k FROM probe_buckets LIMIT 2000", "elasticsearch")).toEqual({
      rows: "The result has more than 1000 rows, the most this server reads for one call. Add a LIMIT of 1000 or less, and page it in SQL: ORDER BY a unique field, and for the next page add WHERE that field > the last value read.",
    });
    // Nor does CQL's, which has no OFFSET either.
    expect(RUN_READ_QUERY_ARM.tooLarge("SELECT id FROM probe.customers LIMIT 2000", "cassandra")).toEqual({
      rows: "The result has more than 1000 rows, the most this server reads for one call. Add a LIMIT of 1000 or less, and page it in SQL: LIMIT n, and for the next page add WHERE token(the partition key) > token(the last one read), or, within one partition, WHERE the clustering column > the last value read.",
    });
  });

  test("takes a database, drops an unknown key rather than refusing it, and refuses an empty statement in its own words", () => {
    expect(RUN_READ_QUERY_ARM.title).toBe("Run a read-only query");
    expect(RUN_READ_QUERY_ARM.inputSchema.shape).toHaveProperty("database");
    const parsed = RunReadQueryInputSchema.safeParse({
      connection_id: "seed:s",
      sql: "SELECT 1",
      database: "app",
      extra: 1,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ connection_id: "seed:s", sql: "SELECT 1", database: "app" });
    expect(parsed.data).not.toHaveProperty("extra");
    const empty = RunReadQueryInputSchema.safeParse({ connection_id: "seed:s", sql: "" });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues.map((issue) => issue.message)).toEqual(["SQL cannot be empty"]);
  });

  test("sends a client on another engine to the read_tool list_connections names, not to inspect_schema", () => {
    expect(RUN_READ_QUERY_ARM.description).toContain(
      `Runs on ${RUN_READ_QUERY_ARM.engines}; other engines refuse it, and list_connections' read_tool names the tool that reads each connection.`,
    );
    expect(RUN_READ_QUERY_ARM.description).not.toContain("inspect_schema");
  });
});

describe("the MongoDB arm", () => {
  const server = languageServer("mongo");
  const find = JSON.stringify({ collection: "orders", operation: "find" });

  test("takes the command object, no offset, and sends the command as written", () => {
    expect(RUN_MONGO_COMMAND_ARM.title).toBe("Run a read-only MongoDB command");
    expect(RUN_MONGO_COMMAND_ARM.argument).toBe("command");
    expect(RUN_MONGO_COMMAND_ARM.paging).toBe("none");
    expect(RUN_MONGO_COMMAND_ARM.inputSchema.shape).not.toHaveProperty("offset");
    expect(
      RunMongoCommandInputSchema.safeParse({ connection_id: "seed:m", command: { operation: "find" }, offset: 5 })
        .success,
    ).toBe(false);
  });

  test("offers no database: a MongoDB connection reads the database it is bound to, as the agent's tool does", () => {
    expect(RUN_MONGO_COMMAND_ARM.inputSchema.shape).not.toHaveProperty("database");
    expect(
      RunMongoCommandInputSchema.safeParse({ connection_id: "seed:m", command: { operation: "find" }, database: "app" })
        .success,
    ).toBe(false);
  });

  test("reads its argument with the agent's canonicalize, in the order the command was written", () => {
    const command = { collection: "orders", operation: "find", options: { sort: { b: 1, a: 1 } } };
    expect(RUN_MONGO_COMMAND_ARM.canonicalize(command)).toBe(server.canonicalize(command));
    expect(RUN_MONGO_COMMAND_ARM.canonicalize(command)).toBe(JSON.stringify(command));
    expect(RUN_MONGO_COMMAND_ARM.canonicalize({})).toBeNull();
  });

  test("fences with the agent's admission and quotes its sentence", () => {
    expect(RUN_MONGO_COMMAND_ARM.fence(find, "mongodb")).toBeNull();
    const out = JSON.stringify({ collection: "orders", operation: "aggregate", pipeline: [{ $out: "copy" }] });
    const refusal = server.admit?.(out);
    expect(refusal).not.toBeNull();
    expect(RUN_MONGO_COMMAND_ARM.fence(out, "mongodb")).toBe(
      `The command was refused before it reached the database (${refusal?.code}). ${refusal?.message}`,
    );
    const insert = JSON.stringify({ collection: "orders", operation: "insertOne", document: { a: 1 } });
    expect(RUN_MONGO_COMMAND_ARM.fence(insert, "mongodb")).toStartWith(
      "The command was refused before it reached the database (",
    );
  });

  test("answers a row refusal with the language's row-cap advice for the operation", () => {
    const rows = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed"),
      1,
      2,
      RUN_MONGO_COMMAND_ARM.tooLarge(find, "mongodb"),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice(find, "1000")}`,
    });
    const bytes = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the byte budget: 2 > 1"),
      1,
      2,
      RUN_MONGO_COMMAND_ARM.tooLarge(find, "mongodb"),
    );
    expect(bytes).toEqual({ kind: "too-large", text: RUN_MONGO_COMMAND_ARM.tooLarge(find, "mongodb").bytes as string });
    expect(RUN_MONGO_COMMAND_ARM.tooLarge(find, "mongodb").bytes).not.toContain("LIMIT");
  });

  test("names no SQL clause where more rows exist, says the tool takes no offset, and pages with skip", () => {
    const hint = RUN_MONGO_COMMAND_ARM.moreRows(find, "mongodb", { maxRows: 100, shown: 100, cut: "max_rows" });
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice(find, "100")} To read past the 100 rows returned, skip them with a find's "skip" or a $skip stage.`,
    );
    expect(RUN_MONGO_COMMAND_ARM.rowOverCap).not.toContain("column");
    expect(RUN_MONGO_COMMAND_ARM.rowOverCap).toBe(
      "One row of this result is larger than the 32 KiB result limit. Narrow the read to fewer or smaller fields, and run it again.",
    );
  });

  test("a cut at one row names one document and one row", () => {
    expect(RUN_MONGO_COMMAND_ARM.moreRows(find, "mongodb", { maxRows: 1, shown: 1, cut: "max_rows" })).toBe(
      'More rows exist than this result holds, and this tool does not page with offset. Ask for at most 1 document: narrow the filter, or set "options": {"limit": 1}, and run it again. To read past the 1 row returned, skip it with a find\'s "skip" or a $skip stage.',
    );
    expect(RUN_MONGO_COMMAND_ARM.moreRows(find, "mongodb", { maxRows: 100, shown: 1, cut: "result_bytes" })).toBe(
      'More rows exist than the 32 KiB result limit holds, and 1 of them fitted; this tool does not page with offset. Project fewer fields to fit more rows, and to read past the 1 row returned, skip it with a find\'s "skip" or a $skip stage.',
    );
  });

  test("a cut at the result cap advises fewer fields and skipping the rows that fitted, never the same limit", () => {
    const limited = JSON.stringify({ collection: "orders", operation: "find", options: { limit: 100 } });
    const hint = RUN_MONGO_COMMAND_ARM.moreRows(limited, "mongodb", { maxRows: 100, shown: 15, cut: "result_bytes" });
    expect(hint).toBe(
      `More rows exist than the 32 KiB result limit holds, and 15 of them fitted; this tool does not page with offset. Project fewer fields to fit more rows, and to read past the 15 rows returned, skip them with a find's "skip" or a $skip stage.`,
    );
    expect(hint).not.toContain(`"limit": 100`);
  });
});

describe("the kubectl arm", () => {
  const server = languageServer("kubectl");

  test("takes one statement line, no offset and no database, and sends it as written", () => {
    expect(RUN_KUBECTL_READ_ARM.title).toBe("Run a read-only kubectl read");
    expect(RUN_KUBECTL_READ_ARM.argument).toBe("statement");
    expect(RUN_KUBECTL_READ_ARM.paging).toBe("none");
    expect(RUN_KUBECTL_READ_ARM.types).toEqual(["kubernetes"]);
    expect(RUN_KUBECTL_READ_ARM.inputSchema.shape).not.toHaveProperty("offset");
    expect(RUN_KUBECTL_READ_ARM.inputSchema.shape).not.toHaveProperty("database");
    for (const extra of [{ offset: 5 }, { database: "shop" }, { sql: "SELECT 1" }]) {
      expect(
        RunKubectlReadInputSchema.safeParse({ connection_id: "seed:k", statement: "get pods", ...extra }).success,
      ).toBe(false);
    }
    expect(RunKubectlReadInputSchema.safeParse({ connection_id: "seed:k", statement: "" }).success).toBe(false);
  });

  test("reads its argument with the agent's canonicalize", () => {
    expect(RUN_KUBECTL_READ_ARM.canonicalize("get pods -n shop")).toBe(server.canonicalize("get pods -n shop"));
    expect(RUN_KUBECTL_READ_ARM.canonicalize({ statement: "get pods" })).toBeNull();
  });

  test.each([
    ["exec", "exec web -- sh"],
    ["a write", "delete pod web -n shop"],
    ["the paging line", "get pods -n shop\n# libredb:page offset=0 limit=10"],
  ])("fences %s with the agent's admission and quotes its sentence", (_what, line) => {
    const refusal = server.admit?.(line);
    expect(refusal).not.toBeNull();
    expect(RUN_KUBECTL_READ_ARM.fence(line, "kubernetes")).toBe(
      `The statement was refused before it reached the cluster (${refusal?.code}). ${refusal?.message}`,
    );
  });

  test("admits a read", () => {
    expect(RUN_KUBECTL_READ_ARM.fence("get pods -n shop", "kubernetes")).toBeNull();
    expect(RUN_KUBECTL_READ_ARM.fence("kubectl get secrets -n shop", "kubernetes")).toBeNull();
  });

  test("answers a row refusal with the command's own row-cap advice", () => {
    const rows = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed"),
      1,
      2,
      RUN_KUBECTL_READ_ARM.tooLarge("get pods -A", "kubernetes"),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice("get pods -A", "1000")}`,
    });
  });

  test("a cut at one row names one pod and one row", () => {
    expect(RUN_KUBECTL_READ_ARM.moreRows("top pods -A", "kubernetes", { maxRows: 1, shown: 1, cut: "max_rows" })).toBe(
      "More rows exist than this result holds, and this tool does not page with offset. Ask for at most 1 pod: name a namespace with -n, or narrow with -l, and run it again. To read past the 1 row returned, split the read into narrower ones, since a kubectl read is never paged.",
    );
  });

  test("names neither a MongoDB stage nor a SQL clause where more rows exist, and says a kubectl read is not paged", () => {
    const hint = RUN_KUBECTL_READ_ARM.moreRows("get pods -A", "kubernetes", {
      maxRows: 100,
      shown: 100,
      cut: "max_rows",
    });
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice("get pods -A", "100")} To read past the 100 rows returned, split the read into narrower ones, since a kubectl read is never paged.`,
    );
    const bytes = RUN_KUBECTL_READ_ARM.moreRows("get pods -A -o yaml", "kubernetes", {
      maxRows: 100,
      shown: 4,
      cut: "result_bytes",
    });
    expect(bytes).toBe(
      "More rows exist than the 32 KiB result limit holds, and 4 of them fitted; this tool does not page with offset. Read fewer fields, without -o wide, -o yaml or -o json, to fit more rows, and to read past the 4 rows returned, split the read into narrower ones, since a kubectl read is never paged.",
    );
    for (const text of [hint, bytes, RUN_KUBECTL_READ_ARM.rowOverCap]) {
      expect(text).not.toContain("$skip");
      expect(text).not.toContain("LIMIT");
    }
    expect(RUN_KUBECTL_READ_ARM.rowOverCap).toBe(
      "One row of this result is larger than the 32 KiB result limit. Read it in a shorter form, without -o yaml or -o json, and run it again.",
    );
  });

  test("describes the commands it takes, the refusals, the masking and its engine", () => {
    const description = RUN_KUBECTL_READ_ARM.description;
    expect(description.startsWith("Run one read-only kubectl read")).toBe(true);
    expect(description).toContain("Runs on Kubernetes; other engines refuse it.");
    expect(description).toContain("this tool takes no offset");
    expect(description).toContain("exec");
    expect(description).toContain("<redacted>");
  });
});

describe("the Weaviate arm", () => {
  const server = languageServer("weaviateapi");
  const Input = RUN_WEAVIATE_READ_ARM.inputSchema;

  test("takes one request, no offset and no database, and sends it as written", () => {
    expect(RUN_WEAVIATE_READ_ARM.title).toBe("Run a read-only Weaviate metadata read");
    expect(RUN_WEAVIATE_READ_ARM.argument).toBe("statement");
    expect(RUN_WEAVIATE_READ_ARM.paging).toBe("none");
    expect(RUN_WEAVIATE_READ_ARM.types).toEqual(["weaviate"]);
    expect(RUN_WEAVIATE_READ_ARM.inputSchema.shape).not.toHaveProperty("offset");
    expect(RUN_WEAVIATE_READ_ARM.inputSchema.shape).not.toHaveProperty("database");
    for (const extra of [{ offset: 5 }, { database: "Note" }, { sql: "SELECT 1" }]) {
      expect(Input.safeParse({ connection_id: "seed:w", statement: "GET /v1/meta", ...extra }).success).toBe(false);
    }
    expect(Input.safeParse({ connection_id: "seed:w", statement: "" }).success).toBe(false);
  });

  test("reads its argument with the agent's canonicalize", () => {
    expect(RUN_WEAVIATE_READ_ARM.canonicalize("GET /v1/schema")).toBe(server.canonicalize("GET /v1/schema"));
    expect(RUN_WEAVIATE_READ_ARM.canonicalize({ statement: "GET /v1/schema" })).toBeNull();
  });

  test.each([
    ["an object read", "GET /v1/objects?class=Note"],
    ["a search", 'POST /v1/search/Note/bm25 {"query": "x"}'],
    ["an aggregate's groupBy", 'POST /v1/aggregate/Note {"groupBy": ["body"]}'],
    ["a write", "DELETE /v1/schema/Note"],
  ])("fences %s with the agent's admission and quotes its sentence", (_what, statement) => {
    const refusal = server.admit?.(statement);
    expect(refusal).not.toBeNull();
    expect(RUN_WEAVIATE_READ_ARM.fence(statement, "weaviate")).toBe(
      `The request was refused before it reached the server (${refusal?.code}). ${refusal?.message}`,
    );
  });

  test("admits each metadata read", () => {
    for (const statement of [
      "GET /v1/meta",
      "GET /v1/schema/Note",
      "GET /v1/schema/Tenanted/tenants",
      "GET /v1/aliases",
      "GET /v1/nodes?output=verbose",
      'POST /v1/aggregate/Tenanted {"tenant": "hot"}',
    ]) {
      expect(RUN_WEAVIATE_READ_ARM.fence(statement, "weaviate")).toBeNull();
    }
  });

  test("answers a row refusal with the request's own row-cap advice", () => {
    const statement = "GET /v1/schema/Tenanted/tenants";
    const rows = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed"),
      1,
      2,
      RUN_WEAVIATE_READ_ARM.tooLarge(statement, "weaviate"),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice(statement, "1000")}`,
    });
  });

  test("says how to narrow a cut result in Weaviate's words, never with a stage, a clause or an offset", () => {
    const statement = "GET /v1/schema/Tenanted/tenants";
    const hint = RUN_WEAVIATE_READ_ARM.moreRows(statement, "weaviate", { maxRows: 100, shown: 100, cut: "max_rows" });
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice(statement, "100")} To read past the 100 rows returned, read one collection, tenant or alias at a time, since a Weaviate read is never paged.`,
    );
    const bytes = RUN_WEAVIATE_READ_ARM.moreRows("GET /v1/schema", "weaviate", {
      maxRows: 100,
      shown: 4,
      cut: "result_bytes",
    });
    expect(bytes).toBe(
      "More rows exist than the 32 KiB result limit holds, and 4 of them fitted; this tool does not page with offset. Read one collection's schema, tenants or nodes rather than the whole server's to fit more rows, and to read past the 4 rows returned, read one collection, tenant or alias at a time, since a Weaviate read is never paged.",
    );
    for (const text of [hint, bytes, RUN_WEAVIATE_READ_ARM.rowOverCap]) {
      expect(text).not.toContain("$skip");
      expect(text).not.toContain("LIMIT");
    }
    expect(RUN_WEAVIATE_READ_ARM.rowOverCap).toBe(
      "One row of this result is larger than the 32 KiB result limit. Read one collection, tenant or alias instead, and run it again.",
    );
  });

  test("describes the reads it takes, the refusals, what an answer carries, the key and its engine", () => {
    const description = RUN_WEAVIATE_READ_ARM.description;
    expect(description.startsWith("Run one read-only Weaviate metadata read")).toBe(true);
    expect(description).toContain("Runs on Weaviate; other engines refuse it.");
    expect(description).toContain("this tool takes no offset");
    expect(description).toContain("never a stored object, property or vector");
    expect(description).toContain("viewer");
    expect(description).toContain("more than 1000 tenants");
  });
});
describe("the qdrantapi arm", () => {
  const server = languageServer("qdrantapi");

  test("takes one request, no offset and no database, and sends it as written", () => {
    expect(RUN_QDRANT_READ_ARM.title).toBe("Run a read-only Qdrant metadata read");
    expect(RUN_QDRANT_READ_ARM.argument).toBe("statement");
    expect(RUN_QDRANT_READ_ARM.paging).toBe("none");
    expect(RUN_QDRANT_READ_ARM.types).toEqual(["qdrant"]);
    expect(RUN_QDRANT_READ_ARM.inputSchema.shape).not.toHaveProperty("offset");
    expect(RUN_QDRANT_READ_ARM.inputSchema.shape).not.toHaveProperty("database");
    for (const extra of [{ offset: 5 }, { database: "plain" }, { sql: "SELECT 1" }]) {
      expect(
        RunQdrantReadInputSchema.safeParse({ connection_id: "seed:q", statement: "GET /collections", ...extra })
          .success,
      ).toBe(false);
    }
    expect(RunQdrantReadInputSchema.safeParse({ connection_id: "seed:q", statement: "" }).success).toBe(false);
  });

  test("reads its argument with the agent's canonicalize", () => {
    expect(RUN_QDRANT_READ_ARM.canonicalize("GET /collections")).toBe(server.canonicalize("GET /collections"));
    expect(RUN_QDRANT_READ_ARM.canonicalize({ statement: "GET /collections" })).toBeNull();
  });

  test.each([
    ["a point read", 'POST /collections/plain/points\n{"ids": [1]}'],
    ["a query", 'POST /collections/plain/points/query\n{"query": [0.1, 0.2]}'],
    ["a count filter", 'POST /collections/plain/points/count\n{"filter": {"must": []}}'],
    ["a write", 'PUT /collections/plain/points\n{"points": []}'],
    ["a request past 4,096 characters", `GET /collections/${"a".repeat(4_100)}`],
  ])("fences %s with the agent's admission and quotes its sentence", (_what, request) => {
    const refusal = server.admit?.(request);
    expect(refusal).not.toBeNull();
    expect(RUN_QDRANT_READ_ARM.fence(request, "qdrant")).toBe(
      `The request was refused before it reached the server (${refusal?.code}). ${refusal?.message}`,
    );
  });

  test("admits a metadata read and a bare count", () => {
    expect(RUN_QDRANT_READ_ARM.fence("GET /collections", "qdrant")).toBeNull();
    expect(RUN_QDRANT_READ_ARM.fence('POST /collections/plain/points/count\n{"exact": true}', "qdrant")).toBeNull();
  });

  test("answers a row refusal with the request's own row-cap advice", () => {
    const rows = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed"),
      1,
      2,
      RUN_QDRANT_READ_ARM.tooLarge("GET /aliases", "qdrant"),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice("GET /aliases", "1000")}`,
    });
  });

  test("names neither a MongoDB stage nor a SQL clause where more rows exist, and says a Qdrant read is not paged", () => {
    const hint = RUN_QDRANT_READ_ARM.moreRows("GET /aliases", "qdrant", { maxRows: 100, shown: 100, cut: "max_rows" });
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice("GET /aliases", "100")} To read past the 100 rows returned, raise max_rows (at most 500), or read a narrower route, since a Qdrant read is never paged.`,
    );
    const bytes = RUN_QDRANT_READ_ARM.moreRows("GET /aliases", "qdrant", {
      maxRows: 100,
      shown: 4,
      cut: "result_bytes",
    });
    expect(bytes).toBe(
      "More rows exist than the 32 KiB result limit holds, and 4 of them fitted; this tool does not page with offset. Read a narrower route, one collection instead of a whole list, or a collection's count, aliases or cluster layout instead of its full description, to fit more rows, and to read past the 4 rows returned, read a narrower route, since a Qdrant read is never paged.",
    );
    expect(bytes).not.toContain("max_rows");
    // A read of one collection is already narrow: its hint must not tell the client to read one collection on its own.
    const one = RUN_QDRANT_READ_ARM.moreRows("GET /collections/plain", "qdrant", {
      maxRows: 100,
      shown: 100,
      cut: "max_rows",
    });
    expect(one).toContain("raise max_rows (at most 500)");
    expect(one).not.toContain("read each collection on its own");
    for (const text of [hint, bytes, RUN_QDRANT_READ_ARM.rowOverCap]) {
      expect(text).not.toContain("$skip");
      expect(text).not.toContain("LIMIT");
    }
    expect(RUN_QDRANT_READ_ARM.rowOverCap).toBe(
      "One row of this result is larger than the 32 KiB result limit. Read one collection on its own, and run it again.",
    );
  });

  test("a cut at one row names one row, and a byte cut never advises raising max_rows", () => {
    expect(RUN_QDRANT_READ_ARM.moreRows("GET /aliases", "qdrant", { maxRows: 1, shown: 1, cut: "max_rows" })).toBe(
      "More rows exist than this result holds, and this tool does not page with offset. Ask for at most 1 row: read one collection's aliases with GET /collections/{collection}/aliases instead of every alias, and run it again. To read past the 1 row returned, raise max_rows (at most 500), or read a narrower route, since a Qdrant read is never paged.",
    );
    expect(
      RUN_QDRANT_READ_ARM.moreRows("GET /aliases", "qdrant", { maxRows: 100, shown: 1, cut: "result_bytes" }),
    ).toBe(
      "More rows exist than the 32 KiB result limit holds, and 1 of them fitted; this tool does not page with offset. Read a narrower route, one collection instead of a whole list, or a collection's count, aliases or cluster layout instead of its full description, to fit more rows, and to read past the 1 row returned, read a narrower route, since a Qdrant read is never paged.",
    );
  });

  test("describes the reads it takes, the refusals, the proof and its engine", () => {
    const description = RUN_QDRANT_READ_ARM.description;
    expect(description.startsWith("Run one read-only Qdrant metadata read")).toBe(true);
    expect(description).toContain("Runs on Qdrant; other engines refuse it.");
    expect(description).toContain("this tool takes no offset");
    expect(description).toContain("never a stored payload or vector");
    expect(description).toContain("an empty alias update and an empty point delete");
  });
});

describe("the etcdctl arm", () => {
  const server = languageServer("etcdctl");
  const RunEtcdReadInputSchema = RUN_ETCD_READ_ARM.inputSchema;

  test("takes one command, no offset and no database, and sends it as written", () => {
    expect(RUN_ETCD_READ_ARM.title).toBe("Run a read-only etcd metadata read");
    expect(RUN_ETCD_READ_ARM.argument).toBe("statement");
    expect(RUN_ETCD_READ_ARM.paging).toBe("none");
    expect(RUN_ETCD_READ_ARM.types).toEqual(["etcd"]);
    expect(RUN_ETCD_READ_ARM.inputSchema.shape).not.toHaveProperty("offset");
    expect(RUN_ETCD_READ_ARM.inputSchema.shape).not.toHaveProperty("database");
    for (const extra of [{ offset: 5 }, { database: "app" }, { sql: "SELECT 1" }]) {
      expect(
        RunEtcdReadInputSchema.safeParse({ connection_id: "seed:e", statement: "endpoint status", ...extra }).success,
      ).toBe(false);
    }
    expect(RunEtcdReadInputSchema.safeParse({ connection_id: "seed:e", statement: "" }).success).toBe(false);
  });

  test("reads its argument with the agent's canonicalize", () => {
    expect(RUN_ETCD_READ_ARM.canonicalize("  member list ")).toBe(server.canonicalize("  member list "));
    expect(RUN_ETCD_READ_ARM.canonicalize({ statement: "member list" })).toBeNull();
  });

  test.each([
    ["a prefix get", "get /app/ --prefix"],
    ["a prefix count", "get /registry/ --prefix --count-only"],
    ["a keys-only get", "get /app/config --keys-only"],
    ["a lease's keys", "lease timetolive 694d8147df1dc4c8 --keys"],
    ["a watch", "watch /app/config"],
    ["a write", "put /app/config value"],
    ["a second command", "member list; endpoint status"],
  ])("fences %s with the agent's admission and quotes its sentence", (_what, command) => {
    const refusal = server.admit?.(command);
    expect(refusal).not.toBeNull();
    expect(RUN_ETCD_READ_ARM.fence(command, "etcd")).toBe(
      `The command was refused before it reached the cluster (${refusal?.code}). ${refusal?.message}`,
    );
  });

  test("admits the metadata reads and the get of one key", () => {
    for (const command of ["endpoint status", "member list", "lease list", "get /app/config"]) {
      expect(RUN_ETCD_READ_ARM.fence(command, "etcd")).toBeNull();
    }
  });

  test("answers a row refusal with the command's own row-cap advice", () => {
    const rows = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed"),
      1,
      2,
      RUN_ETCD_READ_ARM.tooLarge("lease list", "etcd"),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice("lease list", "1000")}`,
    });
  });

  test("says an etcd read is not paged, and a byte cut never advises raising max_rows", () => {
    expect(RUN_ETCD_READ_ARM.moreRows("lease list", "etcd", { maxRows: 100, shown: 100, cut: "max_rows" })).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice("lease list", "100")} To read past the 100 rows returned, raise max_rows (at most 500), or read one lease with lease timetolive, since an etcd read is never paged.`,
    );
    const bytes = RUN_ETCD_READ_ARM.moreRows("lease list", "etcd", { maxRows: 100, shown: 1, cut: "result_bytes" });
    expect(bytes).toBe(
      "More rows exist than the 32 KiB result limit holds, and 1 of them fitted; this tool does not page with offset. Read one lease with lease timetolive, or the cluster with endpoint status, instead of a whole list, to fit more rows, and to read past the 1 row returned, read one lease with lease timetolive, since an etcd read is never paged.",
    );
    expect(bytes).not.toContain("max_rows");
    expect(RUN_ETCD_READ_ARM.rowOverCap).toBe(
      "One row of this result is larger than the 32 KiB result limit. Read one lease or one key on its own, and run it again.",
    );
  });

  test("describes the reads it takes, the refusals, the proof, inspect_schema and its engine", () => {
    const description = RUN_ETCD_READ_ARM.description;
    expect(description.startsWith("Run one read-only etcd metadata read")).toBe(true);
    expect(description).toContain("Runs on etcd; other engines refuse it.");
    expect(description).toContain("this tool takes no offset");
    expect(description).toContain("never a key name, a stored value or a member's address");
    expect(description).toContain("on no Kubernetes storage prefix and not on every key");
    expect(description).toContain("A key outside the user's READ ranges is refused alike whether it exists or not.");
    expect(description).toContain("inspect_schema lists no key prefix of an etcd connection");
  });
});

describe("the Kafka arm", () => {
  const server = languageServer("kafkaread");
  const topics = '{"read": "topics"}';

  test("takes one read request, no offset and no database, and sends it as written", () => {
    expect(RUN_KAFKA_READ_ARM.title).toBe("Run a read-only Kafka metadata read");
    expect(RUN_KAFKA_READ_ARM.argument).toBe("statement");
    expect(RUN_KAFKA_READ_ARM.paging).toBe("none");
    expect(RUN_KAFKA_READ_ARM.types).toEqual(["kafka"]);
    expect(RUN_KAFKA_READ_ARM.inputSchema.shape).not.toHaveProperty("offset");
    expect(RUN_KAFKA_READ_ARM.inputSchema.shape).not.toHaveProperty("database");
    for (const extra of [{ offset: 5 }, { database: "shop" }, { sql: "SELECT 1" }]) {
      expect(
        RUN_KAFKA_READ_ARM.inputSchema.safeParse({ connection_id: "seed:k", statement: topics, ...extra }).success,
      ).toBe(false);
    }
    expect(RUN_KAFKA_READ_ARM.inputSchema.safeParse({ connection_id: "seed:k", statement: "" }).success).toBe(false);
    // The request is JSON written as text, as the agent's own tool takes it; an object is not one.
    expect(
      RUN_KAFKA_READ_ARM.inputSchema.safeParse({ connection_id: "seed:k", statement: { read: "topics" } }).success,
    ).toBe(false);
  });

  test("reads its argument with the agent's canonicalize", () => {
    expect(RUN_KAFKA_READ_ARM.canonicalize(topics)).toBe(server.canonicalize(topics));
    expect(RUN_KAFKA_READ_ARM.canonicalize({ read: "topics" })).toBeNull();
  });

  test.each([
    ["a fetch", '{"read": "fetch", "topic": "orders"}'],
    ["the editor's record read", '{"topic": "orders", "from": "earliest"}'],
    ["an internal topic", '{"read": "offsets", "topic": "__transaction_state"}'],
    ["a platform's own topic", '{"read": "offsets", "topic": "_schemas"}'],
  ])("fences %s with the agent's admission and quotes its sentence", (_what, request) => {
    const refusal = server.admit?.(request);
    expect(refusal).not.toBeNull();
    expect(RUN_KAFKA_READ_ARM.fence(request, "kafka")).toBe(
      `The read request was refused before it reached the broker (${refusal?.code}). ${refusal?.message}`,
    );
  });

  test("admits each of the four reads", () => {
    for (const request of [
      topics,
      '{"read": "brokers", "after": 3}',
      '{"read": "partitions", "topic": "orders"}',
      '{"read": "offsets", "topic": "orders", "limit": 500}',
    ]) {
      expect(RUN_KAFKA_READ_ARM.fence(request, "kafka")).toBeNull();
    }
  });

  test("answers a row refusal with the read's own row-cap advice", () => {
    const rows = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed"),
      1,
      2,
      RUN_KAFKA_READ_ARM.tooLarge(topics, "kafka"),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice(topics, "1000")}`,
    });
  });

  test("reads past a cut with after, never an offset, a SQL clause or a MongoDB stage", () => {
    const hint = RUN_KAFKA_READ_ARM.moreRows(topics, "kafka", { maxRows: 100, shown: 100, cut: "max_rows" });
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice(topics, "100")} To read past the 100 rows returned, set "after" to the last topic name, node id or partition id among them.`,
    );
    const bytes = RUN_KAFKA_READ_ARM.moreRows(topics, "kafka", { maxRows: 100, shown: 40, cut: "result_bytes" });
    expect(bytes).toBe(
      `More rows exist than the 32 KiB result limit holds, and 40 of them fitted; this tool does not page with offset. A Kafka read's columns are fixed, so none can be left out to fit more rows, and to read past the 40 rows returned, set "after" to the last topic name, node id or partition id among them.`,
    );
    for (const text of [hint, bytes, RUN_KAFKA_READ_ARM.rowOverCap]) {
      expect(text).not.toContain("$skip");
      expect(text).not.toContain("LIMIT");
    }
    expect(RUN_KAFKA_READ_ARM.rowOverCap).toBe(
      "One row of this result is larger than the 32 KiB result limit. Read a narrower listing, one topic's partitions or offsets, and run it again.",
    );
  });

  test("describes the four reads, what is never read, the paging and its engine", () => {
    const description = RUN_KAFKA_READ_ARM.description;
    expect(description.startsWith("Run one read-only Kafka metadata read")).toBe(true);
    expect(description).toContain("Runs on Apache Kafka; other engines refuse it.");
    expect(description).toContain("this tool takes no offset");
    for (const read of ["topics", "brokers", "partitions", "offsets"])
      expect(description).toContain(`"read": "${read}"`);
    expect(description).toContain("no record's key, value, headers or timestamp is ever fetched");
    expect(description).toContain("a platform's own topics (a leading underscore, or connect-) are withheld");
  });
});

describe("the Cypher arm", () => {
  const server = languageServer("cypher");
  const read = "MATCH (n:Person) RETURN n.name AS name LIMIT 10";

  test("takes one statement, no offset and no database, and sends it as written", () => {
    expect(RUN_CYPHER_READ_ARM.title).toBe("Run a read-only Cypher statement");
    expect(RUN_CYPHER_READ_ARM.argument).toBe("statement");
    expect(RUN_CYPHER_READ_ARM.paging).toBe("none");
    expect(RUN_CYPHER_READ_ARM.types).toEqual(["neo4j"]);
    expect(RUN_CYPHER_READ_ARM.inputSchema.shape).not.toHaveProperty("offset");
    expect(RUN_CYPHER_READ_ARM.inputSchema.shape).not.toHaveProperty("database");
    for (const extra of [{ offset: 5 }, { database: "neo4j" }, { sql: "SELECT 1" }]) {
      expect(RunCypherReadInputSchema.safeParse({ connection_id: "seed:g", statement: read, ...extra }).success).toBe(
        false,
      );
    }
    expect(RunCypherReadInputSchema.safeParse({ connection_id: "seed:g", statement: "" }).success).toBe(false);
  });

  test("reads its argument with the agent's canonicalize", () => {
    expect(RUN_CYPHER_READ_ARM.canonicalize(read)).toBe(server.canonicalize(read));
    expect(RUN_CYPHER_READ_ARM.canonicalize({ statement: read })).toBeNull();
  });

  test.each([
    ["a write", "CREATE (:Probe)"],
    ["LOAD CSV", "LOAD CSV FROM 'file:///probe.csv' AS row RETURN row"],
    ["USE", "USE other MATCH (n) RETURN n LIMIT 1"],
    ["a procedure outside the schema reads", "CALL db.checkpoint()"],
    ["a comment", "MATCH (n) RETURN n LIMIT 1 // why"],
  ])("fences %s with the agent's admission and quotes its sentence", (_what, statement) => {
    const refusal = server.admit?.(statement);
    expect(refusal).not.toBeNull();
    expect(RUN_CYPHER_READ_ARM.fence(statement, "neo4j")).toBe(
      `The statement was refused before it reached the database (${refusal?.code}). ${refusal?.message}`,
    );
  });

  test("admits a read, a schema procedure and an index listing", () => {
    for (const statement of [read, "CALL db.labels()", "SHOW INDEXES"]) {
      expect(RUN_CYPHER_READ_ARM.fence(statement, "neo4j")).toBeNull();
    }
  });

  test("answers a row refusal with the language's own row-cap advice", () => {
    const rows = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed"),
      1,
      2,
      RUN_CYPHER_READ_ARM.tooLarge(read, "neo4j"),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice(read, "1000")}`,
    });
  });

  test("names no SQL clause or MongoDB stage where more rows exist, and pages with SKIP and LIMIT", () => {
    const hint = RUN_CYPHER_READ_ARM.moreRows(read, "neo4j", { maxRows: 100, shown: 100, cut: "max_rows" });
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice(read, "100")} To read past the 100 rows returned, ORDER BY a unique property and add SKIP 100 before the LIMIT.`,
    );
    const bytes = RUN_CYPHER_READ_ARM.moreRows(read, "neo4j", { maxRows: 100, shown: 4, cut: "result_bytes" });
    expect(bytes).toBe(
      "More rows exist than the 32 KiB result limit holds, and 4 of them fitted; this tool does not page with offset. Return fewer or smaller properties to fit more rows, and to read past the 4 rows returned, ORDER BY a unique property and add SKIP 4 before the LIMIT.",
    );
    for (const text of [hint, bytes, RUN_CYPHER_READ_ARM.rowOverCap]) {
      expect(text).not.toContain("$skip");
      expect(text).not.toContain("FETCH");
    }
    expect(RUN_CYPHER_READ_ARM.rowOverCap).toBe(
      "One row of this result is larger than the 32 KiB result limit. Return fewer or smaller properties instead of whole nodes, and run it again.",
    );
  });

  test("describes the reads it takes, the refusals, the user proof and its engine", () => {
    const description = RUN_CYPHER_READ_ARM.description;
    expect(description.startsWith("Run one read-only Cypher statement")).toBe(true);
    expect(description).toContain("Runs on Neo4j; other engines refuse it.");
    expect(description).toContain("this tool takes no offset");
    expect(description).toContain("LOAD CSV");
    expect(description).toContain("Enterprise Edition");
  });
});

describe("the Redis arm", () => {
  const server = languageServer("rediscli");

  test("takes one command line, no offset and no database, and sends it as written", () => {
    expect(RUN_REDIS_READ_ARM.title).toBe("Run a read-only Redis metadata read");
    expect(RUN_REDIS_READ_ARM.argument).toBe("statement");
    expect(RUN_REDIS_READ_ARM.paging).toBe("none");
    expect(RUN_REDIS_READ_ARM.types).toEqual(["redis"]);
    expect(RUN_REDIS_READ_ARM.inputSchema.shape).not.toHaveProperty("offset");
    expect(RUN_REDIS_READ_ARM.inputSchema.shape).not.toHaveProperty("database");
    for (const extra of [{ offset: 5 }, { database: "1" }, { sql: "SELECT 1" }]) {
      expect(
        RunRedisReadInputSchema.safeParse({ connection_id: "seed:r", statement: "DBSIZE", ...extra }).success,
      ).toBe(false);
    }
    const empty = RunRedisReadInputSchema.safeParse({ connection_id: "seed:r", statement: "" });
    expect(empty.error?.issues.map((issue) => issue.message)).toEqual(["statement cannot be empty"]);
  });

  test("reads its argument with the agent's canonicalize", () => {
    expect(RUN_REDIS_READ_ARM.canonicalize("TYPE user:42")).toBe(server.canonicalize("TYPE user:42"));
    expect(RUN_REDIS_READ_ARM.canonicalize({ statement: "DBSIZE" })).toBeNull();
  });

  test.each([
    ["a write", "SET user:42 x"],
    ["a key listing", "SCAN 0"],
    ["a value read", "GET user:42"],
    ["INFO", "INFO keyspace"],
    ["a second command", "DBSIZE\nDEL user:42"],
    ["MEMORY USAGE sampling every nested value", "MEMORY USAGE user:42 SAMPLES 0"],
  ])("fences %s with the agent's admission and quotes its sentence", (_what, line) => {
    const refusal = server.admit?.(line);
    expect(refusal).not.toBeNull();
    expect(RUN_REDIS_READ_ARM.fence(line, "redis")).toBe(
      `The command was refused before it reached the server (${refusal?.code}). ${refusal?.message}`,
    );
    // The refusal never repeats the key the command named.
    expect(RUN_REDIS_READ_ARM.fence(line, "redis")).not.toContain("user:42");
  });

  test("admits each read of the closed table", () => {
    for (const line of [
      "DBSIZE",
      "TYPE user:42",
      "EXISTS user:42",
      "TTL user:42",
      "PTTL user:42",
      "STRLEN user:42",
      "LLEN user:42",
      "HLEN user:42",
      "SCARD user:42",
      "ZCARD user:42",
      "XLEN user:42",
      "OBJECT ENCODING user:42",
      "MEMORY USAGE user:42 SAMPLES 5",
    ]) {
      expect({ line, fence: RUN_REDIS_READ_ARM.fence(line, "redis") }).toEqual({ line, fence: null });
    }
  });

  test("answers a row refusal with the command's own row-cap advice", () => {
    const rows = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the row budget: 2 rows > 1 allowed"),
      1,
      2,
      RUN_REDIS_READ_ARM.tooLarge("DBSIZE", "redis"),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice("DBSIZE", "1000")}`,
    });
  });

  test("says a Redis read answers one row and is never paged, naming no SQL clause or MongoDB stage", () => {
    const hint = RUN_REDIS_READ_ARM.moreRows("DBSIZE", "redis", { maxRows: 1, shown: 1, cut: "max_rows" });
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice("DBSIZE", "1")} To read past the 1 rows returned, read one key at a time, since a Redis read answers one row and is never paged.`,
    );
    const bytes = RUN_REDIS_READ_ARM.moreRows("DBSIZE", "redis", { maxRows: 100, shown: 0, cut: "result_bytes" });
    expect(bytes).toBe(
      "More rows exist than the 32 KiB result limit holds, and 0 of them fitted; this tool does not page with offset. Read one key at a time to fit more rows, and to read past the 0 rows returned, read one key at a time, since a Redis read answers one row and is never paged.",
    );
    for (const text of [hint, bytes, RUN_REDIS_READ_ARM.rowOverCap]) {
      expect(text).not.toContain("$skip");
      expect(text).not.toContain("LIMIT");
    }
    expect(RUN_REDIS_READ_ARM.rowOverCap).toBe(
      "One row of this result is larger than the 32 KiB result limit. Read one key at a time, and run it again.",
    );
  });

  test("describes the reads it takes, what an answer withholds, the proof and its engine", () => {
    const description = RUN_REDIS_READ_ARM.description;
    expect(description.startsWith("Run one read-only Redis metadata read")).toBe(true);
    expect(description).toContain("Runs on Redis; other engines refuse it.");
    expect(description).toContain("this tool takes no offset");
    for (const word of ["DBSIZE", "MEMORY USAGE", "SCAN", "KEYS", "INFO", "never repeats the key"]) {
      expect(description).toContain(word);
    }
    // The data-scope promise: what a call reads is bounded by the ACL user's key patterns, enforced by the server.
    expect(description).toContain(
      "The connection's ACL user is proved read-only by the server before every command, and a key outside that user's key patterns is refused by the server.",
    );
  });
});

describe("the mtconnectread arm", () => {
  const server = languageServer("mtconnectread");

  test("takes one request line, no offset and no database, and sends it as written", () => {
    expect(RUN_MTCONNECT_READ_ARM.title).toBe("Run a read-only MTConnect read");
    expect(RUN_MTCONNECT_READ_ARM.argument).toBe("statement");
    expect(RUN_MTCONNECT_READ_ARM.paging).toBe("none");
    expect(RUN_MTCONNECT_READ_ARM.types).toEqual(["mtconnect"]);
    expect(RUN_MTCONNECT_READ_ARM.inputSchema.shape).not.toHaveProperty("offset");
    expect(RUN_MTCONNECT_READ_ARM.inputSchema.shape).not.toHaveProperty("database");
    for (const extra of [{ offset: 5 }, { database: "LATHE" }, { sql: "SELECT 1" }]) {
      expect(
        RunMtconnectReadInputSchema.safeParse({ connection_id: "seed:m", statement: "/current", ...extra }).success,
      ).toBe(false);
    }
    expect(RunMtconnectReadInputSchema.safeParse({ connection_id: "seed:m", statement: "" }).success).toBe(false);
  });

  test("reads its argument with the agent's canonicalize", () => {
    expect(RUN_MTCONNECT_READ_ARM.canonicalize("/current")).toBe(server.canonicalize("/current"));
    expect(RUN_MTCONNECT_READ_ARM.canonicalize({ statement: "/current" })).toBeNull();
  });

  test.each([
    ["a PUT", "PUT /probe"],
    ["a POST", "POST /LATHE?x=1"],
    ["/cancel", "/cancel/id=1"],
    ["a streaming parameter", "/sample?interval=1000"],
    ["a second request line", "/current\n/sample"],
    ["a path outside agent mode's subset", '/current?path=//DataItem[starts-with(@id,"_")]'],
  ])("fences %s with the agent's admission and quotes its sentence", (_what, line) => {
    const refusal = server.admit?.(line);
    expect(refusal).not.toBeNull();
    expect(RUN_MTCONNECT_READ_ARM.fence(line, "mtconnect")).toBe(
      `The request was refused before it reached the agent (${refusal?.code}). ${refusal?.message}`,
    );
  });

  test("admits a read of each route", () => {
    for (const line of ["/probe", "/LATHE/current", "/sample?count=-5", "/assets", "/asset/TOOL-1"]) {
      expect(RUN_MTCONNECT_READ_ARM.fence(line, "mtconnect")).toBeNull();
    }
  });

  test("answers a row refusal with the request language's own row-cap advice", () => {
    const rows = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed"),
      1,
      2,
      RUN_MTCONNECT_READ_ARM.tooLarge("/current", "mtconnect"),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice("/current", "1000")}`,
    });
  });

  test("names neither a MongoDB stage nor a SQL clause where more rows exist, and says a read is never paged", () => {
    const hint = RUN_MTCONNECT_READ_ARM.moreRows("/current", "mtconnect", {
      maxRows: 100,
      shown: 100,
      cut: "max_rows",
    });
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice("/current", "100")} To read past the 100 rows returned, read /sample from the sequence after the last one returned, or split the read by device or path, since an MTConnect read is never paged.`,
    );
    const bytes = RUN_MTCONNECT_READ_ARM.moreRows("/assets", "mtconnect", {
      maxRows: 100,
      shown: 4,
      cut: "result_bytes",
    });
    expect(bytes).toBe(
      "More rows exist than the 32 KiB result limit holds, and 4 of them fitted; this tool does not page with offset. Name one device, narrow the path or give /sample or /assets a smaller count to fit more rows, and to read past the 4 rows returned, read the assets by type with /assets?type=..., by device with /{device}/assets or by id with /asset/{assetIds}, since an MTConnect read is never paged.",
    );
    // An asset row carries no sequence, so an asset read is never pointed at /sample; every other read is.
    for (const line of ["/assets", "/LATHE/assets?type=CuttingTool", "/asset/TOOL-1;TOOL-2"]) {
      for (const cut of ["max_rows", "result_bytes"] as const) {
        const text = RUN_MTCONNECT_READ_ARM.moreRows(line, "mtconnect", { maxRows: 100, shown: 4, cut });
        expect(text).toContain(
          "read the assets by type with /assets?type=..., by device with /{device}/assets or by id with /asset/{assetIds}",
        );
        expect(text).not.toContain("/sample from");
      }
    }
    for (const line of ["/current", "/sample?count=-5", "/probe", "/assets/TOOL-1"]) {
      const text = RUN_MTCONNECT_READ_ARM.moreRows(line, "mtconnect", { maxRows: 100, shown: 4, cut: "result_bytes" });
      expect(text).toContain("read /sample from the sequence after the last one returned");
    }
    for (const text of [hint, bytes, RUN_MTCONNECT_READ_ARM.rowOverCap]) {
      expect(text).not.toContain("$skip");
      expect(text).not.toContain("LIMIT");
    }
    expect(RUN_MTCONNECT_READ_ARM.rowOverCap).toBe(
      "One row of this result is larger than the 32 KiB result limit, as an asset with a long document can be, and a row is never cut. Read other rows, with a narrower path or other asset ids, and run it again.",
    );
  });

  test("describes the routes it takes, the refusals, what is withheld and its engine", () => {
    const description = RUN_MTCONNECT_READ_ARM.description;
    expect(description.startsWith("Run one read-only MTConnect read")).toBe(true);
    expect(description).toContain("Runs on MTConnect; other engines refuse it.");
    expect(description).toContain("this tool takes no offset");
    expect(description).toContain("/cancel");
    expect(description).toContain("adapter connections");
    expect(description).toContain(
      "after a URL's start (a scheme and its colon in any case, or two slashes or backslashes) and the slashes or backslashes that follow, up to the last @ in the value",
    );
    expect(description).toContain("its user name, password, query string and fragment never reach the answer");
    expect(description).toContain(
      "Values are read after NFKC and percent-decoding: a word with a : before an @ is withheld from its start, past a scheme and //, to its last @",
    );
    expect(description).toContain("asset ids in observations alike");
  });
});

describe("the s3api arm", () => {
  const server = languageServer("s3api");

  test("takes one command, no offset and no database, and sends it as written", () => {
    expect(RUN_S3_READ_ARM.title).toBe("Run a read-only S3 metadata read");
    expect(RUN_S3_READ_ARM.argument).toBe("statement");
    expect(RUN_S3_READ_ARM.paging).toBe("none");
    expect(RUN_S3_READ_ARM.types).toEqual(["s3"]);
    expect(RUN_S3_READ_ARM.withholdsDatabase).toBe(false);
    expect(RUN_S3_READ_ARM.inputSchema.shape).not.toHaveProperty("offset");
    expect(RUN_S3_READ_ARM.inputSchema.shape).not.toHaveProperty("database");
    for (const extra of [{ offset: 5 }, { database: "sales" }, { sql: "SELECT 1" }]) {
      expect(
        RunS3ReadInputSchema.safeParse({ connection_id: "seed:s", statement: "aws s3api list-buckets", ...extra })
          .success,
      ).toBe(false);
    }
    expect(RunS3ReadInputSchema.safeParse({ connection_id: "seed:s", statement: "" }).success).toBe(false);
  });

  test("reads its argument with the agent's canonicalize", () => {
    expect(RUN_S3_READ_ARM.canonicalize("aws s3api list-buckets")).toBe(server.canonicalize("aws s3api list-buckets"));
    expect(RUN_S3_READ_ARM.canonicalize({ statement: "aws s3api list-buckets" })).toBeNull();
  });

  test.each([
    ["an object listing", "aws s3api list-objects-v2 --bucket sales"],
    ["a key listing", "aws s3 ls s3://sales/"],
    ["a count over a prefix", "aws s3 ls s3://sales/2026/ --recursive --summarize"],
    ["a --prefix", "aws s3api head-bucket --bucket sales --prefix a"],
    ["an object read", "aws s3api get-object --bucket sales --key a.csv out.csv"],
    ["a preview", "preview s3://sales/a.csv"],
    ["a write", "aws s3api put-object --bucket sales --key a.csv"],
    ["an endpoint", "aws s3api list-buckets --endpoint-url http://elsewhere"],
  ])("fences %s with the agent's admission and quotes its sentence", (_what, line) => {
    const refusal = server.admit?.(line);
    expect(refusal).not.toBeNull();
    expect(RUN_S3_READ_ARM.fence(line, "s3")).toBe(
      `The command was refused before it reached the server (${refusal?.code}). ${refusal?.message}`,
    );
  });

  test("admits each of the six reads", () => {
    for (const line of [
      "aws s3api list-buckets",
      "aws s3api head-bucket --bucket sales",
      "aws s3api get-bucket-location --bucket sales",
      "aws s3api get-bucket-versioning --bucket sales",
      "aws s3 ls s3://sales --recursive --summarize",
      "aws s3api head-object --bucket sales --key a.csv",
    ]) {
      expect(RUN_S3_READ_ARM.fence(line, "s3")).toBeNull();
    }
  });

  test("points past a cut bucket list at one bucket the request names, never at a page", () => {
    const rows = RUN_S3_READ_ARM.moreRows("aws s3api list-buckets", "s3", {
      maxRows: 100,
      shown: 100,
      cut: "max_rows",
    });
    expect(rows).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice("aws s3api list-buckets", "100")} To read past the 100 rows returned, raise max_rows (at most 500), or read one bucket you name with head-bucket, since an S3 read is never paged.`,
    );
    const bytes = RUN_S3_READ_ARM.moreRows("aws s3api list-buckets", "s3", {
      maxRows: 500,
      shown: 1,
      cut: "result_bytes",
    });
    expect(bytes).toBe(
      "More rows exist than the 32 KiB result limit holds, and 1 of them fitted; this tool does not page with offset. Read one bucket you name with head-bucket instead of the bucket list to fit more rows, and to read past the 1 row returned, read one bucket you name with head-bucket, since an S3 read is never paged.",
    );
    expect(RUN_S3_READ_ARM.rowOverCap).toBe(
      "One row of this result is larger than the 32 KiB result limit, which a name, a count and a flag never are. Run the read again.",
    );
  });

  test("describes the six reads, what is withheld, the agent read key and its engine", () => {
    const description = RUN_S3_READ_ARM.description;
    expect(description.startsWith("Run one read-only S3 metadata read")).toBe(true);
    expect(description).toContain("Runs on S3-compatible object storage; other engines refuse it.");
    expect(description).toContain("this tool takes no offset");
    expect(description).toContain(
      "object keys, bodies, user metadata, tags, ETags, version ids, owners, ACLs, policies and the endpoint are withheld",
    );
    expect(description).toContain(
      "Every read is signed with the connection's agent read key, never the connection's own key",
    );
    expect(description).toContain(
      "a bucket or key it may not read answers in the same sentence as one that does not exist",
    );
    expect(description).toContain("inspect_schema refuses an S3 connection");
  });
});

describe("the Milvus arm", () => {
  const server = languageServer("milvusrpc");
  const collections = "POST /v2/vectordb/collections/list";

  test("takes one request, no offset and no database, and sends it as written", () => {
    expect(RUN_MILVUS_READ_ARM.title).toBe("Run a read-only Milvus metadata read");
    expect(RUN_MILVUS_READ_ARM.argument).toBe("statement");
    expect(RUN_MILVUS_READ_ARM.paging).toBe("none");
    expect(RUN_MILVUS_READ_ARM.types).toEqual(["milvus"]);
    expect(RUN_MILVUS_READ_ARM.inputSchema.shape).not.toHaveProperty("offset");
    expect(RUN_MILVUS_READ_ARM.inputSchema.shape).not.toHaveProperty("database");
    for (const extra of [{ offset: 5 }, { database: "default" }, { sql: "SELECT 1" }]) {
      expect(
        RUN_MILVUS_READ_ARM.inputSchema.safeParse({ connection_id: "seed:m", statement: collections, ...extra })
          .success,
      ).toBe(false);
    }
    expect(RUN_MILVUS_READ_ARM.inputSchema.safeParse({ connection_id: "seed:m", statement: "" }).success).toBe(false);
  });

  test("reads its argument with the agent's canonicalize", () => {
    expect(RUN_MILVUS_READ_ARM.canonicalize(collections)).toBe(server.canonicalize(collections));
    expect(RUN_MILVUS_READ_ARM.canonicalize({ route: "collections/list" })).toBeNull();
  });

  test.each([
    ["a query of stored values", 'POST /v2/vectordb/entities/query\n{"collectionName": "docs", "filter": "id > 0"}'],
    ["a search", 'POST /v2/vectordb/entities/search\n{"collectionName": "docs", "annsField": "vec", "data": [[0.1]]}'],
    ["a write", 'POST /v2/vectordb/collections/drop\n{"collectionName": "docs"}'],
    ["a Load", 'POST /v2/vectordb/collections/load\n{"collectionName": "docs"}'],
    ["every alias of the database", "POST /v2/vectordb/aliases/list"],
  ])("fences %s with the agent's admission and quotes its sentence", (_what, request) => {
    const refusal = server.admit?.(request);
    expect(refusal).not.toBeNull();
    expect(RUN_MILVUS_READ_ARM.fence(request, "milvus")).toBe(
      `The request was refused before it reached the server (${refusal?.code}). ${refusal?.message}`,
    );
  });

  test("admits each metadata read", () => {
    for (const request of [
      collections,
      "POST /v2/vectordb/databases/list",
      'POST /v2/vectordb/collections/describe\n{"collectionName": "docs"}',
      'POST /v2/vectordb/aliases/list\n{"collectionName": "docs"}',
      'POST /v2/vectordb/aliases/describe\n{"aliasName": "docs_alias"}',
    ]) {
      expect(RUN_MILVUS_READ_ARM.fence(request, "milvus")).toBeNull();
    }
  });

  test("answers a row refusal with the read's own row-cap advice", () => {
    const rows = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed"),
      1,
      2,
      RUN_MILVUS_READ_ARM.tooLarge(collections, "milvus"),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice(collections, "1000")}`,
    });
  });

  test("reads past a cut with a narrower route, never an offset, a SQL clause or a MongoDB stage", () => {
    const hint = RUN_MILVUS_READ_ARM.moreRows(collections, "milvus", { maxRows: 100, shown: 100, cut: "max_rows" });
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice(collections, "100")} To read past the 100 rows returned, read a narrower route, one collection instead of a whole list, since a Milvus read is never paged.`,
    );
    const bytes = RUN_MILVUS_READ_ARM.moreRows(collections, "milvus", { maxRows: 100, shown: 40, cut: "result_bytes" });
    expect(bytes).toContain("40 of them fitted; this tool does not page with offset.");
    for (const text of [hint, bytes, RUN_MILVUS_READ_ARM.rowOverCap]) {
      expect(text).not.toContain("$skip");
      expect(text).not.toContain("LIMIT");
    }
  });

  test("a cut at one row names one row", () => {
    const hint = RUN_MILVUS_READ_ARM.moreRows(collections, "milvus", { maxRows: 1, shown: 1, cut: "max_rows" });
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice(collections, "1")} To read past the 1 row returned, read a narrower route, one collection instead of a whole list, since a Milvus read is never paged.`,
    );
    const bytes = RUN_MILVUS_READ_ARM.moreRows(collections, "milvus", { maxRows: 100, shown: 1, cut: "result_bytes" });
    expect(bytes).toContain("to read past the 1 row returned,");
  });

  test("describes the reads, what is never read, the data scope, the proof and its engine", () => {
    const description = RUN_MILVUS_READ_ARM.description;
    expect(description.startsWith("Run one read-only Milvus metadata read")).toBe(true);
    expect(description).toContain("Runs on Milvus; other engines refuse it.");
    expect(description).toContain("this tool takes no offset");
    for (const route of ["databases/list", "collections/list", "collections/describe", "aliases/describe"]) {
      expect(description).toContain(route);
    }
    expect(description).toContain("never a stored field value or vector");
    expect(description).toContain("only of the collections collections/list lists the connection's user");
    expect(description).toContain("before every read the server must prove the user read-only");
  });
});

describe("the tool each engine is read with", () => {
  test("is the tool whose arm serves it, and null where none does", () => {
    for (const type of SHIPPED_DATABASE_TYPES) {
      const language = AGENT_STATEMENT_LANGUAGE[type];
      const arm = language === null ? null : MCP_STATEMENT_ARMS[language];
      expect(mcpStatementToolFor(type)).toBe(arm !== null && arm.types.includes(type) ? arm.tool : null);
    }
  });

  test("an engine of a served language whose own records keep it closed has no read tool", () => {
    const closed = SHIPPED_DATABASE_TYPES.filter((type) => {
      const language = AGENT_STATEMENT_LANGUAGE[type];
      return language !== null && MCP_STATEMENT_ARMS[language] !== null && !MCP_STATEMENT_READ[type];
    });
    expect(closed).not.toEqual([]);
    for (const type of closed) expect(mcpStatementToolFor(type)).toBeNull();
  });

  test("the tools registered are the arms that serve an engine", () => {
    expect(servingStatementArms()).toEqual(ARMS.filter((arm) => arm.types.length > 0));
  });

  test("an arm that serves no engine is neither listed nor registered", () => {
    const idle = Object.freeze({ ...RUN_MONGO_COMMAND_ARM, types: [] });
    const arms = {
      ...Object.fromEntries(Object.keys(MCP_STATEMENT_ARMS).map((language) => [language, null])),
      sql: RUN_READ_QUERY_ARM,
      mongo: idle,
    } as unknown as typeof MCP_STATEMENT_ARMS;
    expect(servingStatementArms(arms)).toEqual([RUN_READ_QUERY_ARM]);
    const registerTool = mock((_name: string) => undefined);
    registerStatementTools({ registerTool } as unknown as McpServer, {} as McpConnectionContext, arms);
    expect(registerTool.mock.calls.map(([name]) => name)).toEqual(["run_read_query"]);
  });
});

describe("the libredbkv arm", () => {
  const server = languageServer("libredbkv");

  test("takes one command, no offset and no database, and sends it as written", () => {
    expect(RUN_LIBREDB_READ_ARM.title).toBe("Run a read-only LibreDB command");
    expect(RUN_LIBREDB_READ_ARM.argument).toBe("statement");
    expect(RUN_LIBREDB_READ_ARM.paging).toBe("none");
    expect(RUN_LIBREDB_READ_ARM.types).toEqual(["libredb"]);
    expect(RUN_LIBREDB_READ_ARM.inputSchema.shape).not.toHaveProperty("offset");
    // A LibreDB connection's database is its file's path, which the seed names: a client never names another file.
    expect(RUN_LIBREDB_READ_ARM.inputSchema.shape).not.toHaveProperty("database");
    for (const extra of [{ offset: 5 }, { database: "/tmp/other.libredb" }, { sql: "SELECT 1" }]) {
      expect(
        RunLibredbReadInputSchema.safeParse({ connection_id: "seed:kv", statement: "get users:1", ...extra }).success,
      ).toBe(false);
    }
    const empty = RunLibredbReadInputSchema.safeParse({ connection_id: "seed:kv", statement: "" });
    expect(empty.error?.issues.map((issue) => issue.message)).toEqual(["statement cannot be empty"]);
  });

  test("reads its argument with the agent's canonicalize", () => {
    expect(RUN_LIBREDB_READ_ARM.canonicalize("prefix users:")).toBe(server.canonicalize("prefix users:"));
    expect(RUN_LIBREDB_READ_ARM.canonicalize({ get: "users:1" })).toBeNull();
  });

  test.each([
    ["a put", "put users:1 x"],
    ["a delete", "delete users:1"],
    ["a quoted write", '"put" users:1 x'],
    ["a second line", "get users:1\nput users:1 x"],
    ["text that is no command", "SELECT 1"],
    ["a command longer than the agent takes", `get ${"k".repeat(4_100)}`],
  ])("fences %s with the agent's admission and quotes its sentence", (_what, statement) => {
    const refusal = server.admit?.(statement);
    expect(refusal).not.toBeNull();
    expect(RUN_LIBREDB_READ_ARM.fence(statement, "libredb")).toBe(
      `The command was refused before it reached the file (${refusal?.code}). ${refusal?.message}`,
    );
  });

  test("admits each read", () => {
    for (const statement of ["get users:1", "prefix users:", "range users:1 users:9", 'get "a key"']) {
      expect(RUN_LIBREDB_READ_ARM.fence(statement, "libredb")).toBeNull();
    }
  });

  test("names no SQL clause or MongoDB stage where more rows exist, and reads on with a range", () => {
    const hint = RUN_LIBREDB_READ_ARM.moreRows("prefix users:", "libredb", {
      maxRows: 100,
      shown: 100,
      cut: "max_rows",
    });
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice("prefix users:", "100")} To read past the 100 rows returned, read on with range <the last key returned> <end>: a range includes its start, so its first row is the last one returned again.`,
    );
    const bytes = RUN_LIBREDB_READ_ARM.moreRows("prefix users:", "libredb", {
      maxRows: 100,
      shown: 40,
      cut: "result_bytes",
    });
    expect(bytes).toBe(
      "More rows exist than the 32 KiB result limit holds, and 40 of them fitted; this tool does not page with offset. Read keys whose values are smaller to fit more rows, and to read past the 40 rows returned, read on with range <the last key returned> <end>: a range includes its start, so its first row is the last one returned again.",
    );
    for (const text of [hint, bytes, RUN_LIBREDB_READ_ARM.rowOverCap]) {
      expect(text).not.toContain("$skip");
      expect(text).not.toContain("LIMIT");
    }
    expect(RUN_LIBREDB_READ_ARM.rowOverCap).toBe(
      "One row of this result is larger than the 32 KiB result limit: a key's value is answered whole, never cut. Read keys whose values are smaller.",
    );
  });

  test("answers a row refusal with the command's own row-cap advice", () => {
    const rows = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed"),
      1,
      2,
      RUN_LIBREDB_READ_ARM.tooLarge("range a b", "libredb"),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice("range a b", "1000")}`,
    });
  });

  test("describes the commands it takes, the handle it reads through, the refusals and its engine", () => {
    const description = RUN_LIBREDB_READ_ARM.description;
    expect(description.startsWith("Run one read-only LibreDB command")).toBe(true);
    expect(description).toContain("Runs on LibreDB; other engines refuse it.");
    expect(description).toContain("get <key>");
    expect(description).toContain("prefix <p>");
    expect(description).toContain("range <start> <end>");
    expect(description).toContain("put, delete and anything else are refused before the file is opened");
    expect(description).toContain(
      "opens the connection's file read-only, on a handle of its own that takes no lock and cannot write",
    );
    expect(description).toContain(
      "this tool takes no offset, so narrow the read with a longer prefix or a closer range",
    );
  });
});

describe("the rabbitread arm", () => {
  const server = languageServer("rabbitread");
  const read = JSON.stringify({ vhost: "/", stream: "orders", from: "first", limit: 50 });

  test("takes one read request, no offset and no database, and sends it as written", () => {
    expect(RUN_RABBITMQ_READ_ARM.title).toBe("Run a read-only RabbitMQ stream read");
    expect(RUN_RABBITMQ_READ_ARM.argument).toBe("statement");
    expect(RUN_RABBITMQ_READ_ARM.paging).toBe("none");
    expect(RUN_RABBITMQ_READ_ARM.types).toEqual(["rabbitmq"]);
    expect(RUN_RABBITMQ_READ_ARM.inputSchema.shape).not.toHaveProperty("offset");
    expect(RUN_RABBITMQ_READ_ARM.inputSchema.shape).not.toHaveProperty("database");
    for (const extra of [{ offset: 5 }, { database: "/" }, { sql: "SELECT 1" }]) {
      expect(RunRabbitmqReadInputSchema.safeParse({ connection_id: "seed:r", statement: read, ...extra }).success).toBe(
        false,
      );
    }
    const empty = RunRabbitmqReadInputSchema.safeParse({ connection_id: "seed:r", statement: "" });
    expect(empty.error?.issues.map((issue) => issue.message)).toEqual(["statement cannot be empty"]);
  });

  test("reads its argument with the agent's canonicalize", () => {
    expect(RUN_RABBITMQ_READ_ARM.canonicalize(read)).toBe(server.canonicalize(read));
    expect(RUN_RABBITMQ_READ_ARM.canonicalize({ vhost: "/" })).toBeNull();
  });

  test.each([
    ["a key the request does not take", JSON.stringify({ vhost: "/", stream: "orders", headers: { a: "b" } })],
    ["a limit past 500", JSON.stringify({ vhost: "/", stream: "orders", limit: 501 })],
    ["text that is no read request", "queue.purge orders"],
  ])("fences %s with the agent's admission and quotes its sentence", (_what, statement) => {
    const refusal = server.admit?.(statement);
    expect(refusal).not.toBeNull();
    expect(RUN_RABBITMQ_READ_ARM.fence(statement, "rabbitmq")).toBe(
      `The read request was refused before it reached the broker (${refusal?.code}). ${refusal?.message}`,
    );
  });

  test("admits a read", () => {
    expect(RUN_RABBITMQ_READ_ARM.fence(read, "rabbitmq")).toBeNull();
    expect(RUN_RABBITMQ_READ_ARM.fence(JSON.stringify({ vhost: "/", stream: "orders" }), "rabbitmq")).toBeNull();
  });

  test("names no SQL clause or MongoDB stage where more rows exist, and reads on from the next offset", () => {
    const hint = RUN_RABBITMQ_READ_ARM.moreRows(read, "rabbitmq", { maxRows: 100, shown: 100, cut: "max_rows" });
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice(read, "100")} To read past the 100 rows returned, start the next read at {"offset": n}, where n is the last offset returned plus one.`,
    );
    const bytes = RUN_RABBITMQ_READ_ARM.moreRows(read, "rabbitmq", { maxRows: 100, shown: 40, cut: "result_bytes" });
    expect(bytes).toBe(
      'More rows exist than the 32 KiB result limit holds, and 40 of them fitted; this tool does not page with offset. A row is only an offset and a body size and cannot be made smaller, so read on in later reads, from {"offset": n} or a later start, to fit more rows, and to read past the 40 rows returned, start the next read at {"offset": n}, where n is the last offset returned plus one.',
    );
    for (const text of [hint, bytes, RUN_RABBITMQ_READ_ARM.rowOverCap]) {
      expect(text).not.toContain("$skip");
      expect(text).not.toContain("LIMIT");
    }
    expect(RUN_RABBITMQ_READ_ARM.rowOverCap).toBe(
      "One row of this result is larger than the 32 KiB result limit, though a row holds only an offset and a body size. Run the read again.",
    );
  });

  test("answers a row refusal with the read's own row-cap advice", () => {
    const rows = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed"),
      1,
      2,
      RUN_RABBITMQ_READ_ARM.tooLarge(read, "rabbitmq"),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice(read, "1000")}`,
    });
  });

  test("describes the request it takes, what it withholds, the refusals and its engine", () => {
    const description = RUN_RABBITMQ_READ_ARM.description;
    expect(description.startsWith("Run one read-only read of one RabbitMQ stream")).toBe(true);
    expect(description).toContain("Runs on RabbitMQ; other engines refuse it.");
    expect(description).toContain("its offset and its body size, and nothing else");
    expect(description).toContain("a classic or quorum queue is refused");
    expect(description).toContain('this tool takes no offset, so read on with "from": {"offset": n}');
  });

  test("says what an early stop and a read from next answer, since an MCP answer carries no warning text", () => {
    const description = RUN_RABBITMQ_READ_ARM.description;
    expect(description).toContain(
      'A read that stops before its limit because no message arrived for 1 s answers the messages it read, and that stop is not proof of the stream\'s end. "next" answers only messages published after the read starts, so a read from "next" that nothing is published to during the read answers no rows.',
    );
  });
});

/**
 * An engine that holds no object inspect_schema lists is refused there by name, rather than answered an empty page,
 * and the refusal names its statement tool. The arm declares it for its language, and every engine it serves is held
 * to its provider's own declaration: no relation kind where the arm says none, at least one where it does not.
 */
describe("the arms whose engines hold no table", () => {
  test("kubectl, MQTT and S3 declare it, SQL, MongoDB, libredbkv, Weaviate, Qdrant, etcd, rabbitread, Kafka, Cypher, Milvus, Redis, MTConnect, Sparkplug and SNMP do not", () => {
    expect(RUN_KUBECTL_READ_ARM.holdsNoTables).toBe(true);
    expect(RUN_READ_QUERY_ARM.holdsNoTables).toBe(false);
    expect(RUN_MONGO_COMMAND_ARM.holdsNoTables).toBe(false);
    // A LibreDB table, collection and keyspace are relations, so inspect_schema lists them.
    expect(RUN_WEAVIATE_READ_ARM.holdsNoTables).toBe(false);
    expect(RUN_LIBREDB_READ_ARM.holdsNoTables).toBe(false);
    expect(RUN_QDRANT_READ_ARM.holdsNoTables).toBe(false);
    // A key prefix is a relation kind; every agent-mode handle lists none, so inspect_schema answers an empty page.
    expect(RUN_ETCD_READ_ARM.holdsNoTables).toBe(false);
    // A RabbitMQ stream is a relation, so inspect_schema lists the streams and their agent columns.
    expect(RUN_RABBITMQ_READ_ARM.holdsNoTables).toBe(false);
    expect(RUN_KAFKA_READ_ARM.holdsNoTables).toBe(false);
    expect(RUN_CYPHER_READ_ARM.holdsNoTables).toBe(false);
    expect(RUN_MILVUS_READ_ARM.holdsNoTables).toBe(false);
    // A Redis key grouping is a `keyspace` relation, which inspect_schema lists.
    expect(RUN_REDIS_READ_ARM.holdsNoTables).toBe(false);
    expect(RUN_MTCONNECT_READ_ARM.holdsNoTables).toBe(false);
    // An MQTT broker declares no relation kind: a topic is a key, so inspect_schema refuses it by name.
    expect(RUN_MQTT_READ_ARM.holdsNoTables).toBe(true);
    // An edge node and a device are relation kinds; an agent-mode handle declares none, so inspect_schema answers an
    // empty page.
    expect(RUN_SPARKPLUG_READ_ARM.holdsNoTables).toBe(false);
    // A conceptual table and a group of scalars are relation kinds, so inspect_schema lists the bundled catalog's.
    expect(RUN_SNMP_READ_ARM.holdsNoTables).toBe(false);
    // A bucket and an object are config kinds, not relations, so inspect_schema refuses an S3 connection by name.
    expect(RUN_S3_READ_ARM.holdsNoTables).toBe(true);
  });

  test.each(ARMS.flatMap((arm) => arm.types.map((type) => [arm.tool, type, arm] as const)))(
    "%s on %s declares what the provider's own relation kinds say",
    async (_tool, type, arm) => {
      const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
      expect(relationKindIds(capabilities).length === 0).toBe(arm.holdsNoTables);
    },
  );

  test("names the statement tool of an engine whose arm holds no table, and null everywhere else", () => {
    for (const type of SHIPPED_DATABASE_TYPES) {
      const language = AGENT_STATEMENT_LANGUAGE[type];
      const arm = language === null ? null : MCP_STATEMENT_ARMS[language];
      const served = arm !== null && arm.types.includes(type);
      expect(mcpTablelessReadTool(type)).toBe(served && arm.holdsNoTables ? arm.tool : null);
    }
  });
});

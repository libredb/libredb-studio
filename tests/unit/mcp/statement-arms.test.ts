/**
 * The MCP statement arms: one per statement language, total over the language ids, each
 * reading its engines from the one served-engine resolver, and each non-SQL arm reading and fencing its statement with
 * the agent's own adapter, so an MCP client meets the agent's sentences.
 */
import { describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { AGENT_LANGUAGE_COPY, AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import { languageServer } from "@/lib/agent/languages/server";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { relationKindIds } from "@/lib/db/object-kinds";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { MCP_TOOL_INPUT_SCHEMAS } from "@/lib/mcp/tools";
import { classifyReadQueryFailure } from "@/lib/mcp/tools/read-query-limits";
import { RUN_READ_QUERY_DESCRIPTION, RUN_READ_QUERY_TYPES } from "@/lib/mcp/tools/run-read-query";
import { registerStatementTools } from "@/lib/mcp/tools/run-statement";
import { mcpStatementEngines } from "@/lib/mcp/tools/served-engines";
import {
  MCP_STATEMENT_ARMS,
  mcpStatementToolFor,
  mcpTablelessReadTool,
  RUN_KUBECTL_READ_ARM,
  RUN_MONGO_COMMAND_ARM,
  RUN_READ_QUERY_ARM,
  RunKubectlReadInputSchema,
  RunMongoCommandInputSchema,
  servingStatementArms,
} from "@/lib/mcp/tools/statement-arms";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

const ARMS = Object.values(MCP_STATEMENT_ARMS).flatMap((arm) => (arm === null ? [] : [arm]));

describe("MCP_STATEMENT_ARMS", () => {
  test("is total over the statement languages, and keyed by the language each arm reads", () => {
    expect(Object.keys(MCP_STATEMENT_ARMS).sort()).toEqual(Object.keys(AGENT_LANGUAGE_COPY).sort());
    for (const [language, arm] of Object.entries(MCP_STATEMENT_ARMS)) {
      if (arm !== null) expect(arm.language).toBe(language as (typeof arm)["language"]);
    }
  });

  test("every language has its arm: run_read_query, run_kubectl_read and run_mongo_command", () => {
    expect(MCP_STATEMENT_ARMS.sql).toBe(RUN_READ_QUERY_ARM);
    expect(MCP_STATEMENT_ARMS.kubectl).toBe(RUN_KUBECTL_READ_ARM);
    expect(MCP_STATEMENT_ARMS.mongo).toBe(RUN_MONGO_COMMAND_ARM);
    expect(ARMS.map((arm) => arm.tool)).toEqual(["run_read_query", "run_kubectl_read", "run_mongo_command"]);
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
    expect(RUN_READ_QUERY_ARM.tooLarge("SELECT 1")).toEqual({});
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
      RUN_MONGO_COMMAND_ARM.tooLarge(find),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice(find, "1000")}`,
    });
    const bytes = classifyReadQueryFailure(
      new Error("Read-only execution exceeded the byte budget: 2 > 1"),
      1,
      2,
      RUN_MONGO_COMMAND_ARM.tooLarge(find),
    );
    expect(bytes).toEqual({ kind: "too-large", text: RUN_MONGO_COMMAND_ARM.tooLarge(find).bytes as string });
    expect(RUN_MONGO_COMMAND_ARM.tooLarge(find).bytes).not.toContain("LIMIT");
  });

  test("names no SQL clause where more rows exist, says the tool takes no offset, and pages with skip", () => {
    const hint = RUN_MONGO_COMMAND_ARM.moreRows(find, "mongodb", { maxRows: 100, shown: 100, cut: "max_rows" });
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice(find, "100")} To read past the 100 rows returned, skip them with a find's "skip" or a $skip stage.`,
    );
    expect(RUN_MONGO_COMMAND_ARM.rowOverCap).not.toContain("column");
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
      RUN_KUBECTL_READ_ARM.tooLarge("get pods -A"),
    );
    expect(rows).toEqual({
      kind: "too-large",
      text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice("get pods -A", "1000")}`,
    });
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

describe("the tool each engine is read with", () => {
  test("is the tool whose arm serves it, and null where none does", () => {
    for (const type of SHIPPED_DATABASE_TYPES) {
      const language = AGENT_STATEMENT_LANGUAGE[type];
      const arm = language === null ? null : MCP_STATEMENT_ARMS[language];
      expect(mcpStatementToolFor(type)).toBe(arm !== null && arm.types.includes(type) ? arm.tool : null);
    }
  });

  test("MongoDB is read with run_mongo_command, Kubernetes with run_kubectl_read, the SQL engines with run_read_query, the rest with none", () => {
    expect(mcpStatementToolFor("mongodb")).toBe("run_mongo_command");
    expect(mcpStatementToolFor("kubernetes")).toBe("run_kubectl_read");
    for (const type of RUN_READ_QUERY_TYPES) expect(mcpStatementToolFor(type)).toBe("run_read_query");
    expect(mcpStatementToolFor("redis")).toBeNull();
    expect(mcpStatementToolFor("snowflake")).toBeNull();
  });

  test("the tools registered are the arms that serve an engine", () => {
    expect(servingStatementArms()).toEqual(ARMS.filter((arm) => arm.types.length > 0));
    expect(servingStatementArms().map((arm) => arm.tool)).toEqual([
      "run_read_query",
      "run_kubectl_read",
      "run_mongo_command",
    ]);
  });

  test("an arm that serves no engine is neither listed nor registered", () => {
    const idle = Object.freeze({ ...RUN_MONGO_COMMAND_ARM, types: [] });
    const arms = { sql: RUN_READ_QUERY_ARM, kubectl: null, mongo: idle };
    expect(servingStatementArms(arms)).toEqual([RUN_READ_QUERY_ARM]);
    const registerTool = mock((_name: string) => undefined);
    registerStatementTools({ registerTool } as unknown as McpServer, {} as McpConnectionContext, arms);
    expect(registerTool.mock.calls.map(([name]) => name)).toEqual(["run_read_query"]);
  });
});

/**
 * An engine that holds no object inspect_schema lists is refused there by name, rather than answered an empty page,
 * and the refusal names its statement tool. The arm declares it for its language, and every engine it serves is held
 * to its provider's own declaration: no relation kind where the arm says none, at least one where it does not.
 */
describe("the arms whose engines hold no table", () => {
  test("kubectl declares it, SQL and MongoDB do not", () => {
    expect(RUN_KUBECTL_READ_ARM.holdsNoTables).toBe(true);
    expect(RUN_READ_QUERY_ARM.holdsNoTables).toBe(false);
    expect(RUN_MONGO_COMMAND_ARM.holdsNoTables).toBe(false);
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
    expect(mcpTablelessReadTool("kubernetes")).toBe("run_kubectl_read");
    expect(mcpTablelessReadTool("mongodb")).toBeNull();
    expect(mcpTablelessReadTool("postgres")).toBeNull();
    expect(mcpTablelessReadTool("redis")).toBeNull();
  });
});

/**
 * The MCP statement arms (all-providers design 6, B117): one per statement language, total over the language ids, each
 * reading its engines from the one served-engine resolver, and each non-SQL arm reading and fencing its statement with
 * the agent's own adapter, so an MCP client meets the agent's sentences.
 */
import { describe, expect, test } from "bun:test";
import { AGENT_LANGUAGE_COPY, AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import { languageServer } from "@/lib/agent/languages/server";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { MCP_TOOL_INPUT_SCHEMAS } from "@/lib/mcp/tools";
import { classifyReadQueryFailure } from "@/lib/mcp/tools/read-query-limits";
import { RUN_READ_QUERY_DESCRIPTION, RUN_READ_QUERY_TYPES } from "@/lib/mcp/tools/run-read-query";
import { mcpStatementEngines } from "@/lib/mcp/tools/served-engines";
import {
  MCP_STATEMENT_ARMS,
  mcpStatementToolFor,
  RUN_MONGO_COMMAND_ARM,
  RUN_READ_QUERY_ARM,
  RunMongoCommandInputSchema,
  servingStatementArms,
} from "@/lib/mcp/tools/statement-arms";

const ARMS = Object.values(MCP_STATEMENT_ARMS).flatMap((arm) => (arm === null ? [] : [arm]));

describe("MCP_STATEMENT_ARMS", () => {
  test("is total over the statement languages, and keyed by the language each arm reads", () => {
    expect(Object.keys(MCP_STATEMENT_ARMS).sort()).toEqual(Object.keys(AGENT_LANGUAGE_COPY).sort());
    for (const [language, arm] of Object.entries(MCP_STATEMENT_ARMS)) {
      if (arm !== null) expect(arm.language).toBe(language as (typeof arm)["language"]);
    }
  });

  test("kubectl decides no arm yet, and the other two are run_read_query and run_mongo_command", () => {
    expect(MCP_STATEMENT_ARMS.kubectl).toBeNull();
    expect(MCP_STATEMENT_ARMS.sql).toBe(RUN_READ_QUERY_ARM);
    expect(MCP_STATEMENT_ARMS.mongo).toBe(RUN_MONGO_COMMAND_ARM);
    expect(ARMS.map((arm) => arm.tool)).toEqual(["run_read_query", "run_mongo_command"]);
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

  test("names no SQL clause where more rows exist, and says the tool takes no offset", () => {
    const hint = RUN_MONGO_COMMAND_ARM.moreRows(find, "mongodb", 100);
    expect(hint).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice(find, "100")}`,
    );
    expect(RUN_MONGO_COMMAND_ARM.rowOverCap).not.toContain("column");
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

  test("MongoDB is read with run_mongo_command, the SQL engines with run_read_query, the rest with none", () => {
    expect(mcpStatementToolFor("mongodb")).toBe("run_mongo_command");
    for (const type of RUN_READ_QUERY_TYPES) expect(mcpStatementToolFor(type)).toBe("run_read_query");
    expect(mcpStatementToolFor("kubernetes")).toBeNull();
    expect(mcpStatementToolFor("redis")).toBeNull();
    expect(mcpStatementToolFor("snowflake")).toBeNull();
  });

  test("the tools registered are the arms that serve an engine", () => {
    expect(servingStatementArms()).toEqual(ARMS.filter((arm) => arm.types.length > 0));
    expect(servingStatementArms().map((arm) => arm.tool)).toEqual(["run_read_query", "run_mongo_command"]);
  });
});

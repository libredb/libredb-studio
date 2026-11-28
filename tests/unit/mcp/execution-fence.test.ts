import { describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { forgetServerCatalog, installServerCatalog, servedEngineRecord } from "@/lib/db/server-catalog";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { assertReadOnlyStatement, checkReadOnlyStatement } from "@/lib/mcp/guards/execution-fence";
import { type McpStatementInput, runStatement } from "@/lib/mcp/tools/run-statement";
import { type McpStatementArm, mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import * as querySink from "@/lib/query-events/sink";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseType } from "@/lib/types";
import { STATEMENT_ROW_ENGINE, statementRowCatalog } from "../../helpers/package-statement-row";

describe("MCP Execution Fence", () => {
  test("allows legitimate SELECT queries", () => {
    expect(() => assertReadOnlyStatement("SELECT * FROM users")).not.toThrow();
    expect(checkReadOnlyStatement("SELECT id, name FROM accounts WHERE active = true")).toBeNull();
  });

  test("allows queries with pure read CTEs", () => {
    const sql = "WITH active_users AS (SELECT id FROM users WHERE active = true) SELECT * FROM active_users";
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
  });

  test("rejects DDL statements (DROP, CREATE, ALTER, TRUNCATE)", () => {
    expect(() => assertReadOnlyStatement("DROP TABLE users")).toThrow();
    expect(() => assertReadOnlyStatement("CREATE TABLE hacked (id INT)")).toThrow();
    expect(() => assertReadOnlyStatement("ALTER TABLE users ADD COLUMN compromised INT")).toThrow();
    expect(() => assertReadOnlyStatement("TRUNCATE TABLE logs")).toThrow();
  });

  test("rejects DML statements (INSERT, UPDATE, DELETE)", () => {
    expect(() => assertReadOnlyStatement("INSERT INTO users (name) VALUES ('hacker')")).toThrow();
    expect(() => assertReadOnlyStatement("UPDATE users SET is_admin = true")).toThrow();
    expect(() => assertReadOnlyStatement("DELETE FROM users WHERE id = 1")).toThrow();
  });

  test("rejects multiple statements separated by semicolons", () => {
    expect(() => assertReadOnlyStatement("SELECT 1; DROP TABLE users;")).toThrow();
    expect(checkReadOnlyStatement("SELECT 1; SELECT 2;")).toBe("MULTIPLE_STATEMENTS");
  });

  test("rejects commands disguised in comments or ambiguous text", () => {
    expect(() => assertReadOnlyStatement("/* SELECT */ INSERT INTO users VALUES (1)")).toThrow();
  });
});

// A provider package's engine whose register row grants every MCP statement claim and the SQL statement language and
// reviews no grammar: while no arm serves it (its record offers no execution profile), the statement tool refuses it
// before its statement is canonicalized or fenced and before any query event, so nothing reads its statement under a
// grammar the row did not review.
describe("a provider package's engine whose row reviews no grammar", () => {
  test("a package engine whose row reviews no grammar reaches neither the fence nor a query event while no arm serves it", async () => {
    installHostCore(createHostCore(), "test");
    installServerCatalog(statementRowCatalog());
    const events = spyOn(querySink, "recordQueryEvent");
    try {
      expect(servedEngineRecord(STATEMENT_ROW_ENGINE).grants).toMatchObject({
        reviewedGrammar: false,
        exposable: true,
      });
      const served = mcpStatementArm("run_read_query");
      const canonicalize = mock((input: unknown) => served.canonicalize(input));
      const fence = mock((statement: string, type: DatabaseType) => served.fence(statement, type));
      const arm = { ...served, canonicalize, fence } as McpStatementArm;
      const connection = {
        id: "seed:acme",
        name: "Acme",
        type: STATEMENT_ROW_ENGINE,
        seedId: "acme",
        managed: true,
        mcp: true,
        roles: ["admin"],
        createdAt: new Date(),
      } as unknown as ManagedConnection;
      const context = {
        caller: { username: "alice", role: "admin" },
        resolve: async () => connection,
      } as unknown as McpConnectionContext;
      const args = arm.inputSchema.parse({ connection_id: "seed:acme", sql: `SELECT '${randomUUID()}'` });
      const result = await runStatement(arm, args as McpStatementInput, {
        context,
        signal: new AbortController().signal,
      });
      // Refused by the served-engine gate, by name, which is what keeps the fence and the query event unreached.
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining(
            `this tool does not serve ${servedEngineRecord(STATEMENT_ROW_ENGINE).displayName}; use inspect_schema there`,
          ),
        },
      ]);
      expect(canonicalize).not.toHaveBeenCalled();
      expect(fence).not.toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
    } finally {
      events.mockRestore();
      forgetServerCatalog();
      forgetHostCore();
    }
  });
});

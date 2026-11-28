import { describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { clearProviderCache } from "@/lib/db/factory";
import { languageDataSha256 } from "@/lib/db/language-digest";
import * as statementGuard from "@/lib/db/operations/statement-guard";
import { forgetServerCatalog, installServerCatalog, servedEngineRecord } from "@/lib/db/server-catalog";
import { McpConnectionContext, type MCP_CONNECTIONS_UNREADABLE } from "@/lib/mcp/context";
import { assertReadOnlyStatement, checkReadOnlyStatement } from "@/lib/mcp/guards/execution-fence";
import { type McpStatementInput, runStatement } from "@/lib/mcp/tools/run-statement";
import { type McpStatementArm, mcpStatementArm, type McpStatementTool } from "@/lib/mcp/tools/statement-arms";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import * as queryEventBuild from "@/lib/query-events/build";
import * as querySink from "@/lib/query-events/sink";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseType } from "@/lib/types";
import { mcpPackageLanguageRow, withMcpPackageLanguage } from "../../helpers/agent-package-catalog";
import { acmereadData } from "../../helpers/declared-agent-language";
import { admitSessionPackages, setHooks } from "../../helpers/package-session-fixture";
import { STATEMENT_ROW_ENGINE, statementRowCatalog } from "../../helpers/package-statement-row";
import { removeScratch, scratchDirectory } from "../../helpers/provider-artifacts";

/** The package engine of the served case: its own declared language, its row reviewing no grammar. */
const FENCE_ENGINE = "acmefencelang";

/** A context whose visible connections are `listed`, every other member the real context's. */
class PlantedContext extends McpConnectionContext {
  constructor(private readonly listed: readonly ManagedConnection[]) {
    super({ username: "alice", role: "admin" });
  }

  override visibleConnections(): Promise<readonly ManagedConnection[] | typeof MCP_CONNECTIONS_UNREADABLE> {
    return Promise.resolve(this.listed);
  }
}

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

// A provider package's engine whose register row reviews no grammar, though its manifest states SQL text: MCP's
// statement tools never read its statement under a grammar. A declared statement is admitted by its declared form,
// never by the SQL fence, and a package granted `sql` is served by no MCP statement tool, since run_read_query serves
// only an engine whose record offers execution profiles; MCP records no query event, so none keeps its statement text.
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
      // Refused by the served-engine gate, by name, since run_read_query serves only an engine whose record offers
      // execution profiles: what keeps the fence and the query event unreached.
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

  test("a package engine whose row reviews no grammar is fenced under the default grammar and its query events keep none of its statement text", async () => {
    const data = acmereadData("acmefencelangql", "run_acmefencelang_read");
    const providers = scratchDirectory("studio-mcp-fence-package-");
    installHostCore(createHostCore(), "test");
    const inspected = spyOn(statementGuard, "inspectAgentStatement");
    const built = spyOn(queryEventBuild, "buildQueryEvent");
    const events = spyOn(querySink, "recordQueryEvent");
    try {
      // The minimal manifest states SQL text; the row grants the package its own language and names no grammar.
      await admitSessionPackages(
        providers,
        [{ name: "acme-fence-lang", engine: FENCE_ENGINE, honours: ["readOnly"], edit: withMcpPackageLanguage(data) }],
        { [FENCE_ENGINE]: mcpPackageLanguageRow(data.name, languageDataSha256(data)) },
      );
      expect(servedEngineRecord(FENCE_ENGINE).grants).toMatchObject({
        reviewedGrammar: false,
        statementLanguage: data.name,
      });
      const executes: unknown[] = [];
      setHooks(FENCE_ENGINE, {
        open: () => Promise.resolve({ handle: { session: randomUUID() } }),
        close: () => Promise.resolve(),
        execute: (_handle, request) => {
          executes.push(request);
          return Promise.resolve({
            results: [
              {
                columns: [{ name: "topic" }],
                next: () => Promise.resolve({ rows: [["orders"]], done: true }),
                close: () => Promise.resolve(),
              },
            ],
            warnings: [],
            executionTimeMs: 1,
            pageApplied: false,
          });
        },
      });
      const arm = mcpStatementArm(data.agent?.mcp?.tool as McpStatementTool);
      const connection = {
        id: "seed:acme-fence",
        name: "Acme",
        type: FENCE_ENGINE,
        host: "fence.local",
        password: randomUUID(),
        seedId: "acme-fence",
        managed: true,
        mcp: true,
        roles: ["admin"],
        createdAt: new Date(),
      } as unknown as ManagedConnection;
      const context = new PlantedContext([connection]);
      const args = arm.inputSchema.parse({ connection_id: connection.id, [arm.argument]: '{"read":"topics"}' });
      const result = await runStatement(arm, args as McpStatementInput, {
        context,
        signal: new AbortController().signal,
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ rows: [{ topic: "orders" }] });
      expect(executes).toHaveLength(1);
      // Admitted by its declared form alone: no grammar-reading fence, no query event, no masking of its text.
      expect(inspected).not.toHaveBeenCalled();
      expect(built).not.toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
    } finally {
      inspected.mockRestore();
      built.mockRestore();
      events.mockRestore();
      await clearProviderCache();
      forgetServerCatalog();
      forgetHostCore();
      removeScratch(providers);
    }
  });
});

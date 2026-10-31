/**
 * SNMP's agent leg as the registries and documents state it: the factory hands the provider its execution context, the
 * plan-mode statement language names the four commands and the six withheld modules, MCP stays closed, the read-only
 * flag is untouched, and the B entry that records what agent mode opened is cited both ways.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { MCP_EXPOSABLE, MCP_STATEMENT_READ, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import { DatabaseConfigError, RefusedBeforeSendError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import { SNMP_WITHHELD_SUBTREES } from "@/lib/db/providers/network/snmp/agent-statement";
import { SNMP_LABELS } from "@/lib/db/providers/network/snmp/labels";
import type { DatabaseConnection } from "@/lib/types";

const ROOT = posix.resolve(import.meta.dir.replaceAll("\\", "/"), "../../../..");
const read = (relative: string) => readFileSync(posix.join(ROOT, relative), "utf8");
const BUDGET = { statementTimeoutMs: 1_000, maxResultRows: 5, maxResultBytes: 1_000 };

const connection = {
  id: "snmp-registration",
  name: "snmp",
  type: "snmp",
  host: "127.0.0.1",
  port: 9,
  password: "not-a-real-community",
  createdAt: new Date(),
} as unknown as DatabaseConnection;

describe("the registries", () => {
  test("snmp speaks snmpget, executes agent reads, and MCP stays closed with the read-only flag untouched", () => {
    expect(AGENT_STATEMENT_LANGUAGE.snmp).toBe("snmpget");
    expect(AGENT_EXECUTION_ENGINES).toContain("snmp");
    expect(MCP_EXPOSABLE.snmp).toBe(false);
    expect(MCP_STATEMENT_READ.snmp).toBe(false);
    expect(READ_ONLY_ENFORCED.snmp).toBe(true);
  });

  test("the factory hands the provider its execution context", async () => {
    const editor = await createDatabaseProvider(connection);
    await expect(editor.queryReadOnly?.("get sysDescr.0", BUDGET)).rejects.toThrow(RefusedBeforeSendError);
    const agent = await createDatabaseProvider(connection, {}, { readOnly: true, sendsStatements: true });
    // Past the profile check: the handle is an agent read-only one, and only the closed connection stops it.
    await expect(agent.queryReadOnly?.("get sysDescr.0", BUDGET)).rejects.toThrow(DatabaseConfigError);
  });
});

describe("what plan mode is told", () => {
  test("the statement language names the four commands, no set, and every withheld module", () => {
    const language = SNMP_LABELS.statementLanguage as string;
    for (const command of ["get OID", "next OID", "walk SUBTREE", "table ENTRY"]) expect(language).toContain(command);
    expect(language).toContain("there is no set");
    for (const entry of SNMP_WITHHELD_SUBTREES) expect(language).toContain(entry.module);
    expect(language).toContain("never a value the agent holds");
  });
});

describe("the B entry, both ways", () => {
  test("BACKLOG holds it, docs/AGENT.md cites it, and the provider document links it", () => {
    expect(read("docs/BACKLOG.md")).toContain(
      "### B158. SNMP's agent reads withhold the security and target modules, and it has no MCP surface",
    );
    expect(read("docs/AGENT.md")).toContain(
      "- **B158**: SNMP's `snmpget` statement language reads the device's values",
    );
    expect(read("docs/providers/snmp.md")).toContain(
      "(../BACKLOG.md#b158-snmps-agent-reads-withhold-the-security-and-target-modules-and-it-has-no-mcp-surface)",
    );
  });
});

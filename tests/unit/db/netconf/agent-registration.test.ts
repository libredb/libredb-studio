/**
 * NETCONF's agent leg as the registries, the pack and the documents state it: the factory hands the provider its
 * execution context, the language reads with the provider's own reader, every agent-facing text names each withheld
 * kind by its own identifier, MCP stays closed, the read-only flag is untouched, and the B entry is cited both ways.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { fingerprintNetconfrpc, netconfrpcRowCapAdvice } from "@/lib/agent/languages/netconfrpc/adapter";
import { NETCONFRPC_CLIENT_PACK } from "@/lib/agent/languages/netconfrpc/client";
import { NETCONFRPC_TOOL_OVERRIDES } from "@/lib/agent/languages/netconfrpc/definitions";
import { NETCONFRPC_SERVER_PACK } from "@/lib/agent/languages/netconfrpc/server";
import { MCP_EXPOSABLE, MCP_STATEMENT_READ, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import { QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import {
  admitNetconfrpcStatement,
  NETCONFRPC_AGENT_MAX_STATEMENT_CHARS,
  netconfrpcAgentReadInput,
} from "@/lib/db/operations/netconfrpc-admission";
import { NETCONF_AGENT_SENTENCES } from "@/lib/db/providers/network/netconf/agent-statement";
import { NETCONF_WITHHELD_TEXT } from "@/lib/db/providers/network/netconf/agent-withheld";
import { NETCONF_LABELS } from "@/lib/db/providers/network/netconf/labels";
import type { DatabaseConnection } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const BUDGET = { statementTimeoutMs: 1_000, maxResultRows: 5, maxResultBytes: 1_000 };
const READ = '{"datastore": "running", "path": "ietf-interfaces:interfaces"}';
const KINDS = [
  "ietf-keystore",
  "ietf-netconf-acm",
  "nacm:default-deny-all",
  "crypt-hash",
  "private-key-type",
  "key-type",
  "password-type",
  "leafref that may point at a withheld node",
  "unresolved leafref",
  "keyed by a withheld leaf",
];

const connection = {
  id: "netconf-registration",
  name: "netconf",
  type: "netconf",
  host: "127.0.0.1",
  port: 9,
  user: "ro",
  password: "not-a-real-password",
  createdAt: new Date(),
} as unknown as DatabaseConnection;

describe("the registries", () => {
  test("netconf speaks netconfrpc, executes agent reads, and MCP stays closed with the read-only flag untouched", () => {
    expect(AGENT_STATEMENT_LANGUAGE.netconf).toBe("netconfrpc");
    expect(AGENT_EXECUTION_ENGINES).toContain("netconf");
    expect(MCP_EXPOSABLE.netconf).toBe(false);
    expect(MCP_STATEMENT_READ.netconf).toBe(false);
    expect(READ_ONLY_ENFORCED.netconf).toBe(true);
  });

  test("the factory hands the provider its execution context", async () => {
    const editor = await createDatabaseProvider(connection);
    await expect(editor.queryReadOnly?.(READ, BUDGET)).rejects.toThrow(RefusedBeforeSendError);
    const agent = await createDatabaseProvider(connection, {}, { readOnly: true, sendsStatements: true });
    // Past the profile check: the handle is an agent read-only one, and only the closed connection stops it.
    await expect(agent.queryReadOnly?.(READ, BUDGET)).rejects.toThrow(new QueryError("This connection is not open."));
  });
});

describe("the pack's server facet", () => {
  test("the fingerprint is the reader's plan, so two spellings of one read are one, and a refused text is its own", () => {
    expect(fingerprintNetconfrpc(READ)).toBe(
      fingerprintNetconfrpc('{ "path":"ietf-interfaces:interfaces","datastore":"running" }'),
    );
    expect(fingerprintNetconfrpc(READ)).not.toBe(
      fingerprintNetconfrpc('{"datastore": "operational", "path": "ietf-interfaces:interfaces"}'),
    );
    expect(fingerprintNetconfrpc("nope")).toBe(fingerprintNetconfrpc("nope"));
    expect(fingerprintNetconfrpc("nope")).not.toBe(fingerprintNetconfrpc("nope "));
    expect(netconfrpcRowCapAdvice(READ, "7")).toStartWith("Ask for at most 7 rows:");
  });

  test("the admission is the reader plus the length bound, and the descriptor's input is strict", () => {
    expect(admitNetconfrpcStatement(READ)).toBeNull();
    expect(admitNetconfrpcStatement("x".repeat(NETCONFRPC_AGENT_MAX_STATEMENT_CHARS + 1))?.code).toBe(
      "agent-too-large",
    );
    expect(admitNetconfrpcStatement('{"schema": "ietf-keystore"}')).toEqual({
      code: "withheld",
      message: NETCONF_AGENT_SENTENCES.withheldModule("ietf-keystore"),
    });
    expect(netconfrpcAgentReadInput.safeParse({ statement: READ }).success).toBe(true);
    expect(netconfrpcAgentReadInput.safeParse({ statement: READ, sql: "x" }).success).toBe(false);
    const refused = netconfrpcAgentReadInput.safeParse({ statement: '{"operation": "edit-config"}' });
    expect(refused.success).toBe(false);
  });

  test("the tool description, the rule, the grounding and the ungrounded note name every withheld kind; no planning rules", () => {
    const tool = NETCONFRPC_TOOL_OVERRIDES.investigation?.run_read_query;
    const texts = [
      tool?.description ?? "",
      NETCONFRPC_SERVER_PACK.workflowToolRules.investigation ?? "",
      NETCONFRPC_SERVER_PACK.grounding.omissionAdvice,
      NETCONFRPC_SERVER_PACK.grounding.ungrounded?.("No inventory.", { singular: "node", plural: "nodes" } as never) ??
        "",
    ];
    for (const text of texts) expect(text).toContain(NETCONF_WITHHELD_TEXT);
    expect(NETCONFRPC_SERVER_PACK.grounding.planningRules).toBeUndefined();
  });
});

describe("what the client facet and plan mode are told", () => {
  test("the posture names each withheld kind by its own identifier and the reads the client sends, and claims no write", () => {
    const posture = NETCONFRPC_CLIENT_PACK.posture.reads({ maxResultRows: 200, statementTimeoutMs: 10_000 } as never);
    for (const kind of KINDS) expect(posture.body).toContain(kind);
    for (const read of ["get-config", "get-data", "get-schema"]) expect(posture.qualifier).toContain(read);
    for (const kind of [
      "ietf-keystore",
      "ietf-netconf-acm",
      "nacm:default-deny-all",
      "crypt-hash",
      "ietf-crypto-types secrets",
      "leafrefs to a withheld node",
      "unresolved leafrefs and typedefs",
      "entries of lists keyed by a withheld leaf",
    ]) {
      expect(posture.qualifier).toContain(kind);
    }
    expect(posture.body).toContain("refused past them rather than cut");
    expect(posture.body).toContain("every leaf whose type names a typedef no module the device serves declares");
    expect(NETCONFRPC_CLIENT_PACK.copy.writes).toContain("an unresolved leafref or typedef");
    expect(Object.keys(NETCONFRPC_CLIENT_PACK.variants).sort()).toEqual(["investigation", "operations"]);
    expect(NETCONFRPC_CLIENT_PACK.variants.investigation.canAutoExecute).toBe(false);
    expect(NETCONFRPC_CLIENT_PACK.posture.handoverTerms()).toContain("never run in your editor");
  });

  test("the statement language names only the request the editor runs, no XML or other operation, and every withheld kind", () => {
    const language = NETCONF_LABELS.statementLanguage as string;
    expect(language).toContain('{"datastore": "running", "path": "ietf-interfaces:interfaces", "limit": 100}');
    // The console refuses a schema request, so plan mode, which drafts for the editor, is never offered one.
    expect(language).not.toContain('"schema"');
    expect(language).toContain("A draft never reads a node agent mode withholds.");
    expect(language).toContain("There is no XML, no edit-config or other operation");
    expect(language).toContain(NETCONF_WITHHELD_TEXT);
    expect(language).toContain("never a value the device holds");
  });
});

describe("the B entry, both ways", () => {
  test("BACKLOG holds it, docs/AGENT.md cites it, and the provider document links it", () => {
    expect(read("docs/BACKLOG.md")).toContain(
      "### B159. NETCONF's agent reads withhold keys, password hashes and access rules, and it has no MCP surface",
    );
    expect(read("docs/AGENT.md")).toContain("- **B159**: NETCONF's `netconfrpc` request language reads");
    expect(read("docs/providers/netconf.md")).toContain(
      "(../BACKLOG.md#b159-netconfs-agent-reads-withhold-keys-password-hashes-and-access-rules-and-it-has-no-mcp-surface)",
    );
  });
});

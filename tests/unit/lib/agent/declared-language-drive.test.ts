import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseConnection, DatabaseProvider } from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";
import { acmereadData } from "../../../helpers/declared-agent-language";

/**
 * A statement language declared as data, `acmeread` (tests/helpers/declared-agent-language.ts), offered on a legacy
 * engine with no module of its own: the language registries hold it beside the module languages, the run's tools,
 * rules and posture read its composed text, MCP offers its declared statement tool, and a read is admitted or refused
 * by its declared request form before any provider is acquired, in agent mode and on the MCP path alike.
 *
 * No shipped declaration states agent data yet, so this file substitutes the list of the declared languages' data
 * (`@/lib/db/declared-statement-languages`) with `acmeread` and `acmeplain`, a language with no agent part, and grants
 * MQTT `acmeread`: in the browser tables by substituting the grant reader's `GRANTED_AGENT_STATEMENT_LANGUAGE` row, and
 * on the server by a crafted catalog. MQTT rather than Kafka, so no Kafka test reads a substituted language. The real
 * grant reader is captured as a plain object before the substitution, because a namespace follows its replacement.
 * `mock.module` is process-wide, so the substitutions are made before anything that reads them is loaded: every such
 * module is imported dynamically below them, and the runner gives this file its own process. The crafted catalog is
 * installed before those imports too, since `MCP_STATEMENT_ARMS` reads each arm's served engines once, when its module
 * loads (`served-engines.ts`), so a catalog installed later would leave the declared tool serving no engine.
 */

const ACMEREAD = acmereadData();
const ACMEPLAIN = { ...acmereadData("acmeplain"), agent: null };
const AGENT = ACMEREAD.agent as NonNullable<typeof ACMEREAD.agent>;

const REAL_CLAIM_GRANTS = { ...(await import("@/lib/db/claim-grants")) };
mock.module("@/lib/db/declared-statement-languages", () => ({
  DECLARED_STATEMENT_LANGUAGES: Object.freeze([ACMEREAD, ACMEPLAIN]),
}));
mock.module("@/lib/db/claim-grants", () => ({
  ...REAL_CLAIM_GRANTS,
  GRANTED_AGENT_STATEMENT_LANGUAGE: Object.freeze({
    ...REAL_CLAIM_GRANTS.GRANTED_AGENT_STATEMENT_LANGUAGE,
    mqtt: "acmeread",
  }),
}));

const { forgetServerCatalog, installServerCatalog } = await import("@/lib/db/server-catalog");
const { craftedCatalog } = await import("../../../helpers/package-catalog");
installServerCatalog(craftedCatalog({ mqtt: { statementLanguage: "acmeread" } }));

const {
  AGENT_LANGUAGE_COPY,
  AGENT_PLAN_ESTIMATE_OPERATION,
  AGENT_WORKFLOW_VARIANTS,
  agentVariant,
  workflowAvailability,
} = await import("@/lib/agent/agent-manifest");
const { agentPosture } = await import("@/lib/agent/posture");
const {
  AGENT_EVIDENCE_EVENTS,
  AGENT_PACK_REQUIREMENTS,
  agentLanguageOfGrant,
  isAgentStatementLanguage,
  languageClientPack,
} = await import("@/lib/agent/languages/client");
const { LANGUAGE_BASE_DEFINITIONS, languageServer, languageServerPack, WORKFLOW_TOOL_RULES } = await import(
  "@/lib/agent/languages/server"
);
const { agentLanguagePack, LANGUAGE_TOOL_ARMS } = await import("@/lib/agent/languages/index");
const { declaredAgentLanguages } = await import("@/lib/agent/languages/declared-client");
const { AGENT_LANGUAGE_MCP_FACETS } = await import("@/lib/agent/languages/mcp");
const { agentEnginePack } = await import("@/lib/agent/languages/engines/index");
const { AgentRunDeadline } = await import("@/lib/agent/deadline");
const { AGENT_WORKFLOW_BUDGETS } = await import("@/lib/agent/execution-policy");
const { AgentRepairLedger } = await import("@/lib/agent/repair-ledger");
const { UNAVAILABLE_TEXT } = await import("@/lib/agent/tool-contracts");
const { agentToolDefinition, runReadQueryTool, selectAgentTools } = await import("@/lib/agent/tools");
const {
  MCP_STATEMENT_ARMS,
  MCP_STATEMENT_TOOLS,
  mcpStatementArm,
  mcpStatementToolFor,
  mcpTablelessReadTool,
  servingStatementArms,
} = await import("@/lib/mcp/tools/statement-arms");
const { isMcpToolName, MCP_TOOL_INPUT_SCHEMAS } = await import("@/lib/mcp/tools");
const { ListedConnectionSchema } = await import("@/lib/mcp/tools/list-connections");
const { databaseContentNotice, MCP_UNTRUSTED_NOTICE } = await import("@/lib/mcp/output");
const { providerAuthor } = await import("@/lib/db/operations/provider-text");
const { McpConnectionContext } = await import("@/lib/mcp/context");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { getDBConfig } = await import("@/lib/db-ui-config");
const { fillAgentText } = await import("@/lib/agent/languages/declared-client");
const { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } = await import("../../../helpers/mcp-fixtures");
const { connectClient, handlerServe, testAuthInfo } = await import("../../../helpers/mcp-harness");
const { ExecutionArtifactStore } = await import("@/lib/db/operations/artifacts");
const { ExecutionBudgetTracker } = await import("@/lib/db/operations/budgets");
const { createCanonicalOperationRegistry, isStatementReadOperation } = await import("@/lib/db/operations/descriptors");
const { admitDeclaredRequest } = await import("@/lib/db/operations/declared-request-form");
const { createTargetScope } = await import("@/lib/db/operations/policy");
const { createHostCore } = await import("@/lib/provider-host/core/host-core");
const { forgetHostCore, installHostCore } = await import("@/lib/provider-host/instance");
const { CENSUS_CONNECTION } = await import("../../../helpers/census-connection");
const { createDatabaseProvider } = await import("@/lib/db/factory");

beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(() => {
  forgetServerCatalog();
  forgetHostCore();
});

const NAME = "acmeread";
if (!isAgentStatementLanguage(NAME)) throw new Error("the substituted list does not reach the language registries");
const ACME = NAME;
const BOUNDS = Object.freeze({ maxResultRows: 7, statementTimeoutMs: 2500 });
/** The result limits every statement tool shares, which Studio fills into a declared description as `limits`. */
const SHARED_LIMITS =
  "Returns at most max_rows rows (default 100, at most 500) and at most 32 KiB; truncated and pagination.hasMore say when rows were cut";

describe("a data-declared language in the language registries", () => {
  test("the language registries hold a data-declared language beside the module languages, and refuse one whose name a module or another declared language holds", () => {
    expect(isAgentStatementLanguage("acmeread")).toBe(true);
    expect(isAgentStatementLanguage("acmeplain")).toBe(false);
    expect<string | null>(agentLanguageOfGrant("mqtt", "acmeread")).toBe("acmeread");
    expect(() => agentLanguageOfGrant("mqtt", "acmeplain")).toThrow(
      'mqtt is granted the statement language "acmeplain", for which agent mode holds no pack',
    );

    const client = languageClientPack(ACME);
    const server = languageServerPack(ACME);
    const pack = agentLanguagePack(ACME);
    expect<string>(pack.id).toBe("acmeread");
    expect(pack.client).toBe(client);
    expect(pack.server).toBe(server);
    expect(languageServer(ACME)).toBe(server.adapter);
    expect(pack.execution).toEqual({ arms: {}, evidenceTools: {} });
    expect(Object.isFrozen(pack)).toBe(true);
    expect(client.copy.subject).toBe(AGENT.text.copy.subject as string);
    expect<string>(server.adapter.readOperation).toBe("acmeread.query.read");
    expect(server.answerNotADataRead).toBe(UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ);

    expect(AGENT_LANGUAGE_COPY[ACME]).toBe(client.copy);
    expect(AGENT_WORKFLOW_VARIANTS[ACME]).toBe(client.variants);
    expect(AGENT_PLAN_ESTIMATE_OPERATION[ACME]).toBeNull();
    expect(WORKFLOW_TOOL_RULES[ACME]).toBe(server.workflowToolRules);
    expect(LANGUAGE_TOOL_ARMS[ACME]).toBe(pack.execution.arms);
    expect(Object.keys(AGENT_LANGUAGE_COPY).at(-1)).toBe("acmeread");
    expect(Object.keys(AGENT_LANGUAGE_COPY)).not.toContain("acmeplain");
    // A declared language adds nothing to the tables merged across languages.
    expect(Object.keys(AGENT_EVIDENCE_EVENTS)).not.toContain("acmeread");
    expect(Object.keys(AGENT_PACK_REQUIREMENTS).some((key) => key.includes("acme"))).toBe(false);
    expect(Object.values(LANGUAGE_BASE_DEFINITIONS).some((d) => d?.operationId?.startsWith("acmeread"))).toBe(false);

    // The MCP facet is composed from the data's MCP part, after the module languages' facets, and the arm is built
    // from it; a declared language whose agent part is null has neither.
    const facet = AGENT_LANGUAGE_MCP_FACETS[ACME];
    expect<string | undefined>(facet?.tool).toBe("run_acme_read");
    expect(facet?.title).toBe(AGENT.mcp?.text.title as string);
    expect(Object.keys(AGENT_LANGUAGE_MCP_FACETS).at(-1)).toBe("acmeread");
    expect(Object.keys(AGENT_LANGUAGE_MCP_FACETS)).not.toContain("acmeplain");
    expect<string | undefined>(MCP_STATEMENT_ARMS[ACME]?.tool).toBe("run_acme_read");

    // The load check, read on the module languages this build holds.
    const modules = Object.keys(AGENT_LANGUAGE_COPY).filter((language) => language !== "acmeread");
    expect(declaredAgentLanguages([ACMEREAD, ACMEPLAIN], modules).map(({ id }) => id as string)).toEqual(["acmeread"]);
    expect(() => declaredAgentLanguages([acmereadData("kafkaread")], modules)).toThrow(
      'The statement language "kafkaread" is declared as data and is also a module language of this build.',
    );
    expect(() => declaredAgentLanguages([ACMEREAD, acmereadData()], modules)).toThrow(
      'The statement language "acmeread" is declared as data twice.',
    );
  });

  test("a crafted data-declared language on a legacy engine is admitted, refused with its declared sentence and code and offered with its composed text, with no module of its own", async () => {
    const client = languageClientPack(ACME);
    const variant = client.variants.investigation ?? null;
    expect(workflowAvailability("agent", "investigation", "mqtt")).toEqual({
      open: true,
      statementLanguage: ACME,
      variant,
    });
    // The operations variant is Studio's, which needs an agent reading MQTT does not offer.
    expect(client.variants.operations?.requires).toEqual(["agent-readings"]);
    expect(workflowAvailability("agent", "operations", "mqtt")).toMatchObject({
      open: false,
      cause: "requirement-unmet",
    });
    expect(workflowAvailability("agent", "data-analysis", "mqtt")).toMatchObject({ open: false, cause: "no-variant" });
    expect(agentVariant(ACME, "investigation")).toBe(client.variants.investigation);

    const definition = agentToolDefinition(ACME, "investigation", "run_read_query");
    expect(definition.description).toBe(AGENT.text.investigation.toolDescription as string);
    expect(
      selectAgentTools({ mode: "agent", workflowType: "investigation", statementLanguage: ACME }).map((t) => t.name),
    ).toEqual(["run_read_query", "compose_report"]);
    expect(WORKFLOW_TOOL_RULES[ACME]?.investigation).toBe(AGENT.text.investigation.toolRule as string);

    const bounds = AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets;
    expect(agentPosture({ mode: "agent", engine: "mqtt", engineLabel: "MQTT", handover: true })).toEqual({
      tone: "reads",
      headline: "Reads only",
      ...client.posture.reads(bounds),
    });
    expect(client.posture.reads(BOUNDS).body).toContain(" 7 rows and 2.5 seconds each.");

    expect(agentEnginePack("mqtt")).toBe(agentLanguagePack(ACME));
    expect<string | null>(mcpStatementToolFor("mqtt")).toBe("run_acme_read");

    // The read operation is registered and resolved like any language's.
    expect(isStatementReadOperation("acmeread.query.read")).toBe(true);
    expect(createCanonicalOperationRegistry().registeredIds()).toContain("acmeread.query.read");

    // A refused request answers its declared sentence and acquires nothing, and never quotes the request.
    const marker = randomUUID();
    const refusedText = JSON.stringify({ read: "topics", topic: marker });
    const refused = await harness();
    const refusal = await runReadQueryTool(refused.context, { statement: refusedText });
    const declared = admitDeclaredRequest(AGENT.request, refusedText);
    expect(declared?.code).toBe("topic-not-taken");
    expect(refusal).toMatchObject({
      kind: "unavailable",
      reasonCode: "STATEMENT_NOT_ADMITTED",
      detail: declared?.message,
    });
    expect(JSON.stringify(refusal)).toContain(declared?.message as string);
    expect(JSON.stringify(refusal)).not.toContain(marker);
    expect(refused.acquireProvider).not.toHaveBeenCalled();

    // An admitted request reaches the provider under acmeread.query.read as the canonical statement.
    const admitted = await harness();
    const outcome = await runReadQueryTool(admitted.context, { statement: '{"read":"topics"}' });
    expect(outcome.kind).toBe("completed");
    expect(admitted.queryReadOnly).toHaveBeenCalledWith('{"read":"topics"}', expect.any(Object), undefined);
    if (outcome.kind === "completed") expect(outcome.artifact.operationId).toBe("acmeread.query.read");
  });

  test("a crafted data-declared language on a legacy engine is fenced on the MCP path with its declared sentence and offered as its statement tool", async () => {
    const mcp = AGENT.mcp as NonNullable<typeof AGENT.mcp>;
    const arm = MCP_STATEMENT_ARMS[ACME];
    if (arm === null) throw new Error("the declared language's MCP facet builds no arm");

    // The arm: the declared tool on the engine granted the language, with the input Studio fixes.
    expect<string>(arm.tool).toBe("run_acme_read");
    expect(arm.title).toBe(mcp.text.title as string);
    expect(arm.types).toEqual(["mqtt"]);
    expect(arm.engines).toBe(getDBConfig("mqtt").label);
    expect(arm.argument).toBe("statement");
    expect(arm.paging).toBe("none");
    expect(arm.holdsNoTables).toBe(true);
    expect(arm.answersWarnings).toBe(false);
    expect(arm.withholdsDatabase).toBe(false);
    expect(arm.description).toBe(
      `${fillAgentText(mcp.text.description, { engines: arm.engines, limits: SHARED_LIMITS })} ${MCP_UNTRUSTED_NOTICE}`,
    );
    const input = { connection_id: "seed:plant", statement: '{"read":"topics"}' };
    expect(arm.inputSchema.safeParse(input).success).toBe(true);
    for (const refused of [{ database: "d" }, { offset: 0 }, { sql: "x" }, { statement: "" }]) {
      expect(arm.inputSchema.safeParse({ ...input, ...refused }).success).toBe(false);
    }

    // The lists MCP keeps hold the declared tool, and the engine's own module tool serves it no more.
    expect(servingStatementArms()).toContain(arm);
    expect<readonly string[]>(MCP_STATEMENT_TOOLS).toContain("run_acme_read");
    expect(isMcpToolName("run_acme_read")).toBe(true);
    expect(MCP_TOOL_INPUT_SCHEMAS[arm.tool]).toBe(arm.inputSchema);
    expect(mcpStatementArm(arm.tool)).toBe(arm);
    expect(ListedConnectionSchema.shape.read_tool.safeParse("run_acme_read").success).toBe(true);
    expect<string | null>(mcpStatementToolFor("mqtt")).toBe("run_acme_read");
    expect<string | null>(mcpTablelessReadTool("mqtt")).toBe("run_acme_read");
    expect(MCP_STATEMENT_ARMS.mqttread?.types).toEqual([]);

    // Through the route: tools/list offers it, a refused request answers the declared sentence before anything is
    // acquired, and an admitted one reaches the acquisition under the agent read-only profile.
    pinMcpTestEnvironment();
    const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-acmeread-"));
    // The factory's MQTT provider, never connected, with only its read-only statement answered here.
    const provider = await createDatabaseProvider(CENSUS_CONNECTION.mqtt as DatabaseConnection);
    const queryReadOnly = spyOn(provider, "queryReadOnly").mockImplementation(
      async (): Promise<QueryResult> => ({ rows: [{ name: "t" }], fields: ["name"], rowCount: 1, executionTime: 1 }),
    );
    const acquire = spyOn(McpConnectionContext.prototype, "acquire").mockImplementation(async () => provider);
    const serve = handlerServe(testAuthInfo());
    const call = async (args: Record<string, unknown>) => {
      const session = await connectClient(serve, { negotiation: "legacy" });
      try {
        return (await session.client.callTool({ name: "run_acme_read", arguments: args })) as {
          isError?: boolean;
          content: Array<{ type: string; text: string }>;
        };
      } finally {
        await session.close();
      }
    };
    try {
      writeSeedFile(dir, [{ id: "plant", type: "mqtt", host: "broker.example", port: 1883 }]);
      const session = await connectClient(serve, { negotiation: "legacy" });
      try {
        const listed = (await session.client.listTools()).tools.find((tool) => tool.name === "run_acme_read");
        expect(listed?.description).toBe(arm.description);
        expect(Object.keys(listed?.inputSchema.properties ?? {})).toEqual([
          "connection_id",
          "statement",
          "max_rows",
          "timeout_ms",
        ]);
      } finally {
        await session.close();
      }

      const marker = randomUUID();
      const refusedText = JSON.stringify({ read: "topics", topic: marker });
      const declared = admitDeclaredRequest(AGENT.request, refusedText);
      expect(declared?.code).toBe("topic-not-taken");
      const refused = await call({ connection_id: "seed:plant", statement: refusedText });
      const copy = AGENT_LANGUAGE_COPY[ACME];
      expect(refused).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: `The ${copy.noun} was refused before it reached ${copy.reached} (${declared?.code}). ${declared?.message}`,
          },
        ],
      });
      expect(copy.noun).toBe(AGENT.text.copy.noun as string);
      expect(copy.reached).toBe(AGENT.text.copy.reached as string);
      expect(JSON.stringify(refused)).not.toContain(marker);
      expect(acquire).not.toHaveBeenCalled();
      const events = getServerAuditBuffer()
        .getAll()
        .filter((event) => event.type === "mcp_operation");
      expect(events).toEqual([
        expect.objectContaining({
          action: "run_acme_read",
          target: "mcp/decision",
          result: "failure",
          reason: "mcp_statement_refused",
        }),
      ]);

      // The provider's read is answered through the host core's read-only execute, its row behind the notice.
      const admitted = await call({ connection_id: "seed:plant", statement: '{"read":"topics"}' });
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(acquire.mock.calls[0]?.[1]).toBe("agent-read-only");
      expect(queryReadOnly).toHaveBeenCalledTimes(1);
      expect(queryReadOnly.mock.calls[0]?.[0]).toBe('{"read":"topics"}');
      expect(admitted.isError ?? false).toBe(false);
      expect(admitted.content[0]).toEqual({ type: "text", text: databaseContentNotice(providerAuthor("mqtt")) });
      expect(JSON.parse(admitted.content[1]?.text as string)).toMatchObject({
        connection_id: "seed:plant",
        rows: [{ name: "t" }],
        row_count: 1,
        truncated: false,
      });
      expect(
        getServerAuditBuffer()
          .getAll()
          .filter((event) => event.type === "mcp_operation")
          .slice(1)
          .map((event) => [event.action, event.target, event.result]),
      ).toEqual([
        ["run_acme_read", "mcp/decision", "success"],
        ["run_acme_read", "mcp/execution", "success"],
      ]);
    } finally {
      acquire.mockRestore();
      await resetMcpTestState();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A run on an MQTT connection granted `acmeread`, whose provider answers one row. */
async function harness() {
  const connection = CENSUS_CONNECTION.mqtt as DatabaseConnection;
  const real = await createDatabaseProvider(connection);
  const queryReadOnly = mock(
    async (): Promise<QueryResult> => ({ rows: [{ name: "t" }], fields: ["name"], rowCount: 1, executionTime: 1 }),
  );
  const provider = { queryReadOnly } as unknown as DatabaseProvider;
  const acquireProvider = mock(async () => provider);
  return {
    queryReadOnly,
    acquireProvider,
    context: {
      runId: "run-1",
      modelId: "unmeasured-model-for-tests",
      mode: "agent" as const,
      workflowType: "investigation" as const,
      statementLanguage: ACME,
      actor: { sessionId: "session-1", role: "user" as const },
      connection,
      capabilities: real.getCapabilities(),
      labels: real.getLabels(),
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope(connection.id),
      tracker: new ExecutionBudgetTracker(),
      artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
      deadline: new AgentRunDeadline(
        AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2,
        () => 1_000,
      ),
      repairs: new AgentRepairLedger(),
      acquireProvider,
      clock: () => 1_000,
    },
  };
}

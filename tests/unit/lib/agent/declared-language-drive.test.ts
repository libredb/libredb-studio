import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseConnection, DatabaseProvider } from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";
import { acmereadData } from "../../../helpers/declared-agent-language";
import { LEGACY_RUN_SESSIONS } from "../../../helpers/agent-engine-sessions";

/**
 * A statement language declared as data, `acmeread` (tests/helpers/declared-agent-language.ts), offered on a legacy
 * engine with no module of its own: the language registries hold it beside the module languages, the run's tools,
 * rules and posture read its composed text, MCP offers its declared statement tool, and a read is admitted or refused
 * by its declared request form before any provider is acquired, in agent mode and on the MCP path alike.
 *
 * The browser and the server compose a declared language from different sources, so this file plants `acmeread` in
 * both. The browser's composition reads the statement language projection
 * (`@/lib/db/engine-catalog/statement-language.generated`), which this file substitutes with the shipped one plus
 * `acmeread`, stated under Spark, and `acmeplain`, a language with no agent part, stated under Snowflake, and it reads
 * MQTT's grant of `acmeread` from the substituted legacy grants of MQTT (`legacyEngineGrants`). The server's
 * registries compose the language data of each served record whose grant names it (`servedLanguageData`), so the
 * server half installs a crafted catalog whose MQTT record is granted `acmeread` and states the projection's very
 * `acmeread` data object; Spark's record states it too, through the substituted projection, but no grant names it
 * there, so the server composes it once, from MQTT's record, into the client facet the browser holds. MQTT rather than
 * an engine whose declaration states its language as data, so no such engine's test reads a substituted language.
 * Spark and Snowflake state no statement language of their own and Studio holds no code row for either, so the
 * confirmation gate's resolver, which compiles a row from each engine's stated data and refuses an engine holding both,
 * loads in this process; both follow every shipped engine stating its language as data in the projection's id order,
 * so `acmeread` is the last declared language. The real grant reader and projection are captured as plain objects
 * before the substitution, because a namespace follows its replacement.
 * `mock.module` is process-wide, so the substitutions are made before anything that reads them is loaded: every such
 * module is imported dynamically below them, and the runner gives this file its own process. The crafted catalog is
 * installed before those imports too, though the server's language registries and MCP's statement arms read the
 * catalog installed when they are read (`servedLanguageData`, `mcpStatementSurface`), not when their modules load, so
 * every module this file loads reads the one crafted catalog from its first read.
 *
 * The last two cases put a provider package's catalog in the crafted one's place (`withPackageCatalog`): a package,
 * admitted through Studio's boot admission (tests/helpers/package-session-fixture.ts), declares its own language
 * `acmepkgread`, `acmeread`'s data under another name and with no MCP tool, and its row grants it under the digest of
 * that data; a second package is granted `sql`. Both rows review no grammar, and both packages take a read-only
 * execute. A declared statement is admitted by its declared form and sent through the package's read-only statement
 * session, never judged by the SQL guard, and agent mode sends a package granted `sql` no statement, since the SQL
 * workflows' requirements hold on legacy engines alone: its text meets only plan mode's draft fence, which reads
 * Studio's default grammar. While the package catalog is installed, MQTT's substituted grant names a language no
 * served record states, so neither case reads MQTT; each reinstalls the crafted catalog when it ends. The fence and
 * the query events are recorded by substitutions spreading the real modules captured before them, each recorder
 * calling the captured function, so every other case reads them unchanged.
 */

const ACMEREAD = acmereadData();
const ACMEPLAIN = { ...acmereadData("acmeplain"), agent: null };
const AGENT = ACMEREAD.agent as NonNullable<typeof ACMEREAD.agent>;

const REAL_CLAIM_GRANTS = { ...(await import("@/lib/db/claim-grants")) };
const REAL_PROJECTION = { ...(await import("@/lib/db/engine-catalog/statement-language.generated")) };
const SUBSTITUTED_PROJECTION = Object.freeze({
  ...REAL_PROJECTION.BUNDLED_STATEMENT_LANGUAGE_DATA,
  snowflake: ACMEPLAIN,
  spark: ACMEREAD,
});
mock.module("@/lib/db/engine-catalog/statement-language.generated", () => ({
  BUNDLED_STATEMENT_LANGUAGE_DATA: SUBSTITUTED_PROJECTION,
}));
mock.module("@/lib/db/claim-grants", () => ({
  ...REAL_CLAIM_GRANTS,
  legacyEngineGrants: (id: string) =>
    id === "mqtt"
      ? Object.freeze({ ...REAL_CLAIM_GRANTS.legacyEngineGrants(id), statementLanguage: "acmeread" })
      : REAL_CLAIM_GRANTS.legacyEngineGrants(id),
}));

const REAL_GUARD = { ...(await import("@/lib/db/operations/statement-guard")) };
const REAL_BUILD = { ...(await import("@/lib/query-events/build")) };
const REAL_SINK = { ...(await import("@/lib/query-events/sink")) };
const inspected = mock((...args: Parameters<typeof REAL_GUARD.inspectAgentStatement>) =>
  REAL_GUARD.inspectAgentStatement(...args),
);
const built = mock((...args: Parameters<typeof REAL_BUILD.buildQueryEvent>) => REAL_BUILD.buildQueryEvent(...args));
const recorded = mock((...args: Parameters<typeof REAL_SINK.recordQueryEvent>) => REAL_SINK.recordQueryEvent(...args));
mock.module("@/lib/db/operations/statement-guard", () => ({ ...REAL_GUARD, inspectAgentStatement: inspected }));
mock.module("@/lib/query-events/build", () => ({ ...REAL_BUILD, buildQueryEvent: built }));
mock.module("@/lib/query-events/sink", () => ({ ...REAL_SINK, recordQueryEvent: recorded }));

const { forgetServerCatalog, installServerCatalog, servedEngines, servedEngineRecord } = await import(
  "@/lib/db/server-catalog"
);
const { craftedCatalog, withEngineRecord, withLoosestClaims, withStatementLanguageData } = await import(
  "../../../helpers/package-catalog"
);
const CRAFTED = withEngineRecord(craftedCatalog({ mqtt: { statementLanguage: "acmeread" } }), "mqtt", (engine) => ({
  ...engine,
  statementLanguageData: ACMEREAD,
}));
installServerCatalog(CRAFTED);

const {
  AGENT_LANGUAGE_COPY,
  AGENT_PLAN_ESTIMATE_OPERATION,
  AGENT_WORKFLOW_VARIANTS,
  agentVariant,
  legacyAgentEngine,
  workflowAvailability,
} = await import("@/lib/agent/agent-manifest");
const { agentPosture } = await import("@/lib/agent/posture");
const {
  AGENT_EVIDENCE_EVENTS,
  AGENT_PACK_REQUIREMENTS,
  BUNDLED_CLIENT_PACKS,
  agentLanguageOfGrant,
  DECLARED_AGENT_LANGUAGES,
  languageClientPack,
} = await import("@/lib/agent/languages/client");
const { LANGUAGE_BASE_DEFINITIONS, languageServer, languageServerPack, workflowToolRules } = await import(
  "@/lib/agent/languages/server"
);
const { agentLanguagePack, languageToolArms } = await import("@/lib/agent/languages/index");
const { declaredAgentLanguages } = await import("@/lib/agent/languages/declared-client");
const { agentLanguageMcpFacets } = await import("@/lib/agent/languages/mcp");
const { agentEnginePack } = await import("@/lib/agent/languages/engines/index");
const { AgentRunDeadline } = await import("@/lib/agent/deadline");
const { AGENT_WORKFLOW_BUDGETS } = await import("@/lib/agent/execution-policy");
const { AgentRepairLedger } = await import("@/lib/agent/repair-ledger");
const { UNAVAILABLE_TEXT } = await import("@/lib/agent/tool-contracts");
const { agentToolDefinition, runReadQueryTool, selectAgentTools } = await import("@/lib/agent/tools");
const { mcpStatementSurface, mcpStatementArm, mcpStatementToolFor, mcpTablelessReadTool, servingStatementArms } =
  await import("@/lib/mcp/tools/statement-arms");
const { isMcpToolName, mcpToolInputSchemas } = await import("@/lib/mcp/tools");
const { listedConnectionSchema } = await import("@/lib/mcp/tools/list-connections");
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
const { clearProviderCache, createDatabaseProvider } = await import("@/lib/db/factory");
const { admitSessionPackages, setHooks } = await import("../../../helpers/package-session-fixture");
const { removeScratch, scratchDirectory } = await import("../../../helpers/provider-artifacts");
const { servedAvailabilityTables, servedClientPacks } = await import("@/lib/agent/languages/server");
const { grantedAgentLanguage } = await import("@/lib/agent/granted-language");
const { readOnlyStatementSession } = await import("@/lib/api/editor-provider");
const { agentEngineDeclarations } = await import("@/lib/agent/engine-view");
const { validatePlanStatement } = await import("@/lib/agent/plan-statement");
const { languageDataSha256 } = await import("@/lib/db/language-digest");
const { ConnectionError } = await import("@/lib/db/errors");
const { logger } = await import("@/lib/logger");

beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(() => {
  forgetServerCatalog();
  forgetHostCore();
});

const ACME = DECLARED_AGENT_LANGUAGES.find(({ id }) => id === "acmeread")?.id;
if (ACME === undefined) throw new Error("the substituted list does not reach the language registries");
const BOUNDS = Object.freeze({ maxResultRows: 7, statementTimeoutMs: 2500 });
/** The result limits every statement tool shares, which Studio fills into a declared description as `limits`. */
const SHARED_LIMITS =
  "Returns at most max_rows rows (default 100, at most 500) and at most 32 KiB; truncated and pagination.hasMore say when rows were cut";

describe("a data-declared language in the language registries", () => {
  test("the language registries hold a data-declared language beside the module languages, and refuse one whose name a module or another declared language holds", () => {
    expect(Object.hasOwn(BUNDLED_CLIENT_PACKS, "acmeread")).toBe(true);
    expect(Object.hasOwn(BUNDLED_CLIENT_PACKS, "acmeplain")).toBe(false);
    expect<string | null>(agentLanguageOfGrant("mqtt", "acmeread", BUNDLED_CLIENT_PACKS)).toBe("acmeread");
    expect(() => agentLanguageOfGrant("mqtt", "acmeplain", BUNDLED_CLIENT_PACKS)).toThrow(
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
    expect(workflowToolRules()[ACME]).toBe(server.workflowToolRules);
    expect(languageToolArms()[ACME]).toBe(pack.execution.arms);
    expect(Object.keys(AGENT_LANGUAGE_COPY).at(-1)).toBe("acmeread");
    expect(Object.keys(AGENT_LANGUAGE_COPY)).not.toContain("acmeplain");
    // A declared language adds nothing to the tables merged across languages.
    expect(Object.keys(AGENT_EVIDENCE_EVENTS)).not.toContain("acmeread");
    expect(Object.keys(AGENT_PACK_REQUIREMENTS).some((key) => key.includes("acme"))).toBe(false);
    expect(Object.values(LANGUAGE_BASE_DEFINITIONS).some((d) => d?.operationId?.startsWith("acmeread"))).toBe(false);

    // The MCP facet is composed from the data's MCP part, after the module languages' facets, and the arm is built
    // from it; a declared language whose agent part is null has neither.
    const facet = agentLanguageMcpFacets()[ACME];
    expect<string | undefined>(facet?.tool).toBe("run_acme_read");
    expect(facet?.title).toBe(AGENT.mcp?.text.title as string);
    expect(Object.keys(agentLanguageMcpFacets()).at(-1)).toBe("acmeread");
    expect(Object.keys(agentLanguageMcpFacets())).not.toContain("acmeplain");
    expect<string | undefined>(mcpStatementSurface().arms[ACME]?.tool).toBe("run_acme_read");

    // The load check, read on the module languages this build holds: every language but the declared ones.
    const declaredNames = Object.values(SUBSTITUTED_PROJECTION).flatMap((data) => (data === null ? [] : [data.name]));
    const modules = Object.keys(AGENT_LANGUAGE_COPY).filter((language) => !declaredNames.includes(language));
    expect(declaredAgentLanguages([ACMEREAD, ACMEPLAIN], modules).map(({ id }) => id as string)).toEqual(["acmeread"]);
    expect(() => declaredAgentLanguages([acmereadData("rabbitread")], modules)).toThrow(
      'The statement language "rabbitread" is declared as data and is also a module language of this build.',
    );
    expect(() => declaredAgentLanguages([ACMEREAD, acmereadData()], modules)).toThrow(
      'The statement language "acmeread" is declared as data twice.',
    );
  });

  test("a crafted data-declared language on a legacy engine is admitted, refused with its declared sentence and code and offered with its composed text, with no module of its own", async () => {
    const client = languageClientPack(ACME);
    const variant = client.variants.investigation ?? null;
    expect(workflowAvailability("agent", "investigation", legacyAgentEngine("mqtt"))).toEqual({
      open: true,
      statementLanguage: ACME,
      variant,
    });
    // The operations variant is Studio's, which needs an agent reading MQTT does not offer.
    expect(client.variants.operations?.requires).toEqual(["agent-readings"]);
    expect(workflowAvailability("agent", "operations", legacyAgentEngine("mqtt"))).toMatchObject({
      open: false,
      cause: "requirement-unmet",
    });
    expect(workflowAvailability("agent", "data-analysis", legacyAgentEngine("mqtt"))).toMatchObject({
      open: false,
      cause: "no-variant",
    });
    expect(agentVariant(ACME, "investigation", BUNDLED_CLIENT_PACKS)).toBe(client.variants.investigation);

    const definition = agentToolDefinition(ACME, "investigation", "run_read_query");
    expect(definition.description).toBe(AGENT.text.investigation.toolDescription as string);
    expect(
      selectAgentTools({ mode: "agent", workflowType: "investigation", statementLanguage: ACME }).map((t) => t.name),
    ).toEqual(["run_read_query", "compose_report"]);
    expect(workflowToolRules()[ACME]?.investigation).toBe(AGENT.text.investigation.toolRule as string);

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
    const arm = mcpStatementSurface().arms[ACME];
    if (arm === null) throw new Error("the declared language's MCP facet builds no arm");

    // The arm: the declared tool on the engine granted the language, with the input Studio fixes.
    expect<string>(arm.tool).toBe("run_acme_read");
    expect(arm.title).toBe(mcp.text.title as string);
    expect<readonly string[]>(arm.types).toEqual(["mqtt"]);
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
    expect<readonly string[]>(mcpStatementSurface().tools).toContain("run_acme_read");
    expect(isMcpToolName("run_acme_read")).toBe(true);
    expect(mcpToolInputSchemas()[arm.tool]).toBe(arm.inputSchema);
    expect(mcpStatementArm(arm.tool)).toBe(arm);
    expect(listedConnectionSchema(mcpStatementSurface().tools).shape.read_tool.safeParse("run_acme_read").success).toBe(
      true,
    );
    expect<string | null>(mcpStatementToolFor("mqtt")).toBe("run_acme_read");
    expect<string | null>(mcpTablelessReadTool("mqtt")).toBe("run_acme_read");
    expect<readonly string[] | undefined>(mcpStatementSurface().arms.mqttread?.types).toEqual([]);

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
      sessions: LEGACY_RUN_SESSIONS,
      acquireProvider,
      clock: () => 1_000,
    },
  };
}

/** `acmeread`'s data under the name `acmepkgread`, with no MCP tool, which a provider package declares as its own. */
const PKG_LANGUAGE = (() => {
  const data = acmereadData("acmepkgread");
  return { ...data, agent: { ...(data.agent as NonNullable<typeof data.agent>), mcp: null } };
})();
const PKG_AGENT = PKG_LANGUAGE.agent;
/** The package engine granted its own language, and the one granted `sql`; both take a read-only execute. */
const PKG_READ = "acmepkgreadengine";
const PKG_SQL = "acmepkgsqlengine";
const PKG_PROVIDERS = scratchDirectory("studio-declared-language-drive-");
afterAll(() => removeScratch(PKG_PROVIDERS));

/** The package catalog, admitted once in this process (the loader keeps every package it admitted). */
let packageCatalog: Parameters<typeof installServerCatalog>[0] | undefined;

/**
 * Runs `body` with the package catalog installed in the crafted one's place, then closes every session it opened and
 * reinstalls the crafted catalog. The first call admits both packages through boot admission, which installs their
 * catalog; a later call installs the catalog it composed.
 */
async function withPackageCatalog<T>(body: () => Promise<T>): Promise<T> {
  forgetServerCatalog();
  try {
    if (packageCatalog === undefined) {
      const unread = { deniedFileAccessRefusal: null, readRootsRequired: false, agentExecution: true } as const;
      await admitSessionPackages(
        PKG_PROVIDERS,
        [
          {
            name: "acme-pkg-read",
            engine: PKG_READ,
            honours: ["readOnly"],
            edit: (engine) => {
              engine.agent = { statementLanguage: PKG_LANGUAGE.name, overlay: { dialect: null, grounding: null } };
              withStatementLanguageData(engine, PKG_LANGUAGE);
            },
          },
          {
            name: "acme-pkg-sql",
            engine: PKG_SQL,
            offered: ["objects.tree", "monitoring.panel"],
            honours: ["readOnly"],
            edit: withLoosestClaims,
          },
        ],
        {
          [PKG_READ]: {
            ...unread,
            statementLanguage: PKG_LANGUAGE.name,
            languageSha256: languageDataSha256(PKG_LANGUAGE),
          },
          [PKG_SQL]: { ...unread, statementLanguage: "sql" },
        },
      );
      packageCatalog = Object.freeze({ engines: servedEngines(), unavailable: new Map() });
    } else {
      installServerCatalog(packageCatalog);
    }
    return await body();
  } finally {
    await clearProviderCache();
    forgetServerCatalog();
    installServerCatalog(CRAFTED);
  }
}

/** What the package's functions were called with in one case. */
interface PackageCalls {
  readonly opens: unknown[];
  readonly executes: unknown[];
}

/** Hooks for `engine`'s package recording every open and execute; each execute answers one row. */
function packageHooks(engine: string): PackageCalls {
  const calls: PackageCalls = { opens: [], executes: [] };
  setHooks(engine, {
    open: (ctx) => {
      calls.opens.push(ctx);
      return Promise.resolve({ handle: { session: randomUUID() } });
    },
    close: () => Promise.resolve(),
    execute: (_handle, request) => {
      calls.executes.push(request);
      return Promise.resolve({
        results: [
          {
            columns: [{ name: "name" }],
            next: () => Promise.resolve({ rows: [["t"]], done: true }),
            close: () => Promise.resolve(),
          },
        ],
        warnings: [],
        executionTimeMs: 1,
        pageApplied: false,
      });
    },
  });
  return calls;
}

/**
 * A run of the package engine `engine` as the drive builds it: its facts from its record (`agentEngineDeclarations`),
 * its read-only statement session over the real `readOnlyStatementSession`, and an acquirer that fails the case if
 * called, since a package's engine has no profiled provider.
 */
async function packageRun(engine: string) {
  const record = servedEngineRecord(engine);
  const connection = {
    id: `seed:${randomUUID()}`,
    name: "Acme",
    type: engine,
    host: "pkg.local",
    password: randomUUID(),
    createdAt: new Date(0),
  };
  const { capabilities, labels } = await agentEngineDeclarations(record, connection, {});
  const acquireProvider = mock(async (): Promise<DatabaseProvider> => {
    throw new Error(
      "the run's acquirer opens a legacy provider only, and this run is a package engine's: a test defect",
    );
  });
  return {
    record,
    capabilities,
    acquireProvider,
    context: {
      runId: "run-pkg",
      modelId: "unmeasured-model-for-tests",
      mode: "agent" as const,
      workflowType: "investigation" as const,
      statementLanguage: PKG_LANGUAGE.name as typeof ACME,
      actor: { sessionId: "session-1", role: "user" as const },
      connection,
      capabilities,
      labels,
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope(connection.id),
      tracker: new ExecutionBudgetTracker(),
      artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
      deadline: new AgentRunDeadline(
        AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2,
        () => 1_000,
      ),
      repairs: new AgentRepairLedger(),
      sessions: {
        ...LEGACY_RUN_SESSIONS,
        readOnlyStatements: () => readOnlyStatementSession({ role: "user" }, connection, record),
      },
      acquireProvider,
      clock: () => 1_000,
    },
  };
}

describe("a provider package's own declared language", () => {
  test("a package's own language, granted by its row, is composed from the installed catalog and drives a run with no composer change", async () => {
    await withPackageCatalog(async () => {
      const language = PKG_LANGUAGE.name as typeof ACME;
      // The installed catalog composes the package's language: the registries hold it, and the engine is granted it.
      expect(Object.hasOwn(servedClientPacks(), language)).toBe(true);
      expect<string | null>(grantedAgentLanguage(PKG_READ)).toBe(language);
      expect(agentEnginePack(PKG_READ)).toBe(agentLanguagePack(language));
      expect(workflowToolRules()[language]?.investigation).toBe(PKG_AGENT.text.investigation.toolRule as string);
      const record = servedEngineRecord(PKG_READ);
      expect(record.offers.readOnlyStatements).toBe(true);
      expect(workflowAvailability("agent", "investigation", record, servedAvailabilityTables())).toEqual({
        open: true,
        statementLanguage: language,
        variant: servedClientPacks()[language]?.variants.investigation ?? null,
      });

      // A refused request answers its declared sentence, and the package never opens.
      const calls = packageHooks(PKG_READ);
      const refusedText = JSON.stringify({ read: "topics", topic: randomUUID() });
      const declared = admitDeclaredRequest(PKG_AGENT.request, refusedText);
      expect(declared?.code).toBe("topic-not-taken");
      const refused = await packageRun(PKG_READ);
      expect(await runReadQueryTool(refused.context, { statement: refusedText })).toMatchObject({
        kind: "unavailable",
        reasonCode: "STATEMENT_NOT_ADMITTED",
        detail: declared?.message,
      });
      expect(calls.opens).toEqual([]);

      // An admitted one opens the package's read-only statement session and is sent through it as written.
      const admitted = await packageRun(PKG_READ);
      const outcome = await runReadQueryTool(admitted.context, { statement: '{"read":"topics"}' });
      expect(outcome.kind).toBe("completed");
      if (outcome.kind === "completed") expect(outcome.artifact.operationId).toBe(`${language}.query.read`);
      expect(calls.opens).toEqual([
        expect.objectContaining({ policy: expect.objectContaining({ readOnly: true, sendsStatements: true }) }),
      ]);
      expect(calls.executes).toEqual([
        expect.objectContaining({ statement: '{"read":"topics"}', readOnly: expect.any(Object) }),
      ]);
      expect(admitted.acquireProvider).not.toHaveBeenCalled();

      // A package whose open fails sent nothing: the run is told a not-sent connection failure in Studio's sentence,
      // the package's words logged once under the statement's route.
      const marker = randomUUID();
      setHooks(PKG_READ, {
        open: () => Promise.reject(new Error(`the package could not sign in ${marker}`)),
        close: () => Promise.resolve(),
      });
      const logged = spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        const unopened = await packageRun(PKG_READ);
        const failed = await runReadQueryTool(unopened.context, { statement: '{"read":"topics"}' }).then(
          (answer) => answer,
          (error: unknown) => error,
        );
        expect(failed).toBeInstanceOf(ConnectionError);
        expect((failed as Error).message).toStartWith("The provider package's open failed (");
        expect(JSON.stringify([(failed as Error).message])).not.toContain(marker);
        expect(logged.mock.calls.filter(([line]) => line === "A provider package's open failed")).toEqual([
          [expect.any(String), expect.anything(), { route: "agent/statement" }],
        ]);
      } finally {
        logged.mockRestore();
      }
    });
    // The crafted catalog is back, and it composes no language of the package's.
    expect(Object.hasOwn(servedClientPacks(), PKG_LANGUAGE.name)).toBe(false);
  });

  test("a package engine whose row reviews no grammar is fenced under the default grammar and its query events keep none of its statement text", async () => {
    await withPackageCatalog(async () => {
      for (const recorder of [inspected, built, recorded]) recorder.mockClear();
      // The package's own language: its statement is admitted by its declared form and sent through its read-only
      // statement session; the SQL guard never reads it, and no query event is built or recorded.
      expect(servedEngineRecord(PKG_READ).grants.reviewedGrammar).toBe(false);
      const calls = packageHooks(PKG_READ);
      const run = await packageRun(PKG_READ);
      expect((await runReadQueryTool(run.context, { statement: '{"read":"topics"}' })).kind).toBe("completed");
      expect(calls.executes).toHaveLength(1);
      for (const recorder of [inspected, built, recorded]) expect(recorder).not.toHaveBeenCalled();

      // A package granted sql: agent mode sends it no statement, so nothing opens; plan mode's draft is judged by the
      // fence under Studio's default grammar, which is handed no grammar of the package's.
      const sql = servedEngineRecord(PKG_SQL);
      expect(sql.grants).toMatchObject({ statementLanguage: "sql", agentExecution: true, reviewedGrammar: false });
      expect(sql.offers.readOnlyStatements).toBe(true);
      const sqlCalls = packageHooks(PKG_SQL);
      for (const workflow of ["investigation", "query-optimization", "database-assessment", "data-analysis"] as const) {
        expect(workflowAvailability("agent", workflow, sql, servedAvailabilityTables())).toMatchObject({
          open: false,
          cause: "requirement-unmet",
        });
      }
      const draft = "SELECT id FROM orders";
      const planned = await packageRun(PKG_SQL);
      expect(validatePlanStatement(draft, null, planned.capabilities.queryLanguage)).toMatchObject({
        guardApplicable: true,
      });
      expect(inspected.mock.calls).toEqual([[draft]]);
      expect(sqlCalls).toEqual({ opens: [], executes: [] });
      for (const recorder of [built, recorded]) expect(recorder).not.toHaveBeenCalled();
    });
  });
});

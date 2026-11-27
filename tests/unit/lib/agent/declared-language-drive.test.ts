import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { DatabaseConnection, DatabaseProvider } from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";
import { acmereadData } from "../../../helpers/declared-agent-language";

/**
 * A statement language declared as data, `acmeread` (tests/helpers/declared-agent-language.ts), offered on a legacy
 * engine with no module of its own: the language registries hold it beside the module languages, the run's tools,
 * rules and posture read its composed text, and a read is admitted or refused by its declared request form before any
 * provider is acquired.
 *
 * No shipped declaration states agent data yet, so this file substitutes the list of the declared languages' data
 * (`@/lib/db/declared-statement-languages`) with `acmeread` and `acmeplain`, a language with no agent part, and grants
 * MQTT `acmeread`: in the browser tables by substituting the grant reader's `GRANTED_AGENT_STATEMENT_LANGUAGE` row, and
 * on the server by a crafted catalog. MQTT rather than Kafka, so no Kafka test reads a substituted language. The real
 * grant reader is captured as a plain object before the substitution, because a namespace follows its replacement.
 * `mock.module` is process-wide, so the substitutions are made before anything that reads them is loaded: every such
 * module is imported dynamically below them, and the runner gives this file its own process.
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
const { MCP_STATEMENT_ARMS, mcpStatementToolFor } = await import("@/lib/mcp/tools/statement-arms");
const { ExecutionArtifactStore } = await import("@/lib/db/operations/artifacts");
const { ExecutionBudgetTracker } = await import("@/lib/db/operations/budgets");
const { createCanonicalOperationRegistry, isStatementReadOperation } = await import("@/lib/db/operations/descriptors");
const { admitDeclaredRequest } = await import("@/lib/db/operations/declared-request-form");
const { createTargetScope } = await import("@/lib/db/operations/policy");
const { createHostCore } = await import("@/lib/provider-host/core/host-core");
const { forgetHostCore, installHostCore } = await import("@/lib/provider-host/instance");
const { forgetServerCatalog, installServerCatalog } = await import("@/lib/db/server-catalog");
const { craftedCatalog } = await import("../../../helpers/package-catalog");
const { CENSUS_CONNECTION } = await import("../../../helpers/census-connection");
const { createDatabaseProvider } = await import("@/lib/db/factory");

beforeAll(() => {
  installHostCore(createHostCore(), "test");
  installServerCatalog(craftedCatalog({ mqtt: { statementLanguage: "acmeread" } }));
});
afterAll(() => {
  forgetServerCatalog();
  forgetHostCore();
});

const NAME = "acmeread";
if (!isAgentStatementLanguage(NAME)) throw new Error("the substituted list does not reach the language registries");
const ACME = NAME;
const BOUNDS = Object.freeze({ maxResultRows: 7, statementTimeoutMs: 2500 });

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

    // No MCP statement tool yet: the facet and the arm are null.
    expect(Object.hasOwn(AGENT_LANGUAGE_MCP_FACETS, "acmeread")).toBe(true);
    expect((AGENT_LANGUAGE_MCP_FACETS as Readonly<Record<string, unknown>>).acmeread).toBeNull();
    expect(MCP_STATEMENT_ARMS[ACME]).toBeNull();

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
    expect(mcpStatementToolFor("mqtt")).toBeNull();

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

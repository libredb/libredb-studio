import { describe, expect, test } from "bun:test";
import { AGENT_STATEMENT_LANGUAGE, workflowAvailability } from "@/lib/agent/agent-manifest";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { verifyRunGoal } from "@/lib/agent/goal-verifier";
import { agentEnginePack } from "@/lib/agent/languages/engines/index";
import { runServerPack } from "@/lib/agent/languages/engines/server";
import type { AgentEnginePack, AgentEngineServerDialect } from "@/lib/agent/languages/pack";
import { REFERENCE_RECOMMENDATION_CARD } from "@/lib/agent/languages/server";
import { type AgentToolName, agentToolDefinition } from "@/lib/agent/tools";
import type { AgentRunWorkflowType } from "@/lib/agent/types";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import type { DatabaseType } from "@/lib/types";
import { toolsNamedIn } from "../../../helpers/agent-tool-rules";

/**
 * The engine pack contract (#1821): what must hold for the pack an engine RESOLVES to, run over every engine that
 * speaks a statement language. It is written against the resolved pack rather than the family pack, so it keeps
 * holding, or fails by name, once an engine overrides a member its family supplies.
 *
 * What it does not repeat:
 * - the registry facts, member identity against the family pack, the dialect keyset, client and server parity,
 *   `statistics` implying `catalogRead`, the capture-kind bound and empty-overlay identity, which
 *   `engine-overlays.test.ts` holds;
 * - the per-language census of offers, arms, rules and statement reads, which `tool-offer-census.test.ts` holds.
 */

const ENGINES = (Object.keys(AGENT_STATEMENT_LANGUAGE) as DatabaseType[]).filter(
  (type) => AGENT_STATEMENT_LANGUAGE[type] !== null,
);

const WORKFLOWS = Object.keys(AGENT_WORKFLOW_BUDGETS) as AgentRunWorkflowType[];

/** Every workflow an agent-mode run opens on `type` with a variant, with that variant. */
const openVariants = (type: DatabaseType) =>
  WORKFLOWS.flatMap((workflow) => {
    const availability = workflowAvailability("agent", workflow, type);
    return availability.open && availability.variant !== null ? [{ workflow, variant: availability.variant }] : [];
  });

/** The tools whose arm is the engine's own, each held to the very schema it is offered with. */
const ARMED_TOOLS = ["inspect_schema", "inspect_plan", "profile_table"] as const;

/** Each dialect-bound tool, and the server dialect member that serves it. */
const DIALECT_MEMBER_OF: Readonly<Record<(typeof ARMED_TOOLS)[number], keyof AgentEngineServerDialect>> = {
  inspect_schema: "catalogRead",
  inspect_plan: "planEstimate",
  profile_table: "profileComposition",
};

/**
 * The offered dialect-bound tools whose member is unsupported, exactly. `profile_table` on DuckDB is offered and
 * refuses with `UNSUPPORTED_DIALECT` (B111). Held both ways, so the entry goes when DuckDB gains a composition.
 */
const UNSERVED_OFFERS: Readonly<Partial<Record<DatabaseType, readonly AgentToolName[]>>> = {
  duckdb: ["profile_table"],
  clickhouse: ["profile_table"],
};

/** Inputs no adapter may throw on: a statement, the empty one, and every non-string a ledger or a model can send. */
const ADAPTER_CORPUS: readonly unknown[] = ["", "SELECT 1", {}, { a: 1 }, null, 42, []];

const REGISTERED_OPERATIONS = new Set(createCanonicalOperationRegistry().registeredIds());

test("the engines are every type with a statement language, and the execution engines are among them", () => {
  // Read from the manifest, never restated: an engine that gains a language joins every case below.
  expect(ENGINES.length).toBeGreaterThan(0);
  // A subset only. A type may speak a language and execute nothing; the two lists are not the same claim.
  for (const type of AGENT_EXECUTION_ENGINES) expect(ENGINES).toContain(type);
});

test("the unserved offers name only engines that speak a language", () => {
  for (const type of Object.keys(UNSERVED_OFFERS)) expect(ENGINES).toContain(type as DatabaseType);
});

describe.each(ENGINES)("%s", (type) => {
  const pack: AgentEnginePack = agentEnginePack(type);

  test("is its language's pack, frozen, and is what the run resolver reads", () => {
    expect<string | null>(pack.id).toBe(AGENT_STATEMENT_LANGUAGE[type]);
    for (const frozen of [pack, pack.client, pack.server, pack.execution, pack.server.adapter, pack.client.posture]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
    const run = runServerPack(pack.id, type);
    expect(Object.keys(run).sort()).toEqual(Object.keys(pack.server).sort());
    for (const member of Object.keys(pack.server) as (keyof typeof pack.server)[]) {
      expect(run[member], member).toBe(pack.server[member]);
    }
  });

  test("every workflow it opens is told its rules, offered resolvable tools, armed and judged", () => {
    const opened = openVariants(type);
    expect(opened.length).toBeGreaterThan(0);
    const arms: Partial<Record<AgentToolName, { readonly inputSchema: unknown }>> = pack.execution.arms;
    for (const { workflow, variant } of opened) {
      const rules = pack.server.workflowToolRules[workflow];
      if (rules === undefined) throw new Error(`${type} opens ${workflow} with no rules for it`);
      for (const tool of toolsNamedIn(rules)) expect(variant.tools, `${workflow} names ${tool}`).toContain(tool);
      for (const tool of [...variant.tools, ...variant.narrowedExtras]) {
        expect(agentToolDefinition(pack.id, workflow, tool).name, `${workflow} ${tool}`).toBe(tool);
      }
      for (const tool of ARMED_TOOLS) {
        if (!variant.tools.includes(tool)) continue;
        const arm = arms[tool];
        if (arm === undefined) throw new Error(`${type} ${workflow} offers ${tool} with no arm`);
        expect(arm.inputSchema, `${workflow} ${tool}`).toBe(agentToolDefinition(pack.id, workflow, tool).inputSchema);
      }
      const verdict = verifyRunGoal({
        mode: "agent",
        workflowType: workflow,
        status: "succeeded",
        events: [],
        statementLanguage: pack.id,
        verifier: variant.verifier,
      });
      expect(verdict.verifier).toBe(variant.verifier);
    }
  });

  test("an offered dialect-bound tool has its member, except the exact unserved offers", () => {
    const dialect = pack.server.dialect;
    const unserved = new Set<AgentToolName>();
    if (dialect !== undefined) {
      for (const { variant } of openVariants(type)) {
        for (const tool of ARMED_TOOLS) {
          if (variant.tools.includes(tool) && dialect[DIALECT_MEMBER_OF[tool]] === "unsupported") unserved.add(tool);
        }
      }
    }
    expect([...unserved].sort()).toEqual([...(UNSERVED_OFFERS[type] ?? [])].sort());
  });

  test("its adapter is total over the corpus", () => {
    const { adapter } = pack.server;
    for (const raw of ADAPTER_CORPUS) {
      const canonical = adapter.canonicalize(raw);
      expect(canonical === null || typeof canonical === "string", JSON.stringify(raw)).toBe(true);
    }
    for (const text of ADAPTER_CORPUS.filter((raw): raw is string => typeof raw === "string")) {
      expect(adapter.fingerprint(text)).toBe(adapter.fingerprint(text));
      expect(adapter.fingerprint(text).length, JSON.stringify(text)).toBeGreaterThan(0);
      expect(adapter.rowCapAdvice(text, "500").length, JSON.stringify(text)).toBeGreaterThan(0);
    }
  });

  test("its read operation and its plan operation are registered operations", () => {
    expect(REGISTERED_OPERATIONS.has(pack.server.adapter.readOperation)).toBe(true);
    const plan = pack.client.planEstimateOperation;
    if (plan !== null) expect(REGISTERED_OPERATIONS.has(plan)).toBe(true);
  });

  test("says what it is under every workflow's statement bounds", () => {
    expect(pack.server.answerNotADataRead.length).toBeGreaterThan(0);
    expect(pack.server.grounding.omissionAdvice.length).toBeGreaterThan(0);
    for (const workflow of WORKFLOWS) {
      const bounds = AGENT_WORKFLOW_BUDGETS[workflow].policy.budgets;
      for (const posture of [pack.client.posture.reads(bounds), pack.client.posture.widened(bounds)]) {
        for (const field of [posture.headline, posture.qualifier, posture.title, posture.body]) {
          expect(field.length, workflow).toBeGreaterThan(0);
        }
      }
      expect(pack.client.posture.handoverTerms(bounds).length, workflow).toBeGreaterThan(0);
    }
  });

  test("its card is frozen, and every recommend_change it offers is read by the card that owns its schema", () => {
    // The schema itself is a zod object, which is not frozen; the card that holds it is. `recommendChangeTool` parses
    // with the family's card when the offered schema is that card's, with the reference card when it is that one's,
    // and throws for a schema neither owns, so this holds every shipped offer to one of the two before a run does.
    const card = pack.server.recommendationCard;
    if (card !== undefined) expect(Object.isFrozen(card)).toBe(true);
    const owners: readonly unknown[] = [card?.inputSchema, REFERENCE_RECOMMENDATION_CARD.inputSchema];
    for (const { workflow, variant } of openVariants(type)) {
      if (!variant.tools.includes("recommend_change")) continue;
      expect(owners, workflow).toContain(agentToolDefinition(pack.id, workflow, "recommend_change").inputSchema);
    }
  });
});

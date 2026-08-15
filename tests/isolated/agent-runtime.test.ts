/**
 * The composition root (#329 T9): what a route hands the run loop.
 *
 * Isolated because it mocks `@/lib/db` and `@/lib/agent/investigation`, which every
 * provider and agent-loop suite imports for real.
 *
 * The ledger underneath is a REAL `@workflow/world-local` over a temporary data
 * directory, for the same reason `tests/unit/lib/agent/run-store.test.ts` uses one:
 * what is under test is that a drive re-derives everything from a run's own durable
 * record, and a fake store would let that pass while the record said something else.
 */

import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { configureAgentModel, restoreAgentModel } from "../helpers/agent-model-env";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import * as realRunStore from "@/lib/agent/run-store";
import { AgentRunServiceError } from "@/lib/agent/run-service";
import { LLMAuthError, LLMConfigError, LLMRateLimitError } from "@/lib/llm/types";
import { ExecutionProfileError } from "@/lib/db/errors";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import { acquireExecutionProfileProvider } from "@/lib/db/factory";
import type { AgentToolResources } from "@/lib/agent/investigation";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { AgentRunWorkflowType } from "@/lib/agent/types";
import type { DatabaseConnection } from "@/lib/types";

const dataDirs: string[] = [];

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-"));
  dataDirs.push(dir);
  return dir;
}

// One world for the whole file: `driveAgentRun` opens its own service each call, and
// the run it reads has to be the one the previous call wrote.
const world = createLocalWorld({ dataDir: freshDataDir(), recoverActiveRuns: false });

// Only the fields the composition root reads; the run loop is mocked away here.
const CONNECTION = { id: "seed:sales", name: "Sales", type: "postgres" } as unknown as DatabaseConnection;
const CAPABILITIES = { supportsTransactions: true } as unknown as ProviderCapabilities;

const mockResolveConnection = mock(async () => CONNECTION);
const mockGetCapabilities = mock(() => CAPABILITIES);
const mockCreateAgentModel = mock(async () => ({ provider: "gemini", modelId: "gemini-3-pro" }));

let investigationCalls: { runId: string; resources: AgentToolResources }[] = [];

const mockRunInvestigation = mock(async (runId: string, options: { resources: AgentToolResources }) => {
  investigationCalls.push({ runId, resources: options.resources });
  return { runId, status: "succeeded", stopReason: "report-composed", turns: 1, text: "" };
});

mock.module("@/lib/agent/run-store", () => ({ ...realRunStore, resolveAgentLedgerWorld: async () => world }));
mock.module("@/lib/seed/resolve-connection", () => ({ resolveConnection: mockResolveConnection }));
mock.module("@/lib/db", () => ({ createDatabaseProvider: async () => ({ getCapabilities: mockGetCapabilities }) }));
mock.module("@/lib/agent/model-adapter", () => ({ createAgentModel: mockCreateAgentModel }));
mock.module("@/lib/agent/investigation", () => ({ runInvestigation: mockRunInvestigation }));

const { AGENT_MAX_ARTIFACTS, driveAgentRun, getAgentRunService, readAgentArtifact } = await import(
  "@/lib/agent/runtime"
);

const ACTOR = { sessionId: "ada", role: "user" } as const;

async function openRun(runId: string, workflowType?: AgentRunWorkflowType): Promise<void> {
  const service = await getAgentRunService();
  await service.start({
    mode: "agent",
    actor: ACTOR,
    connectionId: "seed:sales",
    objective: "why is checkout slow",
    runId,
    ...(workflowType === undefined ? {} : { workflowType }),
  });
}

beforeEach(() => {
  // A configured model is what makes the runtime available since #331 T5; the
  // flag only switches it off. `configureAgentModel` also clears whatever the
  // checkout's `.env` put in `process.env`, so this suite answers the same way
  // here and in CI.
  delete process.env[AGENT_ENABLED_ENV];
  configureAgentModel();
  investigationCalls = [];
  mockResolveConnection.mockClear();
});

afterEach(() => {
  restoreAgentModel();
});

afterAll(() => {
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("getAgentRunService", () => {
  test("builds a service over the durable backend, whose runs read back", async () => {
    await openRun("arun_readback");

    const report = await (await getAgentRunService()).status("arun_readback");

    expect(report?.record.objective).toBe("why is checkout slow");
    expect(report?.record.actor).toEqual(ACTOR);
  });
});

describe("driveAgentRun", () => {
  /**
   * The wall clock is one of the four figures the decision table varies per workflow,
   * so it has to be built from the RUN'S record: a composition root that read one
   * constant would bound a `database-assessment` drive by an investigation's clock
   * while the rail stated the assessment's, and only one of the two would be true.
   */
  test.each([["investigation"], ["database-assessment"], ["operations"]] as const)(
    "gives a %s run the wall clock its own workflow was frozen with",
    async (workflowType) => {
      await openRun(`arun_clock_${workflowType.replace(/-/g, "_")}`, workflowType);

      await driveAgentRun(`arun_clock_${workflowType.replace(/-/g, "_")}`);

      const { deadline } = investigationCalls[investigationCalls.length - 1].resources;
      const expected = AGENT_WORKFLOW_BUDGETS[workflowType].runDeadlineMs;
      // A fresh deadline has spent only the microseconds since it was constructed.
      expect(deadline.remainingMs()).toBeGreaterThan(expected - 1_000);
      expect(deadline.remainingMs()).toBeLessThanOrEqual(expected);
    },
  );

  test("refuses a run that does not exist", async () => {
    await expect(driveAgentRun("arun_nosuchrun")).rejects.toThrow(AgentRunServiceError);
  });

  test("does not invent a ledger for a run that does not exist", async () => {
    // The refusal above must stay a refusal: a drive asked for an unknown run has
    // nothing to record a failure ON, and writing one would create the very record
    // whose absence it is reporting.
    await expect(driveAgentRun("arun_neverwas")).rejects.toThrow(AgentRunServiceError);

    expect(await (await getAgentRunService()).status("arun_neverwas")).toBeNull();
  });

  test("resolves the connection as the run's persisted actor, not as the caller", async () => {
    await openRun("arun_actor");

    await driveAgentRun("arun_actor");

    // The role is what decides which managed connections are visible; taking it
    // from the ledger is what makes a resumed drive see exactly what its opener saw.
    expect(mockResolveConnection).toHaveBeenCalledWith(
      { connectionId: "seed:sales" },
      { role: "user", username: "ada" },
    );
  });

  test("scopes the run to its own connection and reaches the database through the profiled seam", async () => {
    await openRun("arun_scope");

    await driveAgentRun("arun_scope");

    const { resources } = investigationCalls[0];
    expect(resources.scope.connectionId).toBe("seed:sales");
    expect(resources.connection).toEqual(CONNECTION);
    expect(resources.capabilities).toEqual(CAPABILITIES);
    // Never the shared writable cache: a provider is acquired for the run's
    // execution profile, which is the only seam the tool layer is allowed to use.
    expect(resources.acquireProvider).toBe(acquireExecutionProfileProvider);
  });

  test("gives the run a canonical registry, a deadline and an empty repair ledger", async () => {
    await openRun("arun_parts");

    await driveAgentRun("arun_parts");

    const { resources } = investigationCalls[0];
    expect(resources.registry.resolve("sql.query.read").kind).toBe("resolved");
    expect(resources.deadline.remainingMs()).toBeGreaterThan(0);
    expect(resources.repairs).toBeDefined();
  });

  test("two drives of one run share the budget and artifact accounting", async () => {
    // They are keyed by run id and released together when the run ends, so a second
    // drive that built its own pair would restart the budget and orphan the results.
    await openRun("arun_shared");

    await driveAgentRun("arun_shared");
    await driveAgentRun("arun_shared");

    expect(investigationCalls[1].resources.tracker).toBe(investigationCalls[0].resources.tracker);
    expect(investigationCalls[1].resources.artifacts).toBe(investigationCalls[0].resources.artifacts);
  });
});

/**
 * A drive that dies before the loop does not leave the run sitting at `queued`.
 *
 * `runInvestigation` ends a run it actually entered, so every stop reason it owns is
 * already recorded. What was missing is everything BEFORE it: resolving the
 * connection, reading capabilities and building the model all happen first, and a
 * throw there used to unwind past the ledger entirely. The run stayed `queued` with
 * an empty timeline, the reason readable only in the server log, and — because
 * nothing produces a drive delivery yet (`docs/BACKLOG.md` B9) — nothing would ever
 * come back to it.
 *
 * The reason is classified from the error's TYPE and never from its message, which
 * is written by a model provider or a connection resolver and promises nothing about
 * what it does not contain.
 */
describe("a drive that fails before the loop", () => {
  async function finishedEvent(runId: string): Promise<Record<string, unknown> | undefined> {
    const report = await (await getAgentRunService()).status(runId);
    return report?.record.events.find((event) => event.kind === "run-finished") as Record<string, unknown> | undefined;
  }

  test("records an unusable model as failed, not as still queued", async () => {
    await openRun("arun_modelgone");
    mockCreateAgentModel.mockImplementationOnce(async () => {
      throw new LLMConfigError("Gemini API key is required", "gemini");
    });

    await expect(driveAgentRun("arun_modelgone")).rejects.toThrow(LLMConfigError);

    const report = await (await getAgentRunService()).status("arun_modelgone");
    expect(report?.record.status).toBe("failed");
    expect(await finishedEvent("arun_modelgone")).toMatchObject({
      status: "failed",
      reason: "model-unavailable",
    });
  });

  /*
    The three model failures a user can tell apart, and must.

    Collapsing them into "model-unavailable" is what a real run produced on
    2026-08-12: a Gemini free-tier quota of 15 requests per minute was exhausted by
    testing, and the rail reported that the provider "is not configured or could not
    be reached" — of a provider that was configured and had answered a second
    earlier. A quota is the one model failure that fixes itself, and it was the one
    described as a misconfiguration.
  */
  test("records a rate limit as itself, not as an unreachable provider", async () => {
    await openRun("arun_ratelimited");
    mockCreateAgentModel.mockImplementationOnce(async () => {
      throw new LLMRateLimitError("You exceeded your current quota. Please retry in 54.6s.", "gemini");
    });

    await expect(driveAgentRun("arun_ratelimited")).rejects.toThrow(LLMRateLimitError);

    expect(await finishedEvent("arun_ratelimited")).toMatchObject({
      status: "failed",
      reason: "model-rate-limited",
    });
  });

  test("records refused model credentials as itself", async () => {
    await openRun("arun_badkey");
    mockCreateAgentModel.mockImplementationOnce(async () => {
      throw new LLMAuthError("API key not valid", "gemini");
    });

    await expect(driveAgentRun("arun_badkey")).rejects.toThrow(LLMAuthError);

    expect(await finishedEvent("arun_badkey")).toMatchObject({
      status: "failed",
      reason: "model-unauthorized",
    });
  });

  test("records an engine the agent cannot execute on read-only", async () => {
    // The default connection of a zero-config deployment is the LibreDB sample,
    // which has no database-native read-only profile. Reported as "internal", that
    // is a server fault the user should report; reported as itself, it is a
    // connection they should switch away from.
    await openRun("arun_noprofile");
    mockResolveConnection.mockImplementationOnce(async () => {
      throw new ExecutionProfileError(
        'Provider type "libredb" has no database-native read-only execution profile',
        "PROFILE_UNSUPPORTED_BY_PROVIDER",
      );
    });

    await expect(driveAgentRun("arun_noprofile")).rejects.toThrow(ExecutionProfileError);

    expect(await finishedEvent("arun_noprofile")).toMatchObject({
      status: "failed",
      reason: "engine-unsupported",
    });
  });

  test("records a connection that no longer resolves", async () => {
    await openRun("arun_connectiongone");
    mockResolveConnection.mockImplementationOnce(async () => {
      throw new SeedConnectionError('connection "seed:sales" was not found', 404);
    });

    await expect(driveAgentRun("arun_connectiongone")).rejects.toThrow();

    expect(await finishedEvent("arun_connectiongone")).toMatchObject({
      status: "failed",
      reason: "connection-unresolvable",
    });
  });

  test("does not dress an unrecognised failure up as a specific one", async () => {
    await openRun("arun_odd");
    mockGetCapabilities.mockImplementationOnce(() => {
      throw new TypeError("capabilities blew up");
    });

    await expect(driveAgentRun("arun_odd")).rejects.toThrow(TypeError);

    expect(await finishedEvent("arun_odd")).toMatchObject({ status: "failed", reason: "internal" });
  });

  test("surfaces the original failure to the caller rather than one raised while recording it", async () => {
    // Ending the run is a best effort: if the ledger itself refuses, what the caller
    // needs is still the reason the drive died, not the bookkeeping that followed.
    await openRun("arun_doublefault");
    await (await getAgentRunService()).finish("arun_doublefault", "cancelled");
    mockCreateAgentModel.mockImplementationOnce(async () => {
      throw new LLMConfigError("Gemini API key is required", "gemini");
    });

    await expect(driveAgentRun("arun_doublefault")).rejects.toThrow(LLMConfigError);
  });
});

/**
 * Reading a stored result back (#329 T11).
 *
 * The property that matters is identity: the route that serves an artifact's rows has
 * to read the SAME process-wide store the run wrote them into, or it would answer
 * "released" for results that are sitting in memory. So the store is taken from what
 * a real drive was handed rather than constructed here.
 */
describe("readAgentArtifact", () => {
  const RESULT = { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 4 };
  /** What the module derives its TTL from, restated so this file reads it the same way. */
  const LONGEST_DEADLINE_MS = Math.max(...Object.values(AGENT_WORKFLOW_BUDGETS).map((b) => b.runDeadlineMs));

  test("reads back what the run loop stored, and answers undefined once it has expired", async () => {
    await openRun("arun_artifact");
    await driveAgentRun("arun_artifact");
    const { artifacts } = investigationCalls[0].resources;

    artifacts.put(
      {
        correlationId: "corr_read",
        runId: "arun_artifact",
        operationId: "sql.query.read",
        createdAtMs: 1_000,
        value: RESULT,
      },
      1_000,
    );

    const held = readAgentArtifact("corr_read", 1_500);
    expect(held?.runId).toBe("arun_artifact");
    expect(held?.value).toEqual(RESULT);

    // The TTL is the store's, not this module's: past it the same id is simply gone.
    expect(readAgentArtifact("corr_read", 1_000 + LONGEST_DEADLINE_MS * 4)).toBeUndefined();
  });

  /**
   * The TTL is derived from the LONGEST workflow deadline, and it has to be: the store
   * is process-wide, so a TTL taken from a shorter row would expire a
   * `data-analysis` run's earliest result while that run was still allowed to
   * cite it — the dead reference §1.2 of the design says the multiple exists to
   * prevent. Asserted behaviourally, because the constant is private to the module.
   */
  test("a result outlives the longest run any workflow may have, by the factor the design relies on", async () => {
    await openRun("arun_ttl");
    await driveAgentRun("arun_ttl");
    const { artifacts } = investigationCalls[investigationCalls.length - 1].resources;
    artifacts.put(
      {
        correlationId: "corr_ttl",
        runId: "arun_ttl",
        operationId: "sql.query.read",
        createdAtMs: 1_000,
        value: RESULT,
      },
      1_000,
    );

    for (const [workflow, budget] of Object.entries(AGENT_WORKFLOW_BUDGETS)) {
      expect(readAgentArtifact("corr_ttl", 1_000 + budget.runDeadlineMs * 4 - 1), workflow).toBeDefined();
    }
    expect(readAgentArtifact("corr_ttl", 1_000 + LONGEST_DEADLINE_MS * 4 - 1)).toBeDefined();
    expect(readAgentArtifact("corr_ttl", 1_000 + LONGEST_DEADLINE_MS * 4)).toBeUndefined();
    expect(LONGEST_DEADLINE_MS).toBe(AGENT_WORKFLOW_BUDGETS["data-analysis"].runDeadlineMs);
  });

  test("an id nothing ever stored is undefined rather than an error", () => {
    expect(readAgentArtifact("corr_never", 1_000)).toBeUndefined();
  });
});

describe("AGENT_MAX_ARTIFACTS", () => {
  /**
   * The largest per-workflow statement ceiling the decision table freezes
   * (`database-assessment`, 45) and the number of concurrent runs the single
   * agent process is sized for (4). Asserted as a product rather than as the
   * number itself so the assertion still means something when another workflow
   * row lands: `data-analysis` at 42 statements is under this, and a row above
   * 45 must move the constant with it.
   */
  const LARGEST_STATEMENT_CEILING = 45;
  const ASSUMED_CONCURRENT_RUNS = 4;

  test("holds every artifact the busiest workflow can produce, on all the runs assumed at once", () => {
    expect(AGENT_MAX_ARTIFACTS).toBeGreaterThanOrEqual(LARGEST_STATEMENT_CEILING * ASSUMED_CONCURRENT_RUNS);
  });
});

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

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import { AGENT_RUN_DEADLINE_MS } from "@/lib/agent/execution-policy";
import * as realRunStore from "@/lib/agent/run-store";
import { AgentRunServiceError } from "@/lib/agent/run-service";
import { acquireExecutionProfileProvider } from "@/lib/db/factory";
import type { AgentToolResources } from "@/lib/agent/investigation";
import type { ProviderCapabilities } from "@/lib/db/types";
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

const { driveAgentRun, getAgentRunService, readAgentArtifact } = await import("@/lib/agent/runtime");

const ACTOR = { sessionId: "ada", role: "user" } as const;

async function openRun(runId: string): Promise<void> {
  const service = await getAgentRunService();
  await service.start({
    mode: "agent",
    actor: ACTOR,
    connectionId: "seed:sales",
    objective: "why is checkout slow",
    runId,
  });
}

beforeEach(() => {
  process.env[AGENT_ENABLED_ENV] = "true";
  investigationCalls = [];
  mockResolveConnection.mockClear();
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
  test("refuses a run that does not exist", async () => {
    await expect(driveAgentRun("arun_nosuchrun")).rejects.toThrow(AgentRunServiceError);
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
 * Reading a stored result back (#329 T11).
 *
 * The property that matters is identity: the route that serves an artifact's rows has
 * to read the SAME process-wide store the run wrote them into, or it would answer
 * "released" for results that are sitting in memory. So the store is taken from what
 * a real drive was handed rather than constructed here.
 */
describe("readAgentArtifact", () => {
  const RESULT = { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 4 };

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
    expect(readAgentArtifact("corr_read", 1_000 + AGENT_RUN_DEADLINE_MS * 4)).toBeUndefined();
  });

  test("an id nothing ever stored is undefined rather than an error", () => {
    expect(readAgentArtifact("corr_never", 1_000)).toBeUndefined();
  });
});

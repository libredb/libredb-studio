/**
 * A run on a seed that declares an agent credential signs in as that credential, from the seed file to the provider.
 *
 * Driven end to end from what an operator writes: a seed file with `agentUser` and `agentPassword` as `${ENV}`
 * references, a run started through `POST /api/agent/runs`, the real drive, the real `resolveConnection` and the real
 * factory. The assertion reads the user and password each provider was constructed with, never the connection the
 * test wrote, so it fails if the schema, the projection or the resolution drops a field.
 *
 * Isolated because it mocks the run ledger's world, the model and the investigation loop, which other suites import
 * for real. The loop is replaced by one that acquires every execution profile a run can take and stops there.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { configureAgentModel, restoreAgentModel } from "../helpers/agent-model-env";
import { createMockRequest } from "../helpers/mock-next";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import * as realAuth from "@/lib/auth";
import * as realGate from "@/lib/agent/capability-gate";
import * as realRunStore from "@/lib/agent/run-store";
import type { AgentToolResources } from "@/lib/agent/investigation";
import { PostgresProvider } from "@/lib/db/providers/sql/postgres";
import { resetCache } from "@/lib/seed";
import { resetPlaintextWarnings } from "@/lib/seed/credential-resolver";

const dir = mkdtempSync(join(tmpdir(), "agent-run-seed-credential-"));
const world = createLocalWorld({ dataDir: join(dir, "ledger"), recoverActiveRuns: false });

const PROFILES = ["agent-read-only", "agent-operations", "agent-handover"] as const;

let acquired: Promise<readonly unknown[][]> = Promise.resolve([]);
let settleAcquired: (logins: readonly unknown[][]) => void = () => {};

/** Acquires every profile through the run's own acquirer, as the loop's tools would, and records each refusal. */
const mockRunInvestigation = mock(async (runId: string, options: { resources: AgentToolResources }) => {
  const outcomes: unknown[][] = [];
  for (const profile of PROFILES) {
    // oxlint-disable-next-line no-await-in-loop -- one profile at a time, so the captured logins keep their order.
    const error = await options.resources.acquireProvider(options.resources.connection, profile).then(
      () => null,
      (refusal: unknown) => refusal,
    );
    outcomes.push([profile, (error as Error | null)?.message ?? null]);
  }
  settleAcquired(outcomes);
  return { runId, status: "succeeded", stopReason: "report-composed", turns: 1, text: "" };
});

mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "ada" })),
  readSession: mock(async () => ({ kind: "authenticated", session: { role: "admin", username: "ada" } })),
}));
mock.module("@/lib/agent/capability-gate", () => ({
  ...realGate,
  admitAgentModel: mock(async () => ({ kind: "allowed", protocol: "native" })),
}));
mock.module("@/lib/agent/run-store", () => ({ ...realRunStore, resolveAgentLedgerWorld: async () => world }));
mock.module("@/lib/agent/model-adapter", () => ({
  createAgentModel: mock(async () => ({ provider: "gemini", modelId: "gemini-3-pro" })),
}));
mock.module("@/lib/agent/investigation", () => ({ runInvestigation: mockRunInvestigation }));

const { POST } = await import("@/app/api/agent/runs/route");

function seedFile(entry: Record<string, unknown>): void {
  const path = join(dir, "seed-connections.json");
  writeFileSync(
    path,
    JSON.stringify({ version: "1", connections: [{ name: entry.id, roles: ["admin"], managed: true, ...entry }] }),
  );
  process.env.SEED_CONFIG_PATH = path;
  resetCache();
}

/** The user and password each Postgres provider was constructed with; the open stops there, before any socket. */
function captureLogins(): { readonly logins: unknown[][]; restore(): void } {
  const logins: unknown[][] = [];
  const connect = spyOn(PostgresProvider.prototype, "connect").mockImplementation(async function (
    this: PostgresProvider,
  ) {
    logins.push([this.config.user, this.config.password]);
    throw new Error("stopped after the open read its login");
  });
  return { logins, restore: () => connect.mockRestore() };
}

async function startRun(connectionId: string): Promise<readonly unknown[][]> {
  acquired = new Promise((resolve) => {
    settleAcquired = resolve;
  });
  const response = await POST(
    createMockRequest("/api/agent/runs", {
      method: "POST",
      body: { mode: "agent", objective: "why is checkout slow", connectionId },
    }),
  );
  expect(response.status).toBe(202);
  return acquired;
}

beforeEach(() => {
  delete process.env[AGENT_ENABLED_ENV];
  configureAgentModel();
  resetPlaintextWarnings();
  mockRunInvestigation.mockClear();
});

afterEach(() => {
  restoreAgentModel();
  delete process.env.SEED_CONFIG_PATH;
  delete process.env.RUN_SEED_OWNER_PASSWORD;
  delete process.env.RUN_SEED_AGENT_USER;
  delete process.env.RUN_SEED_AGENT_PASSWORD;
  resetCache();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a run on a seed with an agent credential", () => {
  const seed = {
    type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    database: "sales",
    user: "owner",
    password: "${RUN_SEED_OWNER_PASSWORD}",
  };

  test("acquires every execution profile as the agent user, with its resolved password", async () => {
    process.env.RUN_SEED_OWNER_PASSWORD = "not-a-real-owner-password";
    process.env.RUN_SEED_AGENT_USER = "agent_reader";
    process.env.RUN_SEED_AGENT_PASSWORD = "not-a-real-agent-password";
    seedFile({
      ...seed,
      id: "sales",
      agentUser: "${RUN_SEED_AGENT_USER}",
      agentPassword: "${RUN_SEED_AGENT_PASSWORD}",
    });
    const captured = captureLogins();
    let outcomes: readonly unknown[][] = [];
    try {
      outcomes = await startRun("seed:sales");
    } finally {
      captured.restore();
    }

    expect(outcomes.map(([profile]) => profile)).toEqual([...PROFILES]);
    expect(captured.logins).toEqual(PROFILES.map(() => ["agent_reader", "not-a-real-agent-password"]));
  });

  test("acquires under the seed's own login when it declares none", async () => {
    process.env.RUN_SEED_OWNER_PASSWORD = "not-a-real-owner-password";
    seedFile({ ...seed, id: "sales-own" });
    const captured = captureLogins();
    try {
      await startRun("seed:sales-own");
    } finally {
      captured.restore();
    }

    expect(captured.logins[0]).toEqual(["owner", "not-a-real-owner-password"]);
  });
});

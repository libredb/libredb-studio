/**
 * A run whose ledger header names a statement language or goal rule this Studio does not have, or has retired
 * (FND-1), driven through the real route handlers.
 *
 * Real: every per-run route, the drive route, the access gate, the run service and the store over a real
 * `@workflow/world-local` in a temporary directory. Replaced: the session read, which needs a request scope, the
 * ledger world resolution, pointed at this file's world as `tests/isolated/agent-runtime.test.ts` points it, and the
 * four seams a route would reach a database or a model through, each a recorder that must never be called.
 *
 * What is pinned: the run's owner is answered 409 `AGENT_RUN_UNAVAILABLE` with the refusal's sentence on every route,
 * anyone else exactly as for a run that does not exist, nothing is resolved, built, acquired or appended, and a run
 * with no persisted language still opens.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { configureAgentModel, restoreAgentModel } from "../../helpers/agent-model-env";
import { createMockRequest } from "../../helpers/mock-next";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import { AGENT_DRIVE_HEADER, mintAgentDriveToken } from "@/lib/agent/drive-token";
import * as realModelAdapter from "@/lib/agent/model-adapter";
import * as realRunStore from "@/lib/agent/run-store";
import { runHeaderRefusal } from "@/lib/agent/run-ledger-ids";
import type { AgentRunEvent } from "@/lib/agent/types";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import * as realAuth from "@/lib/auth";
import * as realDb from "@/lib/db";
import * as realFactory from "@/lib/db/factory";
import { logger } from "@/lib/logger";
import * as realResolveConnection from "@/lib/seed/resolve-connection";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-unavailable-run-"));
const world = createLocalWorld({ dataDir, recoverActiveRuns: false });

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const OWNER = "ada";
let sessionUser = OWNER;

const reached: string[] = [];
function recorder(name: string) {
  return mock(async (..._args: unknown[]): Promise<never> => {
    reached.push(name);
    throw new Error(`${name} must not be reached for a run this Studio cannot read`);
  });
}

mock.module("@/lib/agent/run-store", () => ({ ...realRunStore, resolveAgentLedgerWorld: async () => world }));
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: async () => ({ username: sessionUser, role: "user" }),
  readSession: async () => ({ kind: "authenticated", session: { username: sessionUser, role: "user" } }),
}));
mock.module("@/lib/seed/resolve-connection", () => ({
  ...realResolveConnection,
  resolveConnection: recorder("resolveConnection"),
}));
mock.module("@/lib/db", () => ({ ...realDb, createDatabaseProvider: recorder("createDatabaseProvider") }));
mock.module("@/lib/db/factory", () => ({
  ...realFactory,
  acquireExecutionProfileProvider: recorder("acquireExecutionProfileProvider"),
}));
mock.module("@/lib/agent/model-adapter", () => ({
  ...realModelAdapter,
  createAgentModel: recorder("createAgentModel"),
}));

const runRoute = await import("@/app/api/agent/runs/[runId]/route");
const streamRoute = await import("@/app/api/agent/runs/[runId]/stream/route");
const artifactRoute = await import("@/app/api/agent/runs/[runId]/artifacts/[correlationId]/route");
const handoverRoute = await import("@/app/api/agent/runs/[runId]/handover/route");
const driveRoute = await import("@/app/api/agent/drive/route");

const store = new realRunStore.AgentRunStore({ world });
const ACTOR = { sessionId: OWNER, role: "user" } as const;

const event = (fields: Record<string, unknown>): AgentRunEvent => fields as unknown as AgentRunEvent;

async function open(
  runId: string,
  header: { readonly statementLanguage?: string; readonly verifier?: string },
  workflowType: "data-analysis" | "investigation" | "operations" = "data-analysis",
): Promise<void> {
  await store.openRun({
    runId,
    mode: "agent",
    workflowType,
    autoExecute: true,
    ...(header.statementLanguage === undefined ? {} : { statementLanguage: header.statementLanguage as never }),
    ...(header.verifier === undefined ? {} : { verifier: header.verifier as never }),
    actor: ACTOR,
    connectionId: "seed:sales",
    objective: "how many orders shipped",
  });
}

async function started(runId: string): Promise<void> {
  await store.appendEvent(runId, event({ kind: "run-started", atMs: 1, mode: "agent" }));
}

async function paused(runId: string): Promise<void> {
  await started(runId);
  await store.appendEvent(runId, event({ kind: "run-paused", atMs: 2 }));
}

/** A finished run whose answer was auto-executed, so the hand-over would replay it and its artifact is named. */
async function finished(runId: string): Promise<void> {
  await started(runId);
  const artifact = {
    correlationId: `corr_${runId}`,
    runId,
    operationId: "sql.query.read",
    summary: { rowCount: 1, columnNames: ["n"], elapsedMs: 1 },
  };
  await store.appendEvent(runId, event({ kind: "tool-invoked", atMs: 2, stepId: "s1", tool: "run_read_query" }));
  await store.appendEvent(runId, event({ kind: "tool-completed", atMs: 3, stepId: "s1", artifact }));
  await store.appendEvent(
    runId,
    event({
      kind: "answer-composed",
      atMs: 4,
      sql: "SELECT COUNT(*) AS n FROM orders",
      artifact,
      presentation: { kind: "table" },
      handover: "auto-executed",
    }),
  );
  await store.appendEvent(runId, event({ kind: "run-finished", atMs: 5, status: "succeeded" }));
  await store.close(runId);
}

/** The ledger's raw chunk count, read past the store so a refused read cannot hide an append. */
async function chunkCount(runId: string): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await world.getStreamChunks(realRunStore.ledgerStreamName(runId), "", { cursor });
    count += page.data.length;
    if (!page.hasMore || page.cursor === null) return count;
    cursor = page.cursor;
  }
}

const params = (runId: string) => ({ params: Promise.resolve({ runId }) });

type Call = (runId: string) => Promise<Response>;

const ROUTES: Readonly<Record<string, Call>> = {
  GET: (runId) => runRoute.GET(createMockRequest(`/api/agent/runs/${runId}`), params(runId)),
  "GET stream": (runId) => streamRoute.GET(createMockRequest(`/api/agent/runs/${runId}/stream`), params(runId)),
  "GET artifact": (runId) =>
    artifactRoute.GET(createMockRequest(`/api/agent/runs/${runId}/artifacts/corr_${runId}`), {
      params: Promise.resolve({ runId, correlationId: `corr_${runId}` }),
    }),
  "POST handover": (runId) =>
    handoverRoute.POST(createMockRequest(`/api/agent/runs/${runId}/handover`, { method: "POST" }), params(runId)),
  DELETE: (runId) => runRoute.DELETE(createMockRequest(`/api/agent/runs/${runId}`, { method: "DELETE" }), params(runId)),
  "PATCH pause": (runId) =>
    runRoute.PATCH(
      createMockRequest(`/api/agent/runs/${runId}`, { method: "PATCH", body: { action: "pause" } }),
      params(runId),
    ),
  "PATCH resume": (runId) =>
    runRoute.PATCH(
      createMockRequest(`/api/agent/runs/${runId}`, { method: "PATCH", body: { action: "resume" } }),
      params(runId),
    ),
  "POST drive": async (runId) =>
    driveRoute.POST(
      createMockRequest("/api/agent/drive", {
        method: "POST",
        headers: { [AGENT_DRIVE_HEADER]: await mintAgentDriveToken(runId) },
      }),
    ),
};

let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;

beforeEach(() => {
  delete process.env[AGENT_ENABLED_ENV];
  configureAgentModel();
  clearRateLimitState();
  reached.length = 0;
  sessionUser = OWNER;
  warn = spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  restoreAgentModel();
});

describe("a run whose ledger names an id this Studio does not have", () => {
  test.each([
    ["GET", "finished", "cobol"],
    ["GET stream", "finished", "cobol"],
    ["GET artifact", "finished", "cobol"],
    ["POST handover", "finished", "cobol"],
    ["DELETE", "paused", "cobol"],
    ["DELETE", "queued", "cobol"],
    ["DELETE", "running", "cobol"],
    ["PATCH pause", "running", "cobol"],
    ["PATCH resume", "paused", "cobol"],
    ["POST drive", "running", "cobol"],
    ["POST drive", "running", "verifier"],
    ["POST drive", "paused", "cobol"],
    ["PATCH resume", "paused", "verifier"],
  ] as const)("%s on a %s run (%s) answers the run's owner 409 AGENT_RUN_UNAVAILABLE by name and reaches nothing", async (route, state, id) => {
    const runId = `arun_${route.replace(" ", "")}_${state}_${id}`.toLowerCase();
    const header = id === "cobol" ? { statementLanguage: "cobol" } : { verifier: "agent-nonexistent.1" };
    await open(runId, header, id === "cobol" ? "data-analysis" : "investigation");
    if (state === "finished") await finished(runId);
    if (state === "paused") await paused(runId);
    if (state === "running") await started(runId);
    const before = await chunkCount(runId);

    const response = await ROUTES[route](runId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: runHeaderRefusal(header)?.sentence,
      code: "AGENT_RUN_UNAVAILABLE",
      statusCode: 409,
    });
    expect(reached).toEqual([]);
    expect(await chunkCount(runId)).toBe(before);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("Agent run unavailable");
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      runId,
      field: id === "cobol" ? "statementLanguage" : "verifier",
      reason: "unknown",
    });
  });

  test("a retired verifier is named as retired", async () => {
    const runId = "arun_retired_operations";
    await open(runId, { verifier: "agent-operations.1" }, "operations");
    await paused(runId);

    const response = await ROUTES.DELETE(runId);

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      'This run is judged by the goal rule "agent-operations.1", which this LibreDB Studio has retired. The run is kept as it was, and this LibreDB Studio does not open, drive, stop or replay it.',
    );
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ field: "verifier", reason: "retired" });
  });

  test.each(["GET", "POST handover"] as const)(
    "someone else's run answers %s 404, exactly as a run that does not exist",
    async (route) => {
      const runId = `arun_foreign_${route.replace(" ", "")}`.toLowerCase();
      await open(runId, { statementLanguage: "cobol" });
      await finished(runId);
      sessionUser = "bob";

      const foreign = await ROUTES[route](runId);
      const missing = await ROUTES[route]("arun_never_opened");

      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual({ error: "No such agent run" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "No such agent run" });
      expect(reached).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  test("an SQL run with no persisted language still opens", async () => {
    const runId = "arun_sql_control";
    await open(runId, {});
    await finished(runId);

    const response = await ROUTES.GET(runId);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { record: { runId: string; status: string } };
    expect(body.record).toMatchObject({ runId, status: "succeeded" });
  });
});

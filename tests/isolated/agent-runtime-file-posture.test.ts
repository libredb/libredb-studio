/**
 * The run's declaration provider is built under the run actor's file-access posture (FND-2 slice 3).
 *
 * Isolated because it mocks `@/lib/agent/investigation`, which every agent-loop suite imports for real. Unlike
 * tests/isolated/agent-runtime.test.ts, `@/lib/db` is NOT mocked: the drive reaches the real provider factory, which
 * refuses a SQLite connection whose posture is denied when it builds the provider. So an administrator's run on a
 * SQLite file reaches its investigation, and a user's run, which SQLite refuses, is refused at the declaration build
 * with SQLite's own sentence and recorded failed. The ledger is a real `@workflow/world-local` over a temporary directory;
 * only the ledger world, the connection resolver, the model and the investigation loop are replaced.
 */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { configureAgentModel, restoreAgentModel } from "../helpers/agent-model-env";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import * as realRunStore from "@/lib/agent/run-store";
import * as realResolve from "@/lib/seed/resolve-connection";
import { forgetStorageLocation } from "@/lib/data-dir";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";
import { legacyRegisterTable } from "../helpers/legacy-register";

const deniedFileAccessRefusal = legacyRegisterTable("deniedFileAccessRefusal");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-file-posture-"));
const previousStoragePath = process.env.STORAGE_SQLITE_PATH;
process.env.STORAGE_SQLITE_PATH = path.join(work, "data", "libredb-storage.db");
forgetStorageLocation();

const world = createLocalWorld({ dataDir: path.join(work, "ledger"), recoverActiveRuns: false });
const file = path.join(work, "app.db");
fs.writeFileSync(file, "");
const CONNECTION = { id: "seed:app", name: "App", type: "sqlite", database: file } as unknown as DatabaseConnection;

let investigated: string[] = [];
mock.module("@/lib/agent/run-store", () => ({ ...realRunStore, resolveAgentLedgerWorld: async () => world }));
mock.module("@/lib/seed/resolve-connection", () => ({ ...realResolve, resolveConnection: async () => CONNECTION }));
mock.module("@/lib/agent/model-adapter", () => ({
  createAgentModel: async () => ({ provider: "gemini", modelId: "gemini-3-pro" }),
}));
mock.module("@/lib/agent/investigation", () => ({
  runInvestigation: async (runId: string) => {
    investigated.push(runId);
    return { runId, status: "succeeded", stopReason: "report-composed", turns: 1, text: "" };
  },
}));

const { driveAgentRun, getAgentRunService } = await import("@/lib/agent/runtime");

async function openRun(runId: string, role: "admin" | "user", mode: "agent" | "planning"): Promise<void> {
  const service = await getAgentRunService();
  await service.start({
    mode,
    actor: { sessionId: role, role },
    connectionId: "seed:app",
    objective: "count rows",
    runId,
  });
}

beforeEach(() => {
  delete process.env[AGENT_ENABLED_ENV];
  configureAgentModel();
  investigated = [];
});

afterAll(() => {
  restoreAgentModel();
  if (previousStoragePath === undefined) delete process.env.STORAGE_SQLITE_PATH;
  else process.env.STORAGE_SQLITE_PATH = previousStoragePath;
  forgetStorageLocation();
  fs.rmSync(work, { recursive: true, force: true });
});

for (const mode of ["agent", "planning"] as const) {
  test(`an administrator's ${mode} run on a SQLite file reaches its investigation`, async () => {
    const runId = `arun_sqlite_admin_${mode}`;
    await openRun(runId, "admin", mode);

    await driveAgentRun(runId);

    expect(investigated).toEqual([runId]);
  });

  test(`a user's ${mode} run on a SQLite file is refused at the declaration build with SQLite's own sentence`, async () => {
    const runId = `arun_sqlite_user_${mode}`;
    await openRun(runId, "user", mode);

    const refused = await driveAgentRun(runId).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(DatabaseConfigError);
    expect((refused as Error).message).toBe(deniedFileAccessRefusal.sqlite as string);
    expect(investigated).toEqual([]);
    const status = await (await getAgentRunService()).status(runId);
    expect((status?.record as unknown as { status?: unknown } | undefined)?.status).toBe("failed");
  });
}

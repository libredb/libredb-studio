import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realAuth from "@/lib/auth";
import * as capabilityGate from "@/lib/agent/capability-gate";
import * as workflowClassifier from "@/lib/agent/workflow-classifier";
import { configureAgentModel, restoreAgentModel } from "../../helpers/agent-model-env";
import { ALL_ROUTES, CONNECTION_ROUTES } from "../../security/helpers/provider-routes";

/**
 * A seed entry whose type names no provider this Studio has (FND-1) is listed, and refused by name wherever it is
 * opened: every route that resolves a connection, the fleet health check and the agent's run and classify routes answer
 * a `seed:` id that names it 400 PROVIDER_UNKNOWN with the sentence that quotes its type, before any provider is built
 * or any model asked. The seed file's other entries still resolve.
 *
 * Measured on 2026-11-20 before the change: one such entry failed the whole seed file, so every `seed:` id of the file,
 * the valid ones included, answered 500 INTERNAL_ERROR on every route.
 *
 * Only the session reader is replaced, with an admin session. `resolveServedConnection`, the seed loader and the factory are
 * the real ones, reading a seed file in a temp directory named by SEED_CONFIG_PATH. A provider is counted where it is
 * built, by the legacy adapter's open's `[DB] Creating <type> provider` line, as
 * tests/api/db/inline-connection-record.test.ts counts it. The model gate and the classifier are spied on, never
 * replaced, to prove neither is reached.
 */

const mockGetSession = mock(async () => ({ role: "admin", username: "admin" }));

// Spread over the real module: a partial replacement stays installed process-wide and breaks the next importer of an
// export this one forgot.
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mock(async () => ({ kind: "authenticated", session: await mockGetSession() })),
}));

const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { unknownTypeSentence } = await import("@/lib/db/type-id");
const { resetCache } = await import("@/lib/seed");

const SENTENCE = unknownTypeSentence("acmefoo");
const PROVIDER_UNKNOWN = {
  status: 400,
  body: { error: SENTENCE, code: "PROVIDER_UNKNOWN", statusCode: 400, kind: "unknown-provider", outcome: "unknown" },
};

const dir = mkdtempSync(join(tmpdir(), "libredb-unavailable-seed-"));
const ROUTE_MODULES = new Map(ALL_ROUTES);
const ENV_KEYS = ["SEED_CONFIG_PATH", "SEED_CACHE_TTL_MS", "ALLOW_CUSTOM_CONNECTIONS", "GOVERNANCE_SOURCE"] as const;
const saved: Record<string, string | undefined> = {};

type Handler = (request: Request) => Promise<Response>;

async function postHandler(route: string): Promise<Handler> {
  const load = ROUTE_MODULES.get(route);
  if (load === undefined) throw new Error(`"${route}" is not a route`);
  const { POST } = await load();
  if (typeof POST !== "function") throw new Error(`"${route}" exports no POST`);
  return POST as unknown as Handler;
}

async function answer(route: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const handler = await postHandler(route);
  const response = await handler(
    new Request(`http://localhost/api/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as unknown };
}

/** Runs `work` with the factory's announcement captured, and answers what it answered and how many providers it built. */
async function counted<T>(work: () => Promise<T>): Promise<{ result: T; built: number }> {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = await work();
    const built = log.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("[DB] Creating "),
    ).length;
    return { result, built };
  } finally {
    log.mockRestore();
  }
}

beforeAll(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  const file = join(dir, "seed-connections.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: "1",
      connections: [
        {
          id: "acme",
          name: "Acme Store",
          type: "acmefoo",
          host: "acme.internal",
          password: "CANARY-7f3a",
          roles: ["*"],
        },
        // Nothing listens on port 1, so a route that reached this seed's server would fail rather than hang.
        { id: "pg", name: "PG", type: "postgres", host: "127.0.0.1", port: 1, user: "u", roles: ["*"] },
      ],
    }),
  );
  process.env.SEED_CONFIG_PATH = file;
  process.env.SEED_CACHE_TTL_MS = "0";
  resetCache();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetCache();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clearRateLimitState();
});

describe("a seed whose type names no provider, on every connection route", () => {
  // A listing bug that found nothing would make every route test below pass vacuously.
  test("the inventory holds at least today's 23 connection routes", () => {
    expect(Object.keys(CONNECTION_ROUTES).length).toBeGreaterThanOrEqual(23);
  });

  test("every connection route answers a seed whose type names no provider 400 PROVIDER_UNKNOWN, and builds nothing", async () => {
    for (const [route, fields] of Object.entries(CONNECTION_ROUTES)) {
      // oxlint-disable-next-line no-await-in-loop -- one route at a time, so a failure names its route.
      const { result, built } = await counted(() => answer(route, { ...fields, connectionId: "seed:acme" }));
      expect({ route, ...result }).toEqual({ route, ...PROVIDER_UNKNOWN });
      expect({ route, built }).toEqual({ route, built: 0 });
    }
  });

  test("the file's other seed still resolves", async () => {
    const { result, built } = await counted(() => answer("db/provider-meta", { connectionId: "seed:pg" }));
    expect(result.status).toBe(200);
    expect(built).toBe(1);
  });

  test("a fleet-health item naming it reports the refusal", async () => {
    const { result, built } = await counted(() =>
      answer("admin/fleet-health", { connections: [{ id: "seed:acme", name: "Acme Store", type: "postgres" }] }),
    );

    expect(result.status).toBe(200);
    expect((result.body as { results: unknown[] }).results).toEqual([
      expect.objectContaining({ connectionId: "seed:acme", status: "error", error: SENTENCE }),
    ]);
    expect(built).toBe(0);
  });
});

describe("a seed whose type names no provider, on the agent routes", () => {
  beforeEach(() => {
    configureAgentModel();
  });

  afterEach(() => {
    restoreAgentModel();
  });

  test("POST /api/agent/runs answers it 400 PROVIDER_UNKNOWN before any model is asked", async () => {
    const gate = spyOn(capabilityGate, "admitAgentModel");
    try {
      const { result, built } = await counted(() =>
        answer("agent/runs", { mode: "agent", objective: "why is checkout slow", connectionId: "seed:acme" }),
      );

      expect(result).toEqual(PROVIDER_UNKNOWN);
      expect(result.body).not.toHaveProperty("refused");
      expect(gate).not.toHaveBeenCalled();
      expect(built).toBe(0);
    } finally {
      gate.mockRestore();
    }
  });

  test("POST /api/agent/classify answers it 400 PROVIDER_UNKNOWN and classifies nothing", async () => {
    const classify = spyOn(workflowClassifier, "classifyAgentWorkflow");
    try {
      const result = await answer("agent/classify", {
        objective: "why is checkout slow",
        connectionId: "seed:acme",
        mode: "agent",
      });

      expect(result).toEqual(PROVIDER_UNKNOWN);
      expect(classify).not.toHaveBeenCalled();
    } finally {
      classify.mockRestore();
    }
  });
});

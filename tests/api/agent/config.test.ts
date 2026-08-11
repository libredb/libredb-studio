/**
 * The agent capability probe (#329 T10a): what the browser is allowed to know
 * about whether this server runs agents.
 *
 * The rail cannot read `LIBREDB_AGENT_ENABLED` — it is server-side only, and the
 * standalone pages are statically prerendered, so baking the flag into the bundle
 * at build time would answer for the build rather than for the operator's running
 * container. Discovery is therefore a request, the same shape the storage mode
 * already uses (`/api/storage/config`, `src/hooks/use-storage-sync.ts:184`), with
 * one deliberate difference: this one requires a session, because T9 pinned that an
 * unauthenticated caller may not learn whether an agent surface exists here.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { AGENT_ENABLED_ENV, AGENT_WORLD_TARGET_ENV } from "@/lib/agent/config";
import * as realAuth from "@/lib/auth";
import { parseResponseJSON } from "../../helpers/mock-next";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "ada" }),
);

// Spread over the real module: a partial replacement stays installed process-wide
// and breaks the next file that imports an export this one forgot (T9's lesson).
function installMocks(): void {
  mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));
}

installMocks();

const { GET } = await import("@/app/api/agent/config/route");

beforeEach(() => {
  installMocks();
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  delete process.env[AGENT_ENABLED_ENV];
  delete process.env[AGENT_WORLD_TARGET_ENV];
});

describe("GET /api/agent/config", () => {
  test("reports the runtime as enabled when the operator turned it on", async () => {
    process.env[AGENT_ENABLED_ENV] = "true";

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await parseResponseJSON<{ enabled: boolean }>(res)).toEqual({ enabled: true });
  });

  test("reports it disabled when the flag is absent, which is the default", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(await parseResponseJSON<{ enabled: boolean }>(res)).toEqual({ enabled: false });
  });

  test("an unauthenticated caller learns nothing about the flag", async () => {
    process.env[AGENT_ENABLED_ENV] = "true";
    mockGetSession.mockResolvedValue(null);

    const res = await GET();
    const body = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(401);
    expect(body).not.toHaveProperty("enabled");
  });

  /**
   * The backend selector is validated where a world is actually built
   * (`resolveAgentDurableBackend`, refusing an unsanctioned value). This route
   * answers a visibility question and builds nothing, so a misconfigured backend
   * must not turn the probe into a 500 — the rail would then be indistinguishable
   * from a server whose runtime is off, which is the state the operator would be
   * trying to diagnose.
   */
  test("an unsanctioned durable backend does not break the probe", async () => {
    process.env[AGENT_ENABLED_ENV] = "true";
    process.env[AGENT_WORLD_TARGET_ENV] = "@workflow/world-turso";

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await parseResponseJSON<{ enabled: boolean }>(res)).toEqual({ enabled: true });
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realAuth from "@/lib/auth";
import { recordGovernanceSnapshot, resetGovernanceState } from "@/lib/governance/state";
import { grantedSnapshot } from "../../helpers/governance/granted-snapshot";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "ada" }),
);

// Spread over the real module: a partial replacement stays installed process-wide and breaks the
// next importer of an export this one forgot.
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mock(async () => {
    const s = await mockGetSession();
    return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
  }),
}));

const { GET } = await import("@/app/api/connections/policy/route");

const original = process.env.ALLOW_CUSTOM_CONNECTIONS;
const originalGovernance = process.env.GOVERNANCE_SOURCE;

beforeEach(() => {
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  delete process.env.ALLOW_CUSTOM_CONNECTIONS;
  delete process.env.GOVERNANCE_SOURCE;
});

afterEach(() => {
  resetGovernanceState();
  if (original === undefined) delete process.env.ALLOW_CUSTOM_CONNECTIONS;
  else process.env.ALLOW_CUSTOM_CONNECTIONS = original;
  if (originalGovernance === undefined) delete process.env.GOVERNANCE_SOURCE;
  else process.env.GOVERNANCE_SOURCE = originalGovernance;
});

describe("GET /api/connections/policy", () => {
  test("answers 401 and says nothing about the policy without a session", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    // The session-required body every route answers (#1484): the code is what sends the browser to sign in.
    expect(await res.json()).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
  });

  test("allows custom connections by default", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ customConnections: true });
  });

  test("answers false to every role once the operator switches them off", async () => {
    process.env.ALLOW_CUSTOM_CONNECTIONS = " Off ";

    const asUser = await GET();
    mockGetSession.mockResolvedValue({ role: "admin", username: "root" });
    const asAdmin = await GET();

    expect(asUser.status).toBe(200);
    expect(await asUser.json()).toEqual({ customConnections: false });
    expect(asAdmin.status).toBe(200);
    expect(await asAdmin.json()).toEqual({ customConnections: false });
  });

  test("governance reports governance true and custom connections off", async () => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    // The variable says on; governance serves the governance source's connections only, whatever it says.
    process.env.ALLOW_CUSTOM_CONNECTIONS = "true";

    const res = await GET();

    expect(res.status).toBe(200);
    // No snapshot has set queryLog.statementCapture yet, so the registry default applies.
    expect(await res.json()).toEqual({ customConnections: false, governance: true, statementCapture: "none" });
  });

  test("governance reports statementCapture full", async () => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    recordGovernanceSnapshot({
      ...grantedSnapshot([], []),
      settings: { values: new Map([["queryLog.statementCapture", "full"]]), ignored: [], malformed: 0 },
    });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ customConnections: false, governance: true, statementCapture: "full" });
  });

  test("without governance a recorded statementCapture is not reported", async () => {
    recordGovernanceSnapshot({
      ...grantedSnapshot([], []),
      settings: { values: new Map([["queryLog.statementCapture", "full"]]), ignored: [], malformed: 0 },
    });

    const res = await GET();

    expect(await res.json()).toEqual({ customConnections: true });
  });
});

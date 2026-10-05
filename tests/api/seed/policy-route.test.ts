import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realAuth from "@/lib/auth";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "ada" }),
);

// Spread over the real module: a partial replacement stays installed process-wide and breaks the
// next importer of an export this one forgot.
mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));

const { GET } = await import("@/app/api/connections/policy/route");

const original = process.env.ALLOW_CUSTOM_CONNECTIONS;

beforeEach(() => {
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  delete process.env.ALLOW_CUSTOM_CONNECTIONS;
});

afterEach(() => {
  if (original === undefined) delete process.env.ALLOW_CUSTOM_CONNECTIONS;
  else process.env.ALLOW_CUSTOM_CONNECTIONS = original;
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
});

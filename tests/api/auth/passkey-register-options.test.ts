import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseResponseJSON } from "../../helpers/mock-next";

const mockGetSession = mock(
  async (): Promise<{
    username: string;
    role: "admin" | "user";
  } | null> => null,
);

const mockGetOrCreateWebAuthnUserId = mock(
  (_userId: string) => "web-authn-user-id",
);

const mockGetPasskeysForUser = mock((_userId: string) => []);

const mockSaveRegistrationChallenge = mock(
  (_userId: string, _challenge: string, _expiresAt: number) => {},
);

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
}));

mock.module("@/lib/passkey/passkey-store", () => ({
  getOrCreateWebAuthnUserId: mockGetOrCreateWebAuthnUserId,
  getPasskeysForUser: mockGetPasskeysForUser,
  saveRegistrationChallenge: mockSaveRegistrationChallenge,
}));

const { GET } = await import(
  "@/app/api/auth/passkey/register/options/route"
);

describe("GET /api/auth/passkey/register/options", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetOrCreateWebAuthnUserId.mockClear();
    mockGetPasskeysForUser.mockClear();
    mockSaveRegistrationChallenge.mockClear();

    delete process.env.WEBAUTHN_RP_ID;
    delete process.env.WEBAUTHN_RP_NAME;
  });

  afterEach(() => {
    delete process.env.WEBAUTHN_RP_ID;
    delete process.env.WEBAUTHN_RP_NAME;
  });

  test("returns 401 when the user is not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const request = new Request(
      "http://localhost:3000/api/auth/passkey/register/options",
    );

    const response = await GET(request);
    const data = await parseResponseJSON<{ error: string }>(response);

    expect(response.status).toBe(401);
    expect(data.error).toBe("Authentication required");
  });

  test("returns registration options for an authenticated user", async () => {
    mockGetSession.mockResolvedValueOnce({
      username: "alice@example.com",
      role: "user",
    });

    const request = new Request(
      "http://localhost:3000/api/auth/passkey/register/options",
    );

    const response = await GET(request);
    const data = await parseResponseJSON<{
      challenge: string;
      rp: {
        id: string;
        name: string;
      };
      user: {
        name: string;
      };
    }>(response);

    expect(response.status).toBe(200);
    expect(data.challenge).toEqual(expect.any(String));
    expect(data.challenge.length).toBeGreaterThan(0);
    expect(data.rp.id).toBe("localhost");
    expect(data.rp.name).toBe("LibreDB Studio");
    expect(data.user.name).toBe("alice@example.com");
  });

  test("stores the generated registration challenge", async () => {
    mockGetSession.mockResolvedValueOnce({
      username: "alice@example.com",
      role: "user",
    });

    const request = new Request(
      "http://localhost:3000/api/auth/passkey/register/options",
    );

    const response = await GET(request);
    const data = await parseResponseJSON<{ challenge: string }>(response);

    expect(response.status).toBe(200);

    expect(mockGetOrCreateWebAuthnUserId).toHaveBeenCalledWith(
      "alice@example.com",
    );

    expect(mockGetPasskeysForUser).toHaveBeenCalledWith(
      "alice@example.com",
    );

    expect(mockSaveRegistrationChallenge).toHaveBeenCalledTimes(1);
    expect(mockSaveRegistrationChallenge).toHaveBeenCalledWith(
      "alice@example.com",
      data.challenge,
      expect.any(Number),
    );
  });

  test("uses configured RP settings when provided", async () => {
    process.env.WEBAUTHN_RP_ID = "example.com";
    process.env.WEBAUTHN_RP_NAME = "Custom LibreDB";

    mockGetSession.mockResolvedValueOnce({
      username: "alice@example.com",
      role: "user",
    });

    const request = new Request(
      "https://example.com/api/auth/passkey/register/options",
    );

    const response = await GET(request);
    const data = await parseResponseJSON<{
      rp: {
        id: string;
        name: string;
      };
    }>(response);

    expect(response.status).toBe(200);
    expect(data.rp.id).toBe("example.com");
    expect(data.rp.name).toBe("Custom LibreDB");
  });
});
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseResponseJSON } from "../../helpers/mock-next";

const mockConsumeAuthenticationChallenge = mock(
  (_sessionId: string): string | null => null,
);

const mockGetPasskeyById = mock(
  (
    _id: string,
  ): {
    id: string;
    userId: string;
    publicKey: string;
    counter: number;
    transports?: string[];
    createdAt: string;
    lastUsedAt?: string;
  } | undefined => undefined,
);

const mockUpdatePasskeyCounter = mock(
  (_id: string, _counter: number) => {},
);

const mockVerifyAuthenticationResponse = mock(
  async (): Promise<{
    verified: boolean;
    authenticationInfo: {
      newCounter: number;
    };
  }> => ({
    verified: false,
    authenticationInfo: {
      newCounter: 0,
    },
  }),
);

const mockLogin = mock(
  async (_role: "admin" | "user", _username?: string) => {},
);

const mockGetAuthUsers = mock(
  (): Array<{
    email: string;
    password: string;
    role: "admin" | "user";
    totpSecret?: string;
  }> => [],
);

mock.module("@/lib/auth", () => ({
  login: mockLogin,
}));

mock.module("@/lib/local-auth", () => ({
  getAuthUsers: mockGetAuthUsers,
}));

mock.module("@/lib/passkey/passkey-store", () => ({
  consumeAuthenticationChallenge:
    mockConsumeAuthenticationChallenge,
  getPasskeyById: mockGetPasskeyById,
  updatePasskeyCounter: mockUpdatePasskeyCounter,
}));

mock.module("@simplewebauthn/server", () => ({
  verifyAuthenticationResponse:
    mockVerifyAuthenticationResponse,
}));

mock.module("@simplewebauthn/server/helpers", () => ({
  isoBase64URL: {
    toBuffer: mock((_value: string) => new Uint8Array([1, 2, 3])),
  },
}));

const { POST } = await import(
  "@/app/api/auth/passkey/authenticate/verify/route"
);

describe("POST /api/auth/passkey/authenticate/verify", () => {
  beforeEach(() => {
    mockConsumeAuthenticationChallenge.mockReset();
    mockGetPasskeyById.mockReset();
    mockUpdatePasskeyCounter.mockReset();
    mockVerifyAuthenticationResponse.mockReset();
    mockLogin.mockReset();
    mockGetAuthUsers.mockReset();

    mockConsumeAuthenticationChallenge.mockReturnValue(null);
    mockGetPasskeyById.mockReturnValue(undefined);

    mockVerifyAuthenticationResponse.mockResolvedValue({
      verified: false,
      authenticationInfo: {
        newCounter: 0,
      },
    });

    mockLogin.mockResolvedValue(undefined);
    mockGetAuthUsers.mockReturnValue([]);
  });

  afterEach(() => {
    delete process.env.WEBAUTHN_RP_ID;
    delete process.env.WEBAUTHN_ORIGIN;
  });

  test("returns 400 when the session ID or response is missing", async () => {
    const request = new Request(
      "http://localhost:3000/api/auth/passkey/authenticate/verify",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );

    const response = await POST(request);
    const data = await parseResponseJSON<{ error: string }>(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe(
      "Authentication session or response is missing",
    );
  });

  test("returns 400 when the authentication challenge is missing", async () => {
    mockConsumeAuthenticationChallenge.mockReturnValueOnce(null);

    const request = new Request(
      "http://localhost:3000/api/auth/passkey/authenticate/verify",
      {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-123",
          response: {
            id: "credential-1",
          },
        }),
      },
    );

    const response = await POST(request);
    const data = await parseResponseJSON<{ error: string }>(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe(
      "Authentication challenge is missing or expired",
    );

    expect(mockGetPasskeyById).not.toHaveBeenCalled();
  });

  test("returns 404 when the passkey is not registered", async () => {
    mockConsumeAuthenticationChallenge.mockReturnValueOnce(
      "authentication-challenge",
    );

    mockGetPasskeyById.mockReturnValueOnce(undefined);

    const request = new Request(
      "http://localhost:3000/api/auth/passkey/authenticate/verify",
      {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-123",
          response: {
            id: "unknown-credential",
          },
        }),
      },
    );

    const response = await POST(request);
    const data = await parseResponseJSON<{ error: string }>(response);

    expect(response.status).toBe(404);
    expect(data.error).toBe("Passkey is not registered");
  });

  test("returns 400 when WebAuthn verification fails", async () => {
    mockConsumeAuthenticationChallenge.mockReturnValueOnce(
      "authentication-challenge",
    );

    mockGetPasskeyById.mockReturnValueOnce({
      id: "credential-1",
      userId: "alice@example.com",
      publicKey: "encoded-public-key",
      counter: 5,
      transports: ["internal"],
      createdAt: "2026-09-23T00:00:00.000Z",
    });

    mockVerifyAuthenticationResponse.mockResolvedValueOnce({
      verified: false,
      authenticationInfo: {
        newCounter: 5,
      },
    });

    const request = new Request(
      "http://localhost:3000/api/auth/passkey/authenticate/verify",
      {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-123",
          response: {
            id: "credential-1",
          },
        }),
      },
    );

    const response = await POST(request);
    const data = await parseResponseJSON<{ error: string }>(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe(
      "Passkey authentication could not be verified",
    );

    expect(mockUpdatePasskeyCounter).not.toHaveBeenCalled();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  test("returns 401 when the passkey user is no longer configured", async () => {
    mockConsumeAuthenticationChallenge.mockReturnValueOnce(
      "authentication-challenge",
    );

    mockGetPasskeyById.mockReturnValueOnce({
      id: "credential-1",
      userId: "alice@example.com",
      publicKey: "encoded-public-key",
      counter: 5,
      transports: ["internal"],
      createdAt: "2026-09-23T00:00:00.000Z",
    });

    mockVerifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: {
        newCounter: 6,
      },
    });

    mockGetAuthUsers.mockReturnValueOnce([]);

    const request = new Request(
      "http://localhost:3000/api/auth/passkey/authenticate/verify",
      {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-123",
          response: {
            id: "credential-1",
          },
        }),
      },
    );

    const response = await POST(request);
    const data = await parseResponseJSON<{ error: string }>(response);

    expect(response.status).toBe(401);
    expect(data.error).toBe(
      "Passkey user is no longer configured",
    );

    expect(mockUpdatePasskeyCounter).not.toHaveBeenCalled();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  test("updates the counter and creates a session when authentication succeeds", async () => {
    mockConsumeAuthenticationChallenge.mockReturnValueOnce(
      "authentication-challenge",
    );

    mockGetPasskeyById.mockReturnValueOnce({
      id: "credential-1",
      userId: "alice@example.com",
      publicKey: "encoded-public-key",
      counter: 5,
      transports: ["internal"],
      createdAt: "2026-09-23T00:00:00.000Z",
    });

    mockVerifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: {
        newCounter: 6,
      },
    });

    mockGetAuthUsers.mockReturnValueOnce([
      {
        email: "alice@example.com",
        password: "test-password",
        role: "user",
      },
    ]);

    const request = new Request(
      "http://localhost:3000/api/auth/passkey/authenticate/verify",
      {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-123",
          response: {
            id: "credential-1",
          },
        }),
      },
    );

    const response = await POST(request);

    const data = await parseResponseJSON<{
      verified: boolean;
      userId: string;
      role: "admin" | "user";
    }>(response);

    expect(response.status).toBe(200);
    expect(data.verified).toBe(true);
    expect(data.userId).toBe("alice@example.com");
    expect(data.role).toBe("user");

    expect(mockConsumeAuthenticationChallenge).toHaveBeenCalledWith(
      "session-123",
    );

    expect(mockGetPasskeyById).toHaveBeenCalledWith(
      "credential-1",
    );

    expect(mockGetAuthUsers).toHaveBeenCalled();

    expect(mockUpdatePasskeyCounter).toHaveBeenCalledWith(
      "credential-1",
      6,
    );

    expect(mockLogin).toHaveBeenCalledWith(
      "user",
      "alice@example.com",
    );
  });

  test("creates an admin session for an admin passkey", async () => {
    mockConsumeAuthenticationChallenge.mockReturnValueOnce(
      "authentication-challenge",
    );

    mockGetPasskeyById.mockReturnValueOnce({
      id: "credential-admin",
      userId: "admin@example.com",
      publicKey: "encoded-public-key",
      counter: 10,
      transports: ["internal"],
      createdAt: "2026-09-23T00:00:00.000Z",
    });

    mockVerifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: {
        newCounter: 11,
      },
    });

    mockGetAuthUsers.mockReturnValueOnce([
      {
        email: "admin@example.com",
        password: "admin-password",
        role: "admin",
      },
    ]);

    const request = new Request(
      "http://localhost:3000/api/auth/passkey/authenticate/verify",
      {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-admin",
          response: {
            id: "credential-admin",
          },
        }),
      },
    );

    const response = await POST(request);

    const data = await parseResponseJSON<{
      verified: boolean;
      userId: string;
      role: "admin" | "user";
    }>(response);

    expect(response.status).toBe(200);
    expect(data.verified).toBe(true);
    expect(data.userId).toBe("admin@example.com");
    expect(data.role).toBe("admin");

    expect(mockLogin).toHaveBeenCalledWith(
      "admin",
      "admin@example.com",
    );
  });

  test("uses configured WebAuthn RP ID and origin", async () => {
    process.env.WEBAUTHN_RP_ID = "example.com";
    process.env.WEBAUTHN_ORIGIN = "https://example.com";

    mockConsumeAuthenticationChallenge.mockReturnValueOnce(
      "authentication-challenge",
    );

    mockGetPasskeyById.mockReturnValueOnce({
      id: "credential-1",
      userId: "alice@example.com",
      publicKey: "encoded-public-key",
      counter: 5,
      transports: ["internal"],
      createdAt: "2026-09-23T00:00:00.000Z",
    });

    mockVerifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: {
        newCounter: 6,
      },
    });

    mockGetAuthUsers.mockReturnValueOnce([
      {
        email: "alice@example.com",
        password: "test-password",
        role: "user",
      },
    ]);

    const request = new Request(
      "https://example.com/api/auth/passkey/authenticate/verify",
      {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-123",
          response: {
            id: "credential-1",
          },
        }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(200);

    expect(mockVerifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: "authentication-challenge",
        expectedOrigin: "https://example.com",
        expectedRPID: "example.com",
        requireUserVerification: false,
      }),
    );

    expect(mockLogin).toHaveBeenCalledWith(
      "user",
      "alice@example.com",
    );
  });
});
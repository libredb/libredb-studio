import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseResponseJSON } from "../../helpers/mock-next";

const mockGetSession = mock(
  async (): Promise<{
    username: string;
    role: "admin" | "user";
  } | null> => null,
);

const mockConsumeRegistrationChallenge = mock(
  (_userId: string): string | null => null,
);

const mockSavePasskey = mock((_passkey: unknown) => {});

const mockVerifyRegistrationResponse = mock(
  async (): Promise<{
    verified: boolean;
    registrationInfo:
      | {
          credential: {
            id: string;
            publicKey: Uint8Array;
            counter: number;
            transports?: string[];
          };
        }
      | undefined;
  }> => ({
    verified: false,
    registrationInfo: undefined,
  }),
);

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
}));

mock.module("@/lib/passkey/passkey-store", () => ({
  consumeRegistrationChallenge: mockConsumeRegistrationChallenge,
  savePasskey: mockSavePasskey,
}));

mock.module("@simplewebauthn/server", () => ({
  verifyRegistrationResponse: mockVerifyRegistrationResponse,
}));

mock.module("@simplewebauthn/server/helpers", () => ({
  isoBase64URL: {
    fromBuffer: mock((_buffer: Uint8Array) => "encoded-public-key"),
  },
}));

const { POST } = await import(
  "@/app/api/auth/passkey/register/verify/route"
);

describe("POST /api/auth/passkey/register/verify", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockConsumeRegistrationChallenge.mockReset();
    mockSavePasskey.mockReset();
    mockVerifyRegistrationResponse.mockReset();

    mockGetSession.mockResolvedValue(null);
    mockConsumeRegistrationChallenge.mockReturnValue(null);
    mockVerifyRegistrationResponse.mockResolvedValue({
      verified: false,
      registrationInfo: undefined,
    });
  });

  afterEach(() => {
    delete process.env.WEBAUTHN_RP_ID;
    delete process.env.WEBAUTHN_ORIGIN;
  });

  test("returns 401 when the user is not authenticated", async () => {
    const request = new Request(
      "http://localhost:3000/api/auth/passkey/register/verify",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );

    const response = await POST(request);
    const data = await parseResponseJSON<{ error: string }>(response);

    expect(response.status).toBe(401);
    expect(data.error).toBe("Authentication required");
  });

  test("returns 400 when the registration challenge is missing", async () => {
    mockGetSession.mockResolvedValueOnce({
      username: "alice@example.com",
      role: "user",
    });

    mockConsumeRegistrationChallenge.mockReturnValueOnce(null);

    const request = new Request(
      "http://localhost:3000/api/auth/passkey/register/verify",
      {
        method: "POST",
        body: JSON.stringify({
          id: "credential-1",
        }),
      },
    );

    const response = await POST(request);
    const data = await parseResponseJSON<{ error: string }>(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe(
      "Registration challenge is missing or expired",
    );
  });

  test("returns 400 when WebAuthn verification fails", async () => {
    mockGetSession.mockResolvedValueOnce({
      username: "alice@example.com",
      role: "user",
    });

    mockConsumeRegistrationChallenge.mockReturnValueOnce(
      "registration-challenge",
    );

    mockVerifyRegistrationResponse.mockResolvedValueOnce({
      verified: false,
      registrationInfo: undefined,
    });

    const request = new Request(
      "http://localhost:3000/api/auth/passkey/register/verify",
      {
        method: "POST",
        body: JSON.stringify({
          id: "credential-1",
        }),
      },
    );

    const response = await POST(request);
    const data = await parseResponseJSON<{ error: string }>(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe(
      "Passkey registration could not be verified",
    );

    expect(mockSavePasskey).not.toHaveBeenCalled();
  });

  test("saves the passkey when registration verification succeeds", async () => {
    mockGetSession.mockResolvedValueOnce({
      username: "alice@example.com",
      role: "user",
    });

    mockConsumeRegistrationChallenge.mockReturnValueOnce(
      "registration-challenge",
    );

    mockVerifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: {
          id: "credential-1",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 7,
          transports: ["internal"],
        },
      },
    });

    const request = new Request(
      "https://example.com/api/auth/passkey/register/verify",
      {
        method: "POST",
        body: JSON.stringify({
          id: "credential-1",
          response: {
            clientDataJSON: "test",
            attestationObject: "test",
          },
          type: "public-key",
        }),
      },
    );

    const response = await POST(request);
    const data = await parseResponseJSON<{ verified: boolean }>(response);

    expect(response.status).toBe(200);
    expect(data.verified).toBe(true);

    expect(mockConsumeRegistrationChallenge).toHaveBeenCalledWith(
      "alice@example.com",
    );

    expect(mockVerifyRegistrationResponse).toHaveBeenCalledTimes(1);

    expect(mockSavePasskey).toHaveBeenCalledWith({
      id: "credential-1",
      userId: "alice@example.com",
      publicKey: "encoded-public-key",
      counter: 7,
      transports: ["internal"],
      createdAt: expect.any(String),
    });
  });

  test("uses configured WebAuthn RP ID and origin", async () => {
    process.env.WEBAUTHN_RP_ID = "example.com";
    process.env.WEBAUTHN_ORIGIN = "https://example.com";

    mockGetSession.mockResolvedValueOnce({
      username: "alice@example.com",
      role: "user",
    });

    mockConsumeRegistrationChallenge.mockReturnValueOnce(
      "registration-challenge",
    );

    mockVerifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: {
          id: "credential-1",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ["internal"],
        },
      },
    });

    const request = new Request(
      "https://example.com/api/auth/passkey/register/verify",
      {
        method: "POST",
        body: JSON.stringify({
          id: "credential-1",
          response: {
            clientDataJSON: "test",
            attestationObject: "test",
          },
          type: "public-key",
        }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(200);

    expect(mockVerifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: "registration-challenge",
        expectedOrigin: "https://example.com",
        expectedRPID: "example.com",
        requireUserVerification: false,
      }),
    );
  });
});
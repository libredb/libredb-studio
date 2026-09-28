import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseResponseJSON } from "../../helpers/mock-next";

const mockGenerateAuthenticationOptions = mock(async () => ({
  challenge: "authentication-challenge",
  rpId: "localhost",
  userVerification: "preferred" as const,
}));

const mockSaveAuthenticationChallenge = mock(
  (_sessionId: string, _challenge: string, _expiresAt: number) => {},
);

mock.module("@simplewebauthn/server", () => ({
  generateAuthenticationOptions: mockGenerateAuthenticationOptions,
}));

mock.module("@/lib/passkey/passkey-store", () => ({
  saveAuthenticationChallenge: mockSaveAuthenticationChallenge,
}));

const { GET } = await import(
  "@/app/api/auth/passkey/authenticate/options/route"
);

describe("GET /api/auth/passkey/authenticate/options", () => {
  beforeEach(() => {
    mockGenerateAuthenticationOptions.mockReset();
    mockSaveAuthenticationChallenge.mockReset();

    mockGenerateAuthenticationOptions.mockResolvedValue({
      challenge: "authentication-challenge",
      rpId: "localhost",
      userVerification: "preferred",
    });
  });

  afterEach(() => {
    delete process.env.WEBAUTHN_RP_ID;
  });

  test("returns authentication options with a session ID", async () => {
    const request = new Request(
      "http://localhost:3000/api/auth/passkey/authenticate/options",
    );

    const response = await GET(request);

    const data = await parseResponseJSON<{
      sessionId: string;
      options: {
        challenge: string;
        rpId: string;
        userVerification: string;
      };
    }>(response);

    expect(response.status).toBe(200);
    expect(data.sessionId).toEqual(expect.any(String));
    expect(data.sessionId.length).toBeGreaterThan(0);
    expect(data.options.challenge).toBe("authentication-challenge");
    expect(data.options.rpId).toBe("localhost");
    expect(data.options.userVerification).toBe("preferred");
  });

  test("stores the authentication challenge", async () => {
    const request = new Request(
      "http://localhost:3000/api/auth/passkey/authenticate/options",
    );

    const response = await GET(request);

    const data = await parseResponseJSON<{
      sessionId: string;
      options: {
        challenge: string;
      };
    }>(response);

    expect(response.status).toBe(200);

    expect(mockSaveAuthenticationChallenge).toHaveBeenCalledTimes(1);
    expect(mockSaveAuthenticationChallenge).toHaveBeenCalledWith(
      data.sessionId,
      data.options.challenge,
      expect.any(Number),
    );
  });

  test("uses the configured WebAuthn RP ID", async () => {
    process.env.WEBAUTHN_RP_ID = "example.com";

    const request = new Request(
      "https://example.com/api/auth/passkey/authenticate/options",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);

    expect(mockGenerateAuthenticationOptions).toHaveBeenCalledWith({
      rpID: "example.com",
      userVerification: "preferred",
    });
  });

  test("returns 500 when authentication options cannot be generated", async () => {
    mockGenerateAuthenticationOptions.mockRejectedValueOnce(
      new Error("WebAuthn generation failed"),
    );

    const request = new Request(
      "http://localhost:3000/api/auth/passkey/authenticate/options",
    );

    const response = await GET(request);
    const data = await parseResponseJSON<{ error: string }>(response);

    expect(response.status).toBe(500);
    expect(data.error).toBe(
      "Unable to start passkey authentication",
    );
  });
});
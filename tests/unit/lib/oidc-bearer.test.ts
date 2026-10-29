import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { SignJWT } from "jose";
import { AuthConfigError } from "@/lib/auth-errors";
import {
  authenticateBearer,
  bearerTokenFrom,
  readBearerAudience,
  resetBearerKeys,
  type BearerAuthentication,
} from "@/lib/oidc-bearer";
import {
  BEARER_AUDIENCE as AUDIENCE,
  BEARER_ISSUER as ISSUER,
  bearerClaims as claims,
  NATIVE_CLIENT,
  nowSeconds,
  provider,
  restoreBearerEnv,
  rotated,
  rotatedJwk,
  signBearer as sign,
  signerJwk,
  stranger,
  stubIdentityProvider,
  useBearerEnv,
  WEB_CLIENT,
} from "../../helpers/oidc-bearer-provider";

/**
 * The OIDC bearer verifier (native clients, docs/OIDC.md "Bearer access tokens for native clients"). The identity
 * provider is a stubbed fetch serving a discovery document and a key set made in the helper, so every case signs its
 * own token.
 */

const fetchSpy = stubIdentityProvider();

afterAll(() => fetchSpy.mockRestore());

beforeEach(() => {
  useBearerEnv();
  resetBearerKeys();
});

afterEach(restoreBearerEnv);

async function authenticate(token: string): Promise<BearerAuthentication> {
  return await authenticateBearer(`Bearer ${token}`);
}

async function expectDenied(token: string, reason = "bearer_token_invalid") {
  expect(await authenticate(token)).toEqual({ kind: "denied", reason } as BearerAuthentication);
}

describe("bearerTokenFrom", () => {
  test("reads the Bearer scheme, case-insensitively", () => {
    expect(bearerTokenFrom("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerTokenFrom("bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  test("ignores every other scheme, an empty token and a missing header", () => {
    // A reverse proxy in front of Studio (CapRover httpAuth) forwards the browser's Basic credentials on every request.
    expect(bearerTokenFrom("Basic dXNlcjpwYXNz")).toBeNull();
    expect(bearerTokenFrom("Bearer ")).toBeNull();
    expect(bearerTokenFrom("Bearer")).toBeNull();
    expect(bearerTokenFrom(null)).toBeNull();
  });
});

describe("readBearerAudience", () => {
  test("is null while OIDC_BEARER_AUDIENCE is unset or blank", () => {
    delete process.env.OIDC_BEARER_AUDIENCE;
    expect(readBearerAudience()).toBeNull();
    process.env.OIDC_BEARER_AUDIENCE = "  ";
    expect(readBearerAudience()).toBeNull();
  });

  test("answers the trimmed audience under OIDC", () => {
    process.env.OIDC_BEARER_AUDIENCE = ` ${AUDIENCE} `;
    expect(readBearerAudience()).toBe(AUDIENCE);
  });

  test("refuses an audience without NEXT_PUBLIC_AUTH_PROVIDER=oidc", () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    expect(() => readBearerAudience()).toThrow(AuthConfigError);
  });

  test("refuses an audience under NEXT_PUBLIC_AUTH_PROVIDER=openshift with the unchanged message", () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "openshift";
    expect(() => readBearerAudience()).toThrow(
      "OIDC_BEARER_AUDIENCE is set, but bearer access tokens need NEXT_PUBLIC_AUTH_PROVIDER=oidc",
    );
  });

  test("throws the invalid-mode message under an unknown NEXT_PUBLIC_AUTH_PROVIDER value", () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "Oidc";
    expect(() => readBearerAudience()).toThrow("NEXT_PUBLIC_AUTH_PROVIDER must be local, oidc or openshift");
  });

  test("refuses the web client's own id as the audience, because every ID token Studio receives carries it", () => {
    process.env.OIDC_BEARER_AUDIENCE = WEB_CLIENT;
    expect(() => readBearerAudience()).toThrow(AuthConfigError);
  });
});

describe("authenticateBearer", () => {
  test("is absent without a Bearer header, whatever the configuration", async () => {
    expect(await authenticateBearer(null)).toEqual({ kind: "absent" });
    expect(await authenticateBearer("Basic dXNlcjpwYXNz")).toEqual({ kind: "absent" });
    expect(provider.discoveryCalls).toBe(0);
  });

  test("is absent with the channel off, so the header is ignored as before", async () => {
    delete process.env.OIDC_BEARER_AUDIENCE;
    expect(await authenticate(await sign(claims()))).toEqual({ kind: "absent" });
    expect(provider.discoveryCalls).toBe(0);
  });

  test("accepts an access token for the audience and answers the session the callback would mint", async () => {
    const token = claims();
    const result = await authenticate(await sign(token));

    expect(result).toEqual({
      kind: "authenticated",
      session: {
        role: "user",
        username: "ada@example.test",
        idpSubject: token.sub as string,
        idpIssuer: ISSUER,
        iat: token.iat as number,
        exp: token.exp as number,
        channel: "bearer",
      },
    });
  });

  test("maps the role with OIDC_ROLE_CLAIM and OIDC_ADMIN_ROLES", async () => {
    const result = await authenticate(await sign(claims({ realm_access: { roles: ["admin"] } })));
    expect(result.kind === "authenticated" && result.session.role).toBe("admin");
  });

  test("falls back to preferred_username, never to sub", async () => {
    const withName = await authenticate(await sign(claims({ email: undefined })));
    expect(withName.kind === "authenticated" && withName.session.username).toBe("ada");

    await expectDenied(await sign(claims({ email: undefined, preferred_username: undefined })), "bearer_no_identity");
    await expectDenied(await sign(claims({ email: "", preferred_username: "" })), "bearer_no_identity");
  });

  test("passes over an unverified email and never takes an email-shaped preferred_username", async () => {
    const unverified = await authenticate(await sign(claims({ email: "bob@example.test", email_verified: false })));
    expect(unverified.kind === "authenticated" && unverified.session.username).toBe("ada");

    await expectDenied(
      await sign(claims({ email: undefined, preferred_username: "bob@example.test" })),
      "bearer_no_identity",
    );
  });

  test("refuses a token without a non-empty sub", async () => {
    await expectDenied(await sign(claims({ sub: "" })), "bearer_no_identity");
    await expectDenied(await sign(claims({ sub: undefined })), "bearer_no_identity");
  });

  test("refuses an account without a role once OIDC_USER_ROLES is set", async () => {
    process.env.OIDC_USER_ROLES = "user";
    await expectDenied(await sign(claims({ realm_access: { roles: ["guest"] } })), "bearer_no_role");
  });

  test("accepts the issuer with a trailing slash, as the sign-in comparison does", async () => {
    const result = await authenticate(await sign(claims({ iss: `${ISSUER}/` })));
    expect(result.kind).toBe("authenticated");
  });

  test("refuses another issuer", async () => {
    await expectDenied(await sign(claims({ iss: "https://other.example.test/realms/libredb" })));
    await expectDenied(await sign(claims({ iss: undefined })));
  });

  test("refuses a missing or another audience", async () => {
    await expectDenied(await sign(claims({ aud: "account" })));
    await expectDenied(await sign(claims({ aud: undefined })));
  });

  test("refuses an ID token: the web client in aud, nonce, at_hash, c_hash, or Keycloak's typ ID", async () => {
    await expectDenied(await sign(claims({ aud: [AUDIENCE, WEB_CLIENT] })));
    await expectDenied(await sign(claims({ nonce: "n-0S6_WzA2Mj" })));
    await expectDenied(await sign(claims({ at_hash: "77QmUPtjPfzWtF2AnpK9RQ" })));
    await expectDenied(await sign(claims({ c_hash: "LDktKdoQak3Pk0cnXxCltA" })));
    await expectDenied(await sign(claims({ typ: "ID" })));
  });

  test("accepts the typ headers JWT, at+jwt and none, and refuses any other", async () => {
    expect((await authenticate(await sign(claims(), { typ: "at+jwt" }))).kind).toBe("authenticated");
    expect((await authenticate(await sign(claims(), { typ: "application/at+jwt" }))).kind).toBe("authenticated");
    expect((await authenticate(await sign(claims(), { typ: undefined }))).kind).toBe("authenticated");
    await expectDenied(await sign(claims(), { typ: "logout+jwt" }));
  });

  test("refuses alg none and every HMAC algorithm", async () => {
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(
      JSON.stringify(claims()),
    ).toString("base64url")}.`;
    await expectDenied(unsigned);

    const hmac = await new SignJWT(claims())
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .sign(new TextEncoder().encode("a-shared-secret-of-thirty-two-chars"));
    await expectDenied(hmac);
  });

  test("refuses a bad signature and a value that is not a JWT", async () => {
    await expectDenied(await sign(claims(), {}, stranger.privateKey));
    await expectDenied("not-a-jwt");
  });

  test("refuses an expired token and one not yet valid, allowing 30 seconds of skew", async () => {
    await expectDenied(await sign(claims({ exp: nowSeconds() - 31 })));
    expect((await authenticate(await sign(claims({ exp: nowSeconds() - 20 })))).kind).toBe("authenticated");
    await expectDenied(await sign(claims({ nbf: nowSeconds() + 60 })));
    expect((await authenticate(await sign(claims({ nbf: nowSeconds() + 20 })))).kind).toBe("authenticated");
  });

  test("requires iat and exp", async () => {
    await expectDenied(await sign(claims({ iat: undefined })));
    await expectDenied(await sign(claims({ exp: undefined })));
  });

  test("checks azp, else client_id, against OIDC_BEARER_CLIENT_IDS when it is set", async () => {
    process.env.OIDC_BEARER_CLIENT_IDS = ` ${NATIVE_CLIENT} , libredb-tablet`;
    expect((await authenticate(await sign(claims()))).kind).toBe("authenticated");
    expect((await authenticate(await sign(claims({ azp: undefined, client_id: "libredb-tablet" })))).kind).toBe(
      "authenticated",
    );
    await expectDenied(await sign(claims({ azp: "some-other-app" })));
    await expectDenied(await sign(claims({ azp: undefined })));
  });

  test("refetches the key set for an unknown kid after the cooldown, so a rotated key verifies", async () => {
    expect((await authenticate(await sign(claims()))).kind).toBe("authenticated");
    provider.keys = [signerJwk, rotatedJwk];

    // Inside the cooldown an unknown kid costs the provider no request.
    await expectDenied(await sign(claims(), { kid: "k2" }, rotated.privateKey));
    expect(provider.jwksCalls).toBe(1);

    setSystemTime(new Date(Date.now() + 31_000));
    try {
      const result = await authenticate(await sign(claims(), { kid: "k2" }, rotated.privateKey));
      expect(result.kind).toBe("authenticated");
    } finally {
      setSystemTime();
    }
    expect(provider.jwksCalls).toBe(2);
    expect(provider.discoveryCalls).toBe(1);
  });

  test("refuses a kid the provider does not publish", async () => {
    await expectDenied(await sign(claims(), { kid: "k9" }, stranger.privateKey));
  });

  test("answers a fault, not a refusal, when the provider cannot be reached", async () => {
    provider.down = true;
    const result = await authenticate(await sign(claims()));
    expect(result.kind).toBe("fault");
  });

  test("answers a fault when the discovery document fails or names no usable key set", async () => {
    const answers = [
      new Response("unavailable", { status: 503 }),
      Response.json({ issuer: ISSUER }),
      Response.json({ issuer: ISSUER, jwks_uri: "not a url" }),
    ];
    for (const answer of answers) {
      resetBearerKeys();
      fetchSpy.mockImplementationOnce((async () => answer) as unknown as typeof fetch);
      expect((await authenticate(await sign(claims()))).kind).toBe("fault");
    }
  });

  test("does not keep a failed discovery, so the next request tries again", async () => {
    provider.down = true;
    expect((await authenticate(await sign(claims()))).kind).toBe("fault");
    provider.down = false;
    expect((await authenticate(await sign(claims()))).kind).toBe("authenticated");
  });

  test("answers a fault for a configuration error", async () => {
    process.env.OIDC_BEARER_AUDIENCE = WEB_CLIENT;
    const configError = await authenticate(await sign(claims()));
    expect(configError.kind).toBe("fault");

    process.env.OIDC_BEARER_AUDIENCE = AUDIENCE;
    delete process.env.OIDC_CLIENT_SECRET;
    const incomplete = await authenticate(await sign(claims()));
    expect(incomplete.kind === "fault" && incomplete.error).toBeInstanceOf(AuthConfigError);
  });
});

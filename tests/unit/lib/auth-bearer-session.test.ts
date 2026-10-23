/**
 * getSession() with the OIDC bearer channel (src/lib/oidc-bearer.ts): a Bearer header decides alone while the channel
 * is on, is ignored while it is off, and never touches the session cookie. Under governance the access token's subject,
 * issuer and own `iat` go through storedAccountAllows() exactly as a cookie session's do.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { recordGovernanceSnapshot, resetGovernanceState } from "@/lib/governance/state";
import * as localAccounts from "@/lib/local-accounts";
import { logger } from "@/lib/logger";
import { resetBearerKeys } from "@/lib/oidc-bearer";
import { grantedSnapshot } from "../../helpers/governance/granted-snapshot";
import {
  BEARER_ISSUER,
  BEARER_SUBJECT,
  bearerClaims,
  nowSeconds,
  provider,
  restoreBearerEnv,
  signBearer,
  stubIdentityProvider,
  useBearerEnv,
} from "../../helpers/oidc-bearer-provider";

let cookieStore: Record<string, { value: string } | undefined> = {};
let cookieWrites: string[] = [];
let requestHeaders: Record<string, string> = {};

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore[name],
    set: (name: string) => cookieWrites.push(`set ${name}`),
    delete: (cookie: string | { name: string }) =>
      cookieWrites.push(`delete ${typeof cookie === "string" ? cookie : cookie.name}`),
  }),
  headers: async () => ({ get: (name: string) => requestHeaders[name.toLowerCase()] ?? null }),
}));

const { getSession, signJWT } = await import("@/lib/auth");

const fetchSpy = stubIdentityProvider();
afterAll(() => fetchSpy.mockRestore());

let savedGovernance: string | undefined;

beforeEach(async () => {
  useBearerEnv();
  resetBearerKeys();
  savedGovernance = process.env.GOVERNANCE_SOURCE;
  delete process.env.GOVERNANCE_SOURCE;
  cookieWrites = [];
  requestHeaders = {};
  // A valid cookie session for someone else, so every case shows which credential decided.
  cookieStore = { "auth-token": { value: await signJWT({ role: "admin", username: "cookie@example.test" }) } };
});

afterEach(() => {
  restoreBearerEnv();
  resetGovernanceState();
  if (savedGovernance === undefined) delete process.env.GOVERNANCE_SOURCE;
  else process.env.GOVERNANCE_SOURCE = savedGovernance;
});

describe("getSession() and a bearer access token", () => {
  test("answers the access token's session, marked bearer, and touches no cookie", async () => {
    requestHeaders.authorization = `Bearer ${await signBearer()}`;

    const session = await getSession();

    expect(session).toMatchObject({
      role: "user",
      username: "ada@example.test",
      idpSubject: BEARER_SUBJECT,
      idpIssuer: BEARER_ISSUER,
      channel: "bearer",
    });
    expect(cookieWrites).toEqual([]);
  });

  test("a refused bearer is no session even with a valid cookie, and the cookie is left alone", async () => {
    requestHeaders.authorization = `Bearer ${await signBearer(bearerClaims({ exp: nowSeconds() - 120 }))}`;

    expect(await getSession()).toBeNull();
    expect(cookieWrites).toEqual([]);
  });

  test("a provider that cannot be reached is no session, logged as an error", async () => {
    provider.down = true;
    requestHeaders.authorization = `Bearer ${await signBearer()}`;
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(await getSession()).toBeNull();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
    expect(cookieWrites).toEqual([]);
  });

  test("an account registry that cannot be read refuses the session and leaves the cookie alone", async () => {
    requestHeaders.authorization = `Bearer ${await signBearer()}`;
    const allowsSpy = spyOn(localAccounts, "storedAccountAllows").mockRejectedValue(new Error("registry unreadable"));
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(await getSession()).toBeNull();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      allowsSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(cookieWrites).toEqual([]);
  });

  test("with the channel off the header is ignored and the cookie decides, as before", async () => {
    delete process.env.OIDC_BEARER_AUDIENCE;
    requestHeaders.authorization = "Bearer whatever-a-proxy-forwarded";

    expect(await getSession()).toMatchObject({ username: "cookie@example.test" });
    expect(provider.discoveryCalls).toBe(0);
  });

  test("a Basic header is ignored with the channel on, so the cookie decides", async () => {
    requestHeaders.authorization = "Basic dXNlcjpwYXNz";

    expect(await getSession()).toMatchObject({ username: "cookie@example.test" });
  });
});

describe("getSession() and a bearer access token under governance", () => {
  beforeEach(() => {
    process.env.GOVERNANCE_SOURCE = "postgres";
  });

  function revoke(subject: string, at: number): void {
    recordGovernanceSnapshot({
      ...grantedSnapshot([], [], Date.now()),
      revocations: new Map([[subject, at]]),
    });
  }

  test("an access token issued before its subject's revoked_before is refused", async () => {
    revoke(BEARER_SUBJECT, Date.now());
    requestHeaders.authorization = `Bearer ${await signBearer(bearerClaims({ iat: nowSeconds() - 60 }))}`;

    expect(await getSession()).toBeNull();
    expect(cookieWrites).toEqual([]);
  });

  test("an access token issued after revoked_before is accepted", async () => {
    revoke(BEARER_SUBJECT, Date.now() - 120_000);
    requestHeaders.authorization = `Bearer ${await signBearer(bearerClaims({ iat: nowSeconds() - 5 }))}`;

    expect(await getSession()).toMatchObject({ idpSubject: BEARER_SUBJECT, channel: "bearer" });
  });
});

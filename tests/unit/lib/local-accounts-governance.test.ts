/**
 * The governed sign-in rule (spec 5.2, docs/GOVERNANCE.md): under governance a session speaks for someone only when the
 * OIDC callback minted it for the identity provider at OIDC_ISSUER. That callback is the only sign-in that writes
 * idpSubject and idpIssuer, so an env password, passkey or launch session, an OIDC session whose subject is empty and
 * one minted for another issuer are refused, and getSession() then clears the cookie.
 *
 * `storedAccountAllows()` is the check getSession() and the MCP token check consult on every request, so it carries
 * the rule, and `governedIdentityAccepted()` is the rule itself, which the OIDC callback applies to the ID token. Without
 * governance `storedAccountAllows()` keeps today's answers, which the last cases pin.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UserPayload } from "@/lib/auth";
import { governedIdentityAccepted, storedAccountAllows } from "@/lib/local-accounts";
import { closeStorageProvider } from "@/lib/storage/factory";

const ISSUER = "https://idp.example/realms/libredb";

const KEYS = [
  "GOVERNANCE_SOURCE",
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "OIDC_ISSUER",
  "STORAGE_PROVIDER",
  "STORAGE_POSTGRES_URL",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.GOVERNANCE_SOURCE = "postgres";
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
  process.env.OIDC_ISSUER = ISSUER;
  delete process.env.STORAGE_PROVIDER;
  delete process.env.STORAGE_POSTGRES_URL;
});

afterEach(async () => {
  await closeStorageProvider();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A session the OIDC callback mints: the username for display, the provider's subject and issuer for identity. */
function oidcSession(overrides: Partial<UserPayload> = {}): UserPayload {
  return { role: "user", username: "alice@example.com", idpSubject: "kc-user-1", idpIssuer: ISSUER, ...overrides };
}

describe("storedAccountAllows under governance", () => {
  test("governance refuses an OIDC session without idpSubject", async () => {
    expect(await storedAccountAllows({ role: "user", username: "alice@example.com", idpIssuer: ISSUER })).toBe(false);
    // openid-client accepts `sub: ""`, so an empty subject counts as missing.
    expect(await storedAccountAllows(oidcSession({ idpSubject: "" }))).toBe(false);
  });

  test("governance refuses a session whose idpIssuer differs from OIDC_ISSUER", async () => {
    expect(await storedAccountAllows(oidcSession({ idpIssuer: "https://other.example/realms/libredb" }))).toBe(false);
    expect(await storedAccountAllows(oidcSession({ idpIssuer: "https://idp.example/realms/other" }))).toBe(false);
    expect(await storedAccountAllows({ role: "user", username: "alice@example.com", idpSubject: "kc-user-1" })).toBe(
      false,
    );
    expect(await storedAccountAllows(oidcSession({ idpIssuer: "not a url" }))).toBe(false);
  });

  test("governance accepts a session from OIDC_ISSUER, comparing normalized URLs with one trailing slash ignored", async () => {
    expect(await storedAccountAllows(oidcSession())).toBe(true);
    expect(await storedAccountAllows(oidcSession({ role: "admin" }))).toBe(true);
    // The ID token's iss and OIDC_ISSUER may differ by one trailing slash, and the URL parser folds the host's case
    // and the default port.
    process.env.OIDC_ISSUER = `${ISSUER}/`;
    expect(await storedAccountAllows(oidcSession())).toBe(true);
    expect(await storedAccountAllows(oidcSession({ idpIssuer: "https://IDP.example:443/realms/libredb/" }))).toBe(true);
    // A bare-host issuer such as Auth0's ends in a slash that OIDC_ISSUER may leave out.
    process.env.OIDC_ISSUER = "https://tenant.auth0.example";
    expect(await storedAccountAllows(oidcSession({ idpIssuer: "https://tenant.auth0.example/" }))).toBe(true);
  });

  test("governance ignores only one trailing slash and never a path segment", async () => {
    process.env.OIDC_ISSUER = `${ISSUER}//`;
    expect(await storedAccountAllows(oidcSession())).toBe(false);
    process.env.OIDC_ISSUER = "https://idp.example/realms";
    expect(await storedAccountAllows(oidcSession())).toBe(false);
  });

  test("governance refuses every session while OIDC_ISSUER is unset or not a URL", async () => {
    delete process.env.OIDC_ISSUER;
    expect(await storedAccountAllows(oidcSession())).toBe(false);
    process.env.OIDC_ISSUER = "";
    expect(await storedAccountAllows(oidcSession())).toBe(false);
    process.env.OIDC_ISSUER = "idp.example/realms/libredb";
    expect(await storedAccountAllows(oidcSession({ idpIssuer: "idp.example/realms/libredb" }))).toBe(false);
  });

  test("governance refuses password, passkey, launch and MCP sessions without opening the account store", async () => {
    // A postgres store with no URL throws the moment it is opened, so reaching the store would fail differently here.
    process.env.STORAGE_PROVIDER = "postgres";
    // An env password session carries the role and the username only.
    expect(await storedAccountAllows({ role: "admin", username: "admin@libredb.org" })).toBe(false);
    // A store password, passkey or launch session, and the owner an MCP token names, add the session version.
    expect(await storedAccountAllows({ role: "user", username: "member@example.com", sessionVersion: 3 })).toBe(false);
  });

  test("an invalid GOVERNANCE_SOURCE counts as governance and refuses a session without idpSubject", async () => {
    process.env.GOVERNANCE_SOURCE = "postgress";
    expect(await storedAccountAllows({ role: "admin", username: "admin@libredb.org" })).toBe(false);
    expect(await storedAccountAllows(oidcSession())).toBe(true);
  });

  test("governance applies the rule whatever NEXT_PUBLIC_AUTH_PROVIDER says, so a bypassed boot check opens nothing", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    process.env.STORAGE_PROVIDER = "postgres";
    expect(await storedAccountAllows({ role: "admin", username: "admin@libredb.org", sessionVersion: 1 })).toBe(false);
    expect(await storedAccountAllows(oidcSession())).toBe(true);
  });
});

describe("governedIdentityAccepted", () => {
  test("accepts a non-empty subject from OIDC_ISSUER and nothing else, whatever the claims' types", () => {
    expect(governedIdentityAccepted("kc-user-1", ISSUER)).toBe(true);
    expect(governedIdentityAccepted("", ISSUER)).toBe(false);
    expect(governedIdentityAccepted(42, ISSUER)).toBe(false);
    expect(governedIdentityAccepted("kc-user-1", undefined)).toBe(false);
    // What openid-client accepts from Microsoft Entra ID's common endpoint: each user's own tenant as the issuer.
    expect(governedIdentityAccepted("kc-user-1", "https://login.microsoftonline.com/9188040d/v2.0")).toBe(false);
  });
});

describe("storedAccountAllows without governance", () => {
  beforeEach(() => {
    delete process.env.GOVERNANCE_SOURCE;
  });

  test("an OIDC session without the identity provider claims still passes", async () => {
    expect(await storedAccountAllows({ role: "admin", username: "alice@example.com" })).toBe(true);
    expect(await storedAccountAllows(oidcSession({ idpSubject: "", idpIssuer: "https://other.example/" }))).toBe(true);
  });

  test("an empty GOVERNANCE_SOURCE leaves governance off", async () => {
    process.env.GOVERNANCE_SOURCE = "";
    expect(await storedAccountAllows({ role: "user", username: "alice@example.com" })).toBe(true);
  });

  test("a password session with STORAGE_PROVIDER=local still passes without a store", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    expect(await storedAccountAllows({ role: "admin", username: "admin@libredb.org" })).toBe(true);
  });
});

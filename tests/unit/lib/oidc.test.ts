import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { AuthConfigError } from "@/lib/auth-errors";
import { SignJWT, decodeProtectedHeader, decodeJwt, jwtVerify } from "jose";
import { derivedSigningKey, getJwtSecret } from "@/lib/config/auth-env";

// ─── Mock openid-client before importing oidc.ts ────────────────────────────

const mockDiscoveryFn = mock(async () => "mock-oidc-config" as unknown);
const mockRandomPKCECodeVerifier = mock(() => "mock-code-verifier");
const mockCalculatePKCECodeChallenge = mock(async () => "mock-code-challenge");
const mockRandomState = mock(() => "mock-state-value");
const mockRandomNonce = mock(() => "mock-nonce-value");
const mockBuildAuthorizationUrl = mock(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (_config: unknown, _params: Record<string, string>) =>
    new URL("https://provider.com/authorize?state=mock-state-value"),
);
const mockBuildEndSessionUrl = mock(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (_config: unknown, _params: Record<string, string>) => new URL("https://provider.com/logout"),
);
const mockClaims = mock(() => ({ sub: "user-123", email: "user@test.com" }) as Record<string, unknown> | undefined);
const mockAuthorizationCodeGrant = mock(async () => ({
  claims: mockClaims,
  id_token: "raw.id.token" as string | undefined,
}));
const mockClientSecretPost = mock(() => "client-auth-method");

mock.module("openid-client", () => ({
  discovery: mockDiscoveryFn,
  randomPKCECodeVerifier: mockRandomPKCECodeVerifier,
  calculatePKCECodeChallenge: mockCalculatePKCECodeChallenge,
  randomState: mockRandomState,
  randomNonce: mockRandomNonce,
  buildAuthorizationUrl: mockBuildAuthorizationUrl,
  buildEndSessionUrl: mockBuildEndSessionUrl,
  authorizationCodeGrant: mockAuthorizationCodeGrant,
  ClientSecretPost: mockClientSecretPost,
}));

// ─── Dynamic import after mocking ───────────────────────────────────────────

const {
  mapOIDCRole,
  mapOIDCClaimRoles,
  readRoleClaimValues,
  getOIDCConfig,
  encryptState,
  decryptState,
  buildLogoutUrl,
  discoverProvider,
  generateAuthUrl,
  exchangeCode,
  resetDiscoveryCache,
  getPublicOrigin,
} = await import("@/lib/oidc");
import type { OIDCState } from "@/lib/oidc";

// ─── mapOIDCRole ────────────────────────────────────────────────────────────

describe("mapOIDCRole", () => {
  test('returns "user" when roleClaim is empty', () => {
    expect(mapOIDCRole({ roles: "admin" }, "", ["admin"])).toBe("user");
  });

  test('returns "user" when claim is missing', () => {
    expect(mapOIDCRole({}, "roles", ["admin"])).toBe("user");
  });

  test('returns "admin" for flat string claim match', () => {
    expect(mapOIDCRole({ role: "admin" }, "role", ["admin"])).toBe("admin");
  });

  test('returns "user" for flat string claim no match', () => {
    expect(mapOIDCRole({ role: "viewer" }, "role", ["admin"])).toBe("user");
  });

  test('returns "admin" for array claim match', () => {
    const claims = { roles: ["viewer", "admin", "editor"] };
    expect(mapOIDCRole(claims, "roles", ["admin"])).toBe("admin");
  });

  test('returns "user" for array claim no match', () => {
    const claims = { roles: ["viewer", "editor"] };
    expect(mapOIDCRole(claims, "roles", ["admin"])).toBe("user");
  });

  test("supports dot-notation for nested claims", () => {
    const claims = { realm_access: { roles: ["admin"] } };
    expect(mapOIDCRole(claims, "realm_access.roles", ["admin"])).toBe("admin");
  });

  test('returns "user" for nested claim path not found', () => {
    const claims = { realm_access: {} };
    expect(mapOIDCRole(claims, "realm_access.roles", ["admin"])).toBe("user");
  });

  test('returns "user" when nested path traverses non-object', () => {
    const claims = { realm_access: "string" };
    expect(mapOIDCRole(claims, "realm_access.roles", ["admin"])).toBe("user");
  });

  test("case-insensitive matching", () => {
    expect(mapOIDCRole({ role: "Admin" }, "role", ["admin"])).toBe("admin");
    expect(mapOIDCRole({ role: "ADMIN" }, "role", ["admin"])).toBe("admin");
  });

  test("supports multiple admin role values", () => {
    expect(mapOIDCRole({ role: "superadmin" }, "role", ["admin", "superadmin"])).toBe("admin");
    expect(mapOIDCRole({ role: "admin" }, "role", ["admin", "superadmin"])).toBe("admin");
    expect(mapOIDCRole({ role: "viewer" }, "role", ["admin", "superadmin"])).toBe("user");
  });

  test("handles null value in claim path", () => {
    const claims = { realm_access: null };
    expect(mapOIDCRole(claims, "realm_access.roles", ["admin"])).toBe("user");
  });

  // OIDC_USER_ROLES arrives as the fourth argument. Left out, or empty, it is the rule above: an
  // account that matches no admin role is a user, and nobody is ever refused.
  test("three-argument calls map every non-admin to user and never to null", () => {
    const unmatched: [Record<string, unknown>, string][] = [
      [{ roles: "admin" }, ""],
      [{}, "roles"],
      [{ role: "viewer" }, "role"],
      [{ roles: ["viewer", "editor"] }, "roles"],
      [{ realm_access: {} }, "realm_access.roles"],
      [{ realm_access: "string" }, "realm_access.roles"],
      [{ realm_access: null }, "realm_access.roles"],
      [{ libredb_roles: [] }, "libredb_roles"],
    ];
    for (const [claims, roleClaim] of unmatched) {
      expect(mapOIDCRole(claims, roleClaim, ["admin"])).toBe("user");
      expect(mapOIDCRole(claims, roleClaim, ["admin"], [])).toBe("user");
    }
    expect(mapOIDCRole({ roles: ["viewer", "admin"] }, "roles", ["admin"])).toBe("admin");
    expect(mapOIDCRole({ roles: ["viewer", "admin"] }, "roles", ["admin"], [])).toBe("admin");
  });

  test("with userRoles [user], a claim holding only [viewer] maps to null", () => {
    expect(mapOIDCRole({ libredb_roles: ["viewer"] }, "libredb_roles", ["admin"], ["user"])).toBeNull();
  });

  test("with userRoles [user], a claim holding [user] maps to user", () => {
    expect(mapOIDCRole({ libredb_roles: ["user"] }, "libredb_roles", ["admin"], ["user"])).toBe("user");
    expect(mapOIDCRole({ libredb_roles: "user" }, "libredb_roles", ["admin"], ["user"])).toBe("user");
  });

  test("admin wins when the claim holds both the admin and the user role", () => {
    expect(mapOIDCRole({ libredb_roles: ["user", "admin"] }, "libredb_roles", ["admin"], ["user"])).toBe("admin");
    expect(mapOIDCRole({ libredb_roles: ["admin", "user"] }, "libredb_roles", ["admin"], ["user"])).toBe("admin");
  });

  test("an admin match needs no user role", () => {
    expect(mapOIDCRole({ libredb_roles: ["admin"] }, "libredb_roles", ["admin"], ["user"])).toBe("admin");
  });

  test("user roles compare case-insensitively, as admin roles do", () => {
    expect(mapOIDCRole({ libredb_roles: ["USER"] }, "libredb_roles", ["admin"], ["User"])).toBe("user");
    expect(mapOIDCRole({ role: "Analyst" }, "role", ["admin"], ["user", "analyst"])).toBe("user");
  });

  test("with userRoles set, a claim that is missing, empty or not reachable maps to null", () => {
    expect(mapOIDCRole({}, "libredb_roles", ["admin"], ["user"])).toBeNull();
    expect(mapOIDCRole({ libredb_roles: [] }, "libredb_roles", ["admin"], ["user"])).toBeNull();
    expect(mapOIDCRole({ realm_access: {} }, "realm_access.roles", ["admin"], ["user"])).toBeNull();
    expect(mapOIDCRole({ realm_access: "string" }, "realm_access.roles", ["admin"], ["user"])).toBeNull();
    expect(mapOIDCRole({ realm_access: null }, "realm_access.roles", ["admin"], ["user"])).toBeNull();
  });

  test("maps admin from the Auth0 and Zitadel role claims of docs/OIDC.md", () => {
    expect(mapOIDCRole({ "https://libredb.org/roles": ["admin"] }, "https://libredb.org/roles", ["admin"])).toBe(
      "admin",
    );
    const zitadel = { "urn:zitadel:iam:org:project:roles": { admin: { "1234": "acme.zitadel.cloud" } } };
    expect(mapOIDCRole(zitadel, "urn:zitadel:iam:org:project:roles", ["admin"], ["user"])).toBe("admin");
  });

  test("with userRoles set and no role claim configured, no account maps to a role", () => {
    // getOIDCConfig() refuses this configuration; the pure function still answers it consistently.
    expect(mapOIDCRole({ roles: ["user"] }, "", ["admin"], ["user"])).toBeNull();
  });
});

// ─── readRoleClaimValues ───────────────────────────────────────────────────

describe("readRoleClaimValues", () => {
  test("returns empty array when roleClaim is empty", () => {
    expect(readRoleClaimValues({ roles: "admin" }, "")).toEqual([]);
  });

  test("returns empty array when claim is missing or null", () => {
    expect(readRoleClaimValues({}, "roles")).toEqual([]);
    expect(readRoleClaimValues({ roles: null }, "roles")).toEqual([]);
  });

  test("returns single string in an array for flat string claim", () => {
    expect(readRoleClaimValues({ role: "admin" }, "role")).toEqual(["admin"]);
  });

  test("returns array of strings for array claim", () => {
    expect(readRoleClaimValues({ roles: ["admin", "user"] }, "roles")).toEqual(["admin", "user"]);
  });

  test("supports dot-notation for nested claims", () => {
    expect(readRoleClaimValues({ realm_access: { roles: ["admin"] } }, "realm_access.roles")).toEqual(["admin"]);
  });

  test("returns empty array when nested path encounters non-object or null", () => {
    expect(readRoleClaimValues({ realm_access: "string" }, "realm_access.roles")).toEqual([]);
    expect(readRoleClaimValues({ realm_access: null }, "realm_access.roles")).toEqual([]);
    expect(readRoleClaimValues({ realm_access: {} }, "realm_access.roles")).toEqual([]);
  });

  test("reads a top-level claim whose name holds dots whole, as Auth0's namespaced claims are", () => {
    expect(readRoleClaimValues({ "https://libredb.org/roles": ["admin"] }, "https://libredb.org/roles")).toEqual([
      "admin",
    ]);
    expect(readRoleClaimValues({ "realm_access.roles": ["user"] }, "realm_access.roles")).toEqual(["user"]);
  });

  test("takes the keys of an object claim as the role names, as Zitadel's roles claim is", () => {
    const claims = { "urn:zitadel:iam:org:project:roles": { admin: { "1234": "acme.zitadel.cloud" }, viewer: {} } };
    expect(readRoleClaimValues(claims, "urn:zitadel:iam:org:project:roles")).toEqual(["admin", "viewer"]);
  });
});

// ─── mapOIDCClaimRoles ─────────────────────────────────────────────────────

describe("mapOIDCClaimRoles", () => {
  test("returns empty roles and overflow false when prefix is empty", () => {
    expect(mapOIDCClaimRoles(["team-billing"], "")).toEqual({ roles: [], overflow: false });
  });

  test("extracts prefixed claims, keeps prefix and exact casing as IdP sent it", () => {
    const values = ["team-Billing", "other-role", "team-analytics"];
    const result = mapOIDCClaimRoles(values, "team-");
    expect(result.overflow).toBe(false);
    expect(result.roles).toEqual(["team-Billing", "team-analytics"]);
  });

  test("reads custom roles from the Zitadel object claim by its role names", () => {
    const claims = { "urn:zitadel:iam:org:project:roles": { "team-ops": { "1234": "acme" }, admin: {} } };
    expect(mapOIDCClaimRoles(claims, "team-", "urn:zitadel:iam:org:project:roles")).toEqual({
      roles: ["team-ops"],
      overflow: false,
    });
  });

  test("matches prefix case-sensitively", () => {
    const values = ["team-billing", "Team-billing", "TEAM-analytics"];
    const result = mapOIDCClaimRoles(values, "team-");
    expect(result.overflow).toBe(false);
    expect(result.roles).toEqual(["team-billing"]);
  });

  test("ignores values without the prefix", () => {
    const values = ["admin", "user", "billing", "random-role"];
    const result = mapOIDCClaimRoles(values, "team-");
    expect(result.overflow).toBe(false);
    expect(result.roles).toEqual([]);
  });

  test("reserved names (*, admin, user) never become claim roles even if prefix matches them", () => {
    // Prefix "a" matches "admin", "Admin", "ADMIN"
    expect(mapOIDCClaimRoles(["admin", "Admin", "ADMIN", "analyst"], "a")).toEqual({
      roles: ["analyst"],
      overflow: false,
    });

    // Prefix "u" matches "user", "User", "USER"
    expect(mapOIDCClaimRoles(["user", "User", "USER", "ux"], "u")).toEqual({
      roles: ["ux"],
      overflow: false,
    });

    // Prefix "*" matches "*"
    expect(mapOIDCClaimRoles(["*"], "*")).toEqual({
      roles: [],
      overflow: false,
    });

    // Prefix "admin-" on a non-reserved role like "admin-ops" is kept
    expect(mapOIDCClaimRoles(["admin-ops", "admin"], "admin")).toEqual({
      roles: ["admin-ops"],
      overflow: false,
    });
  });

  test("deduplicates and sorts claim roles lexicographically", () => {
    const values = ["team-zeta", "team-alpha", "team-beta", "team-alpha", "team-beta"];
    const result = mapOIDCClaimRoles(values, "team-");
    expect(result.overflow).toBe(false);
    expect(result.roles).toEqual(["team-alpha", "team-beta", "team-zeta"]);
  });

  test("accepts up to 20 claim roles without overflow", () => {
    const values = Array.from({ length: 20 }, (_, i) => `team-${String(i).padStart(2, "0")}`);
    const result = mapOIDCClaimRoles(values, "team-");
    expect(result.overflow).toBe(false);
    expect(result.roles).toHaveLength(20);
  });

  test("refuses with overflow when more than 20 claim roles match", () => {
    const values = Array.from({ length: 21 }, (_, i) => `team-${String(i).padStart(2, "0")}`);
    const result = mapOIDCClaimRoles(values, "team-");
    expect(result.overflow).toBe(true);
    expect(result.roles).toEqual([]);
  });

  test("non-matching values do not count toward the 20 role limit", () => {
    const matching = Array.from({ length: 20 }, (_, i) => `team-${String(i).padStart(2, "0")}`);
    const ignored = Array.from({ length: 50 }, (_, i) => `other-${i}`);
    const result = mapOIDCClaimRoles([...matching, ...ignored], "team-");
    expect(result.overflow).toBe(false);
    expect(result.roles).toHaveLength(20);
  });

  test("accepts claim roles up to 64 bytes in UTF-8 length", () => {
    const exact64 = "team-" + "a".repeat(59);
    expect(Buffer.byteLength(exact64, "utf8")).toBe(64);
    const result = mapOIDCClaimRoles([exact64], "team-");
    expect(result.overflow).toBe(false);
    expect(result.roles).toEqual([exact64]);
  });

  test("accepts multi-byte claim role within 64 UTF-8 bytes", () => {
    // "team-" is 5 bytes. 29 2-byte characters is 58 bytes. 5 + 58 = 63 bytes <= 64.
    const multiByteRole = "team-" + "ü".repeat(29);
    expect(Buffer.byteLength(multiByteRole, "utf8")).toBe(63);
    const result = mapOIDCClaimRoles([multiByteRole], "team-");
    expect(result.overflow).toBe(false);
    expect(result.roles).toEqual([multiByteRole]);
  });

  test("refuses with overflow when any claim role exceeds 64 bytes in UTF-8 (including 64 non-ASCII characters)", () => {
    const char65 = "team-" + "a".repeat(60);
    expect(Buffer.byteLength(char65, "utf8")).toBe(65);
    const result = mapOIDCClaimRoles(["team-valid", char65], "team-");
    expect(result.overflow).toBe(true);
    expect(result.roles).toEqual([]);

    // 64 non-ASCII characters (e.g. 5 ASCII bytes + 59 2-byte chars = 123 bytes, char length = 64)
    const nonAscii64Chars = "team-" + "ü".repeat(59);
    expect(nonAscii64Chars.length).toBe(64);
    expect(Buffer.byteLength(nonAscii64Chars, "utf8")).toBe(123);
    const resultMultiByte = mapOIDCClaimRoles([nonAscii64Chars], "team-");
    expect(resultMultiByte.overflow).toBe(true);
    expect(resultMultiByte.roles).toEqual([]);
  });

  test("non-matching values longer than 64 characters do not trigger overflow", () => {
    const longIgnored = "other-" + "b".repeat(100);
    const result = mapOIDCClaimRoles(["team-billing", longIgnored], "team-");
    expect(result.overflow).toBe(false);
    expect(result.roles).toEqual(["team-billing"]);
  });

  test("extracts from nested claim paths via object input", () => {
    const claims = { realm_access: { roles: ["team-finance", "team-dev", "admin"] } };
    const result = mapOIDCClaimRoles(claims, "team-", "realm_access.roles");
    expect(result.overflow).toBe(false);
    expect(result.roles).toEqual(["team-dev", "team-finance"]);
  });

  test("extracts from flat string claim via object input", () => {
    const claims = { custom_role: "team-single" };
    const result = mapOIDCClaimRoles(claims, "team-", "custom_role");
    expect(result.overflow).toBe(false);
    expect(result.roles).toEqual(["team-single"]);
  });
});

// ─── getOIDCConfig ──────────────────────────────────────────────────────────

describe("getOIDCConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OIDC_ISSUER = "https://example.auth0.com";
    process.env.OIDC_CLIENT_ID = "test-client-id";
    process.env.OIDC_CLIENT_SECRET = "test-client-secret";
    process.env.OIDC_SCOPE = "";
    process.env.OIDC_ROLE_CLAIM = "";
    process.env.OIDC_ADMIN_ROLES = "";
    process.env.OIDC_USER_ROLES = "";
    delete process.env.OIDC_PROMPT;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    if (originalEnv.OIDC_PROMPT === undefined) delete process.env.OIDC_PROMPT;
    if (originalEnv.OIDC_USER_ROLES === undefined) delete process.env.OIDC_USER_ROLES;
  });

  test("returns config with all required fields", () => {
    const config = getOIDCConfig();
    expect(config.issuer).toBe("https://example.auth0.com");
    expect(config.clientId).toBe("test-client-id");
    expect(config.clientSecret).toBe("test-client-secret");
  });

  test("uses default scope when not set", () => {
    const config = getOIDCConfig();
    expect(config.scope).toBe("openid profile email");
  });

  test("uses custom scope when set", () => {
    process.env.OIDC_SCOPE = "openid email";
    const config = getOIDCConfig();
    expect(config.scope).toBe("openid email");
  });

  test("parses admin roles from comma-separated string", () => {
    process.env.OIDC_ADMIN_ROLES = "admin, superadmin, root";
    const config = getOIDCConfig();
    expect(config.adminRoles).toEqual(["admin", "superadmin", "root"]);
  });

  test('defaults admin roles to ["admin"]', () => {
    const config = getOIDCConfig();
    expect(config.adminRoles).toEqual(["admin"]);
  });

  test("parses user roles from a comma list, trimmed and without empty entries", () => {
    process.env.OIDC_ROLE_CLAIM = "libredb_roles";
    process.env.OIDC_USER_ROLES = " user, ,Analyst ,";
    expect(getOIDCConfig().userRoles).toEqual(["user", "Analyst"]);
  });

  test("defaults user roles to an empty list", () => {
    expect(getOIDCConfig().userRoles).toEqual([]);
    delete process.env.OIDC_USER_ROLES;
    expect(getOIDCConfig().userRoles).toEqual([]);
  });

  test("throws AuthConfigError when OIDC_USER_ROLES is set while OIDC_ROLE_CLAIM is empty", () => {
    // Without a claim to read, every account would be refused one sign-in at a time as oidc_no_role;
    // the login route reports it once, as the configuration error it is.
    process.env.OIDC_USER_ROLES = "user";
    expect(() => getOIDCConfig()).toThrow(AuthConfigError);
    expect(() => getOIDCConfig()).toThrow("OIDC_ROLE_CLAIM");
    process.env.OIDC_ROLE_CLAIM = "libredb_roles";
    expect(getOIDCConfig().userRoles).toEqual(["user"]);
  });

  test("throws AuthConfigError when OIDC_ROLE_PREFIX is set while OIDC_ROLE_CLAIM is empty", () => {
    process.env.OIDC_ROLE_PREFIX = "team-";
    delete process.env.OIDC_ROLE_CLAIM;
    expect(() => getOIDCConfig()).toThrow(AuthConfigError);
    expect(() => getOIDCConfig()).toThrow("OIDC_ROLE_CLAIM");
    process.env.OIDC_ROLE_CLAIM = "libredb_roles";
    expect(getOIDCConfig().rolePrefix).toBe("team-");
  });

  test("returns rolePrefix undefined when OIDC_ROLE_PREFIX is unset or empty", () => {
    delete process.env.OIDC_ROLE_PREFIX;
    expect(getOIDCConfig().rolePrefix).toBeUndefined();
    process.env.OIDC_ROLE_PREFIX = "";
    expect(getOIDCConfig().rolePrefix).toBeUndefined();
  });

  test("a user role list of only commas and spaces counts as unset", () => {
    process.env.OIDC_USER_ROLES = " , ,";
    expect(getOIDCConfig().userRoles).toEqual([]);
  });

  test("throws when OIDC_ISSUER is missing", () => {
    delete process.env.OIDC_ISSUER;
    expect(() => getOIDCConfig()).toThrow("OIDC_ISSUER");
  });

  test("throws when OIDC_CLIENT_ID is missing", () => {
    delete process.env.OIDC_CLIENT_ID;
    expect(() => getOIDCConfig()).toThrow("OIDC_CLIENT_ID");
  });

  test("throws AuthConfigError when OIDC_ISSUER is not an https URL", () => {
    // openid-client refuses a plain-http issuer before sending anything, and a value that does
    // not parse (or parses with a bogus scheme, as the scheme-less form does) would fail the same
    // way inside discovery. All of these are the operator's .env, so they classify as
    // configuration on the login route rather than as a provider that did not answer.
    for (const issuer of [
      "http://localhost:8080/realms/dev",
      "localhost:8080/realms/dev",
      "example.com/realms/dev",
      "https://",
    ]) {
      process.env.OIDC_ISSUER = issuer;
      expect(() => getOIDCConfig()).toThrow(AuthConfigError);
      expect(() => getOIDCConfig()).toThrow("https://");
    }
  });

  test("accepts an issuer whose scheme is upper-case", () => {
    // Schemes are case-insensitive to the URL parser and to openid-client; the guard must not be
    // stricter than the library it fronts.
    process.env.OIDC_ISSUER = "HTTPS://example.auth0.com";
    expect(getOIDCConfig().issuer).toBe("HTTPS://example.auth0.com");
  });

  test("throws when OIDC_CLIENT_SECRET is missing", () => {
    delete process.env.OIDC_CLIENT_SECRET;
    expect(() => getOIDCConfig()).toThrow("OIDC_CLIENT_SECRET");
  });

  test("OIDC_PROMPT unset or empty keeps prompt=login", () => {
    expect(getOIDCConfig().prompt).toBe("login");
    process.env.OIDC_PROMPT = "  ";
    expect(getOIDCConfig().prompt).toBe("login");
  });

  test("OIDC_PROMPT is trimmed and lower-cased, and the accepted values pass through", () => {
    for (const [raw, expected] of [
      [" Omit ", "omit"],
      ["LOGIN", "login"],
      ["consent", "consent"],
      ["Select_Account", "select_account"],
    ] as const) {
      process.env.OIDC_PROMPT = raw;
      expect(getOIDCConfig().prompt).toBe(expected);
    }
  });

  test("OIDC_PROMPT=none throws AuthConfigError naming the variable", () => {
    // prompt=none fails with login_required whenever the provider has no session, which is a
    // dead end rather than a sign-in, so it is refused as configuration like any unknown value.
    for (const value of ["none", "silent"]) {
      process.env.OIDC_PROMPT = value;
      expect(() => getOIDCConfig()).toThrow(AuthConfigError);
      expect(() => getOIDCConfig()).toThrow("OIDC_PROMPT must be one of login, consent, select_account, omit");
    }
  });
});

// ─── encryptState / decryptState ────────────────────────────────────────────

describe("encryptState / decryptState", () => {
  const testState: OIDCState = {
    code_verifier: "test-code-verifier-abc123",
    state: "test-state-xyz789",
    nonce: "test-nonce-def456",
  };

  // Ensure JWT_SECRET is always restored — prevents cross-test contamination
  const CRYPTO_TEST_SECRET = "oidc-crypto-test-secret-32chars!!";

  beforeEach(() => {
    process.env.JWT_SECRET = CRYPTO_TEST_SECRET;
  });

  afterEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests-32ch";
  });

  test("round-trips state correctly", async () => {
    const encrypted = await encryptState(testState);
    expect(typeof encrypted).toBe("string");
    expect(encrypted.length).toBeGreaterThan(0);

    const decrypted = await decryptState(encrypted);
    expect(decrypted.code_verifier).toBe(testState.code_verifier);
    expect(decrypted.state).toBe(testState.state);
    expect(decrypted.nonce).toBe(testState.nonce);
  });

  test("carries the return path when there is one, and adds none when there is not (#1420)", async () => {
    expect(await decryptState(await encryptState({ ...testState, return_to: "/admin" }))).toEqual({
      ...testState,
      return_to: "/admin",
    });
    expect(await decryptState(await encryptState(testState))).toEqual(testState);
  });

  test("fails to decrypt tampered token", async () => {
    const encrypted = await encryptState(testState);
    const tampered = encrypted.slice(0, -5) + "XXXXX";
    await expect(decryptState(tampered)).rejects.toThrow();
  });

  test("throws when JWT_SECRET is not set", async () => {
    delete process.env.JWT_SECRET;
    try {
      await expect(encryptState(testState)).rejects.toThrow("JWT_SECRET is required");
    } finally {
      process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests-32ch";
    }
  });

  test("decryptState throws when JWT_SECRET is not set", async () => {
    const encrypted = await encryptState(testState);
    delete process.env.JWT_SECRET;
    try {
      await expect(decryptState(encrypted)).rejects.toThrow("JWT_SECRET is required");
    } finally {
      process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests-32ch";
    }
  });

  // The state token follows the purpose-derived key convention of the other non-session tokens.
  const STATE_KEY_LABEL = "libredb.oidc.state.v1";
  const STATE_TOKEN_TYPE = "libredb-oidc-state+jwt";

  function stateJwt(typ?: string) {
    return new SignJWT({ ...testState })
      .setProtectedHeader(typ ? { alg: "HS256", typ } : { alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m");
  }

  test("the state token pins its own typ and lives five minutes", async () => {
    const encrypted = await encryptState(testState);
    expect(decodeProtectedHeader(encrypted)).toEqual({ alg: "HS256", typ: STATE_TOKEN_TYPE });
    const { iat, exp } = decodeJwt(encrypted);
    expect((exp as number) - (iat as number)).toBe(300);
  });

  test("the state token is signed with a key derived for its purpose, not the session key", async () => {
    const encrypted = await encryptState(testState);
    await expect(jwtVerify(encrypted, getJwtSecret())).rejects.toThrow();
    const { payload } = await jwtVerify(encrypted, await derivedSigningKey(STATE_KEY_LABEL));
    expect(payload.state).toBe(testState.state);
  });

  test("decryptState refuses a state token signed with the session key", async () => {
    const token = await stateJwt(STATE_TOKEN_TYPE).sign(getJwtSecret());
    await expect(decryptState(token)).rejects.toThrow();
  });

  test("decryptState refuses a state token without the pinned typ", async () => {
    const key = await derivedSigningKey(STATE_KEY_LABEL);
    await expect(decryptState(await stateJwt().sign(key))).rejects.toThrow();
    await expect(decryptState(await stateJwt("JWT").sign(key))).rejects.toThrow();
  });
});

// ─── buildLogoutUrl ──────────────────────────────────────────────────────────

describe("buildLogoutUrl", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OIDC_ISSUER = "https://libredb.eu.auth0.com";
    process.env.OIDC_CLIENT_ID = "test-client-id";
    process.env.OIDC_CLIENT_SECRET = "test-client-secret";
    mockDiscoveryFn.mockClear();
    mockBuildEndSessionUrl.mockClear();
    // mockClear() drops recorded calls but keeps whatever return value a previous test queued, so
    // the default is re-established here: otherwise a mockReturnValue set in one test silently
    // decides what a later test sees, and the suite's outcome depends on declaration order.
    mockBuildEndSessionUrl.mockReturnValue(new URL("https://provider.com/logout"));
    resetDiscoveryCache();
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    resetDiscoveryCache();
  });

  test("builds Auth0 logout URL with /v2/logout", async () => {
    const url = await buildLogoutUrl("http://localhost:3000/login");
    expect(url).not.toBeNull();
    expect(url).toContain("/v2/logout");
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain("returnTo=http%3A%2F%2Flocalhost%3A3000%2Flogin");
  });

  test("uses the discovered end-session endpoint instead of deriving one from the issuer", async () => {
    process.env.OIDC_ISSUER = "https://keycloak.example.com/realms/myrealm";
    const returnTo = "http://localhost:3000/login";
    // Deliberately a BARE endpoint, with no query string and an origin that is not the issuer's:
    // the assertions below then describe what buildLogoutUrl() did, not what this fixture spelled out.
    mockBuildEndSessionUrl.mockReturnValue(new URL("https://logout.example.net/custom/end-session"));

    const url = await buildLogoutUrl(returnTo);
    expect(url).not.toBeNull();
    // The endpoint comes from Discovery, not from the issuer: neither the issuer's origin nor its
    // /realms/myrealm path may appear in the result. That is the regression this test exists for.
    const parsed = new URL(url!);
    expect(parsed.origin).toBe("https://logout.example.net");
    expect(parsed.pathname).toBe("/custom/end-session");
    // The only logout parameter this module owns. `client_id` is NOT asserted on the URL: the real
    // buildEndSessionUrl() injects it (openid-client build/index.js sets it when absent), and that
    // function is mocked here — asserting it would only re-assert the mock's own output.
    expect(mockBuildEndSessionUrl).toHaveBeenCalledWith("mock-oidc-config", {
      post_logout_redirect_uri: returnTo,
    });
  });

  test("returns null when the provider does not advertise an end-session endpoint", async () => {
    process.env.OIDC_ISSUER = "https://provider.example.com/tenant";
    mockBuildEndSessionUrl.mockImplementationOnce(() => {
      throw new Error("authorization server metadata does not contain an end_session_endpoint");
    });

    const url = await buildLogoutUrl("http://localhost:3000/login");

    expect(url).toBeNull();
  });

  test("builds Zitadel logout URL", async () => {
    process.env.OIDC_ISSUER = "https://my-instance.zitadel.cloud";
    process.env.OIDC_ROLE_CLAIM = "urn:zitadel:iam:org:project:roles";
    const url = await buildLogoutUrl("http://localhost:3000/login");
    expect(url).not.toBeNull();
    expect(url).toContain("/oidc/v1/end_session");
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain("post_logout_redirect_uri=");
  });

  test("returns null when OIDC config is missing", async () => {
    delete process.env.OIDC_ISSUER;
    const url = await buildLogoutUrl("http://localhost:3000/login");
    expect(url).toBeNull();
  });

  test("passes id_token_hint to the discovered end-session endpoint", async () => {
    process.env.OIDC_ISSUER = "https://keycloak.example.com/realms/myrealm";
    // The Zitadel test above leaves its role claim behind, which would select the Zitadel path.
    delete process.env.OIDC_ROLE_CLAIM;

    await buildLogoutUrl("http://localhost:3000/login", "raw.id.token");

    expect(mockBuildEndSessionUrl).toHaveBeenCalledWith("mock-oidc-config", {
      post_logout_redirect_uri: "http://localhost:3000/login",
      id_token_hint: "raw.id.token",
    });
  });

  test("adds id_token_hint to the Zitadel end-session URL", async () => {
    process.env.OIDC_ISSUER = "https://my-instance.zitadel.cloud";
    process.env.OIDC_ROLE_CLAIM = "urn:zitadel:iam:org:project:roles";
    const without = await buildLogoutUrl("http://localhost:3000/login");
    const url = new URL((await buildLogoutUrl("http://localhost:3000/login", "raw.id.token"))!);

    expect(url.searchParams.get("id_token_hint")).toBe("raw.id.token");
    url.searchParams.delete("id_token_hint");
    expect(url.toString()).toBe(without!);
  });

  test("leaves the Auth0 /v2/logout URL unchanged when a hint is given", async () => {
    const without = await buildLogoutUrl("http://localhost:3000/login");
    const withHint = await buildLogoutUrl("http://localhost:3000/login", "raw.id.token");

    expect(withHint).toBe(without!);
    expect(withHint).toBe(
      "https://libredb.eu.auth0.com/v2/logout?client_id=test-client-id&returnTo=http%3A%2F%2Flocalhost%3A3000%2Flogin",
    );
  });
});

// ─── discoverProvider ────────────────────────────────────────────────────────

describe("discoverProvider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OIDC_ISSUER = "https://example.auth0.com";
    process.env.OIDC_CLIENT_ID = "test-client-id";
    process.env.OIDC_CLIENT_SECRET = "test-client-secret";
    mockDiscoveryFn.mockClear();
    mockClientSecretPost.mockClear();
    resetDiscoveryCache();
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    resetDiscoveryCache();
  });

  test("calls client.discovery with correct parameters", async () => {
    await discoverProvider();

    expect(mockDiscoveryFn).toHaveBeenCalledTimes(1);
    const args = mockDiscoveryFn.mock.calls[0] as unknown as [URL, string, string, unknown];
    expect(args[0].toString()).toBe("https://example.auth0.com/");
    expect(args[1]).toBe("test-client-id");
    expect(args[2]).toBe("test-client-secret");
  });

  test("calls ClientSecretPost with client secret", async () => {
    await discoverProvider();

    expect(mockClientSecretPost).toHaveBeenCalledWith("test-client-secret");
  });

  test("returns the discovered configuration", async () => {
    const config = await discoverProvider();
    expect(config as unknown).toBe("mock-oidc-config");
  });

  test("caches configuration on second call", async () => {
    await discoverProvider();
    await discoverProvider();

    expect(mockDiscoveryFn).toHaveBeenCalledTimes(1);
  });

  test("re-discovers after resetDiscoveryCache", async () => {
    await discoverProvider();
    resetDiscoveryCache();
    await discoverProvider();

    expect(mockDiscoveryFn).toHaveBeenCalledTimes(2);
  });

  test("uses provided oidcConfig when given", async () => {
    const customConfig = {
      issuer: "https://custom.provider.com",
      clientId: "custom-id",
      clientSecret: "custom-secret",
      scope: "openid",
      roleClaim: "",
      adminRoles: ["admin"],
      userRoles: [],
      prompt: "login" as const,
    };

    await discoverProvider(customConfig);

    const args = mockDiscoveryFn.mock.calls[0] as unknown as [URL, string, string, unknown];
    expect(args[0].toString()).toBe("https://custom.provider.com/");
    expect(args[1]).toBe("custom-id");
    expect(args[2]).toBe("custom-secret");
  });
});

// ─── generateAuthUrl ─────────────────────────────────────────────────────────

describe("generateAuthUrl", () => {
  beforeEach(() => {
    mockRandomPKCECodeVerifier.mockClear();
    mockCalculatePKCECodeChallenge.mockClear();
    mockRandomState.mockClear();
    mockRandomNonce.mockClear();
    mockBuildAuthorizationUrl.mockClear();
  });

  test("returns URL and state with PKCE values", async () => {
    const result = await generateAuthUrl(
      "mock-config" as never,
      "http://localhost:3000/callback",
      "openid profile email",
    );

    expect(result.url).toBeInstanceOf(URL);
    expect(result.state.code_verifier).toBe("mock-code-verifier");
    expect(result.state.state).toBe("mock-state-value");
    expect(result.state.nonce).toBe("mock-nonce-value");
  });

  test("calls PKCE helper functions", async () => {
    await generateAuthUrl("mock-config" as never, "http://localhost:3000/callback", "openid");

    expect(mockRandomPKCECodeVerifier).toHaveBeenCalledTimes(1);
    expect(mockCalculatePKCECodeChallenge).toHaveBeenCalledWith("mock-code-verifier");
    expect(mockRandomState).toHaveBeenCalledTimes(1);
    expect(mockRandomNonce).toHaveBeenCalledTimes(1);
  });

  test("passes correct parameters to buildAuthorizationUrl", async () => {
    await generateAuthUrl("mock-config" as never, "http://localhost:3000/callback", "openid profile");

    expect(mockBuildAuthorizationUrl).toHaveBeenCalledTimes(1);
    const [config, params] = mockBuildAuthorizationUrl.mock.calls[0];
    expect(config).toBe("mock-config");
    expect(params).toEqual({
      redirect_uri: "http://localhost:3000/callback",
      scope: "openid profile",
      code_challenge: "mock-code-challenge",
      code_challenge_method: "S256",
      state: "mock-state-value",
      nonce: "mock-nonce-value",
      prompt: "login",
    });
  });

  test("OIDC_PROMPT=omit builds an authorization URL without a prompt parameter", async () => {
    process.env.OIDC_ISSUER = "https://example.auth0.com";
    process.env.OIDC_CLIENT_ID = "test-client-id";
    process.env.OIDC_CLIENT_SECRET = "test-client-secret";
    process.env.OIDC_PROMPT = "omit";
    try {
      await generateAuthUrl("mock-config" as never, "http://localhost:3000/callback", "openid", getOIDCConfig().prompt);
    } finally {
      delete process.env.OIDC_PROMPT;
    }

    const [, params] = mockBuildAuthorizationUrl.mock.calls[0];
    expect(params).not.toHaveProperty("prompt");
    expect(params).toMatchObject({ scope: "openid", state: "mock-state-value" });
  });

  test("passes a configured prompt other than omit through", async () => {
    await generateAuthUrl("mock-config" as never, "http://localhost:3000/callback", "openid", "select_account");

    const [, params] = mockBuildAuthorizationUrl.mock.calls[0];
    expect(params).toMatchObject({ prompt: "select_account" });
  });
});

// ─── exchangeCode ────────────────────────────────────────────────────────────

describe("exchangeCode", () => {
  beforeEach(() => {
    mockAuthorizationCodeGrant.mockClear();
    mockClaims.mockClear();
    mockClaims.mockReturnValue({ iss: "https://example.auth0.com", sub: "user-123", email: "user@test.com" });
  });

  test("exchanges code and returns claims", async () => {
    const result = await exchangeCode(
      "mock-config" as never,
      new URL("http://localhost:3000/callback?code=abc&state=xyz"),
      "verifier",
      "state",
      "nonce",
    );

    expect(result).toEqual({
      claims: { iss: "https://example.auth0.com", sub: "user-123", email: "user@test.com" },
      idToken: "raw.id.token",
    });
  });

  test("returns null when the token response carries no ID token", async () => {
    mockAuthorizationCodeGrant.mockImplementationOnce(async () => ({ claims: mockClaims, id_token: undefined }));

    const result = await exchangeCode(
      "mock-config" as never,
      new URL("http://localhost:3000/callback?code=abc"),
      "verifier",
      "state",
      "nonce",
    );

    expect(result).toBeNull();
  });

  test("calls authorizationCodeGrant with correct parameters", async () => {
    const callbackUrl = new URL("http://localhost:3000/callback?code=abc");

    await exchangeCode("mock-config" as never, callbackUrl, "my-verifier", "my-state", "my-nonce");

    expect(mockAuthorizationCodeGrant).toHaveBeenCalledWith("mock-config", callbackUrl, {
      pkceCodeVerifier: "my-verifier",
      expectedState: "my-state",
      expectedNonce: "my-nonce",
      idTokenExpected: true,
    });
  });

  test("returns null when claims() returns null/undefined", async () => {
    mockClaims.mockReturnValue(undefined);

    const result = await exchangeCode(
      "mock-config" as never,
      new URL("http://localhost:3000/callback?code=abc"),
      "verifier",
      "state",
      "nonce",
    );

    expect(result).toBeNull();
  });
});

// ─── getPublicOrigin ────────────────────────────────────────────────────────

describe("getPublicOrigin", () => {
  test("returns origin from request URL when no forwarded headers", () => {
    const req = new Request("http://localhost:3000/api/auth/oidc/login");
    expect(getPublicOrigin(req)).toBe("http://localhost:3000");
  });

  test("uses x-forwarded-host and x-forwarded-proto", () => {
    const req = new Request("http://0.0.0.0:10000/api/auth/oidc/login", {
      headers: {
        "x-forwarded-host": "app.libredb.org",
        "x-forwarded-proto": "https",
      },
    });
    expect(getPublicOrigin(req)).toBe("https://app.libredb.org");
  });

  test("falls back to host header when x-forwarded-host is absent", () => {
    const req = new Request("http://0.0.0.0:10000/api/auth/oidc/login", {
      headers: {
        host: "myapp.onrender.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(getPublicOrigin(req)).toBe("https://myapp.onrender.com");
  });

  test("defaults proto to https when x-forwarded-proto is absent", () => {
    const req = new Request("http://0.0.0.0:10000/api/auth/oidc/login", {
      headers: {
        "x-forwarded-host": "app.libredb.org",
      },
    });
    expect(getPublicOrigin(req)).toBe("https://app.libredb.org");
  });
});

// ─── resetDiscoveryCache ─────────────────────────────────────────────────────

describe("resetDiscoveryCache", () => {
  beforeEach(() => {
    mockDiscoveryFn.mockClear();
    process.env.OIDC_ISSUER = "https://example.auth0.com";
    process.env.OIDC_CLIENT_ID = "test-client-id";
    process.env.OIDC_CLIENT_SECRET = "test-client-secret";
  });

  afterEach(() => {
    resetDiscoveryCache();
  });

  test("clears cache so next discover call hits provider", async () => {
    // First call populates cache
    await discoverProvider();
    expect(mockDiscoveryFn).toHaveBeenCalledTimes(1);

    // Second call uses cache
    await discoverProvider();
    expect(mockDiscoveryFn).toHaveBeenCalledTimes(1);

    // Reset and call again
    resetDiscoveryCache();
    await discoverProvider();
    expect(mockDiscoveryFn).toHaveBeenCalledTimes(2);
  });
});

/**
 * The OIDC callback with the Kubernetes access review on (docs/SECURITY.md, control 1.12).
 *
 * The ID token's `groups` claim is read and recorded per issuer and subject before the session is minted, and an
 * absent claim, which Rancher sends every local user, is an empty list; a claim the store cannot hold refuses the
 * sign-in. The role claim is not read at all: a Studio admin is a person a fresh review allows to `update` Studio's
 * own Deployment, and everyone else, a failed review included, is a user. The identity provider is mocked with a
 * Rancher-shaped claim set; the gate, the groups store and the review client are the real ones, against a fake API.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { OIDCState } from "@/lib/oidc";
import { type FakeKubernetesApi, startFakeKubernetesApi } from "../../helpers/kubernetes-access/fake-api";

const ISSUER = "https://rancher.example.com/oidc";

/** What Rancher's ID token carries for a local user: no email, no preferred_username, and no groups claim. */
const RANCHER_CLAIMS = { iss: ISSUER, sub: "u-rjs2h", aud: "client-test", name: "Dev A", auth_provider: "local" };

let claims: Record<string, unknown> = { ...RANCHER_CLAIMS };

// The role claim reads that would make anyone an admin: with the review on, none of them may be asked.
const mockMapOIDCRole = mock(() => "admin" as "admin" | "user" | null);
const mockReadRoleClaimValues = mock(() => ["admin"]);

mock.module("@/lib/oidc", () => ({
  getOIDCConfig: mock(() => ({
    issuer: ISSUER,
    clientId: "client-test",
    clientSecret: "not-a-real-secret",
    scope: "openid profile groups",
    roleClaim: "groups",
    rolePrefix: undefined,
    adminRoles: ["admin"],
    userRoles: [],
  })),
  discoverProvider: mock(async () => "mock-config"),
  generateAuthUrl: mock(async () => ({})),
  encryptState: mock(async () => ""),
  decryptState: mock(async (): Promise<OIDCState> => ({ code_verifier: "v", state: "s", nonce: "n" })),
  exchangeCode: mock(async () => ({ claims, idToken: "header.payload.signature" })),
  mapOIDCRole: mockMapOIDCRole,
  mapOIDCClaimRoles: mock(() => ({ roles: [], overflow: false })),
  readRoleClaimValues: mockReadRoleClaimValues,
  resetDiscoveryCache: mock(() => {}),
  getPublicOrigin: mock((request: Request) => new URL(request.url).origin),
}));

const setCookies = new Map<string, string>();
const deleted: string[] = [];
const cookieStore = {
  get: mock((name: string) => (name === "oidc-state" ? { value: "encrypted-state-cookie" } : undefined)),
  set: mock((name: string, value: string) => {
    setCookies.set(name, value);
  }),
  delete: mock((options: { name: string } | string) => {
    deleted.push(typeof options === "string" ? options : options.name);
  }),
};

mock.module("next/headers", () => ({
  cookies: mock(async () => cookieStore),
  headers: mock(async () => ({ get: () => null })),
}));

const { GET } = await import("@/app/api/auth/oidc/callback/route");
const { verifyJWT } = await import("@/lib/auth");
const { recordedGroups, resetGroupRecords } = await import("@/lib/kubernetes-access/groups");
const { resetAccessReviewDecisions } = await import("@/lib/kubernetes-access/decisions");
const { logger } = await import("@/lib/logger");

const UPDATE_STUDIO = {
  verb: "update",
  apiGroup: "apps",
  resource: "deployments",
  namespace: "libredb-studio",
  name: "libredb-studio",
};

/** The default sign-in review, list Rancher's NavLinks at cluster scope, which every role a cluster grants allows. */
const LIST_NAVLINKS = { verb: "list", apiGroup: "ui.cattle.io", resource: "navlinks", namespace: "", name: "" };
const member = (user: string) => ({ user, ...LIST_NAVLINKS });

let api: FakeKubernetesApi;
let log: ReturnType<typeof spyOn>;
let warn: ReturnType<typeof spyOn>;

beforeAll(async () => {
  api = await startFakeKubernetesApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  api.reset();
  api.useEnv();
  resetGroupRecords();
  resetAccessReviewDecisions();
  setCookies.clear();
  deleted.length = 0;
  mockMapOIDCRole.mockClear();
  mockReadRoleClaimValues.mockClear();
  claims = { ...RANCHER_CLAIMS };
  // dev-a and the administrator are members of the cluster; u-zs9b2, as in the lab, has no role in it.
  api.grants = [member("u-rjs2h"), member("user-mf77b")];
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
  process.env.KUBERNETES_ACCESS_REVIEW = "on";
  process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "libredb-studio/libredb-studio";
  process.env.AUTH_SESSION_TTL_SECONDS = "900";
  log = spyOn(console, "log").mockImplementation(() => {});
  warn = spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
  warn.mockRestore();
  api.restoreEnv();
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
  for (const name of [
    "KUBERNETES_ACCESS_REVIEW",
    "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT",
    "AUTH_SESSION_TTL_SECONDS",
  ]) {
    delete process.env[name];
  }
  resetGroupRecords();
  resetAccessReviewDecisions();
});

async function signIn(): Promise<Response> {
  return GET(new Request("https://studio.example.com/api/auth/oidc/callback?code=auth-code&state=s"));
}

async function minted() {
  const token = setCookies.get("auth-token");
  if (token === undefined) throw new Error("the callback set no auth-token cookie");
  return verifyJWT(token);
}

/** The audit lines written to stdout so far, parsed. */
const auditLines = () =>
  (log.mock.calls as unknown[][]).flatMap((call) => {
    try {
      return [JSON.parse(String(call[0])) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

describe("with the access review on", () => {
  test("a Rancher local user without a groups claim signs in as a user, with an empty groups record", async () => {
    const response = await signIn();
    expect(response.headers.get("location")).toBe("https://studio.example.com/");
    expect(await minted()).toMatchObject({
      role: "user",
      username: "u-rjs2h",
      idpSubject: "u-rjs2h",
      idpIssuer: ISSUER,
    });
    expect(recordedGroups(ISSUER, "u-rjs2h")).toEqual([]);
    expect(api.seen.map((seen) => seen.body.spec)).toEqual([
      {
        user: "u-rjs2h",
        groups: [],
        resourceAttributes: { verb: "list", group: "ui.cattle.io", resource: "navlinks", namespace: "", name: "" },
      },
      {
        user: "u-rjs2h",
        groups: [],
        resourceAttributes: {
          verb: "update",
          group: "apps",
          resource: "deployments",
          namespace: "libredb-studio",
          name: "libredb-studio",
        },
      },
    ]);
  });

  test("a Rancher user without a role in the cluster is refused with oidc_no_role: no session, no record, no admin review", async () => {
    claims = { ...RANCHER_CLAIMS, sub: "u-zs9b2" };
    api.grants.push({ user: "u-zs9b2", ...UPDATE_STUDIO });
    const response = await signIn();
    expect(response.headers.get("location")).toBe("https://studio.example.com/login?error=oidc_no_role");
    expect(setCookies.has("auth-token")).toBe(false);
    expect(deleted).toContain("oidc-state");
    expect(recordedGroups(ISSUER, "u-zs9b2")).toBeNull();
    expect(api.seen).toHaveLength(1);
    expect(auditLines()).toContainEqual(
      expect.objectContaining({ event: "login_failure", reason: "oidc_no_role", actor: "u-zs9b2" }),
    );
  });

  test.each([
    ["a Kubernetes system user", "system:admin"],
    ["a ServiceAccount", "system:serviceaccount:kube-system:default"],
    ["an over-long subject", `u-${"x".repeat(300)}`],
    ["a control character", "u-rjs2h\rsystem:masters"],
  ])("a subject that is %s is refused with oidc_no_role before any review runs", async (_case, sub) => {
    claims = { ...RANCHER_CLAIMS, sub };
    api.grants.push(member(sub), { user: sub, ...UPDATE_STUDIO });
    const response = await signIn();
    expect(response.headers.get("location")).toBe("https://studio.example.com/login?error=oidc_no_role");
    expect(setCookies.has("auth-token")).toBe(false);
    expect(recordedGroups(ISSUER, sub)).toBeNull();
    expect(api.seen).toHaveLength(0);
  });

  test("a sign-in review that fails refuses the sign-in", async () => {
    api.answer = { status: 500, body: "{}" };
    const response = await signIn();
    expect(response.headers.get("location")).toBe("https://studio.example.com/login?error=oidc_no_role");
    expect(setCookies.has("auth-token")).toBe(false);
  });

  test("a person the review allows to update Studio's Deployment is an admin", async () => {
    claims = { ...RANCHER_CLAIMS, sub: "user-mf77b" };
    api.grants.push({ user: "user-mf77b", ...UPDATE_STUDIO });
    const response = await signIn();
    expect(response.headers.get("location")).toBe("https://studio.example.com/admin");
    expect(await minted()).toMatchObject({ role: "admin", idpSubject: "user-mf77b" });
  });

  test("a group the review binds counts, and the record keeps the claim's groups sorted", async () => {
    claims = { ...RANCHER_CLAIMS, groups: ["okta_group://owners", "github_team://7"] };
    api.grants.push({ group: "okta_group://owners", ...UPDATE_STUDIO });
    await signIn();
    expect(await minted()).toMatchObject({ role: "admin" });
    expect(api.seen.map((seen) => seen.body.spec?.groups)).toEqual([
      ["github_team://7", "okta_group://owners"],
      ["github_team://7", "okta_group://owners"],
    ]);
    expect(recordedGroups(ISSUER, "u-rjs2h")).toEqual(["github_team://7", "okta_group://owners"]);
  });

  test("the role claim is never read: a group named admin grants nothing", async () => {
    claims = { ...RANCHER_CLAIMS, groups: ["admin"] };
    await signIn();
    expect(await minted()).toMatchObject({ role: "user" });
    expect(mockMapOIDCRole).not.toHaveBeenCalled();
    expect(mockReadRoleClaimValues).not.toHaveBeenCalled();
  });

  test("an admin review that fails makes the sign-in a user, never an admin", async () => {
    api.grants.push({ user: "u-rjs2h", ...UPDATE_STUDIO });
    api.answer = (body) => (body.spec?.resourceAttributes?.verb === "update" ? { status: 500, body: "{}" } : "grants");
    await signIn();
    expect(await minted()).toMatchObject({ role: "user" });
  });

  test("the newest sign-in replaces the subject's record", async () => {
    claims = { ...RANCHER_CLAIMS, groups: ["okta_group://dbas"] };
    await signIn();
    claims = { ...RANCHER_CLAIMS, groups: ["okta_group://readers"] };
    await signIn();
    expect(recordedGroups(ISSUER, "u-rjs2h")).toEqual(["okta_group://readers"]);
  });

  test.each([
    ["a reserved Kubernetes group", ["okta_group://dbas", "system:masters"]],
    ["more than 512 groups", Array.from({ length: 513 }, (_, n) => `okta_group://g${n}`)],
    ["a claim that is not a list", "okta_group://dbas"],
  ])("a groups claim with %s refuses the sign-in, records nothing and asks no review", async (_case, groups) => {
    claims = { ...RANCHER_CLAIMS, groups };
    const response = await signIn();
    expect(response.headers.get("location")).toBe("https://studio.example.com/login?error=oidc_groups_refused");
    expect(setCookies.has("auth-token")).toBe(false);
    expect(deleted).toContain("oidc-state");
    expect(recordedGroups(ISSUER, "u-rjs2h")).toBeNull();
    expect(api.seen).toHaveLength(0);
    expect(auditLines()).toContainEqual(
      expect.objectContaining({ event: "login_failure", reason: "oidc_groups_refused", actor: "u-rjs2h" }),
    );
  });
});

describe("with the access review off", () => {
  test("the role claim decides as before, and nothing is recorded or reviewed", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    claims = { ...RANCHER_CLAIMS, groups: ["system:masters"] };
    await signIn();
    expect(await minted()).toMatchObject({ role: "admin" });
    expect(mockMapOIDCRole).toHaveBeenCalled();
    expect(recordedGroups(ISSUER, "u-rjs2h")).toBeNull();
    expect(api.seen).toHaveLength(0);
  });
});

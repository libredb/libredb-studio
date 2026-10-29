/**
 * openshift sign-in fails closed (docs/SECURITY.md, control 3.27). Studio asks for exactly `user:info
 * user:check-access`, whatever other variables say; a granted scope that is not exactly that signs nobody in; every
 * failure of the metadata, token and users/~ calls sets no session cookie, stores no token record and lands on the
 * login page with its code; the redirect URI comes from OPENSHIFT_PUBLIC_URL whatever the request headers say; no
 * role, session, record, audit line or log line takes anything from groups, a forged group header or a cookie field;
 * and admin comes only from the self review, made with the new token, of update on Studio's Deployment.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { decodeJwt, SignJWT } from "jose";
import { CookieJar } from "../helpers/openshift-auth/cookie-jar";
import {
  closedPort,
  type FakeCluster,
  METADATA_PATH,
  type ScriptedAnswer,
  startFakeCluster,
  TOKEN_PATH,
  USER_PATH,
} from "../helpers/openshift-auth/fake-cluster";
import { approvedSignIn, callbackRequest } from "../helpers/openshift-auth/sign-in";
import { loadTlsFixtures } from "../helpers/tls-fixtures";

const jar = new CookieJar();
mock.module("next/headers", () => jar.module());

const { GET: loginGET } = await import("@/app/api/auth/openshift/login/route");
const { GET: callbackGET } = await import("@/app/api/auth/openshift/callback/route");
const tokenStore = await import("@/lib/openshift-auth/token-store");
const { resetOpenShiftMetadataCache } = await import("@/lib/openshift-auth/metadata");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { logger } = await import("@/lib/logger");

const SECRET = "a-test-secret-that-is-32-chars!!";
const LOGIN_PAGE = "https://studio.apps.example.com/login?error=";
const CALLBACK = "https://studio.apps.example.com/api/auth/openshift/callback";
const json = (document: unknown): ScriptedAnswer => ({
  status: 200,
  body: JSON.stringify(document),
  headers: { "content-type": "application/json" },
});
let cluster: FakeCluster;
const realTimeout = AbortSignal.timeout.bind(AbortSignal);

beforeAll(async () => {
  cluster = await startFakeCluster();
});

afterAll(async () => {
  await cluster.close();
});

beforeEach(() => {
  cluster.reset();
  cluster.useEnv();
  jar.reset();
  resetOpenShiftMetadataCache();
  tokenStore.resetOpenShiftSessions();
  getServerAuditBuffer().clear();
  process.env.JWT_SECRET = SECRET;
});

/**
 * A whole sign-in: `before` runs before the login route, `between` after the approval and before the callback. The
 * answer is where the browser lands; a refusal before the callback is the login route's own redirect.
 */
async function signIn(
  before: () => void | Promise<void> = () => {},
  between: (params: URLSearchParams) => void = () => {},
  headers: Record<string, string> = {},
): Promise<string> {
  await before();
  const login = await loginGET(new Request("http://localhost:3000/api/auth/openshift/login", { headers }));
  const location = login.headers.get("location") ?? "";
  if (!location.includes("/oauth/authorize")) return location;
  const params = cluster.authorize(new URL(location));
  between(params);
  const res = await callbackGET(new Request(callbackRequest(params).url, { headers }));
  return res.headers.get("location") ?? "";
}

/** Runs `run` and checks it failed closed: the code, no session cookie, no stored record. */
async function failsClosed(code: string, run: () => Promise<string>): Promise<void> {
  const store = spyOn(tokenStore, "storeOpenShiftSession");
  try {
    expect(await run(), code).toBe(`${LOGIN_PAGE}${code}`);
    expect(jar.written("auth-token")).toEqual([]);
    expect(store).not.toHaveBeenCalled();
  } finally {
    store.mockRestore();
  }
}

describe("the scope", () => {
  test("Studio asks for exactly user:info user:check-access, whatever other variables say", async () => {
    process.env.OIDC_SCOPE = "openid profile user:full";
    process.env.OPENSHIFT_SCOPE = "user:full";
    try {
      const { authorizeUrl } = await approvedSignIn(loginGET, cluster);
      expect(authorizeUrl.searchParams.getAll("scope")).toEqual(["user:info user:check-access"]);
    } finally {
      delete process.env.OIDC_SCOPE;
      delete process.env.OPENSHIFT_SCOPE;
    }
  });

  test("a granted scope that is not exactly the pin signs nobody in; the two accepted forms do", async () => {
    for (const scope of [
      "user:info",
      "user:check-access",
      "user:info user:check-access user:full",
      "user:full",
      "user:info  user:check-access",
      "",
    ]) {
      jar.reset();
      cluster.reset();
      cluster.tokenAnswer = { ...cluster.tokenAnswer, scope };
      await failsClosed("openshift_scope", () => signIn());
      expect(cluster.requests.filter((request) => request.path === USER_PATH)).toEqual([]);
    }
    for (const scope of ["user:check-access user:info", undefined]) {
      jar.reset();
      cluster.reset();
      const answer: Record<string, unknown> = { ...cluster.tokenAnswer, scope };
      if (scope === undefined) delete answer.scope;
      cluster.tokenAnswer = answer;
      expect(await signIn()).toBe("https://studio.apps.example.com/");
    }
  });
});

describe("fail closed", () => {
  const otherCa = loadTlsFixtures().otherCa;
  /** Short deadlines for the hanging cases, so a test waits milliseconds instead of the 2 and 5 second deadlines. */
  async function withShortDeadlines(run: () => Promise<void>): Promise<void> {
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(100));
    try {
      await run();
    } finally {
      timeout.mockRestore();
    }
  }

  test("every metadata failure", async () => {
    const closed = `https://127.0.0.1:${await closedPort()}`;
    const metadata = cluster.metadata();
    const cases: [string, () => void, string][] = [
      ["network", () => (process.env.OPENSHIFT_API_URL = closed), "openshift_unreachable"],
      ["tls", () => writeFileSync(cluster.caFile, otherCa), "openshift_unreachable"],
      ["404", () => cluster.script(METADATA_PATH, { status: 404, body: "{}" }), "openshift_external_oidc"],
      ["500", () => cluster.script(METADATA_PATH, { status: 500, body: "{}" }), "openshift_unreachable"],
      [
        "302",
        () => cluster.script(METADATA_PATH, { status: 302, headers: { location: "https://x.example.com/" } }),
        "openshift_unreachable",
      ],
      ["oversize", () => cluster.script(METADATA_PATH, "oversize"), "openshift_unreachable"],
      ["not json", () => cluster.script(METADATA_PATH, { status: 200, body: "<html>" }), "openshift_config"],
      [
        "http issuer",
        () => cluster.script(METADATA_PATH, json({ ...metadata, issuer: "http://oauth.example.com" })),
        "openshift_config",
      ],
      [
        "other origin",
        () =>
          cluster.script(
            METADATA_PATH,
            json({ ...metadata, token_endpoint: "https://elsewhere.example.com/oauth/token" }),
          ),
        "openshift_config",
      ],
      [
        "no S256",
        () => cluster.script(METADATA_PATH, json({ ...metadata, code_challenge_methods_supported: ["plain"] })),
        "openshift_config",
      ],
    ];
    for (const [name, setup, code] of cases) {
      jar.reset();
      cluster.reset();
      cluster.useEnv();
      resetOpenShiftMetadataCache();
      await failsClosed(code, () => signIn(setup));
      expect(name).toBeTruthy();
    }
    jar.reset();
    cluster.reset();
    resetOpenShiftMetadataCache();
    await withShortDeadlines(() =>
      failsClosed("openshift_unreachable", () => signIn(() => cluster.script(METADATA_PATH, "hang"))),
    );
  });

  test("every token failure", async () => {
    const closedOrigin = `https://localhost:${await closedPort()}`;
    const cases: [string, (() => void) | null, ((params: URLSearchParams) => void) | null, string][] = [
      [
        "network",
        () =>
          cluster.script(
            METADATA_PATH,
            json({
              ...cluster.metadata(),
              issuer: closedOrigin,
              authorization_endpoint: `${closedOrigin}/oauth/authorize`,
              token_endpoint: `${closedOrigin}/oauth/token`,
            }),
          ),
        null,
        "openshift_unreachable",
      ],
      ["tls", null, () => writeFileSync(cluster.caFile, otherCa), "openshift_unreachable"],
      ["400", null, (params) => params.set("code", "not-issued"), "openshift_failed"],
      ["500", () => cluster.script(TOKEN_PATH, { status: 500, body: "{}" }), null, "openshift_unreachable"],
      [
        "302",
        () => cluster.script(TOKEN_PATH, { status: 302, headers: { location: "https://x.example.com/" } }),
        null,
        "openshift_unreachable",
      ],
      [
        "no access token",
        () => (cluster.tokenAnswer = { token_type: "Bearer", expires_in: 60 }),
        null,
        "openshift_failed",
      ],
      [
        "bad token type",
        () => (cluster.tokenAnswer = { ...cluster.tokenAnswer, token_type: "mac" }),
        null,
        "openshift_failed",
      ],
      [
        "negative expiry",
        () => (cluster.tokenAnswer = { ...cluster.tokenAnswer, expires_in: -1 }),
        null,
        "openshift_failed",
      ],
    ];
    for (const [name, before, between, code] of cases) {
      jar.reset();
      cluster.reset();
      resetOpenShiftMetadataCache();
      await failsClosed(code, () => signIn(before ?? undefined, between ?? undefined));
      expect(name).toBeTruthy();
    }
    jar.reset();
    cluster.reset();
    resetOpenShiftMetadataCache();
    await withShortDeadlines(() =>
      failsClosed("openshift_unreachable", () => signIn(() => cluster.script(TOKEN_PATH, "hang"))),
    );
  });

  test("every users/~ failure", async () => {
    const user = (metadataFields: Record<string, unknown>) => json({ kind: "User", metadata: metadataFields });
    const cases: [ScriptedAnswer, string][] = [
      [{ status: 401, body: "{}" }, "openshift_failed"],
      [{ status: 403, body: "{}" }, "openshift_failed"],
      [{ status: 404, body: "{}" }, "openshift_external_oidc"],
      [{ status: 500, body: "{}" }, "openshift_unreachable"],
      ["oversize", "openshift_unreachable"],
      [json({ kind: "Group", metadata: { name: "dev-a", uid: "u1" } }), "openshift_failed"],
      [user({ name: "kube:admin" }), "openshift_no_uid"],
      [user({ uid: "u1" }), "openshift_no_uid"],
      [user({ name: "system:admin", uid: "u1" }), "openshift_no_uid"],
    ];
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      for (const [answer, code] of cases) {
        jar.reset();
        cluster.reset();
        cluster.script(USER_PATH, answer);
        await failsClosed(code, () => signIn());
      }
    } finally {
      error.mockRestore();
    }
  });
});

describe("the redirect URI", () => {
  test("is the public callback URL on the authorize URL and in the token request, whatever the headers say", async () => {
    const forged = { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" };
    expect(await signIn(undefined, undefined, forged)).toBe("https://studio.apps.example.com/");
    const [token] = cluster.received("oauth");
    expect(new URLSearchParams(token.body).get("redirect_uri")).toBe(CALLBACK);
  });
});

describe("no role or record from groups, headers or cookie fields", () => {
  test("groups on users/~, forged group headers and a groups cookie field change nothing and are recorded nowhere", async () => {
    cluster.user = { ...cluster.user, groups: ["system:cluster-admins", "admins"] };
    const live = await new SignJWT({ role: "user", username: "dev-a", groups: ["system:cluster-admins"] })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    jar.values.set("auth-token", live);
    const logged: unknown[] = [];
    const spies = (["debug", "info", "warn", "error"] as const).map((level) =>
      spyOn(logger, level).mockImplementation((...args: unknown[]) => logged.push(args)),
    );
    try {
      const headers = { "x-remote-group": "system:masters", "x-forwarded-groups": "system:cluster-admins" };
      expect(await signIn(undefined, undefined, headers)).toBe("https://studio.apps.example.com/");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const minted = jar.written("auth-token").filter((write) => write.op === "set");
    expect(minted).toHaveLength(1);
    const claims = decodeJwt(minted[0].value ?? "");
    expect(claims.role).toBe("user");
    expect("groups" in claims).toBe(false);
    const recorded = JSON.stringify([claims, getServerAuditBuffer().getAll(), logged]);
    for (const group of ["system:cluster-admins", "system:masters", "admins"]) expect(recorded).not.toContain(group);
  });

  test("admin comes only from the self review: cluster-admin groups and a forged groups field grant nothing", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "os-lab-studio/studio";
    const update = {
      verb: "update",
      apiGroup: "apps",
      resource: "deployments",
      namespace: "os-lab-studio",
      name: "studio",
    };
    try {
      // users/~ names cluster-admin groups and the replaced cookie carries a forged groups field, but the cluster's own
      // RBAC for the token grants update only to a group the token's user is not in: a user.
      cluster.user = { ...cluster.user, groups: ["system:cluster-admins"] };
      cluster.grants = [{ group: "system:cluster-admins", ...update }];
      const forged = await new SignJWT({ role: "admin", username: "dev-a", groups: ["system:cluster-admins"] })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(new TextEncoder().encode(SECRET));
      jar.values.set("auth-token", forged);
      expect(await signIn()).toBe("https://studio.apps.example.com/");
      const [first] = jar.written("auth-token").filter((write) => write.op === "set");
      expect(decodeJwt(first.value ?? "").role).toBe("user");
      // The same sign-in, with the review allowing the token's user to update Studio's Deployment: an admin.
      jar.reset();
      cluster.grants = [{ user: "dev-a", ...update }];
      expect(await signIn()).toBe("https://studio.apps.example.com/admin");
      const [second] = jar.written("auth-token").filter((write) => write.op === "set");
      const claims = decodeJwt(second.value ?? "");
      expect(claims.role).toBe("admin");
      expect("groups" in claims).toBe(false);
    } finally {
      delete process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT;
    }
  });
});

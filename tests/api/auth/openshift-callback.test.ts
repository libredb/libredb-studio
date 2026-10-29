/**
 * GET /api/auth/openshift/callback against the fake cluster, through the real login route, flow, metadata, users/~,
 * token store and session minting. Each step of the callback ends in its code; the state cookie is deleted with its
 * path on every outcome after it was read; a success stores one record and mints one session whose lifetime is the
 * session lifetime capped by the token's expiry.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { decodeJwt, SignJWT } from "jose";
import { CookieJar, type CookieWrite } from "../../helpers/openshift-auth/cookie-jar";
import {
  ACCESS_TOKEN,
  type FakeCluster,
  METADATA_PATH,
  startFakeCluster,
  TOKEN_PATH,
  USER_PATH,
} from "../../helpers/openshift-auth/fake-cluster";
import { approvedSignIn, callbackRequest } from "../../helpers/openshift-auth/sign-in";

const jar = new CookieJar();
mock.module("next/headers", () => jar.module());

const { GET: loginGET } = await import("@/app/api/auth/openshift/login/route");
const { GET } = await import("@/app/api/auth/openshift/callback/route");
const { GET: meGET } = await import("@/app/api/auth/me/route");
const { getSession } = await import("@/lib/auth");
const { resetOpenShiftMetadataCache } = await import("@/lib/openshift-auth/metadata");
const tokenStore = await import("@/lib/openshift-auth/token-store");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { logger } = await import("@/lib/logger");

const SECRET = "a-test-secret-that-is-32-chars!!";
const LOGIN_PAGE = "https://studio.apps.example.com/login?error=";
const STATE_DELETE: CookieWrite = {
  op: "delete",
  name: "openshift-state",
  options: { name: "openshift-state", path: "/api/auth/openshift" },
};
let cluster: FakeCluster;

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
  delete process.env.AUTH_SESSION_TTL_SECONDS;
  delete process.env.NEXT_PUBLIC_BASE_PATH;
});

/** A sign-in up to the callback, which gets `change` applied to the approval's parameters first. */
async function signIn(change: (params: URLSearchParams) => void = () => {}, query = ""): Promise<Response> {
  const { params } = await approvedSignIn(loginGET, cluster, query);
  change(params);
  return GET(callbackRequest(params));
}

const minted = () => jar.written("auth-token").filter((write) => write.op === "set");
const lastAudit = () => getServerAuditBuffer().getAll().at(-1);

describe("GET /api/auth/openshift/callback, success", () => {
  test("stores the token, mints the session and lands on the public URL", async () => {
    const res = await signIn();
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://studio.apps.example.com/");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(jar.writes.filter((write) => write.name === "openshift-state" && write.op === "delete")).toEqual([
      STATE_DELETE,
    ]);
    const [cookie] = minted();
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    const claims = decodeJwt(cookie.value ?? "");
    expect(claims).toMatchObject({
      role: "user",
      username: "dev-a",
      idpSubject: cluster.user.uid,
      idpIssuer: cluster.issuerOrigin,
    });
    expect(claims.sessionHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const key = {
      sessionHandle: claims.sessionHandle as string,
      uid: cluster.user.uid as string,
      name: "dev-a",
      issuer: cluster.issuerOrigin,
    };
    expect(tokenStore.openShiftBearerToken(key)).toBe(ACCESS_TOKEN);
    expect(lastAudit()).toMatchObject({
      type: "login_success",
      user: "dev-a",
      target: "GET /api/auth/openshift/callback",
    });
    expect(await getSession()).toMatchObject({ username: "dev-a", role: "user" });
  });

  test("lands on the return path the state carried", async () => {
    const res = await signIn(() => {}, "?next=/sql");
    expect(res.headers.get("location")).toBe("https://studio.apps.example.com/sql");
  });

  test("the session lifetime is the configured one capped by the token's expiry", async () => {
    const lifetime = () => {
      const [cookie] = minted();
      const claims = decodeJwt(cookie.value ?? "");
      return [(claims.exp as number) - (claims.iat as number), cookie.options?.maxAge];
    };
    await signIn();
    expect(lifetime()).toEqual([28800, 28800]);
    jar.reset();
    process.env.AUTH_SESSION_TTL_SECONDS = "600";
    await signIn();
    expect(lifetime()).toEqual([600, 600]);
    jar.reset();
    delete process.env.AUTH_SESSION_TTL_SECONDS;
    cluster.tokenAnswer = { ...cluster.tokenAnswer, expires_in: 0 };
    await signIn();
    expect(lifetime()).toEqual([28800, 28800]);
    jar.reset();
    cluster.tokenAnswer = { ...cluster.tokenAnswer, expires_in: 900 };
    await signIn();
    expect(lifetime()).toEqual([900, 900]);
  });

  test("a 512-byte UTF-8 name with dots, @ and + round-trips to /api/auth/me", async () => {
    const name = `dev.a+ops@example.com${"x"}${"é".repeat(245)}`;
    cluster.user = { ...cluster.user, name };
    await signIn();
    const body = (await (await meGET()).json()) as { user: { username: string } };
    expect(body.user.username).toBe(name);
  });

  test("signing in again with a live cookie ends the replaced record, so a copy of the old cookie reads as signed out", async () => {
    await signIn();
    const old = minted()[0].value ?? "";
    jar.writes.length = 0;
    await signIn();
    const fresh = minted()[0].value ?? "";
    jar.values.set("auth-token", old);
    expect(await getSession()).toBeNull();
    jar.values.set("auth-token", fresh);
    expect(await getSession()).toMatchObject({ username: "dev-a" });
  });

  test("a cookie whose signature fails never ends a record", async () => {
    await signIn();
    const live = minted()[0].value ?? "";
    const handle = decodeJwt(live).sessionHandle as string;
    const forged = await new SignJWT({ role: "user", username: "dev-a", sessionHandle: handle })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("another-secret-that-is-32-chars!"));
    jar.values.set("auth-token", forged);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await signIn();
    } finally {
      warn.mockRestore();
    }
    jar.values.set("auth-token", live);
    expect(await getSession()).toMatchObject({ username: "dev-a" });
  });
});

describe("GET /api/auth/openshift/callback, refusals", () => {
  async function refusedWith(code: string, run: () => Promise<Response>): Promise<void> {
    const store = spyOn(tokenStore, "storeOpenShiftSession");
    try {
      const res = await run();
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`${LOGIN_PAGE}${code}`);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(minted()).toEqual([]);
      expect(store).not.toHaveBeenCalled();
      expect(lastAudit()).toMatchObject({ type: "login_failure", reason: code });
    } finally {
      store.mockRestore();
    }
  }

  test("no state cookie is openshift_state_missing", async () => {
    await refusedWith("openshift_state_missing", () => GET(callbackRequest("code=x&state=y")));
    expect(cluster.requests).toEqual([]);
  });

  test("a state cookie that does not verify is deleted and is openshift_state_invalid", async () => {
    jar.values.set("openshift-state", "not.a.token");
    await refusedWith("openshift_state_invalid", () => GET(callbackRequest("code=x&state=y")));
    expect(jar.written("openshift-state")).toEqual([STATE_DELETE]);
  });

  test("the consent page's Deny is openshift_denied; another error or no code is openshift_failed", async () => {
    await refusedWith("openshift_denied", () => signIn((params) => params.set("error", "access_denied")));
    expect(jar.written("openshift-state").at(-1)).toEqual(STATE_DELETE);
    await refusedWith("openshift_failed", () => signIn((params) => params.set("error", "server_error")));
    await refusedWith("openshift_failed", () => signIn((params) => params.delete("code")));
    expect(cluster.received("oauth")).toEqual([]);
  });

  test("a state that differs from the cookie's is openshift_state_invalid, with no token request", async () => {
    await refusedWith("openshift_state_invalid", () => signIn((params) => params.set("state", "another-state")));
    expect(cluster.received("oauth")).toEqual([]);
  });

  test("a callback carrying the first tab's state after a second login is refused", async () => {
    const first = await approvedSignIn(loginGET, cluster);
    await approvedSignIn(loginGET, cluster);
    await refusedWith("openshift_state_invalid", () => GET(callbackRequest(first.params)));
    expect(cluster.received("oauth")).toEqual([]);
  });

  test("the metadata decides: 404, 500, a failed check", async () => {
    const { params } = await approvedSignIn(loginGET, cluster);
    const state = jar.values.get("openshift-state") as string;
    for (const [answer, code] of [
      [{ status: 404, body: "{}" }, "openshift_external_oidc"],
      [{ status: 500, body: "{}" }, "openshift_unreachable"],
      [
        { status: 200, body: JSON.stringify({ ...cluster.metadata(), code_challenge_methods_supported: [] }) },
        "openshift_config",
      ],
    ] as const) {
      resetOpenShiftMetadataCache();
      cluster.script(METADATA_PATH, answer);
      jar.values.set("openshift-state", state);
      await refusedWith(code, () => GET(callbackRequest(params)));
    }
  });

  test("the token exchange decides: secret file, 5xx, refused code, malformed answer, scope", async () => {
    // Emptied after the login route checked it and before the exchange reads it.
    await refusedWith("openshift_config", () => signIn(() => writeFileSync(cluster.tokenFile, "")));
    cluster.reset();
    cluster.script(TOKEN_PATH, { status: 500, body: "{}" });
    await refusedWith("openshift_unreachable", () => signIn());
    cluster.reset();
    await refusedWith("openshift_failed", () => signIn((params) => params.set("code", "not-issued")));
    cluster.reset();
    cluster.tokenAnswer = { ...cluster.tokenAnswer, token_type: "mac" };
    await refusedWith("openshift_failed", () => signIn());
    cluster.reset();
    cluster.tokenAnswer = { ...cluster.tokenAnswer, scope: "user:info" };
    await refusedWith("openshift_scope", () => signIn());
    expect(cluster.requests.filter((request) => request.path === USER_PATH)).toEqual([]);
  });

  test("users/~ decides: 404, 500, no uid, 403, 401", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      for (const [answer, code] of [
        [{ status: 404, body: "{}" }, "openshift_external_oidc"],
        [{ status: 500, body: "{}" }, "openshift_unreachable"],
        [{ status: 200, body: JSON.stringify({ kind: "User", metadata: { name: "kube:admin" } }) }, "openshift_no_uid"],
        [{ status: 403, body: "{}" }, "openshift_failed"],
        [{ status: 401, body: "{}" }, "openshift_failed"],
      ] as const) {
        cluster.reset();
        cluster.script(USER_PATH, answer);
        await refusedWith(code, () => signIn());
      }
      expect(error.mock.calls.filter(([message]) => String(message).includes("403"))).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  test("a session that cannot be minted ends its record: no record is left", async () => {
    const { params } = await approvedSignIn(loginGET, cluster);
    const end = spyOn(tokenStore, "endOpenShiftSession");
    jar.failNextSet = new Error("cookie store unavailable");
    try {
      const res = await GET(callbackRequest(params));
      expect(res.headers.get("location")).toBe(`${LOGIN_PAGE}openshift_failed`);
      expect(end).toHaveBeenCalledTimes(1);
      const handle = end.mock.calls[0][0];
      expect(
        tokenStore.openShiftBearerToken({
          sessionHandle: handle,
          uid: cluster.user.uid as string,
          name: "dev-a",
          issuer: cluster.issuerOrigin,
        }),
      ).toBeNull();
      expect(lastAudit()).toMatchObject({ reason: "openshift_failed", user: "dev-a" });
    } finally {
      end.mockRestore();
    }
  });

  test("a missing session secret is openshift_config", async () => {
    const { params } = await approvedSignIn(loginGET, cluster);
    delete process.env.JWT_SECRET;
    await refusedWith("openshift_config", () => GET(callbackRequest(params)));
    expect(jar.written("openshift-state").at(-1)).toEqual(STATE_DELETE);
  });

  test("a broken audit sink never changes the redirect", async () => {
    const push = spyOn(getServerAuditBuffer(), "push").mockImplementation(() => {
      throw new Error("audit sink down");
    });
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect((await signIn()).headers.get("location")).toBe("https://studio.apps.example.com/");
      expect((await GET(callbackRequest("code=x&state=y"))).headers.get("location")).toBe(
        `${LOGIN_PAGE}openshift_state_missing`,
      );
    } finally {
      push.mockRestore();
      error.mockRestore();
    }
  });
});

// docs/OPENSHIFT.md: a CA file that cannot be read is openshift_config, and the server log names the variable, never
// the file's path or its content, at any level.
describe("GET /api/auth/openshift/callback, a CA file that cannot be read or holds no certificate", () => {
  const CONTENT = "no certificate, only text that must never reach the log";
  let error: ReturnType<typeof spyOn<typeof logger, "error">>;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  const logged = () => JSON.stringify([error.mock.calls, warn.mock.calls]);

  beforeEach(() => {
    error = spyOn(logger, "error").mockImplementation(() => {});
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    error.mockRestore();
    warn.mockRestore();
  });

  test("at the metadata step it is openshift_config, and the log names OPENSHIFT_API_CA_FILE", async () => {
    const { params } = await approvedSignIn(loginGET, cluster);
    resetOpenShiftMetadataCache();
    writeFileSync(cluster.caFile, CONTENT);
    expect((await GET(callbackRequest(params))).headers.get("location")).toBe(`${LOGIN_PAGE}openshift_config`);
    expect(lastAudit()).toMatchObject({ type: "login_failure", reason: "openshift_config" });
    expect(logged()).toContain("OPENSHIFT_API_CA_FILE");
    expect(logged()).not.toContain(CONTENT);
    expect(logged()).not.toContain(cluster.caFile);
    const missing = `${cluster.directory}/missing-ca.crt`;
    process.env.OPENSHIFT_API_CA_FILE = missing;
    const login = await loginGET(new Request("http://localhost:3000/api/auth/openshift/login"));
    expect(login.headers.get("location")).toBe(`${LOGIN_PAGE}openshift_config`);
    expect(logged()).not.toContain(missing);
    expect(logged()).not.toContain(cluster.directory);
    expect(cluster.received("api").filter((request) => request.path === METADATA_PATH)).toHaveLength(1);
    expect(minted()).toEqual([]);
  });

  test("at the token step it is openshift_config, nothing is sent, and the log names both files the call trusts", async () => {
    const { params } = await approvedSignIn(loginGET, cluster);
    writeFileSync(cluster.caFile, "");
    expect((await GET(callbackRequest(params))).headers.get("location")).toBe(`${LOGIN_PAGE}openshift_config`);
    expect(cluster.received("oauth").filter((request) => request.path === TOKEN_PATH)).toEqual([]);
    expect(logged()).toContain("OPENSHIFT_API_CA_FILE");
    expect(logged()).toContain("NODE_EXTRA_CA_CERTS");
    expect(logged()).not.toContain(cluster.directory);
    expect(minted()).toEqual([]);
  });

  test("at users/~ it is openshift_config, no token is stored, and the log names OPENSHIFT_API_CA_FILE", async () => {
    cluster.script(TOKEN_PATH, () => {
      writeFileSync(cluster.caFile, CONTENT);
      return undefined;
    });
    const store = spyOn(tokenStore, "storeOpenShiftSession");
    try {
      expect((await signIn()).headers.get("location")).toBe(`${LOGIN_PAGE}openshift_config`);
      expect(store).not.toHaveBeenCalled();
    } finally {
      store.mockRestore();
    }
    expect(cluster.received("api").filter((request) => request.path === USER_PATH)).toEqual([]);
    expect(logged()).toContain("OPENSHIFT_API_CA_FILE");
    expect(logged()).not.toContain(CONTENT);
    expect(logged()).not.toContain(cluster.directory);
    expect(minted()).toEqual([]);
  });
});

describe("GET /api/auth/openshift/callback, the exact path only", () => {
  test("outside openshift mode, or on any other path, the 404 with no cookie read and nothing sent", async () => {
    const cases: [string | undefined, string][] = [
      ["local", "/api/auth/openshift/callback"],
      ["oidc", "/api/auth/openshift/callback"],
      ["openshift", "/api/auth/openshift/callback/extra"],
      ["openshift", "/api/auth/openshift/callbackx"],
    ];
    for (const [mode, path] of cases) {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = mode;
      const res = await GET(callbackRequest("code=x&state=y", path));
      expect(res.status, `${mode} ${path}`).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
    expect(jar.reads).toEqual([]);
    expect(jar.writes).toEqual([]);
    expect(cluster.requests).toEqual([]);
  });
});

// Next removes the base path from the request URL before a route handler runs
// (next/dist/server/route-modules/route-module.js), so the callback a browser sends to
// /studio/api/auth/openshift/callback reaches the handler as /api/auth/openshift/callback.
describe("GET /api/auth/openshift/callback under a base path", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/studio";
    process.env.OPENSHIFT_PUBLIC_URL = "https://studio.apps.example.com/studio";
  });

  test("a callback whose URL Next stripped of the prefix signs in and lands under the base path", async () => {
    const res = await signIn();
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://studio.apps.example.com/studio/");
    expect(minted()).toHaveLength(1);
    expect(lastAudit()).toMatchObject({ type: "login_success", user: "dev-a" });
  });

  test("a callback whose URL still carries the prefix signs in too", async () => {
    const { params } = await approvedSignIn(loginGET, cluster);
    const res = await GET(callbackRequest(params, "/studio/api/auth/openshift/callback"));
    expect(res.headers.get("location")).toBe("https://studio.apps.example.com/studio/");
    expect(minted()).toHaveLength(1);
  });

  test("any other path is still the 404, with or without the prefix, with no cookie read and nothing sent", async () => {
    const paths = [
      "/api/auth/openshift/callback/extra",
      "/studio/api/auth/openshift/callback/extra",
      "/studio/studio/api/auth/openshift/callback",
      "/other/api/auth/openshift/callback",
    ];
    for (const path of paths) {
      const res = await GET(callbackRequest("code=x&state=y", path));
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
    expect(jar.reads).toEqual([]);
    expect(jar.writes).toEqual([]);
    expect(cluster.requests).toEqual([]);
  });
});

describe("GET /api/auth/openshift/callback, the role from the user's own review", () => {
  const UPDATE_STUDIO = {
    user: "dev-a",
    verb: "update",
    apiGroup: "apps",
    resource: "deployments",
    namespace: "os-lab-studio",
    name: "studio",
  };
  const MEMBER = {
    user: "dev-a",
    verb: "get",
    apiGroup: "",
    resource: "services",
    namespace: "os-lab-studio",
    name: "studio",
  };

  beforeEach(() => {
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "os-lab-studio/studio";
  });

  afterEach(() => {
    delete process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT;
    delete process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN;
  });

  test("an admin when the cluster lets the new token update Studio's Deployment, landing on /admin", async () => {
    cluster.grants = [UPDATE_STUDIO];
    const res = await signIn();
    expect(res.headers.get("location")).toBe("https://studio.apps.example.com/admin");
    expect(decodeJwt(minted()[0].value ?? "").role).toBe("admin");
    const reviews = cluster.received("api").filter((request) => request.path.endsWith("/selfsubjectaccessreviews"));
    expect(reviews.map((request) => request.headers.authorization)).toEqual([`Bearer ${ACCESS_TOKEN}`]);
  });

  test("a user otherwise", async () => {
    const res = await signIn();
    expect(res.headers.get("location")).toBe("https://studio.apps.example.com/");
    expect(decodeJwt(minted()[0].value ?? "").role).toBe("user");
  });

  test("openshift_no_access, with no record and no session, when the sign-in review is set and does not allow", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = "get services/studio -n os-lab-studio";
    cluster.grants = [UPDATE_STUDIO];
    const store = spyOn(tokenStore, "storeOpenShiftSession");
    try {
      const res = await signIn();
      expect(res.headers.get("location")).toBe(`${LOGIN_PAGE}openshift_no_access`);
      expect(store).not.toHaveBeenCalled();
    } finally {
      store.mockRestore();
    }
    expect(minted()).toEqual([]);
    expect(lastAudit()).toMatchObject({ type: "login_failure", reason: "openshift_no_access" });
  });

  test("signs in when the sign-in review allows", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = "get services/studio -n os-lab-studio";
    cluster.grants = [MEMBER];
    const res = await signIn();
    expect(res.headers.get("location")).toBe("https://studio.apps.example.com/");
    expect(decodeJwt(minted()[0].value ?? "").role).toBe("user");
  });
});

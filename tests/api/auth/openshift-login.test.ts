/**
 * GET /api/auth/openshift/login: the start of openshift sign-in. Outside the mode it answers the same 404 as any
 * unknown path; in it, it reads the configuration and the OAuth metadata, signs the PKCE verifier, the state and the
 * return path into the `openshift-state` cookie and sends the browser to the cluster's authorize endpoint, or sends it
 * to the login page with a reason code. The loop guard stops it on Studio's page without calling the cluster.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CookieJar } from "../../helpers/openshift-auth/cookie-jar";
import { type FakeCluster, METADATA_PATH, startFakeCluster } from "../../helpers/openshift-auth/fake-cluster";

const jar = new CookieJar();
mock.module("next/headers", () => jar.module());

const { GET } = await import("@/app/api/auth/openshift/login/route");
const { decryptOpenShiftState } = await import("@/lib/openshift-auth/state");
const { resetOpenShiftMetadataCache } = await import("@/lib/openshift-auth/metadata");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { logger } = await import("@/lib/logger");

const PUBLIC_LOGIN = "https://studio.apps.example.com/login?error=";
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
  getServerAuditBuffer().clear();
  process.env.JWT_SECRET = "a-test-secret-that-is-32-chars!!";
  delete process.env.NEXT_PUBLIC_BASE_PATH;
});

const login = (query = "", headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost:3000/api/auth/openshift/login${query}`, { headers }));

function lastAudit() {
  return getServerAuditBuffer().getAll().at(-1);
}

describe("GET /api/auth/openshift/login outside openshift mode", () => {
  test("answers the 404 of an unknown path, touches no cookie and calls nothing", async () => {
    for (const mode of ["local", "oidc", "OpenShift"]) {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = mode;
      const res = await login("?next=/sql");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(jar.reads).toEqual([]);
    expect(jar.writes).toEqual([]);
    expect(cluster.requests).toEqual([]);
  });
});

describe("GET /api/auth/openshift/login", () => {
  test("sends the browser to the authorize endpoint with the state in a signed cookie", async () => {
    const res = await login();
    expect(res.status).toBe(307);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${cluster.issuerOrigin}/oauth/authorize`);
    const [write] = jar.written("openshift-state");
    expect(write.op).toBe("set");
    expect(write.options).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 300,
      path: "/api/auth/openshift",
    });
    const state = await decryptOpenShiftState(write.value ?? "");
    expect(location.searchParams.get("state")).toBe(state.state);
    expect("return_to" in state).toBe(false);
    expect(cluster.requests.map((request) => request.path)).toEqual([METADATA_PATH]);
  });

  test("keeps a safe return path and drops one that leaves Studio", async () => {
    await login("?next=/sql");
    expect((await decryptOpenShiftState(jar.written("openshift-state")[0].value ?? "")).return_to).toBe("/sql");
    jar.reset();
    await login("?next=//evil.example");
    expect("return_to" in (await decryptOpenShiftState(jar.written("openshift-state")[0].value ?? ""))).toBe(false);
  });

  test("builds the redirect URI from the public URL whatever the forwarded headers say", async () => {
    const res = await login("", {
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
      host: "evil.example",
    });
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://studio.apps.example.com/api/auth/openshift/callback",
    );
  });

  test("with the loop guard tripped, stops on Studio's page, consumes the marker and calls nothing", async () => {
    jar.values.set("access-review-retry", "loop");
    const res = await login();
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${PUBLIC_LOGIN}openshift_session_lost`);
    expect(jar.written("access-review-retry")).toEqual([
      { op: "delete", name: "access-review-retry", options: { name: "access-review-retry", path: "/" } },
    ]);
    expect(jar.written("openshift-state")).toEqual([]);
    expect(cluster.requests).toEqual([]);
    expect(lastAudit()).toMatchObject({ type: "login_failure", reason: "openshift_session_lost", user: "anonymous" });
  });

  test("an armed marker that has not tripped does not stop the sign-in", async () => {
    jar.values.set("access-review-retry", "1999999999");
    expect((await login()).headers.get("location")).toContain("/oauth/authorize");
  });

  test("a missing or empty client secret file is a configuration failure, before any call", async () => {
    process.env.OPENSHIFT_OAUTH_TOKEN_FILE = `${cluster.directory}/missing-token`;
    const res = await login();
    expect(res.headers.get("location")).toBe(`${PUBLIC_LOGIN}openshift_config`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(cluster.requests).toEqual([]);
    expect(jar.written("openshift-state")).toEqual([]);
    expect(lastAudit()).toMatchObject({ reason: "openshift_config", target: "GET /api/auth/openshift/login" });
  });

  test("an invalid variable is a configuration failure, and an unreadable public URL lands on the path", async () => {
    process.env.OPENSHIFT_OAUTH_CLIENT_ID = "not-a-service-account";
    expect((await login()).headers.get("location")).toBe(`${PUBLIC_LOGIN}openshift_config`);
    cluster.useEnv();
    process.env.OPENSHIFT_PUBLIC_URL = "http://studio.apps.example.com";
    expect((await login()).headers.get("location")).toBe("/login?error=openshift_config");
    expect(cluster.requests).toEqual([]);
  });

  test("the metadata answer decides the code: 404, 500, a failed check", async () => {
    const cases: [object, string][] = [
      [{ status: 404, body: "{}" }, "openshift_external_oidc"],
      [{ status: 500, body: "{}" }, "openshift_unreachable"],
      [
        { status: 200, body: JSON.stringify({ ...cluster.metadata(), issuer: "http://x.example.com" }) },
        "openshift_config",
      ],
    ];
    for (const [answer, code] of cases) {
      cluster.script(METADATA_PATH, answer as never);
      jar.reset();
      const res = await login();
      expect(res.headers.get("location"), code).toBe(`${PUBLIC_LOGIN}${code}`);
      expect(jar.written("openshift-state")).toEqual([]);
    }
  });

  test("a missing session secret is a configuration failure; any other fault fails the sign-in", async () => {
    delete process.env.JWT_SECRET;
    expect((await login()).headers.get("location")).toBe(`${PUBLIC_LOGIN}openshift_config`);
    process.env.JWT_SECRET = "a-test-secret-that-is-32-chars!!";
    jar.failNextSet = new Error("cookie store unavailable");
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect((await login()).headers.get("location")).toBe(`${PUBLIC_LOGIN}openshift_failed`);
      expect(JSON.stringify(error.mock.calls)).not.toContain("cookie store unavailable");
    } finally {
      error.mockRestore();
    }
  });

  test("a broken audit sink never changes the redirect", async () => {
    jar.values.set("access-review-retry", "loop");
    const push = spyOn(getServerAuditBuffer(), "push").mockImplementation(() => {
      throw new Error("audit sink down");
    });
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect((await login()).headers.get("location")).toBe(`${PUBLIC_LOGIN}openshift_session_lost`);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      push.mockRestore();
      error.mockRestore();
    }
  });
});

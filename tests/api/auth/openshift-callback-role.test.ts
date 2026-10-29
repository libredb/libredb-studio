/**
 * The callback's role seam and session minting, with `openShiftSignInRole` and `login` replaced (in a file of their
 * own, because a module mock is process-wide): a null role refuses the sign-in with openshift_no_access and stores
 * nothing; an admin lands on /admin; a `login` that throws a configuration error ends the record it stored.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Role } from "@/lib/auth";
import * as realAuth from "@/lib/auth";
import { AuthConfigError } from "@/lib/auth-errors";
import { CookieJar } from "../../helpers/openshift-auth/cookie-jar";
import { type FakeCluster, startFakeCluster } from "../../helpers/openshift-auth/fake-cluster";
import { approvedSignIn, callbackRequest } from "../../helpers/openshift-auth/sign-in";

const jar = new CookieJar();
mock.module("next/headers", () => jar.module());

let role: Role | null = null;
mock.module("@/lib/openshift-auth/role", () => ({ openShiftSignInRole: async () => role }));

let loginError: Error | null = null;
const realLogin = realAuth.login;
mock.module("@/lib/auth", () => ({
  ...realAuth,
  login: async (...args: Parameters<typeof realLogin>) => {
    if (loginError !== null) throw loginError;
    return realLogin(...args);
  },
}));

const { GET: loginGET } = await import("@/app/api/auth/openshift/login/route");
const { GET } = await import("@/app/api/auth/openshift/callback/route");
const tokenStore = await import("@/lib/openshift-auth/token-store");
const { resetOpenShiftMetadataCache } = await import("@/lib/openshift-auth/metadata");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { logger } = await import("@/lib/logger");

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
  process.env.JWT_SECRET = "a-test-secret-that-is-32-chars!!";
  role = "user";
  loginError = null;
});

async function signIn(): Promise<Response> {
  const { params } = await approvedSignIn(loginGET, cluster);
  return GET(callbackRequest(params));
}

describe("the callback's role seam", () => {
  test("a null role is openshift_no_access, names the user and stores nothing", async () => {
    role = null;
    const store = spyOn(tokenStore, "storeOpenShiftSession");
    try {
      const res = await signIn();
      expect(res.headers.get("location")).toBe("https://studio.apps.example.com/login?error=openshift_no_access");
      expect(store).not.toHaveBeenCalled();
    } finally {
      store.mockRestore();
    }
    expect(jar.written("auth-token")).toEqual([]);
    expect(getServerAuditBuffer().getAll().at(-1)).toMatchObject({ reason: "openshift_no_access", user: "dev-a" });
  });

  test("an admin lands on /admin", async () => {
    role = "admin";
    expect((await signIn()).headers.get("location")).toBe("https://studio.apps.example.com/admin");
  });

  test("a login that throws a configuration error is openshift_config, and its record is ended", async () => {
    loginError = new AuthConfigError("JWT_SECRET is too short");
    const end = spyOn(tokenStore, "endOpenShiftSession");
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const res = await signIn();
      expect(res.headers.get("location")).toBe("https://studio.apps.example.com/login?error=openshift_config");
      expect(end).toHaveBeenCalledTimes(1);
      const key = {
        sessionHandle: end.mock.calls[0][0],
        uid: cluster.user.uid as string,
        name: "dev-a",
        issuer: cluster.issuerOrigin,
      };
      expect(tokenStore.openShiftBearerToken(key)).toBeNull();
      expect(JSON.stringify(error.mock.calls)).not.toContain("too short");
    } finally {
      end.mockRestore();
      error.mockRestore();
    }
  });
});

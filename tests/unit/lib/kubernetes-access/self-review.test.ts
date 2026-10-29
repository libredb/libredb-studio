/**
 * One SelfSubjectAccessReview with the signed-in user's own OpenShift token (src/lib/kubernetes-access/review.ts),
 * against the fake cluster of the openshift sign-in tests.
 *
 * The self review is the openshift sign-in backend: the token is the user's, so the answer is the user's own RBAC, and
 * the review names nothing of Studio's choosing about the person. It is sent only through openShiftApiCall, so the
 * API URL, the CA file as the only trust, the deadline, no proxy and no redirect are that one implementation. It is
 * allowed only for a 2xx SelfSubjectAccessReview that echoes the five asked attributes and says `allowed: true`
 * without `denied: true`; a 401 is `expired` (the token is dead), a 403 `forbidden` (the token lacks
 * user:check-access), and every other outcome fails, which every caller treats as a deny.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as http from "@/lib/openshift-auth/http";
import { requestAccessReview, type ResourceAttributes } from "@/lib/kubernetes-access/review";
import {
  ACCESS_TOKEN,
  closedPort,
  type FakeCluster,
  SELF_REVIEW_PATH,
  startFakeCluster,
} from "../../../helpers/openshift-auth/fake-cluster";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

const { ca, otherCa } = loadTlsFixtures();
const ORDERS: ResourceAttributes = {
  verb: "get",
  group: "",
  resource: "secrets",
  namespace: "team-a",
  name: "orders-app",
};
const DEV_A = { sessionHandle: "handle-of-dev-a", token: ACCESS_TOKEN };
const ORDERS_GRANT = {
  user: "dev-a",
  verb: "get",
  apiGroup: "",
  resource: "secrets",
  namespace: "team-a",
  name: "orders-app",
};
const PROXY_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "NODE_USE_ENV_PROXY",
  "NO_PROXY",
  "no_proxy",
];
const SAVED_KEYS = [...PROXY_KEYS, "NODE_EXTRA_CA_CERTS"];

let cluster: FakeCluster;
let saved: Record<string, string | undefined>;

beforeAll(async () => {
  cluster = await startFakeCluster();
});

afterAll(async () => {
  await cluster.close();
});

beforeEach(() => {
  saved = Object.fromEntries(SAVED_KEYS.map((key) => [key, process.env[key]]));
  for (const key of SAVED_KEYS) delete process.env[key];
  cluster.reset();
  cluster.useEnv();
});

afterEach(() => {
  for (const key of SAVED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A scripted 201 self review answer echoing `attributes`, with `status`. */
function answer(
  status: Record<string, unknown>,
  attributes: Record<string, unknown> = { ...ORDERS, group: undefined },
) {
  return {
    status: 201,
    body: JSON.stringify({ kind: "SelfSubjectAccessReview", spec: { resourceAttributes: attributes }, status }),
    headers: { "content-type": "application/json" },
  };
}

describe("the request", () => {
  test("is one POST of a SelfSubjectAccessReview to the review path, with the user's token as the bearer only", async () => {
    cluster.grants = [ORDERS_GRANT];
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "allowed" });
    const reviews = cluster.received("api");
    expect(reviews).toHaveLength(1);
    const [seen] = reviews;
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe(SELF_REVIEW_PATH);
    expect(seen.query).toBe("");
    expect(seen.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(seen.headers["content-type"]).toBe("application/json");
    expect(seen.body).not.toContain(ACCESS_TOKEN);
    expect(seen.body).not.toContain("sha256~");
    expect(seen.body).not.toContain(DEV_A.sessionHandle);
  });

  test("carries nothing of Studio's choosing about the person: the spec is the five resource attributes only", async () => {
    await requestAccessReview(DEV_A, ORDERS);
    const body = JSON.parse(cluster.received("api")[0].body) as Record<string, unknown> & {
      spec: Record<string, unknown> & { resourceAttributes: Record<string, unknown> };
    };
    expect(body).toEqual({
      apiVersion: "authorization.k8s.io/v1",
      kind: "SelfSubjectAccessReview",
      spec: {
        resourceAttributes: { verb: "get", group: "", resource: "secrets", namespace: "team-a", name: "orders-app" },
      },
    });
    expect(Object.keys(body.spec)).toEqual(["resourceAttributes"]);
    expect(Object.keys(body.spec.resourceAttributes)).toEqual(["verb", "group", "resource", "namespace", "name"]);
  });

  test("goes through openShiftApiCall with the deadline it is given, and its default deadline otherwise", async () => {
    const call = spyOn(http, "openShiftApiCall");
    try {
      await requestAccessReview(DEV_A, ORDERS, { timeoutMs: 1234 });
      await requestAccessReview(DEV_A, ORDERS);
      expect(call).toHaveBeenCalledTimes(2);
      expect(call.mock.calls[0][0]).toMatchObject({
        method: "POST",
        path: SELF_REVIEW_PATH,
        bearer: ACCESS_TOKEN,
        maxBytes: 65536,
        timeoutMs: 1234,
      });
      expect(call.mock.calls[1][0].timeoutMs).toBeUndefined();
    } finally {
      call.mockRestore();
    }
  });

  test("no environment proxy carries it: the proxy sees no connection and the review reaches the cluster", async () => {
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) process.env[key] = cluster.proxy.url;
    process.env.NODE_USE_ENV_PROXY = "1";
    cluster.grants = [ORDERS_GRANT];
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "allowed" });
    expect(cluster.proxy.connections).toBe(0);
    expect(cluster.received("api")).toHaveLength(1);
  });
});

describe("the answer", () => {
  test("allowed only where the user's RBAC allows it, for the user or a group of the user", async () => {
    cluster.grants = [ORDERS_GRANT];
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "allowed" });
    expect(await requestAccessReview(DEV_A, { ...ORDERS, name: "analytics-app" })).toEqual({ kind: "denied" });
    cluster.grants = [{ ...ORDERS_GRANT, user: undefined, group: "system:authenticated" }];
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "allowed" });
  });

  test("reads a field the API server left out of the echo as empty, as it omits empty fields", async () => {
    cluster.script(SELF_REVIEW_PATH, answer({ allowed: true }, { verb: "get", resource: "namespaces" }));
    expect(
      await requestAccessReview(DEV_A, { verb: "get", group: "", resource: "namespaces", namespace: "", name: "" }),
    ).toEqual({ kind: "allowed" });
  });

  test("the scope pin's failures deny: an extra scope's explicit deny, and an answer that says both", async () => {
    cluster.script(SELF_REVIEW_PATH, answer({ allowed: false, denied: true }));
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "denied" });
    cluster.script(SELF_REVIEW_PATH, answer({ allowed: true, denied: true }));
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "denied" });
  });

  test("a 200 counts like the 201 the API server sends", async () => {
    cluster.script(SELF_REVIEW_PATH, { ...answer({ allowed: true }), status: 200 });
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "allowed" });
  });

  test("HTTP 401 is expired: the API server refused the token, so the session is over", async () => {
    expect(await requestAccessReview({ ...DEV_A, token: "sha256~not-a-real-token-unknown" }, ORDERS)).toEqual({
      kind: "expired",
    });
  });

  test("HTTP 403 is forbidden: a token without user:check-access may not create the review", async () => {
    cluster.script(SELF_REVIEW_PATH, { status: 403, body: JSON.stringify({ kind: "Status", code: 403 }) });
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "failed", reason: "forbidden" });
  });

  test.each([404, 500, 302])("HTTP %p fails with its status, and a redirect is never followed", async (status) => {
    cluster.script(SELF_REVIEW_PATH, {
      status,
      body: JSON.stringify({ kind: "Status", code: status }),
      headers: { location: `${cluster.apiUrl}/elsewhere` },
    });
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "failed", reason: "status", status });
    expect(cluster.received("api")).toHaveLength(1);
  });

  test.each([
    ["not JSON", "{"],
    ["not an object", "[true]"],
    [
      "another kind",
      JSON.stringify({ kind: "SubjectAccessReview", spec: { resourceAttributes: ORDERS }, status: { allowed: true } }),
    ],
    ["no spec", JSON.stringify({ kind: "SelfSubjectAccessReview", status: { allowed: true } })],
    ["no attributes", JSON.stringify({ kind: "SelfSubjectAccessReview", spec: {}, status: { allowed: true } })],
    ["no status", JSON.stringify({ kind: "SelfSubjectAccessReview", spec: { resourceAttributes: ORDERS } })],
    ["allowed missing", answer({}).body],
    ["allowed as text", answer({ allowed: "true" }).body],
    ["another verb", answer({ allowed: true }, { ...ORDERS, verb: "list" }).body],
    ["another group", answer({ allowed: true }, { ...ORDERS, group: "apps" }).body],
    ["another resource", answer({ allowed: true }, { ...ORDERS, resource: "configmaps" }).body],
    ["another namespace", answer({ allowed: true }, { ...ORDERS, namespace: "team-b" }).body],
    ["another name", answer({ allowed: true }, { ...ORDERS, name: "analytics-app" }).body],
    ["a name left out", answer({ allowed: true }, { ...ORDERS, name: undefined }).body],
    ["a field that is not text", answer({ allowed: true }, { ...ORDERS, name: 7 }).body],
  ])("a body that is %s fails as malformed", async (_case, body) => {
    cluster.script(SELF_REVIEW_PATH, { status: 201, body });
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "failed", reason: "malformed" });
  });

  test("a body over the 64 KiB cap fails without being parsed", async () => {
    cluster.script(SELF_REVIEW_PATH, answer({ allowed: true, reason: "x".repeat(65 * 1024) }));
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "failed", reason: "too-large" });
  });

  test("an API server that does not answer within the deadline fails as timeout", async () => {
    cluster.script(SELF_REVIEW_PATH, "hang");
    const started = Date.now();
    expect(await requestAccessReview(DEV_A, ORDERS, { timeoutMs: 150 })).toEqual({ kind: "failed", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("what fails before anything is sent", () => {
  test.each([
    ["empty", ""],
    ["a CR LF pair", "sha256~not-a-real-token-a\r\nx-injected: 1"],
    ["a line feed", "sha256~not-a-real-token-a\n"],
    ["a space", "sha256~not a real token"],
    ["a byte past ASCII", "sha256~not-a-real-tokén"],
  ])("a token that is %s fails as token, so no CR or LF can reach a header", async (_case, token) => {
    expect(await requestAccessReview({ ...DEV_A, token }, ORDERS)).toEqual({ kind: "failed", reason: "token" });
    expect(cluster.requests).toEqual([]);
  });

  test("an OPENSHIFT_API_URL the configuration refuses fails as config", async () => {
    process.env.OPENSHIFT_API_URL = cluster.apiUrl.replace("https:", "http:");
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "failed", reason: "config" });
    expect(cluster.requests).toEqual([]);
  });

  test("an exception the transport should never throw fails as network", async () => {
    const call = spyOn(http, "openShiftApiCall").mockRejectedValue(new Error("unexpected"));
    try {
      expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "failed", reason: "network" });
    } finally {
      call.mockRestore();
    }
  });

  test("a CA file that holds no certificate fails as ca", async () => {
    writeFileSync(cluster.caFile, "not a certificate");
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "failed", reason: "ca" });
    expect(cluster.requests).toEqual([]);
  });
});

describe("trust", () => {
  test("a server whose certificate the CA file did not sign fails as tls, and gets no request", async () => {
    writeFileSync(cluster.caFile, otherCa);
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "failed", reason: "tls" });
    expect(cluster.requests).toEqual([]);
  });

  test("the CA file is the only trust: a server only the NODE_EXTRA_CA_CERTS CA vouches for gets no review", async () => {
    writeFileSync(cluster.caFile, otherCa);
    const extra = join(cluster.directory, "extra.crt");
    writeFileSync(extra, ca);
    process.env.NODE_EXTRA_CA_CERTS = extra;
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "failed", reason: "tls" });
    expect(cluster.requests).toEqual([]);
  });

  test("an address nothing listens on fails as network", async () => {
    process.env.OPENSHIFT_API_URL = `https://127.0.0.1:${await closedPort()}`;
    expect(await requestAccessReview(DEV_A, ORDERS)).toEqual({ kind: "failed", reason: "network" });
  });
});

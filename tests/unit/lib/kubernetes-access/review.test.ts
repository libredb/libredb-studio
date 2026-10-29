/**
 * One SubjectAccessReview against a fake API server (src/lib/kubernetes-access/review.ts).
 *
 * The review is a trust boundary: an allowed answer opens a database's credentials to a person. So it is allowed only
 * for a 2xx `SubjectAccessReview` that echoes the asked user and says `allowed: true`, and every other outcome, an
 * error, a timeout, a status that is not 2xx, a body that is malformed, too large or for another review, a token or CA
 * that cannot be read, fails, which every caller treats as a deny. The token and the CA are read again for every
 * review, so a rotated projected token is used at once.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { type AddressInfo, createServer } from "node:net";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";
import {
  FAKE_TOKEN,
  type FakeKubernetesApi,
  REVIEW_PATH,
  startFakeKubernetesApi,
} from "../../../helpers/kubernetes-access/fake-api";
import { resetPlatformCheck } from "@/lib/kubernetes-access/platform-check";
import { requestAccessReview, type ResourceAttributes } from "@/lib/kubernetes-access/review";

const SECRET: ResourceAttributes = {
  verb: "get",
  group: "",
  resource: "secrets",
  namespace: "team-a",
  name: "orders-app",
};
const DEV_A = { user: "u-rjs2h", groups: [] as string[] };

let api: FakeKubernetesApi;

beforeAll(async () => {
  api = await startFakeKubernetesApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  api.reset();
  api.useEnv();
});

afterEach(() => {
  api.restoreEnv();
});

/** A scripted 201 that echoes `user` with this status. */
function reviewAnswer(status: Record<string, unknown>, user = DEV_A.user, kind = "SubjectAccessReview"): string {
  return JSON.stringify({ kind, apiVersion: "authorization.k8s.io/v1", spec: { user }, status });
}

describe("the request", () => {
  test("is one POST of a SubjectAccessReview for the subject and the attributes, with the pod's bearer token", async () => {
    api.grants = [
      { user: "u-rjs2h", verb: "get", apiGroup: "", resource: "secrets", namespace: "team-a", name: "orders-app" },
    ];
    const outcome = await requestAccessReview(
      { user: "u-rjs2h", groups: ["github_team://7", "okta_group://dbas"] },
      SECRET,
    );
    expect(outcome).toEqual({ kind: "allowed" });
    expect(api.seen).toHaveLength(1);
    const [seen] = api.seen;
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe(REVIEW_PATH);
    expect(seen.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(seen.contentType).toBe("application/json");
    expect(seen.body).toEqual({
      apiVersion: "authorization.k8s.io/v1",
      kind: "SubjectAccessReview",
      spec: {
        user: "u-rjs2h",
        groups: ["github_team://7", "okta_group://dbas"],
        resourceAttributes: { verb: "get", group: "", resource: "secrets", namespace: "team-a", name: "orders-app" },
      },
    });
  });

  test("goes under the path of the API URL when it has one", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_API_URL = `${api.url}/prefix/`;
    await requestAccessReview(DEV_A, SECRET);
    expect(api.seen[0].path).toBe(`/prefix${REVIEW_PATH}`);
  });

  test("goes to the review path itself when the API URL has no path, or only slashes", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_API_URL = `${api.url}//`;
    await requestAccessReview(DEV_A, SECRET);
    expect(api.seen[0].path).toBe(REVIEW_PATH);
  });

  test("reads the token again for every review, so a rotated token is used at once", async () => {
    await requestAccessReview(DEV_A, SECRET);
    api.setToken("not-a-real-token-2\n");
    await requestAccessReview(DEV_A, SECRET);
    expect(api.seen.map((seen) => seen.authorization)).toEqual([`Bearer ${FAKE_TOKEN}`, "Bearer not-a-real-token-2"]);
  });
});

describe("no proxy and no global agent", () => {
  const PROXY_KEYS = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "NODE_USE_ENV_PROXY",
    "NO_PROXY",
    "no_proxy",
  ] as const;

  test("with the proxy variables set, the proxy sees no connection and the check and the review get agent: false", async () => {
    let connections = 0;
    const proxy = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const saved = Object.fromEntries(PROXY_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) process.env[key] = proxyUrl;
    process.env.NODE_USE_ENV_PROXY = "1";
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    // A cold process, so the platform check is sent too.
    resetPlatformCheck();
    const request = spyOn(https, "request");
    try {
      api.grants = [
        { user: "u-rjs2h", verb: "get", apiGroup: "", resource: "secrets", namespace: "team-a", name: "orders-app" },
      ];
      expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "allowed" });
      expect(request).toHaveBeenCalledTimes(2);
      for (const [options] of request.mock.calls) expect((options as https.RequestOptions).agent).toBe(false);
    } finally {
      request.mockRestore();
      for (const key of PROXY_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
    expect(connections).toBe(0);
    expect(api.platformChecks).toHaveLength(1);
    expect(api.seen).toHaveLength(1);
  });
});

describe("the answer", () => {
  test("allowed only when the review says allowed", async () => {
    api.grants = [
      {
        group: "okta_group://dbas",
        verb: "get",
        apiGroup: "",
        resource: "secrets",
        namespace: "team-a",
        name: "orders-app",
      },
    ];
    expect(await requestAccessReview({ user: "u-x", groups: ["okta_group://dbas"] }, SECRET)).toEqual({
      kind: "allowed",
    });
    expect(await requestAccessReview({ user: "u-x", groups: ["okta_group://other"] }, SECRET)).toEqual({
      kind: "denied",
    });
    expect(await requestAccessReview({ user: "u-x", groups: [] }, { ...SECRET, name: "analytics-app" })).toEqual({
      kind: "denied",
    });
  });

  test("an explicit deny denies, and so does an answer that says both", async () => {
    api.answer = { status: 201, body: reviewAnswer({ allowed: false, denied: true }) };
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "denied" });
    api.answer = { status: 201, body: reviewAnswer({ allowed: true, denied: true }) };
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "denied" });
  });

  test("a 200 counts like the 201 a kube-apiserver sends", async () => {
    api.answer = { status: 200, body: reviewAnswer({ allowed: true }) };
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "allowed" });
  });

  test.each([
    [401, "Unauthorized: the token was refused"],
    [403, "Forbidden: the ServiceAccount may not create subjectaccessreviews"],
    [500, "Internal error"],
    [302, "A redirect, which is never followed"],
  ])("HTTP %p fails", async (status, text) => {
    api.answer = { status, body: JSON.stringify({ kind: "Status", message: text }) };
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "status", status });
  });

  test.each([
    ["not JSON", "{"],
    ["not an object", "[true]"],
    ["another kind", reviewAnswer({ allowed: true }, DEV_A.user, "SelfSubjectAccessReview")],
    ["no status", JSON.stringify({ kind: "SubjectAccessReview", spec: { user: DEV_A.user } })],
    ["no spec", JSON.stringify({ kind: "SubjectAccessReview", status: { allowed: true } })],
    ["allowed as text", reviewAnswer({ allowed: "true" })],
    ["another user's review", reviewAnswer({ allowed: true }, "u-someone-else")],
  ])("a body that is %s fails", async (_case, body) => {
    api.answer = { status: 201, body };
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "malformed" });
  });

  test("a body over the size cap fails without being parsed", async () => {
    api.answer = { status: 201, body: reviewAnswer({ allowed: true, reason: "x".repeat(520 * 1024) }) };
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "too-large" });
  });

  test("an answer echoing the largest groups record the store keeps, escaped as the API server writes it, is read", async () => {
    // 64 KiB of group names, each byte an ampersand, which the API server's JSON writes as six bytes.
    const subject = { user: DEV_A.user, groups: Array.from({ length: 64 }, (_, n) => `${n}`.padEnd(1024, "&")) };
    api.answer = (body) => {
      const echoed = JSON.stringify({ kind: "SubjectAccessReview", spec: body.spec, status: { allowed: true } });
      return { status: 201, body: echoed.replaceAll("&", "\\u0026") };
    };
    expect(await requestAccessReview(subject, SECRET)).toEqual({ kind: "allowed" });
    expect(api.seen[0].body.spec?.groups).toEqual(subject.groups);
  });

  test("an API server that does not answer within the deadline fails", async () => {
    api.answer = "hang";
    const started = Date.now();
    expect(await requestAccessReview(DEV_A, SECRET, { timeoutMs: 150 })).toEqual({ kind: "failed", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("what fails before anything is sent", () => {
  test("a token file that cannot be read, or holds only blanks", async () => {
    rmSync(api.tokenPath);
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "token" });
    writeFileSync(api.tokenPath, " \n");
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "token" });
    expect(api.seen).toHaveLength(0);
  });

  test("a CA file that cannot be read", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_CA_PATH = `${api.caPath}.missing`;
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "ca" });
    expect(api.seen).toHaveLength(0);
  });

  test("an API URL the configuration refuses", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_API_URL = api.url.replace("https:", "http:");
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "config" });
    expect(api.seen).toHaveLength(0);
  });

  test("an empty user, which no review may run for", async () => {
    expect(await requestAccessReview({ user: "", groups: [] }, SECRET)).toEqual({ kind: "failed", reason: "config" });
    expect(api.seen).toHaveLength(0);
  });
});

describe("the TLS check", () => {
  test("an API server whose certificate the configured CA did not sign fails, and gets no request", async () => {
    writeFileSync(api.caPath, loadTlsFixtures().otherCa);
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "tls" });
    expect(api.seen).toHaveLength(0);
  });

  // An empty or certificate-less `ca` must never reach node:https: depending on the runtime it is ignored, and the
  // public roots would then vouch for the API server. It fails as a CA problem before any connection.
  test.each([
    ["empty", ""],
    ["blank", " \n\t"],
    ["not a certificate", "not a certificate"],
    ["a PEM block of another kind", "-----BEGIN PUBLIC KEY-----\nbm90IGEga2V5\n-----END PUBLIC KEY-----\n"],
  ])("a CA file that is %s fails as a CA problem, and no connection is made", async (_case, text) => {
    writeFileSync(api.caPath, text);
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "ca" });
    expect(api.seen).toHaveLength(0);
  });
});

test("a CA file whose certificate is damaged fails before any request reaches the server", async () => {
  writeFileSync(api.caPath, "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n");
  expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "tls" });
  expect(api.seen).toHaveLength(0);
});

test("an address nothing listens on fails as a network failure", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  process.env.KUBERNETES_ACCESS_REVIEW_API_URL = `https://127.0.0.1:${port}`;
  expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "network" });
});

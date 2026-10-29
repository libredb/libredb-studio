/**
 * The ServiceAccount review's platform check (src/lib/kubernetes-access/platform-check.ts).
 *
 * On a cluster that serves config.openshift.io/v1 a ServiceAccount SubjectAccessReview cannot assert the cluster's user
 * name for an OIDC subject, so the ServiceAccount backend refuses every review there with `platform` and tells the
 * admin to sign in with openshift instead. It asks once per process, before its first review, with the same URL, pod
 * token and CA; 200 and 404 are kept for the process, and any other outcome denies that review and is asked again.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  FAKE_TOKEN,
  type FakeKubernetesApi,
  OPENSHIFT_PLATFORM,
  PLATFORM_PATH,
  startFakeKubernetesApi,
} from "../../../helpers/kubernetes-access/fake-api";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";
import { clusterPlatform, resetPlatformCheck } from "@/lib/kubernetes-access/platform-check";
import { requestAccessReview, type ResourceAttributes } from "@/lib/kubernetes-access/review";

const SECRET: ResourceAttributes = {
  verb: "get",
  group: "",
  resource: "secrets",
  namespace: "team-a",
  name: "orders-app",
};
const DEV_A = { user: "u-rjs2h", groups: [] as string[] };
const GRANT = {
  user: "u-rjs2h",
  verb: "get",
  apiGroup: "",
  resource: "secrets",
  namespace: "team-a",
  name: "orders-app",
};
const { ca } = loadTlsFixtures();

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
  resetPlatformCheck();
});

afterEach(() => {
  api.restoreEnv();
  resetPlatformCheck();
});

describe("a cluster that serves config.openshift.io/v1", () => {
  test("refuses every ServiceAccount review with platform, sends none, and is asked once per process", async () => {
    api.platformAnswer = OPENSHIFT_PLATFORM;
    api.grants = [GRANT];
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "platform" });
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "platform" });
    expect(api.platformChecks).toEqual([{ path: PLATFORM_PATH, authorization: `Bearer ${FAKE_TOKEN}` }]);
    expect(api.seen).toHaveLength(0);
  });

  test("asks under the path of the API URL, with the pod token, as the review does", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_API_URL = `${api.url}/prefix/`;
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "denied" });
    expect(api.platformChecks.map((check) => check.path)).toEqual([`/prefix${PLATFORM_PATH}`]);
  });
});

describe("a cluster that does not", () => {
  test("lets the reviews proceed, and is asked once per process", async () => {
    api.grants = [GRANT];
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "allowed" });
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "allowed" });
    expect(api.platformChecks).toHaveLength(1);
    expect(api.seen).toHaveLength(2);
  });
});

describe("a check that gets no verdict", () => {
  test.each([403, 500, 401])(
    "HTTP %p denies that review with its status, sends no review, and asks again",
    async (status) => {
      api.platformAnswer = { status, body: JSON.stringify({ kind: "Status", code: status }) };
      api.grants = [GRANT];
      expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "status", status });
      expect(api.seen).toHaveLength(0);
      api.platformAnswer = { status: 404, body: "{}" };
      expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "allowed" });
      expect(api.platformChecks).toHaveLength(2);
    },
  );

  test("a check that does not answer within the deadline denies that review as timeout, and asks again", async () => {
    api.platformAnswer = "hang";
    expect(await requestAccessReview(DEV_A, SECRET, { timeoutMs: 150 })).toEqual({ kind: "failed", reason: "timeout" });
    api.platformAnswer = OPENSHIFT_PLATFORM;
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "platform" });
    expect(api.platformChecks).toHaveLength(2);
  });
});

describe("clusterPlatform", () => {
  test("answers openshift or kubernetes, and keeps the verdict until reset, as a restart forgets it", async () => {
    const url = new URL(api.url);
    api.platformAnswer = OPENSHIFT_PLATFORM;
    expect(await clusterPlatform(url, FAKE_TOKEN, ca)).toBe("openshift");
    api.platformAnswer = { status: 404, body: "{}" };
    expect(await clusterPlatform(url, FAKE_TOKEN, ca)).toBe("openshift");
    resetPlatformCheck();
    expect(await clusterPlatform(url, FAKE_TOKEN, ca)).toBe("kubernetes");
    expect(api.platformChecks).toHaveLength(2);
  });

  test("keeps the verdict on globalThis under its registered symbol, as separate route bundles share it", async () => {
    await clusterPlatform(new URL(api.url), FAKE_TOKEN, ca);
    const holder = globalThis as Record<symbol, unknown>;
    expect(holder[Symbol.for("libredb-studio.kubernetes-access-platform")]).toBe("kubernetes");
  });
});

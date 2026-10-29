/**
 * The ServiceAccount review's platform check (src/lib/kubernetes-access/platform-check.ts).
 *
 * On a cluster that serves config.openshift.io/v1 a ServiceAccount SubjectAccessReview cannot assert the cluster's user
 * name for an OIDC subject, so the ServiceAccount backend refuses every review there with `platform` and tells the
 * admin to sign in with openshift instead. It asks before its first review, with the same URL, pod token and CA, one
 * request at a time that every waiting review shares; 200 is kept for the process, 404 for five minutes, and any other
 * outcome denies the reviews that waited for it and is asked again.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
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
const T = Date.parse("2026-10-28T08:00:00.000Z");
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FORBIDDEN = { status: 403, body: JSON.stringify({ kind: "Status", code: 403 }) };

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
  setSystemTime();
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
  test("lets the reviews proceed, and is not asked again within five minutes", async () => {
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

describe("one check at a time", () => {
  test("eight concurrent reviews on a cold process wait for one platform check, and each is reviewed", async () => {
    api.grants = [GRANT];
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => requestAccessReview(DEV_A, SECRET)));
    expect(outcomes).toEqual(Array.from({ length: 8 }, () => ({ kind: "allowed" })));
    expect(api.platformChecks).toHaveLength(1);
    expect(api.seen).toHaveLength(8);
  });

  test("concurrent asks share one GET, whose failure each of them gets and nothing keeps", async () => {
    const url = new URL(api.url);
    api.platformAnswer = FORBIDDEN;
    const answers = await Promise.all(Array.from({ length: 8 }, () => clusterPlatform(url, FAKE_TOKEN, ca)));
    expect(answers).toEqual(Array.from({ length: 8 }, () => ({ kind: "failed", reason: "status", status: 403 })));
    expect(api.platformChecks).toHaveLength(1);
    api.platformAnswer = OPENSHIFT_PLATFORM;
    expect(await clusterPlatform(url, FAKE_TOKEN, ca)).toBe("openshift-cluster");
    expect(api.platformChecks).toHaveLength(2);
  });
});

describe("how long a verdict stands", () => {
  test("plain-kubernetes is asked again by the first review five minutes later, so one 404 never holds for good", async () => {
    setSystemTime(new Date(T));
    api.grants = [GRANT];
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "allowed" });
    api.platformAnswer = OPENSHIFT_PLATFORM;
    setSystemTime(new Date(T + FIVE_MINUTES_MS - 1));
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "allowed" });
    expect(api.platformChecks).toHaveLength(1);
    setSystemTime(new Date(T + FIVE_MINUTES_MS));
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "platform" });
    expect(api.platformChecks).toHaveLength(2);
    expect(api.seen).toHaveLength(2);
  });

  test("openshift-cluster is kept for the process, whatever the API server answers later", async () => {
    setSystemTime(new Date(T));
    api.platformAnswer = OPENSHIFT_PLATFORM;
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "platform" });
    api.platformAnswer = { status: 404, body: "{}" };
    setSystemTime(new Date(T + 24 * 60 * 60 * 1000));
    expect(await requestAccessReview(DEV_A, SECRET)).toEqual({ kind: "failed", reason: "platform" });
    expect(api.platformChecks).toHaveLength(1);
    expect(api.seen).toHaveLength(0);
  });

  test("a re-check that fails denies its review, and the next review asks again", async () => {
    const url = new URL(api.url);
    setSystemTime(new Date(T));
    expect(await clusterPlatform(url, FAKE_TOKEN, ca)).toBe("plain-kubernetes");
    setSystemTime(new Date(T + FIVE_MINUTES_MS));
    api.platformAnswer = { status: 500, body: "{}" };
    expect(await clusterPlatform(url, FAKE_TOKEN, ca)).toEqual({ kind: "failed", reason: "status", status: 500 });
    api.platformAnswer = { status: 404, body: "{}" };
    expect(await clusterPlatform(url, FAKE_TOKEN, ca)).toBe("plain-kubernetes");
    expect(api.platformChecks).toHaveLength(3);
  });
});

describe("clusterPlatform", () => {
  test("answers openshift-cluster or plain-kubernetes, and keeps the verdict until reset, as a restart forgets it", async () => {
    const url = new URL(api.url);
    api.platformAnswer = OPENSHIFT_PLATFORM;
    expect(await clusterPlatform(url, FAKE_TOKEN, ca)).toBe("openshift-cluster");
    api.platformAnswer = { status: 404, body: "{}" };
    expect(await clusterPlatform(url, FAKE_TOKEN, ca)).toBe("openshift-cluster");
    resetPlatformCheck();
    expect(await clusterPlatform(url, FAKE_TOKEN, ca)).toBe("plain-kubernetes");
    expect(api.platformChecks).toHaveLength(2);
  });

  test("keeps the verdict on globalThis under its registered symbol, as separate route bundles share it", async () => {
    await clusterPlatform(new URL(api.url), FAKE_TOKEN, ca);
    const holder = globalThis as Record<symbol, unknown>;
    expect(holder[Symbol.for("libredb-studio.kubernetes-access-platform")]).toMatchObject({ verdict: "plain-kubernetes" });
  });
});

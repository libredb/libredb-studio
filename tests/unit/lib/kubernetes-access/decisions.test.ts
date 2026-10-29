/**
 * The decision cache in front of the review (src/lib/kubernetes-access/decisions.ts).
 *
 * An allowed or denied answer is kept per subject, groups and attributes for KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS,
 * with one request in flight per key; a failure is never kept, so the next request asks again, and it denies. Failures
 * are logged at most once a minute per reason, with how many were held back, and never with the token, the subject,
 * the groups or the object.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import {
  type FakeKubernetesApi,
  OPENSHIFT_PLATFORM,
  startFakeKubernetesApi,
} from "../../../helpers/kubernetes-access/fake-api";
import {
  ACCESS_TOKEN,
  type FakeCluster,
  SELF_REVIEW_PATH,
  startFakeCluster,
} from "../../../helpers/openshift-auth/fake-cluster";
import { accessReviewAllows, accessReviewVerdict, resetAccessReviewDecisions } from "@/lib/kubernetes-access/decisions";
import { resetPlatformCheck } from "@/lib/kubernetes-access/platform-check";
import type { ResourceAttributes } from "@/lib/kubernetes-access/review";
import { logger } from "@/lib/logger";

const ORDERS: ResourceAttributes = {
  verb: "get",
  group: "",
  resource: "secrets",
  namespace: "team-a",
  name: "orders-app",
};
const DEV_A = { user: "u-rjs2h", groups: ["okta_group://dbas", "github_team://7"] };
const ORDERS_GRANT = {
  user: "u-rjs2h",
  verb: "get",
  apiGroup: "",
  resource: "secrets",
  namespace: "team-a",
  name: "orders-app",
};

const T = Date.parse("2026-10-28T08:00:00.000Z");

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
  resetAccessReviewDecisions();
  delete process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS;
  setSystemTime(new Date(T));
});

afterEach(() => {
  setSystemTime();
  api.restoreEnv();
  delete process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS;
  resetAccessReviewDecisions();
});

describe("the cache", () => {
  test("keeps an allowed answer for the configured lifetime, then asks again", async () => {
    api.grants = [ORDERS_GRANT];
    expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(true);
    api.grants = [];
    setSystemTime(new Date(T + 29_999));
    expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(true);
    expect(api.seen).toHaveLength(1);
    setSystemTime(new Date(T + 30_000));
    expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(false);
    expect(api.seen).toHaveLength(2);
  });

  test("keeps a denied answer too, for the lifetime KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS sets", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = "15";
    expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(false);
    api.grants = [ORDERS_GRANT];
    setSystemTime(new Date(T + 14_999));
    expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(false);
    setSystemTime(new Date(T + 15_000));
    expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(true);
    expect(api.seen).toHaveLength(2);
  });

  test("with a lifetime of 0 keeps nothing", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = "0";
    api.grants = [ORDERS_GRANT];
    await accessReviewAllows(DEV_A, ORDERS);
    await accessReviewAllows(DEV_A, ORDERS);
    expect(api.seen).toHaveLength(2);
  });

  test("is keyed by the user, the groups as a set and every attribute", async () => {
    api.grants = [ORDERS_GRANT];
    await accessReviewAllows(DEV_A, ORDERS);
    await accessReviewAllows(
      { user: "u-rjs2h", groups: ["github_team://7", "okta_group://dbas", "github_team://7"] },
      ORDERS,
    );
    expect(api.seen).toHaveLength(1);
    await accessReviewAllows({ user: "u-rjs2h", groups: ["github_team://7"] }, ORDERS);
    await accessReviewAllows({ user: "u-other", groups: DEV_A.groups }, ORDERS);
    await accessReviewAllows(DEV_A, { ...ORDERS, namespace: "team-b" });
    await accessReviewAllows(DEV_A, { ...ORDERS, name: "analytics-app" });
    await accessReviewAllows(DEV_A, { ...ORDERS, verb: "list" });
    await accessReviewAllows(DEV_A, { ...ORDERS, group: "apps" });
    await accessReviewAllows(DEV_A, { ...ORDERS, resource: "configmaps" });
    expect(api.seen).toHaveLength(8);
  });

  test("never keeps a failure: the next request asks again", async () => {
    api.answer = { status: 500, body: "{}" };
    expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(false);
    api.answer = "grants";
    api.grants = [ORDERS_GRANT];
    expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(true);
    expect(api.seen).toHaveLength(2);
  });

  test("sends one request for concurrent asks of one key, and every asker gets its answer", async () => {
    api.grants = [ORDERS_GRANT];
    api.delayMs = 50;
    const answers = await Promise.all([
      accessReviewAllows(DEV_A, ORDERS),
      accessReviewAllows(DEV_A, ORDERS),
      accessReviewAllows(DEV_A, ORDERS),
    ]);
    expect(answers).toEqual([true, true, true]);
    expect(api.seen).toHaveLength(1);
  });

  test("evicts the oldest answer first when it is full, so it stays bounded", async () => {
    resetAccessReviewDecisions(2);
    api.grants = [ORDERS_GRANT];
    const user = (n: number) => ({ user: `u-${n}`, groups: [] });
    await accessReviewAllows(user(1), ORDERS);
    await accessReviewAllows(user(2), ORDERS);
    await accessReviewAllows(user(3), ORDERS);
    expect(api.seen).toHaveLength(3);
    await accessReviewAllows(user(3), ORDERS);
    await accessReviewAllows(user(2), ORDERS);
    expect(api.seen).toHaveLength(3);
    await accessReviewAllows(user(1), ORDERS);
    expect(api.seen).toHaveLength(4);
  });

  test("drops expired answers before it evicts a live one", async () => {
    resetAccessReviewDecisions(2);
    api.grants = [ORDERS_GRANT];
    await accessReviewAllows({ user: "u-old", groups: [] }, ORDERS);
    setSystemTime(new Date(T + 10_000));
    await accessReviewAllows({ user: "u-live", groups: [] }, ORDERS);
    setSystemTime(new Date(T + 31_000));
    await accessReviewAllows({ user: "u-new", groups: [] }, ORDERS);
    expect(api.seen).toHaveLength(3);
    await accessReviewAllows({ user: "u-live", groups: [] }, ORDERS);
    expect(api.seen).toHaveLength(3);
  });

  test("a fresh decision asks the API whatever is cached, and keeps nothing", async () => {
    api.grants = [ORDERS_GRANT];
    await accessReviewAllows(DEV_A, ORDERS);
    api.grants = [];
    expect(await accessReviewAllows(DEV_A, ORDERS, { fresh: true })).toBe(false);
    expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(true);
    expect(api.seen).toHaveLength(2);
  });
});

describe("failures", () => {
  test("deny, and are logged at most once a minute per reason with the count held back", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      api.answer = { status: 403, body: "{}" };
      for (let i = 0; i < 3; i += 1) expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1]).toEqual({ route: "kubernetes-access", reason: "status", status: 403, heldBack: 0 });
      setSystemTime(new Date(T + 60_000));
      expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1][1]).toEqual({ route: "kubernetes-access", reason: "status", status: 403, heldBack: 2 });
      // Another reason is logged at once.
      api.answer = "hang";
      process.env.KUBERNETES_ACCESS_REVIEW_API_URL = api.url.replace("https:", "http:");
      expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[2][1]).toEqual({ route: "kubernetes-access", reason: "config", heldBack: 0 });
      const logged = JSON.stringify(warn.mock.calls);
      for (const secret of ["not-a-real-token", "u-rjs2h", "okta_group", "orders-app", "team-a"]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      warn.mockRestore();
    }
  });

  test("an invalid cache lifetime denies without a request, and is logged as a configuration failure", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = "90";
      api.grants = [ORDERS_GRANT];
      expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(false);
      expect(api.seen).toHaveLength(0);
      expect(warn.mock.calls[0][1]).toEqual({ route: "kubernetes-access", reason: "config", heldBack: 0 });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the ServiceAccount review on an OpenShift cluster", () => {
  test("denies, and is logged at error level once a minute with the sentence that names the fix", async () => {
    resetPlatformCheck();
    api.platformAnswer = OPENSHIFT_PLATFORM;
    api.grants = [ORDERS_GRANT];
    const error = spyOn(logger, "error").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await accessReviewVerdict(DEV_A, ORDERS)).toBe("denied");
      expect(await accessReviewAllows(DEV_A, ORDERS)).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]).toEqual([
        "Kubernetes access review: this cluster serves config.openshift.io/v1, where a ServiceAccount review cannot assert the cluster's user name for an OIDC subject, so every review is denied; sign in with NEXT_PUBLIC_AUTH_PROVIDER=openshift instead",
        undefined,
        { route: "kubernetes-access", reason: "platform", heldBack: 0 },
      ]);
      expect(warn).not.toHaveBeenCalled();
      expect(api.seen).toHaveLength(0);
    } finally {
      error.mockRestore();
      warn.mockRestore();
      resetPlatformCheck();
    }
  });
});

describe("self reviews, with the signed-in user's own token", () => {
  const ORDERS_SELF_GRANT = { ...ORDERS_GRANT, user: "dev-a" };
  const H = { sessionHandle: "handle-h-not-a-real-handle-0000000000000000", token: ACCESS_TOKEN };
  const K = { sessionHandle: "handle-k-not-a-real-handle-0000000000000000", token: "sha256~not-a-real-token-b" };
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
    cluster.tokens[K.token] = { user: "dev-b", groups: ["system:authenticated"] };
  });

  afterEach(() => {
    cluster.restoreEnv();
  });

  test("keep allowed and denied for 15 seconds by default in openshift mode, keyed by the session handle", async () => {
    cluster.grants = [ORDERS_SELF_GRANT];
    expect(await accessReviewVerdict(H, ORDERS)).toBe("allowed");
    expect(await accessReviewVerdict(K, ORDERS)).toBe("denied");
    cluster.grants = [];
    setSystemTime(new Date(T + 14_999));
    expect(await accessReviewVerdict(H, ORDERS)).toBe("allowed");
    expect(await accessReviewAllows(K, ORDERS)).toBe(false);
    expect(cluster.selfReviews()).toHaveLength(2);
    setSystemTime(new Date(T + 15_000));
    expect(await accessReviewVerdict(H, ORDERS)).toBe("denied");
    expect(cluster.selfReviews()).toHaveLength(3);
  });

  test("two sessions of one person never share a decision: another handle asks with its own token", async () => {
    const H2 = { ...H, sessionHandle: "handle-h2-not-a-real-handle-000000000000000" };
    cluster.grants = [ORDERS_SELF_GRANT];
    expect(await accessReviewVerdict(H, ORDERS)).toBe("allowed");
    expect(await accessReviewVerdict(H2, ORDERS)).toBe("allowed");
    expect(cluster.selfReviews()).toHaveLength(2);
  });

  test("an expired token is never kept and not logged here: the next ask goes out again", async () => {
    const dead = { ...H, token: "sha256~not-a-real-token-dead" };
    const logged = [spyOn(logger, "warn"), spyOn(logger, "error"), spyOn(logger, "info")];
    for (const spy of logged) spy.mockImplementation(() => {});
    try {
      expect(await accessReviewVerdict(dead, ORDERS)).toBe("expired");
      expect(await accessReviewVerdict(dead, ORDERS)).toBe("expired");
      expect(await accessReviewAllows(dead, ORDERS)).toBe(false);
      expect(cluster.selfReviews()).toHaveLength(3);
      for (const spy of logged) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of logged) spy.mockRestore();
    }
  });

  test("a 403 denies, is never kept, and is logged at error level once a minute", async () => {
    cluster.script(SELF_REVIEW_PATH, { status: 403, body: "{}" });
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(await accessReviewVerdict(H, ORDERS)).toBe("denied");
      expect(await accessReviewVerdict(H, ORDERS)).toBe("denied");
      expect(cluster.selfReviews()).toHaveLength(2);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]).toEqual([
        "Kubernetes access review: the session's token may not create a SelfSubjectAccessReview (HTTP 403), so the request it decides is denied; sign-in should have refused a token without the user:check-access scope",
        undefined,
        { route: "kubernetes-access", reason: "forbidden", heldBack: 0 },
      ]);
      setSystemTime(new Date(T + 60_000));
      expect(await accessReviewVerdict(H, ORDERS)).toBe("denied");
      expect(error.mock.calls[1][2]).toEqual({ route: "kubernetes-access", reason: "forbidden", heldBack: 1 });
    } finally {
      error.mockRestore();
    }
  });

  test("an empty session handle denies without a request unless the decision is fresh, which keeps nothing", async () => {
    const unkeyed = { sessionHandle: "", token: ACCESS_TOKEN };
    cluster.grants = [ORDERS_SELF_GRANT];
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await accessReviewVerdict(unkeyed, ORDERS)).toBe("denied");
      expect(cluster.selfReviews()).toHaveLength(0);
      expect(warn.mock.calls[0][1]).toEqual({ route: "kubernetes-access", reason: "config", heldBack: 0 });
      expect(await accessReviewVerdict(unkeyed, ORDERS, { fresh: true })).toBe("allowed");
      expect(await accessReviewVerdict(unkeyed, ORDERS, { fresh: true })).toBe("allowed");
      expect(cluster.selfReviews()).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("a fresh self decision passes an expired token through, so sign-in can tell it apart", async () => {
    expect(await accessReviewVerdict({ ...H, token: "sha256~not-a-real-token-dead" }, ORDERS, { fresh: true })).toBe(
      "expired",
    );
  });

  test("concurrent asks of one key share one request", async () => {
    cluster.grants = [ORDERS_SELF_GRANT];
    const verdicts = await Promise.all([1, 2, 3].map(() => accessReviewVerdict(H, ORDERS)));
    expect(verdicts).toEqual(["allowed", "allowed", "allowed"]);
    expect(cluster.selfReviews()).toHaveLength(1);
  });

  test("the store holds neither the token nor the handle, in a key or a value", async () => {
    cluster.grants = [ORDERS_SELF_GRANT];
    cluster.script(SELF_REVIEW_PATH, (request) =>
      request.body.includes("analytics-app") ? { status: 403, body: "{}" } : undefined,
    );
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await accessReviewVerdict(H, ORDERS);
      await accessReviewVerdict(H, { ...ORDERS, name: "analytics-app" });
      const pending = accessReviewVerdict(K, ORDERS);
      const held = (globalThis as Record<symbol, unknown>)[
        Symbol.for("libredb-studio.kubernetes-access-decisions")
      ] as {
        decisions: Map<string, unknown>;
        inFlight: Map<string, unknown>;
        failures: Map<string, unknown>;
      };
      const dump = JSON.stringify([
        [...held.decisions.entries()],
        [...held.inFlight.keys()],
        [...held.failures.entries()],
      ]);
      await pending;
      // H allowed and K denied are kept; the 403 is not.
      expect(held.decisions.size).toBe(2);
      for (const secret of [
        ACCESS_TOKEN,
        K.token,
        "sha256~",
        H.sessionHandle,
        K.sessionHandle,
        "dev-a",
        "orders-app",
      ]) {
        expect(dump).not.toContain(secret);
      }
    } finally {
      error.mockRestore();
    }
  });
});

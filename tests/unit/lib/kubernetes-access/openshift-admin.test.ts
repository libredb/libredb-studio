/**
 * The openshift admin rule (src/lib/kubernetes-access/gate.ts): admin only from a self review, with the user's own
 * token, of `update` on Studio's Deployment or its LibreDBStudio resource, decided fresh at sign-in and checked again,
 * through the decision cache, on every request of an admin session. Nothing else grants it: no group, claim, header,
 * cookie field or password. A user session is never promoted; a denied or failed check demotes the request to user;
 * a 401 ends the session.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { resetAccessReviewDecisions } from "@/lib/kubernetes-access/decisions";
import { connectionsUnderAccessReview, reviewedSessionRole, selfReviewSignInRole } from "@/lib/kubernetes-access/gate";
import { logger } from "@/lib/logger";
import {
  endOpenShiftSession,
  openShiftBearerToken,
  resetOpenShiftSessions,
  storeOpenShiftSession,
} from "@/lib/openshift-auth/token-store";
import {
  ACCESS_TOKEN,
  type FakeCluster,
  type RecordedRequest,
  SELF_REVIEW_PATH,
  startFakeCluster,
} from "../../../helpers/openshift-auth/fake-cluster";

const ISSUER = "https://oauth-openshift.apps.example.com";
const UID = "0b6f5c1e-4d2a-4c55-9e1f-7a3b2c1d0e9f";
const H = "handle-h-not-a-real-handle-0000000000000000";
const ADMIN_SESSION = { role: "admin", username: "dev-a", idpSubject: UID, idpIssuer: ISSUER, sessionHandle: H };
const UPDATE_STUDIO = {
  verb: "update",
  apiGroup: "apps",
  resource: "deployments",
  namespace: "os-lab-studio",
  name: "studio",
};
const UPDATE_RESOURCE = {
  verb: "update",
  apiGroup: "studio.libredb.org",
  resource: "libredbstudios",
  namespace: "os-lab-studio",
  name: "studio",
};
const MEMBER = { verb: "get", apiGroup: "", resource: "services", namespace: "os-lab-studio", name: "studio" };
const KEYS = [
  "KUBERNETES_ACCESS_REVIEW",
  "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT",
  "KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO",
  "KUBERNETES_ACCESS_REVIEW_SIGN_IN",
  "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS",
] as const;
const T = Date.parse("2026-10-29T08:00:00.000Z");

let cluster: FakeCluster;
let saved: Record<string, string | undefined>;

const asked = (request: RecordedRequest) =>
  (JSON.parse(request.body) as { spec: { resourceAttributes: Record<string, string> } }).spec.resourceAttributes;

beforeAll(async () => {
  cluster = await startFakeCluster();
});

afterAll(async () => {
  await cluster.close();
});

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "os-lab-studio/studio";
  cluster.reset();
  cluster.useEnv();
  resetAccessReviewDecisions();
  resetOpenShiftSessions();
  storeOpenShiftSession(H, {
    token: ACCESS_TOKEN,
    uid: UID,
    name: "dev-a",
    issuer: ISSUER,
    expiresAtMs: T + 3_600_000,
  });
  setSystemTime(new Date(T));
});

afterEach(() => {
  setSystemTime();
  cluster.restoreEnv();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetAccessReviewDecisions();
  resetOpenShiftSessions();
});

describe("the role at sign-in", () => {
  test("is admin when a fresh self review allows update on Studio's Deployment, and user when it denies", async () => {
    cluster.grants = [{ user: "dev-a", ...UPDATE_STUDIO }];
    expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("admin");
    cluster.grants = [];
    expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("user");
    expect(cluster.selfReviews().map(asked)).toEqual([
      { verb: "update", group: "apps", resource: "deployments", namespace: "os-lab-studio", name: "studio" },
      { verb: "update", group: "apps", resource: "deployments", namespace: "os-lab-studio", name: "studio" },
    ]);
    expect(cluster.selfReviews().every((request) => request.headers.authorization === `Bearer ${ACCESS_TOKEN}`)).toBe(
      true,
    );
  });

  test("asks about the LibreDBStudio resource for an operator install", async () => {
    delete process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT;
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO = "os-lab-studio/studio";
    cluster.grants = [{ user: "dev-a", ...UPDATE_RESOURCE }];
    expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("admin");
    cluster.grants = [{ user: "dev-a", ...UPDATE_STUDIO }];
    expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("user");
  });

  test("an admin review that fails, times out or meets a dead token makes a user, never a refusal", async () => {
    cluster.grants = [{ user: "dev-a", ...UPDATE_STUDIO }];
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      cluster.script(SELF_REVIEW_PATH, { status: 500, body: "{}" });
      expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("user");
      cluster.script(SELF_REVIEW_PATH, { status: 201, body: "not json" });
      expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("user");
      cluster.reset();
      cluster.grants = [{ user: "dev-a", ...UPDATE_STUDIO }];
      expect(await selfReviewSignInRole("sha256~not-a-real-token-unknown")).toBe("user");
    } finally {
      warn.mockRestore();
    }
  });

  test("groups grant nothing of their own: only what the cluster's RBAC answers for the token's user", async () => {
    cluster.tokens[ACCESS_TOKEN] = { user: "dev-a", groups: ["system:authenticated"] };
    cluster.grants = [{ group: "system:cluster-admins", ...UPDATE_STUDIO }];
    expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("user");
    cluster.tokens[ACCESS_TOKEN] = { user: "dev-a", groups: ["system:authenticated", "system:cluster-admins"] };
    expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("admin");
  });

  test("runs no sign-in review while KUBERNETES_ACCESS_REVIEW_SIGN_IN is unset", async () => {
    expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("user");
    expect(cluster.selfReviews().map(asked)).toEqual([
      { verb: "update", group: "apps", resource: "deployments", namespace: "os-lab-studio", name: "studio" },
    ]);
  });

  test("with KUBERNETES_ACCESS_REVIEW_SIGN_IN set, refuses unless a fresh review of it allows, before the admin review", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = "get services/studio -n os-lab-studio";
    cluster.grants = [{ user: "dev-a", ...UPDATE_STUDIO }];
    expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBeNull();
    expect(cluster.selfReviews()).toHaveLength(1);
    cluster.grants = [
      { user: "dev-a", ...MEMBER },
      { user: "dev-a", ...UPDATE_STUDIO },
    ];
    expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("admin");
    cluster.grants = [{ user: "dev-a", ...MEMBER }];
    expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("user");
    expect(
      cluster
        .selfReviews()
        .map(asked)
        .map((attributes) => attributes.verb),
    ).toEqual(["get", "get", "update", "get", "update"]);
  });

  test("a sign-in review that fails or meets a dead token refuses", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = "get services/studio -n os-lab-studio";
    cluster.grants = [{ user: "dev-a", ...MEMBER }];
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      cluster.script(SELF_REVIEW_PATH, { status: 500, body: "{}" });
      expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBeNull();
      cluster.reset();
      cluster.grants = [{ user: "dev-a", ...MEMBER }];
      expect(await selfReviewSignInRole("sha256~not-a-real-token-unknown")).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  test("an unreadable sign-in review refuses everyone, with a warning naming the setting, and asks nothing", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = "list";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBeNull();
      expect(String(warn.mock.calls[0][1]?.problem)).toContain("KUBERNETES_ACCESS_REVIEW_SIGN_IN must be a review");
      expect(cluster.requests).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("an unreadable admin target makes a user, with a warning naming the setting, and asks nothing", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO = "os-lab-studio/studio";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("user");
      expect(String(warn.mock.calls[0][1]?.problem)).toContain("are both set");
      expect(cluster.requests).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("keeps nothing: every sign-in asks again, and the decision store stays empty", async () => {
    cluster.grants = [{ user: "dev-a", ...UPDATE_STUDIO }];
    expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("admin");
    cluster.grants = [];
    expect(await selfReviewSignInRole(ACCESS_TOKEN)).toBe("user");
    expect(cluster.selfReviews()).toHaveLength(2);
    const held = (globalThis as Record<symbol, { decisions: Map<string, unknown> }>)[
      Symbol.for("libredb-studio.kubernetes-access-decisions")
    ];
    expect(held.decisions.size).toBe(0);
  });
});

describe("the role of each request of a session", () => {
  test("a user session stays a user and sends nothing, whatever the review would answer", async () => {
    cluster.grants = [{ user: "dev-a", ...UPDATE_STUDIO }];
    expect(await reviewedSessionRole({ ...ADMIN_SESSION, role: "user" })).toBe("user");
    expect(cluster.requests).toEqual([]);
  });

  test("an admin session stays admin while the review allows, from the cache within its lifetime", async () => {
    cluster.grants = [{ user: "dev-a", ...UPDATE_STUDIO }];
    expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("admin");
    setSystemTime(new Date(T + 14_999));
    expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("admin");
    expect(cluster.selfReviews()).toHaveLength(1);
  });

  test("is demoted to user once the right is gone, at the latest when the cached answer expires", async () => {
    cluster.grants = [{ user: "dev-a", ...UPDATE_STUDIO }];
    expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("admin");
    cluster.grants = [];
    setSystemTime(new Date(T + 15_000));
    expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("user");
    // With a lifetime of 0 nothing is kept, so the next request already sees the change.
    resetAccessReviewDecisions();
    process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = "0";
    cluster.grants = [{ user: "dev-a", ...UPDATE_STUDIO }];
    expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("admin");
    cluster.grants = [];
    expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("user");
  });

  test("a review that fails demotes the request to user, and keeps the session", async () => {
    cluster.script(SELF_REVIEW_PATH, { status: 500, body: "{}" });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("user");
      expect(openShiftBearerToken({ sessionHandle: H, uid: UID, name: "dev-a", issuer: ISSUER })).toBe(ACCESS_TOKEN);
    } finally {
      warn.mockRestore();
    }
  });

  test("a session with no key or no live record is expired, and nothing is asked", async () => {
    const { sessionHandle: _handle, ...unkeyed } = ADMIN_SESSION;
    expect(await reviewedSessionRole(unkeyed)).toBe("expired");
    expect(endOpenShiftSession(H)).toBe(true);
    expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("expired");
    expect(cluster.requests).toEqual([]);
  });

  test("a 401 on the admin review ends the record, logs one line, and answers expired", async () => {
    delete cluster.tokens[ACCESS_TOKEN];
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("expired");
      expect(info).toHaveBeenCalledTimes(1);
      expect(openShiftBearerToken({ sessionHandle: H, uid: UID, name: "dev-a", issuer: ISSUER })).toBeNull();
      expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("expired");
      expect(cluster.selfReviews()).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  test("a cached admin answer is never served once a 401 elsewhere ended the record", async () => {
    cluster.grants = [{ user: "dev-a", ...UPDATE_STUDIO }];
    expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("admin");
    delete cluster.tokens[ACCESS_TOKEN];
    const orders = {
      id: "seed:k8s-cnpg-orders",
      seedId: "k8s-cnpg-orders",
      name: "team-a/orders (CloudNativePG)",
      type: "postgres" as const,
      host: "orders-rw.team-a.svc.cluster.local.",
      port: 5432,
      managed: true,
      roles: [],
      createdAt: new Date(0),
      kubernetesSecret: { namespace: "team-a", name: "orders-app" },
    };
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      expect(await connectionsUnderAccessReview(ADMIN_SESSION, [orders])).toEqual([]);
      expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("expired");
      expect(cluster.selfReviews()).toHaveLength(2);
    } finally {
      info.mockRestore();
    }
  });

  test("an unreadable admin target demotes to user, with a warning at most once a minute, and asks nothing", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO = "os-lab-studio/studio";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("user");
      expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("user");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(
        "Kubernetes access review: no admin role can be decided, so the request runs as a user",
      );
      expect(String(warn.mock.calls[0][1]?.problem)).toContain("are both set");
      setSystemTime(new Date(T + 60_000));
      expect(await reviewedSessionRole(ADMIN_SESSION)).toBe("user");
      expect(warn).toHaveBeenCalledTimes(2);
      expect(cluster.requests).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * The access review's two decisions (src/lib/kubernetes-access/gate.ts), against a fake API server.
 *
 * A connection that names its Kubernetes Secret has roles `*`, so the review is its only gate: it is kept only when
 * the review allows the session's subject, in the groups the store recorded for it, to `get` that Secret, for admins
 * and users alike. The groups come from the store alone; a session without a subject, an issuer or a record is denied
 * without a request. With the review off such a connection is the admin role's only. A connection without the marker
 * is never reviewed. The admin role is a fresh review of `update` on Studio's Deployment at sign-in.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type FakeKubernetesApi, startFakeKubernetesApi } from "../../../helpers/kubernetes-access/fake-api";
import { resetAccessReviewDecisions } from "@/lib/kubernetes-access/decisions";
import {
  accessReviewSignInRole,
  connectionsUnderAccessReview,
  connectionUnderAccessReview,
} from "@/lib/kubernetes-access/gate";
import { recordGroups, resetGroupRecords } from "@/lib/kubernetes-access/groups";
import { logger } from "@/lib/logger";
import type { ManagedConnection } from "@/lib/seed/types";

const ISSUER = "https://rancher.example.com/oidc";
const DEV_A = { role: "user", username: "u-rjs2h", idpSubject: "u-rjs2h", idpIssuer: ISSUER };
const READ_ONLY = { role: "user", username: "u-ro", idpSubject: "u-ro", idpIssuer: ISSUER };
const ADMIN = { role: "admin", username: "user-mf77b", idpSubject: "user-mf77b", idpIssuer: ISSUER };

function reviewed(id: string, namespace: string, secret: string): ManagedConnection {
  return {
    id: `seed:${id}`,
    seedId: id,
    name: `${namespace}/${id} (CloudNativePG)`,
    type: "postgres",
    host: `${id}-rw.${namespace}.svc`,
    port: 5432,
    database: "app",
    user: "app",
    password: "example-only-password",
    managed: true,
    roles: ["*"],
    createdAt: new Date(0),
    literal: true,
    kubernetesSecret: { namespace, name: secret },
  };
}

const ORDERS = reviewed("k8s-cnpg-orders", "team-a", "orders-app");
const ANALYTICS = reviewed("k8s-cnpg-analytics", "team-b", "analytics-app");
const PLAIN: ManagedConnection = {
  id: "seed:shared-pg",
  seedId: "shared-pg",
  name: "Shared PostgreSQL",
  type: "postgres",
  host: "db.example.internal",
  port: 5432,
  managed: true,
  roles: ["*"],
  createdAt: new Date(0),
};

const getSecret = (user: string, namespace: string, name: string) => ({
  user,
  verb: "get",
  apiGroup: "",
  resource: "secrets",
  namespace,
  name,
});

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
  resetGroupRecords();
  process.env.KUBERNETES_ACCESS_REVIEW = "on";
  process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "libredb-studio/libredb-studio";
  process.env.AUTH_SESSION_TTL_SECONDS = "900";
  for (const principal of [DEV_A, READ_ONLY, ADMIN]) recordGroups(ISSUER, principal.idpSubject, []);
});

afterEach(() => {
  api.restoreEnv();
  for (const name of [
    "KUBERNETES_ACCESS_REVIEW",
    "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT",
    "AUTH_SESSION_TTL_SECONDS",
  ]) {
    delete process.env[name];
  }
  resetAccessReviewDecisions();
  resetGroupRecords();
});

describe("connections, with the review on", () => {
  test("keeps a reviewed connection only where the review allows get on its Secret, and never reviews another", async () => {
    api.grants = [getSecret("u-rjs2h", "team-a", "orders-app")];
    expect(await connectionsUnderAccessReview(DEV_A, [ORDERS, ANALYTICS, PLAIN])).toEqual([ORDERS, PLAIN]);
    // The reviews of one list run together, so they reach the server in either order.
    expect(
      api.seen
        .map((seen) => seen.body.spec?.resourceAttributes)
        .sort((a, b) => String(a?.name).localeCompare(String(b?.name))),
    ).toEqual([
      { verb: "get", group: "", resource: "secrets", namespace: "team-b", name: "analytics-app" },
      { verb: "get", group: "", resource: "secrets", namespace: "team-a", name: "orders-app" },
    ]);
    expect(api.seen.every((seen) => seen.body.spec?.user === "u-rjs2h")).toBe(true);
  });

  test("a Read Only subject sees none of the roles * connections whose Secret its role cannot get", async () => {
    api.grants = [getSecret("u-rjs2h", "team-a", "orders-app"), getSecret("u-rjs2h", "team-b", "analytics-app")];
    expect(await connectionsUnderAccessReview(READ_ONLY, [ORDERS, ANALYTICS, PLAIN])).toEqual([PLAIN]);
  });

  test("reviews an admin like everyone else", async () => {
    expect(await connectionsUnderAccessReview(ADMIN, [ORDERS, PLAIN])).toEqual([PLAIN]);
    api.grants = [getSecret("user-mf77b", "team-a", "orders-app")];
    resetAccessReviewDecisions();
    expect(await connectionsUnderAccessReview(ADMIN, [ORDERS, PLAIN])).toEqual([ORDERS, PLAIN]);
  });

  test("takes the groups from the store only, whatever else the session object carries", async () => {
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
    const forged = { ...DEV_A, groups: ["okta_group://dbas", "system:masters"], claimRoles: ["okta_group://dbas"] };
    expect(await connectionsUnderAccessReview(forged, [ORDERS])).toEqual([]);
    expect(api.seen[0].body.spec?.groups).toEqual([]);
    recordGroups(ISSUER, "u-rjs2h", ["okta_group://dbas"]);
    resetAccessReviewDecisions();
    expect(await connectionsUnderAccessReview(forged, [ORDERS])).toEqual([ORDERS]);
    expect(api.seen[1].body.spec?.groups).toEqual(["okta_group://dbas"]);
  });

  test.each([
    ["no subject", { role: "user", idpIssuer: ISSUER }],
    ["no issuer", { role: "user", idpSubject: "u-rjs2h" }],
    ["no record", { role: "user", idpSubject: "u-no-record", idpIssuer: ISSUER }],
    [
      "a record of another issuer",
      { role: "user", idpSubject: "u-rjs2h", idpIssuer: "https://other.example.com/oidc" },
    ],
  ])("a session with %s is denied without a request", async (_case, principal) => {
    api.grants = [getSecret("u-rjs2h", "team-a", "orders-app"), getSecret("u-no-record", "team-a", "orders-app")];
    expect(await connectionsUnderAccessReview(principal, [ORDERS, PLAIN])).toEqual([PLAIN]);
    expect(api.seen).toHaveLength(0);
  });

  test("an API server that fails denies", async () => {
    api.answer = { status: 503, body: "{}" };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await connectionsUnderAccessReview(DEV_A, [ORDERS, PLAIN])).toEqual([PLAIN]);
    } finally {
      warn.mockRestore();
    }
  });

  // A list asks about every reviewed connection it holds, up to 500 discovered databases, and a review the API server
  // answers late denies, so one list keeps a bounded number of reviews in flight rather than all of them at once.
  test("keeps at most 16 reviews of one list in flight, and the list in its order", async () => {
    const connections = Array.from({ length: 40 }, (_, index) =>
      reviewed(`k8s-cnpg-db-${index}`, "team-a", `db-${index}-app`),
    );
    const allowed = connections.filter((_, index) => index % 3 !== 1);
    api.grants = allowed.map((connection) => getSecret("u-rjs2h", "team-a", connection.kubernetesSecret?.name ?? ""));
    api.delayMs = 50;
    expect(await connectionsUnderAccessReview(DEV_A, [PLAIN, ...connections])).toEqual([PLAIN, ...allowed]);
    expect(api.seen).toHaveLength(40);
    expect(api.maxOpen).toBeLessThanOrEqual(16);
    expect(api.maxOpen).toBeGreaterThan(1);
  });

  test("an invalid switch counts as on", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "enabled";
    expect(await connectionsUnderAccessReview(ADMIN, [ORDERS, PLAIN])).toEqual([PLAIN]);
    expect(api.seen).toHaveLength(1);
  });
});

describe("connections, with the review off", () => {
  test("a reviewed connection is the admin role's only, and nothing is asked", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    api.grants = [getSecret("u-rjs2h", "team-a", "orders-app")];
    expect(await connectionsUnderAccessReview(DEV_A, [ORDERS, PLAIN])).toEqual([PLAIN]);
    expect(await connectionsUnderAccessReview(ADMIN, [ORDERS, PLAIN])).toEqual([ORDERS, PLAIN]);
    expect(api.seen).toHaveLength(0);
  });
});

describe("one connection", () => {
  test("is answered as the list would answer it, and a missing one stays missing without a request", async () => {
    api.grants = [getSecret("u-rjs2h", "team-a", "orders-app")];
    expect(await connectionUnderAccessReview(DEV_A, ORDERS)).toBe(ORDERS);
    expect(await connectionUnderAccessReview(DEV_A, ANALYTICS)).toBeNull();
    expect(await connectionUnderAccessReview(DEV_A, PLAIN)).toBe(PLAIN);
    const asked = api.seen.length;
    expect(await connectionUnderAccessReview(DEV_A, null)).toBeNull();
    expect(api.seen).toHaveLength(asked);
  });
});

describe("the role at sign-in", () => {
  const updateStudio = {
    verb: "update",
    apiGroup: "apps",
    resource: "deployments",
    namespace: "libredb-studio",
    name: "libredb-studio",
  };
  /** The default sign-in review: list Rancher's NavLinks at cluster scope, which every cluster role allows. */
  const member = (user: string) => ({
    user,
    verb: "list",
    apiGroup: "ui.cattle.io",
    resource: "navlinks",
    namespace: "",
    name: "",
  });

  test("a cluster member the review allows to update Studio's Deployment, as a user or through a group, is an admin", async () => {
    api.grants = [
      member("user-mf77b"),
      {
        group: "okta_group://members",
        verb: "list",
        apiGroup: "ui.cattle.io",
        resource: "navlinks",
        namespace: "",
        name: "",
      },
      { user: "user-mf77b", ...updateStudio },
      { group: "okta_group://owners", ...updateStudio },
    ];
    expect(await accessReviewSignInRole("user-mf77b", [])).toBe("admin");
    expect(await accessReviewSignInRole("u-cjdkh", ["okta_group://members", "okta_group://owners"])).toBe("admin");
    expect(api.seen.slice(0, 2).map((seen) => seen.body.spec)).toEqual([
      {
        user: "user-mf77b",
        groups: [],
        resourceAttributes: { verb: "list", group: "ui.cattle.io", resource: "navlinks", namespace: "", name: "" },
      },
      {
        user: "user-mf77b",
        groups: [],
        resourceAttributes: {
          verb: "update",
          group: "apps",
          resource: "deployments",
          namespace: "libredb-studio",
          name: "libredb-studio",
        },
      },
    ]);
  });

  test("a cluster member the review does not allow to update it is a user", async () => {
    api.grants = [member("u-rjs2h")];
    expect(await accessReviewSignInRole("u-rjs2h", [])).toBe("user");
    expect(api.seen).toHaveLength(2);
  });

  test("a user the sign-in review does not allow, a Rancher user without a role in the cluster, may not sign in, and no admin review runs", async () => {
    api.grants = [{ user: "u-zs9b2", ...updateStudio }];
    expect(await accessReviewSignInRole("u-zs9b2", [])).toBeNull();
    expect(api.seen).toHaveLength(1);
  });

  test("the sign-in review is the one KUBERNETES_ACCESS_REVIEW_SIGN_IN names", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = "get services/libredb-studio -n libredb-studio";
    api.grants = [
      {
        user: "u-rjs2h",
        verb: "get",
        apiGroup: "",
        resource: "services",
        namespace: "libredb-studio",
        name: "libredb-studio",
      },
    ];
    try {
      expect(await accessReviewSignInRole("u-rjs2h", [])).toBe("user");
      expect(api.seen[0].body.spec?.resourceAttributes).toEqual({
        verb: "get",
        group: "",
        resource: "services",
        namespace: "libredb-studio",
        name: "libredb-studio",
      });
    } finally {
      delete process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN;
    }
  });

  test("an unreadable sign-in review refuses everyone, with a warning that names the setting, and asks nothing", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = "list";
    api.grants = [member("user-mf77b"), { user: "user-mf77b", ...updateStudio }];
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await accessReviewSignInRole("user-mf77b", [])).toBeNull();
      expect(api.seen).toHaveLength(0);
      expect(String(warn.mock.calls[0][1]?.problem)).toContain("KUBERNETES_ACCESS_REVIEW_SIGN_IN must be a review");
    } finally {
      warn.mockRestore();
      delete process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN;
    }
  });

  test.each([
    ["an empty subject", ""],
    ["a Kubernetes system user", "system:admin"],
    ["a ServiceAccount", "system:serviceaccount:kube-system:default"],
    ["a subject longer than OpenID Connect allows", `u-${"x".repeat(254)}`],
    ["a control character", "u-rjs2h\nsystem:masters"],
    ["a C1 control character", "u-rjs2h\u0085"],
  ])("%s is refused before any review runs, and the warning names no subject", async (_case, subject) => {
    api.grants = [member(subject), { user: subject, ...updateStudio }];
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await accessReviewSignInRole(subject, [])).toBeNull();
      expect(api.seen).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
      if (subject !== "") expect(JSON.stringify(warn.mock.calls)).not.toContain(subject);
    } finally {
      warn.mockRestore();
    }
  });

  test("a subject of 255 bytes is accepted", async () => {
    const subject = `u-${"x".repeat(253)}`;
    api.grants = [member(subject)];
    expect(await accessReviewSignInRole(subject, [])).toBe("user");
  });

  test("a sign-in review that fails refuses, and an admin review that fails makes a user", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      api.answer = { status: 403, body: "{}" };
      expect(await accessReviewSignInRole("user-mf77b", [])).toBeNull();
      api.grants = [member("user-mf77b"), { user: "user-mf77b", ...updateStudio }];
      api.answer = (body) =>
        body.spec?.resourceAttributes?.verb === "update" ? { status: 500, body: "{}" } : "grants";
      expect(await accessReviewSignInRole("user-mf77b", [])).toBe("user");
    } finally {
      warn.mockRestore();
    }
  });

  test("asks again at every sign-in instead of trusting a cached answer", async () => {
    api.grants = [member("user-mf77b"), { user: "user-mf77b", ...updateStudio }];
    expect(await accessReviewSignInRole("user-mf77b", [])).toBe("admin");
    api.grants = [member("user-mf77b")];
    expect(await accessReviewSignInRole("user-mf77b", [])).toBe("user");
    api.grants = [];
    expect(await accessReviewSignInRole("user-mf77b", [])).toBeNull();
    expect(api.seen).toHaveLength(5);
  });

  test("is user, with a warning that names the setting, when Studio's Deployment is not configured", async () => {
    delete process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT;
    api.grants = [member("user-mf77b"), { user: "user-mf77b", ...updateStudio }];
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await accessReviewSignInRole("user-mf77b", [])).toBe("user");
      expect(api.seen).toHaveLength(1);
      expect(String(warn.mock.calls[0][1]?.problem)).toContain("KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT is not set");
    } finally {
      warn.mockRestore();
    }
  });
});

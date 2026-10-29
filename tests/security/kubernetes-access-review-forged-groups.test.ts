/**
 * Threat: a signed-in account widening its own Kubernetes access review with groups it chose (docs/SECURITY.md,
 * control 0.10).
 *
 * A review asserts the session's identity provider subject and the groups the OIDC callback recorded for that subject,
 * and nothing else. This file proves it without stubbing the session: the session is a real `auth-token` cookie the
 * server signed, which carries a `groups` field of its own, and every request also carries a `groups` cookie and the
 * Kubernetes impersonation and front-proxy headers, all naming a group the cluster lets read another team's Secret.
 * The routes read the session as they do in production, through `next/headers`, which is the only part stubbed here,
 * so that it hands them that cookie and those headers.
 *
 * The review asks as the recorded groups all the same: the Secret only the forged group may read answers the uniform
 * 404 and leaves the managed list, while the one the recorded group may read opens, which shows the forged session is
 * the one the routes read.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { KUBERNETES_REVIEWED_ROLE } from "@/lib/seed/roles";
import type { ManagedConnection } from "@/lib/seed/types";
import { type FakeKubernetesApi, startFakeKubernetesApi } from "../helpers/kubernetes-access/fake-api";

const ISSUER = "https://rancher.example.com/oidc";
const RECORDED = ["okta_group://team-a-devs"];
const FORGED = "okta_group://team-b-admins";

/** What a caller may add to any request: Kubernetes' impersonation headers and an authenticating proxy's. */
const FORGED_HEADERS: Readonly<Record<string, string>> = {
  "impersonate-user": "user-admin",
  "impersonate-group": FORGED,
  "x-remote-user": "user-admin",
  "x-remote-group": FORGED,
};

let jar: Record<string, { value: string } | undefined> = {};

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar[name],
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers({ ...FORGED_HEADERS, cookie: `groups=${encodeURIComponent(FORGED)}` }),
}));

const { signJWT } = await import("@/lib/auth");
const seedIndex = await import("@/lib/seed");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { logger } = await import("@/lib/logger");
const { resetAccessReviewDecisions } = await import("@/lib/kubernetes-access/decisions");
const { recordGroups, resetGroupRecords } = await import("@/lib/kubernetes-access/groups");
const { GET: listManaged } = await import("@/app/api/connections/managed/route");
const { POST: query } = await import("@/app/api/db/query/route");
const { POST: providerMeta } = await import("@/app/api/db/provider-meta/route");

type Handler = (request: Request) => Promise<Response>;

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
    roles: [KUBERNETES_REVIEWED_ROLE],
    createdAt: new Date(0),
    literal: true,
    kubernetesSecret: { namespace, name: secret },
  };
}

const REVIEWED: Readonly<Record<string, ManagedConnection>> = {
  "k8s-cnpg-orders": reviewed("k8s-cnpg-orders", "team-a", "orders-app"),
  "k8s-cnpg-analytics": reviewed("k8s-cnpg-analytics", "team-b", "analytics-app"),
};

const ENV: Readonly<Record<string, string>> = {
  KUBERNETES_ACCESS_REVIEW: "on",
  NEXT_PUBLIC_AUTH_PROVIDER: "oidc",
  AUTH_SESSION_TTL_SECONDS: "900",
};

const NOT_FOUND_BODY = {
  error: "Connection not found: it does not exist or is not granted to you",
  code: "CONNECTION_NOT_FOUND",
  statusCode: 404,
};

let api: FakeKubernetesApi;
const spies: { mockRestore(): void }[] = [];

beforeAll(async () => {
  api = await startFakeKubernetesApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
  api.reset();
  api.useEnv();
  // The recorded group may read team-a's Secret; only the forged group may read team-b's.
  api.grants = [
    { group: RECORDED[0], verb: "get", apiGroup: "", resource: "secrets", namespace: "team-a", name: "orders-app" },
    { group: FORGED, verb: "get", apiGroup: "", resource: "secrets", namespace: "team-b", name: "analytics-app" },
  ];
  resetAccessReviewDecisions();
  resetGroupRecords();
  clearRateLimitState();
  recordGroups(ISSUER, "u-alice", RECORDED);
  const forged = { role: "user", username: "u-alice", idpSubject: "u-alice", idpIssuer: ISSUER, groups: [FORGED] };
  jar = {
    "auth-token": { value: await signJWT(forged as Parameters<typeof signJWT>[0]) },
    groups: { value: FORGED },
  };
  spies.push(
    spyOn(seedIndex, "getSeedListing").mockImplementation(async () => ({
      before: [],
      pendingReview: structuredClone(Object.values(REVIEWED)),
      after: [],
    })),
    spyOn(logger, "warn").mockImplementation(() => {}),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  api.restoreEnv();
  for (const name of Object.keys(ENV)) delete process.env[name];
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
  resetAccessReviewDecisions();
  resetGroupRecords();
  clearRateLimitState();
  jar = {};
});

function post(route: string, body: unknown): Request {
  return new Request(`http://localhost/api/${route}`, {
    method: "POST",
    headers: { ...FORGED_HEADERS, "content-type": "application/json", cookie: `groups=${encodeURIComponent(FORGED)}` },
    body: JSON.stringify(body),
  });
}

/** The user and groups of every review the fake API server was sent. */
const asserted = () => api.seen.map((seen) => ({ user: seen.body.spec?.user, groups: seen.body.spec?.groups }));

describe("a session cookie field, a cookie and impersonation headers never reach a review", () => {
  test("opening the Secret only the forged group may read answers the uniform 404, asked as the recorded groups", async () => {
    const response = await (query as unknown as Handler)(
      post("db/query", { sql: "SELECT 1", connectionId: "seed:k8s-cnpg-analytics" }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
    expect(api.seen.map((seen) => seen.body.spec)).toEqual([
      {
        user: "u-alice",
        groups: RECORDED,
        resourceAttributes: { verb: "get", group: "", resource: "secrets", namespace: "team-b", name: "analytics-app" },
      },
    ]);
  });

  test("the managed list keeps only the Secret the recorded groups may read", async () => {
    const response = await listManaged();

    expect(response.status).toBe(200);
    const listed = ((await response.json()) as { connections: { id: string }[] }).connections.map(({ id }) => id);
    expect(listed.filter((id) => id.startsWith("seed:k8s-"))).toEqual(["seed:k8s-cnpg-orders"]);
    expect(asserted()).toEqual([
      { user: "u-alice", groups: RECORDED },
      { user: "u-alice", groups: RECORDED },
    ]);
  });

  // The control: the same forged session opens what its recorded groups allow, so the 404 above is a deny for this
  // session and not a session the route failed to read.
  test("the control: the Secret the recorded group may read opens for the same request", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await (providerMeta as unknown as Handler)(
        post("db/provider-meta", { connectionId: "seed:k8s-cnpg-orders" }),
      );
      expect(response.status).toBe(200);
      expect(asserted()).toEqual([{ user: "u-alice", groups: RECORDED }]);
    } finally {
      log.mockRestore();
    }
  });
});

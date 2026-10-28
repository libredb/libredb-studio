/**
 * GET /api/connections/managed with the Kubernetes access review on: the list a browser receives.
 *
 * The seed sources are replaced by a list holding two connections that name their Kubernetes Secret, as a Kubernetes
 * discovery source builds them (roles `*`, literal, the Secret marker), and one ordinary seed; the gate, the decision
 * cache, the groups store and the review client are the real ones, against a fake API server. A subject sees only
 * the reviewed connections whose Secret the review lets it get, with no credential, and neither the Secret marker nor
 * the literal marker ever leaves the server.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as auth from "@/lib/auth";
import * as seedIndex from "@/lib/seed";
import type { ManagedConnection } from "@/lib/seed/types";
import { type FakeKubernetesApi, startFakeKubernetesApi } from "../../helpers/kubernetes-access/fake-api";

const ISSUER = "https://rancher.example.com/oidc";
type Session = auth.UserPayload & { readonly groups?: readonly string[] };
const DEV_A: Session = { role: "user", username: "u-rjs2h", idpSubject: "u-rjs2h", idpIssuer: ISSUER };

let session: Session | null = DEV_A;

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

const SOURCE: ManagedConnection[] = [
  reviewed("k8s-cnpg-orders", "team-a", "orders-app"),
  reviewed("k8s-cnpg-analytics", "team-b", "analytics-app"),
  {
    id: "seed:shared-pg",
    seedId: "shared-pg",
    name: "Shared PostgreSQL",
    type: "postgres",
    host: "db.example.internal",
    port: 5432,
    user: "reader",
    password: "example-only-shared",
    managed: true,
    roles: ["*"],
    createdAt: new Date(0),
  },
];

const { GET } = await import("@/app/api/connections/managed/route");
const { recordGroups, resetGroupRecords } = await import("@/lib/kubernetes-access/groups");
const { resetAccessReviewDecisions } = await import("@/lib/kubernetes-access/decisions");

let api: FakeKubernetesApi;
const spies: { mockRestore(): void }[] = [];

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
  session = DEV_A;
  process.env.KUBERNETES_ACCESS_REVIEW = "on";
  process.env.AUTH_SESSION_TTL_SECONDS = "900";
  recordGroups(ISSUER, "u-rjs2h", []);
  api.grants = [
    { user: "u-rjs2h", verb: "get", apiGroup: "", resource: "secrets", namespace: "team-a", name: "orders-app" },
  ];
  spies.push(
    spyOn(auth, "getSession").mockImplementation(async () => session),
    spyOn(auth, "readSession").mockImplementation(async () =>
      session ? { kind: "authenticated", session } : { kind: "anonymous" },
    ),
    // Copies, as the real loader hands out: the route must not depend on a shared object.
    spyOn(seedIndex, "getManagedConnections").mockImplementation(async () =>
      SOURCE.map((connection) => ({ ...connection })),
    ),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  api.restoreEnv();
  delete process.env.KUBERNETES_ACCESS_REVIEW;
  delete process.env.AUTH_SESSION_TTL_SECONDS;
  resetAccessReviewDecisions();
  resetGroupRecords();
});

async function listed(): Promise<Record<string, unknown>[]> {
  const response = await GET();
  expect(response.status).toBe(200);
  return ((await response.json()) as { connections: Record<string, unknown>[] }).connections;
}

describe("GET /api/connections/managed under the access review", () => {
  test("lists a reviewed connection only where the review allows its Secret, beside the ordinary seed", async () => {
    expect((await listed()).map((connection) => connection.id)).toEqual(["seed:k8s-cnpg-orders", "seed:shared-pg"]);
  });

  test("sends no credential and neither server-only marker", async () => {
    for (const connection of await listed()) {
      for (const field of ["password", "kubernetesSecret", "literal"]) expect(field in connection).toBe(false);
    }
  });

  test("a subject the review allows nothing lists only the ordinary seed", async () => {
    session = { role: "user", username: "u-ro", idpSubject: "u-ro", idpIssuer: ISSUER };
    recordGroups(ISSUER, "u-ro", []);
    expect((await listed()).map((connection) => connection.id)).toEqual(["seed:shared-pg"]);
  });

  test("groups a session object carries are ignored: only the store's record reaches the review", async () => {
    api.grants = [
      {
        group: "okta_group://dbas",
        verb: "get",
        apiGroup: "",
        resource: "secrets",
        namespace: "team-b",
        name: "analytics-app",
      },
    ];
    session = { ...DEV_A, groups: ["okta_group://dbas"], claimRoles: ["okta_group://dbas"] };
    expect((await listed()).map((connection) => connection.id)).toEqual(["seed:shared-pg"]);
    expect(api.seen.every((seen) => JSON.stringify(seen.body.spec?.groups) === "[]")).toBe(true);
  });

  test("with the review off, the reviewed connections are the admin role's only", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    expect((await listed()).map((connection) => connection.id)).toEqual(["seed:shared-pg"]);
    session = { ...DEV_A, role: "admin" };
    expect((await listed()).map((connection) => connection.id)).toEqual([
      "seed:k8s-cnpg-orders",
      "seed:k8s-cnpg-analytics",
      "seed:shared-pg",
    ]);
    expect(api.seen).toHaveLength(0);
  });
});

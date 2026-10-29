/**
 * GET /api/connections/managed and resolveConnection with the real Kubernetes discovery source: an export file the
 * exporter's shape, read through the loader, merged by src/lib/seed/index.ts and gated by the Kubernetes access
 * review against a fake API server. Only getSession is replaced.
 *
 * This is the end-to-end check of the contract between the source and the review: every discovered connection names
 * the Secret its credentials came from, so a subject sees exactly the databases whose Secret the cluster lets it get,
 * an admin role included, and naming a denied id answers like an unknown one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as auth from "@/lib/auth";
import { resetCache } from "@/lib/seed";
import type { KubernetesDiscoveredDatabase } from "@/lib/seed/kubernetes-discovery-export";
import { resetKubernetesDiscoveryCache } from "@/lib/seed/kubernetes-discovery-loader";
import { type FakeKubernetesApi, startFakeKubernetesApi } from "../../helpers/kubernetes-access/fake-api";
import {
  GOLDEN_CASES,
  goldenDatabases,
  goldenRow,
  writeKubernetesDiscoveryExport,
  type KubernetesDiscoveryExportFixture,
} from "../../helpers/kubernetes-discovery-fixture";

const ISSUER = "https://rancher.example.com/oidc";
// The ids come from the golden fixture, which the implementation generated: no id is typed by hand here.
const [ORDERS, ANALYTICS, BILLING] = GOLDEN_CASES.filter((c) => goldenRow(c).slug === "cnpg").map(
  (c) => c.connectionId,
);
/** A discovered id no export lists, and the 12-hex id of team-a/orders that earlier releases listed. */
const UNKNOWN = `k8s-cnpg-${"0".repeat(32)}`;
const LEGACY = "k8s-cnpg-75c1a60b8980";
const ALL_KINDS = ["cnpg", "edbpg", "pgo", "mongo"];

/** `databases` with the row of the Secret `secretName` refused as not_found, as the exporter writes a missing Secret. */
function withRefused(databases: KubernetesDiscoveredDatabase[], secretName: string): KubernetesDiscoveredDatabase[] {
  const refused = databases.filter((entry) => entry.secret.name !== secretName);
  const row = databases.find((entry) => entry.secret.name === secretName);
  if (row === undefined) throw new Error(`no golden row reads ${secretName}`);
  const secret = { name: secretName, problem: "not_found" as const };
  return [...refused, { kind: row.kind, resource: row.resource, secret } as KubernetesDiscoveredDatabase];
}

type Session = auth.UserPayload;
const DEV_A: Session = { role: "user", username: "u-rjs2h", idpSubject: "u-rjs2h", idpIssuer: ISSUER };
const ADMIN: Session = { role: "admin", username: "u-admin", idpSubject: "u-admin", idpIssuer: ISSUER };

let session: Session | null = DEV_A;
let api: FakeKubernetesApi;
let exportFile: KubernetesDiscoveryExportFixture;
const spies: { mockRestore(): void }[] = [];

// The hosts below are those of the default cluster domain.
delete process.env.SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN;

const { GET } = await import("@/app/api/connections/managed/route");
const { resolveConnection } = await import("@/lib/seed/resolve-connection");
const { recordGroups, resetGroupRecords } = await import("@/lib/kubernetes-access/groups");
const { resetAccessReviewDecisions } = await import("@/lib/kubernetes-access/decisions");

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
  resetCache();
  resetKubernetesDiscoveryCache();
  exportFile = writeKubernetesDiscoveryExport();
  process.env.SEED_KUBERNETES_DISCOVERY_PATH = exportFile.path;
  process.env.KUBERNETES_ACCESS_REVIEW = "on";
  process.env.AUTH_SESSION_TTL_SECONDS = "900";
  session = DEV_A;
  recordGroups(ISSUER, "u-rjs2h", []);
  recordGroups(ISSUER, "u-admin", []);
  // dev-a may get the orders Secret only; the admin role is granted nothing.
  api.grants = [
    { user: "u-rjs2h", verb: "get", apiGroup: "", resource: "secrets", namespace: "team-a", name: "orders-app" },
  ];
  spies.push(
    spyOn(auth, "getSession").mockImplementation(async () => session),
    spyOn(auth, "readSession").mockImplementation(async () =>
      session ? { kind: "authenticated", session } : { kind: "anonymous" },
    ),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  api.restoreEnv();
  exportFile.remove();
  delete process.env.SEED_KUBERNETES_DISCOVERY_PATH;
  delete process.env.KUBERNETES_ACCESS_REVIEW;
  delete process.env.AUTH_SESSION_TTL_SECONDS;
  resetAccessReviewDecisions();
  resetGroupRecords();
  resetCache();
  resetKubernetesDiscoveryCache();
});

async function listed(): Promise<Record<string, unknown>[]> {
  const response = await GET();
  expect(response.status).toBe(200);
  return ((await response.json()) as { connections: Record<string, unknown>[] }).connections;
}

describe("Kubernetes-discovered connections under the access review", () => {
  test("a subject lists exactly the databases whose Secret the review lets it get", async () => {
    expect((await listed()).map((connection) => connection.id)).toEqual([`seed:${ORDERS}`]);
    // The reviews of one list run together, so they reach the API in no fixed order.
    const asked = api.seen
      .map((seen) => seen.body.spec?.resourceAttributes)
      .sort((left, right) => String(left?.name).localeCompare(String(right?.name)));
    expect(asked).toEqual([
      { verb: "get", group: "", resource: "secrets", namespace: "team-b", name: "analytics-app" },
      { verb: "get", group: "", resource: "secrets", namespace: "prod", name: "billing-owner" },
      { verb: "get", group: "", resource: "secrets", namespace: "team-a", name: "orders-app" },
    ]);
  });

  test("an admin role is reviewed like a user: without a grant it lists none", async () => {
    session = ADMIN;
    expect(await listed()).toEqual([]);
  });

  test("sends no credential and neither server-only marker to the browser", async () => {
    const [orders] = await listed();
    expect(orders).toMatchObject({
      name: "team-a/orders (CloudNativePG)",
      host: "orders-rw.team-a.svc.cluster.local.",
    });
    for (const field of ["password", "kubernetesSecret", "literal"]) expect(field in orders).toBe(false);
  });

  test("opens an allowed id with its credentials, and answers a denied id exactly like an unknown one", async () => {
    const opened = await resolveConnection({ connectionId: `seed:${ORDERS}` }, DEV_A);
    expect(opened).toMatchObject({
      host: "orders-rw.team-a.svc.cluster.local.",
      password: "not-a-real-password-orders",
    });

    const refusals = await Promise.all(
      [ANALYTICS, BILLING, UNKNOWN, LEGACY].map(async (id) => {
        try {
          await resolveConnection({ connectionId: `seed:${id}` }, DEV_A);
          return "opened";
        } catch (error) {
          const { message, statusCode, code } = error as { message: string; statusCode?: number; code?: string };
          return JSON.stringify({ message, statusCode, code });
        }
      }),
    );
    expect(new Set(refusals).size).toBe(1);
    expect(refusals[0]).toContain("404");
  });

  test("a refused PGO row's id and a 12-hex legacy id answer exactly like an unknown id", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    session = ADMIN;
    const analyst = GOLDEN_CASES.find((c) => c.secretName === "analytics-pguser-analyst");
    if (analyst === undefined) throw new Error("the golden fixture has no PGO analyst case");
    exportFile.write({
      databases: withRefused(goldenDatabases(ALL_KINDS), analyst.secretName),
    });
    resetKubernetesDiscoveryCache();
    resetCache();
    expect(await resolveConnection({ connectionId: `seed:${ORDERS}` }, ADMIN)).toMatchObject({ seedId: ORDERS });
    const refusals = await Promise.all(
      [analyst.connectionId, LEGACY, UNKNOWN].map(async (id) => {
        try {
          await resolveConnection({ connectionId: `seed:${id}` }, ADMIN);
          return "opened";
        } catch (error) {
          // With the review off the refusal names the id it was asked for, as it does for every unknown id.
          const { message, statusCode, code } = error as { message: string; statusCode?: number; code?: string };
          return JSON.stringify({ message: message.replace(id, "<id>"), statusCode, code });
        }
      }),
    );
    expect(new Set(refusals).size).toBe(1);
    expect(refusals[0]).toContain("404");
  });

  test("lists the MongoDB row without its password or a connection string", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    session = ADMIN;
    exportFile.write({ databases: goldenDatabases(ALL_KINDS) });
    resetKubernetesDiscoveryCache();
    resetCache();
    const catalog = (await listed()).find(
      (connection) => connection.name === "team-m/catalog/appuser (MongoDB Community)",
    );
    expect(catalog).toMatchObject({
      type: "mongodb",
      host: "catalog-0.catalog-svc.team-m.svc.cluster.local.",
      database: "catalog",
    });
    for (const field of ["password", "connectionString", "kubernetesSecret", "literal"]) {
      expect(field in (catalog as object)).toBe(false);
    }
    expect(JSON.stringify(await listed())).not.toContain("not-a-real-password");
  });

  test("with the review off, the admin role alone sees them, and no review is sent", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    expect(await listed()).toEqual([]);
    session = ADMIN;
    expect((await listed()).map((connection) => connection.id)).toEqual([
      `seed:${ORDERS}`,
      `seed:${ANALYTICS}`,
      `seed:${BILLING}`,
    ]);
    expect(api.seen).toHaveLength(0);
  });
});

/**
 * How src/lib/seed/index.ts merges the Kubernetes-discovered connections into the managed list: after the seed file
 * and CapRover, before the samples; with roles `*` only while the Kubernetes access review is on, its only gate then,
 * and `admin` otherwise; and always with the literal marker and the Secret marker the review reads, set after the role
 * filter. The export is read through the real loader from a temporary file.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getManagedConnections, getSeedConnectionById, getSeedConnectionByIdUnfiltered, resetCache } from "@/lib/seed";
import { resetDiscoveryCache } from "@/lib/seed/discovery-loader";
import type { KubernetesDiscoveredDatabase } from "@/lib/seed/kubernetes-discovery-export";
import {
  getKubernetesDiscoveredConnections,
  resetKubernetesDiscoveryCache,
} from "@/lib/seed/kubernetes-discovery-loader";
import { postgresService, writeDiscoveryExport, type DiscoveryExportFixture } from "../../helpers/discovery-fixture";
import {
  GOLDEN_CASES,
  goldenDatabases,
  goldenRow,
  writeKubernetesDiscoveryExport,
  type KubernetesDiscoveryExportFixture,
} from "../../helpers/kubernetes-discovery-fixture";

// The ids come from the golden fixture, which the implementation generated: no id is typed by hand here.
const [ORDERS, ANALYTICS, BILLING] = GOLDEN_CASES.filter((c) => goldenRow(c).slug === "cnpg").map(
  (c) => c.connectionId,
);
const KUBERNETES_IDS = [ORDERS, ANALYTICS, BILLING];
const ALL_KINDS = ["cnpg", "edbpg", "pgo", "mongo"];

/** `databases` with the row of the Secret `secretName` refused as not_found, as the exporter writes a missing Secret. */
function withRefused(databases: KubernetesDiscoveredDatabase[], secretName: string): KubernetesDiscoveredDatabase[] {
  const refused = databases.filter((entry) => entry.secret.name !== secretName);
  const row = databases.find((entry) => entry.secret.name === secretName);
  if (row === undefined) throw new Error(`no golden row reads ${secretName}`);
  const secret = { name: secretName, problem: "not_found" as const };
  return [...refused, { kind: row.kind, resource: row.resource, secret } as KubernetesDiscoveredDatabase];
}

/** A discovered id no export lists, and the 12-hex id of team-a/orders that earlier releases listed. */
const UNKNOWN = `k8s-cnpg-${"0".repeat(32)}`;
const LEGACY = "k8s-cnpg-75c1a60b8980";

// The hosts below are those of the default cluster domain.
delete process.env.SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN;

let kubernetes: KubernetesDiscoveryExportFixture;
let caprover: DiscoveryExportFixture;
let scratch = "";

function writeSeedFile(connections: Record<string, unknown>[]): void {
  const seedFile = path.join(scratch, "seed-connections.json");
  writeFileSync(seedFile, JSON.stringify({ version: "1", connections }));
  process.env.SEED_CONFIG_PATH = seedFile;
  resetCache();
}

describe("seed/index with the Kubernetes discovery source", () => {
  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "seed-index-kubernetes-"));
    resetCache();
    resetDiscoveryCache();
    resetKubernetesDiscoveryCache();
    kubernetes = writeKubernetesDiscoveryExport();
    caprover = writeDiscoveryExport([postgresService("pg", "caprover-password")]);
    process.env.SEED_KUBERNETES_DISCOVERY_PATH = kubernetes.path;
    process.env.SEED_DISCOVERY_PATH = caprover.path;
    writeSeedFile([{ id: "file-pg", name: "File PG", type: "postgres", host: "file-pg.internal", roles: ["*"] }]);
  });

  afterEach(() => {
    kubernetes.remove();
    caprover.remove();
    rmSync(scratch, { recursive: true, force: true });
    delete process.env.SEED_KUBERNETES_DISCOVERY_PATH;
    delete process.env.SEED_DISCOVERY_PATH;
    delete process.env.SEED_CONFIG_PATH;
    delete process.env.KUBERNETES_ACCESS_REVIEW;
    resetCache();
    resetDiscoveryCache();
    resetKubernetesDiscoveryCache();
  });

  it("lists the seed file, then CapRover, then Kubernetes", async () => {
    const seedIds = (await getManagedConnections(["admin"])).map((c) => c.seedId);
    expect(seedIds).toEqual(["file-pg", "caprover-pg", ...KUBERNETES_IDS]);
  });

  it("with the access review off, gives the admin role alone the connections, with both markers", async () => {
    const admin = (await getManagedConnections(["admin"])).filter((c) => c.seedId.startsWith("k8s-"));
    expect(admin.map((c) => [c.id, c.roles, c.literal, c.kubernetesSecret])).toEqual([
      [`seed:${ORDERS}`, ["admin"], true, { namespace: "team-a", name: "orders-app" }],
      [`seed:${ANALYTICS}`, ["admin"], true, { namespace: "team-b", name: "analytics-app" }],
      [`seed:${BILLING}`, ["admin"], true, { namespace: "prod", name: "billing-owner" }],
    ]);
    const user = (await getManagedConnections(["user"])).map((c) => c.seedId);
    expect(user).toEqual(["file-pg"]);
  });

  it.each([[["user"]], [["admin"]], [["auditor"]]])(
    "with the access review on, gives %p the connections with roles * and both markers, the review their only gate",
    async (roles) => {
      process.env.KUBERNETES_ACCESS_REVIEW = "on";
      const listed = (await getManagedConnections(roles)).filter((c) => c.seedId.startsWith("k8s-"));
      expect(listed.map((c) => c.seedId)).toEqual(KUBERNETES_IDS);
      for (const connection of listed) {
        expect(connection.roles).toEqual(["*"]);
        expect(connection.literal).toBe(true);
        expect(connection.kubernetesSecret).toBeDefined();
      }
    },
  );

  it("never lets a cached connection keep the roles of a switch that changed", async () => {
    expect((await getManagedConnections(["user"])).map((c) => c.seedId)).toEqual(["file-pg"]);
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    expect((await getManagedConnections(["user"])).map((c) => c.seedId)).toEqual(["file-pg", ...KUBERNETES_IDS]);
  });

  it("carries the connection the golden fixture names, with its password used as written", async () => {
    const orders = await getSeedConnectionById(ORDERS, ["admin"]);
    expect(orders).toMatchObject({
      name: "team-a/orders (CloudNativePG)",
      host: "orders-rw.team-a.svc.cluster.local.",
      port: 5432,
      database: "orders",
      user: "orders",
      password: "not-a-real-password-orders",
      ssl: { mode: "require" },
      managed: true,
      group: "team-a",
    });
    expect(orders?.mcp).toBeUndefined();
    expect(orders?.readOnly).toBeUndefined();
  });

  it("drops an id the seed file gains while the Kubernetes cache is warm", async () => {
    expect((await getManagedConnections(["admin"])).map((c) => c.seedId)).toContain(ORDERS);
    writeSeedFile([{ id: ORDERS, name: "File seed", type: "postgres", host: "db.internal", roles: ["admin"] }]);
    // Control: the loader's cache, which this test did not reset, still lists the id.
    expect((await getKubernetesDiscoveredConnections()).map((c) => c.connection.id)).toContain(ORDERS);

    const clashing = (await getManagedConnections(["admin"])).filter((c) => c.seedId === ORDERS);
    expect(clashing).toHaveLength(1);
    expect(clashing[0]?.host).toBe("db.internal");
    expect(clashing[0]?.kubernetesSecret).toBeUndefined();
    expect(clashing[0]?.literal).toBeUndefined();
  });

  it("does not find a Kubernetes-discovered id through the unfiltered lookup", async () => {
    expect((await getSeedConnectionById(ORDERS, ["admin"]))?.seedId).toBe(ORDERS);
    expect(await getSeedConnectionByIdUnfiltered(ORDERS)).toBeNull();
  });

  it("lists every kind's row, and answers a refused PGO row's id and a 12-hex legacy id exactly like an unknown id", async () => {
    const analyst = GOLDEN_CASES.find((c) => c.secretName === "analytics-pguser-analyst");
    if (analyst === undefined) throw new Error("the golden fixture has no PGO analyst case");
    kubernetes.write({
      databases: withRefused(goldenDatabases(ALL_KINDS), analyst.secretName),
    });
    resetKubernetesDiscoveryCache();
    const listed = (await getManagedConnections(["admin"]))
      .filter((c) => c.seedId.startsWith("k8s-"))
      .map((c) => c.seedId);
    expect(listed.sort()).toEqual(
      GOLDEN_CASES.map((c) => c.connectionId)
        .filter((id) => id !== analyst.connectionId)
        .sort(),
    );
    expect(LEGACY.startsWith(ORDERS.slice(0, 21))).toBe(true);
    const found = await Promise.all(
      [analyst.connectionId, LEGACY, UNKNOWN].map((id) => getSeedConnectionById(id, ["admin"])),
    );
    expect(found).toEqual([null, null, null]);
    expect((await getSeedConnectionById(ORDERS, ["admin"]))?.seedId).toBe(ORDERS);
  });

  it("keeps a reference in a Secret value literal: nothing in it is resolved from Studio's environment", async () => {
    kubernetes.write({
      databases: [
        {
          kind: "cnpg",
          resource: { metadata: { namespace: "team-a", name: "orders" } },
          secret: {
            name: "orders-app",
            data: { username: "${ADMIN_USER}", password: "${JWT_SECRET}", dbname: "orders", port: "5432" },
          },
        },
      ],
    });
    resetKubernetesDiscoveryCache();
    const orders = await getSeedConnectionById(ORDERS, ["admin"]);
    expect(orders?.password).toBe("${JWT_SECRET}");
    expect(orders?.user).toBe("${ADMIN_USER}");
    expect(orders?.literal).toBe(true);
  });
});

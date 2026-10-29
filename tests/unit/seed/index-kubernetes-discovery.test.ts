/**
 * How src/lib/seed/index.ts merges the Kubernetes-discovered connections into the seed listing: after the seed file
 * and CapRover, before the samples. While the Kubernetes access review is on they are set apart in `pendingReview`,
 * carrying the reserved role the role filter never selects, so the review is their only gate and no caller of
 * getManagedConnections ever receives one; with it off they are in `before` under `admin`. Either way they carry the
 * literal marker and the Secret marker the review reads. The export is read through the real loader from a temporary
 * file.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getManagedConnections,
  getSeedConnectionByIdUnfiltered,
  getSeedListing,
  type ManagedConnection,
  resetCache,
} from "@/lib/seed";
import { resetDiscoveryCache } from "@/lib/seed/discovery-loader";
import {
  getKubernetesDiscoveredConnections,
  resetKubernetesDiscoveryCache,
} from "@/lib/seed/kubernetes-discovery-loader";
import { SAMPLE_SEED_ID } from "@/lib/seed/libredb-sample";
import { KUBERNETES_REVIEWED_ROLE } from "@/lib/seed/roles";
import { SQLITE_SAMPLE_SEED_ID } from "@/lib/seed/sqlite-sample";
import { postgresService, writeDiscoveryExport, type DiscoveryExportFixture } from "../../helpers/discovery-fixture";
import {
  writeKubernetesDiscoveryExport,
  type KubernetesDiscoveryExportFixture,
} from "../../helpers/kubernetes-discovery-fixture";

const ORDERS = "k8s-cnpg-75c1a60b8980";
const ANALYTICS = "k8s-cnpg-d06590026498";
const BILLING = "k8s-cnpg-37c1c823437f";
const KUBERNETES_IDS = [ORDERS, ANALYTICS, BILLING];

// The hosts below are those of the default cluster domain.
delete process.env.SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN;

let kubernetes: KubernetesDiscoveryExportFixture;
let caprover: DiscoveryExportFixture;
let scratch = "";

const seedIds = (connections: readonly ManagedConnection[]): string[] => connections.map((c) => c.seedId);

/** The connection `seedId` as the admin role's list carries it while the review is off. */
async function listedForAdmin(seedId: string): Promise<ManagedConnection | undefined> {
  return (await getManagedConnections(["admin"])).find((c) => c.seedId === seedId);
}

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
    delete process.env.GOVERNANCE_SOURCE;
    delete process.env.SQLITE_EMBEDDED_SAMPLE_PATH;
    delete process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
    delete process.env.LIBREDB_EMBEDDED_SAMPLE;
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

  it("with the access review off, lists them in before under admin and sets none apart", async () => {
    const admin = await getSeedListing(["admin"]);
    expect(seedIds(admin.before)).toEqual(["file-pg", "caprover-pg", ...KUBERNETES_IDS]);
    expect(admin.pendingReview).toEqual([]);
    const user = await getSeedListing(["user"]);
    expect(seedIds(user.before)).toEqual(["file-pg"]);
    expect(user.pendingReview).toEqual([]);
  });

  it.each([
    ["*", ["*"]],
    ["user", ["user"]],
    ["admin", ["admin"]],
    ["a claim role", ["auditor"]],
    ["the reserved role itself", [KUBERNETES_REVIEWED_ROLE]],
  ])(
    "with the access review on, sets every one apart for %s, with the reserved role and both markers, the review its only gate",
    async (_caller, roles) => {
      process.env.KUBERNETES_ACCESS_REVIEW = "on";
      const { before, pendingReview, after } = await getSeedListing(roles);
      expect(seedIds(pendingReview)).toEqual(KUBERNETES_IDS);
      expect(pendingReview.map((c) => [c.id, c.roles, c.literal, c.kubernetesSecret])).toEqual([
        [`seed:${ORDERS}`, [KUBERNETES_REVIEWED_ROLE], true, { namespace: "team-a", name: "orders-app" }],
        [`seed:${ANALYTICS}`, [KUBERNETES_REVIEWED_ROLE], true, { namespace: "team-b", name: "analytics-app" }],
        [`seed:${BILLING}`, [KUBERNETES_REVIEWED_ROLE], true, { namespace: "prod", name: "billing-owner" }],
      ]);
      expect([...before, ...after].filter((c) => c.seedId.startsWith("k8s-"))).toEqual([]);
      expect((await getManagedConnections(roles)).filter((c) => c.seedId.startsWith("k8s-"))).toEqual([]);
    },
  );

  it("keeps the list's order: before, then the rows set apart, then the samples", async () => {
    const sqliteSample = path.join(scratch, "sample-employees.db");
    const libredbSample = path.join(scratch, "sample.libredb");
    writeFileSync(sqliteSample, "");
    writeFileSync(libredbSample, "");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = sqliteSample;
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = libredbSample;
    // The review holds the LibreDB sample unless it is asked for, so it is asked for, to fill every section.
    process.env.LIBREDB_EMBEDDED_SAMPLE = "true";
    // Control: with the review off the admin role's list holds every section in this order.
    expect(seedIds(await getManagedConnections(["admin"]))).toEqual([
      "file-pg",
      "caprover-pg",
      ...KUBERNETES_IDS,
      SQLITE_SAMPLE_SEED_ID,
      SAMPLE_SEED_ID,
    ]);

    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    const { before, pendingReview, after } = await getSeedListing(["admin"]);
    expect([seedIds(before), seedIds(pendingReview), seedIds(after)]).toEqual([
      ["file-pg", "caprover-pg"],
      KUBERNETES_IDS,
      [SQLITE_SAMPLE_SEED_ID, SAMPLE_SEED_ID],
    ]);
    expect(seedIds(await getManagedConnections(["admin"]))).toEqual([
      "file-pg",
      "caprover-pg",
      SQLITE_SAMPLE_SEED_ID,
      SAMPLE_SEED_ID,
    ]);
  });

  it("drops an id an operator source declares from the rows set apart, whichever role the entry is for", async () => {
    writeSeedFile([{ id: ORDERS, name: "File seed", type: "postgres", host: "db.internal", roles: ["admin"] }]);
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    const [admin, user] = await Promise.all([getSeedListing(["admin"]), getSeedListing(["user"])]);
    for (const { before, pendingReview } of [admin, user]) {
      expect(seedIds(pendingReview)).toEqual([ANALYTICS, BILLING]);
      expect(before.filter((c) => c.kubernetesSecret !== undefined)).toEqual([]);
    }
    expect(admin.before.find((c) => c.seedId === ORDERS)?.host).toBe("db.internal");
  });

  it("never lets a cached connection keep the section of a switch that changed", async () => {
    expect(seedIds((await getSeedListing(["user"])).pendingReview)).toEqual([]);
    expect(seedIds(await getManagedConnections(["admin"]))).toContain(ORDERS);
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    expect(seedIds((await getSeedListing(["user"])).pendingReview)).toEqual(KUBERNETES_IDS);
    expect(seedIds(await getManagedConnections(["admin"]))).not.toContain(ORDERS);
    delete process.env.KUBERNETES_ACCESS_REVIEW;
    expect(seedIds((await getSeedListing(["user"])).pendingReview)).toEqual([]);
  });

  it("under governance sets nothing apart and reads no export, whatever the review switch says", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    // Control: without governance every Kubernetes row is set apart, read from the export.
    expect(seedIds((await getSeedListing(["admin"])).pendingReview)).toEqual(KUBERNETES_IDS);
    resetCache();
    resetDiscoveryCache();
    resetKubernetesDiscoveryCache();
    const open = spyOn(fsPromises, "open");
    try {
      process.env.GOVERNANCE_SOURCE = "postgres";
      expect(await getSeedListing(["admin"])).toEqual({ before: [], pendingReview: [], after: [] });
      expect(await getSeedListing(["user"])).toEqual({ before: [], pendingReview: [], after: [] });
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it("carries the connection the golden fixture names, with its password used as written", async () => {
    const orders = await listedForAdmin(ORDERS);
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
    expect((await listedForAdmin(ORDERS))?.seedId).toBe(ORDERS);
    expect(await getSeedConnectionByIdUnfiltered(ORDERS)).toBeNull();
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
    const orders = await listedForAdmin(ORDERS);
    expect(orders?.password).toBe("${JWT_SECRET}");
    expect(orders?.user).toBe("${ADMIN_USER}");
    expect(orders?.literal).toBe(true);
  });
});

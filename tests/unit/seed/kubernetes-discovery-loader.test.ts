/**
 * The Kubernetes discovery source: the export the exporter writes into its Secret, as the kubelet projects it into
 * Studio's pod, read through the real loader with the clock and the seed-file ids pinned.
 *
 * Its freshness, staleness, cache and logging rules are the CapRover source's (discovery-source.ts), so these cases
 * mirror tests/unit/seed/discovery-loader.test.ts for the parts that are the Kubernetes source's own: its variables,
 * its default maximum age, its messages, its namespaces, its mapping and its skipped entries.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const debug = mock(() => {});
const info = mock(() => {});
const warn = mock(() => {});
const error = mock(() => {});
mock.module("@/lib/logger", () => ({
  logger: { debug, info, warn, error },
}));

import { resetCache } from "@/lib/seed";
import type { KubernetesDiscoveryExport } from "@/lib/seed/kubernetes-discovery-export";
import {
  getKubernetesDiscoveredConnections,
  getKubernetesDiscoveryStatus,
  resetKubernetesDiscoveryCache,
  type KubernetesDiscoveryDeps,
  type KubernetesDiscoveryStatus,
} from "@/lib/seed/kubernetes-discovery-loader";
import { goldenDatabases, kubernetesExport } from "../../helpers/kubernetes-discovery-fixture";

const T0 = Date.parse("2026-10-28T08:00:00.000Z");
const MAX_AGE_MS = 180_000;
const ROUTE = "seed/kubernetes-discovery-loader";
const OK = "The Kubernetes discovery exporter's last scan is current";
const WAITING = "Waiting for the Kubernetes discovery exporter's export";
const HINT =
  "No export yet: the exporter may not be running, or its export Secret may not be mounted into Studio's pod";
const PASSWORDS = goldenDatabases().map((entry) => entry.secret.data?.password as string);
const SHARED = "id shared with another discovered database, so both are left out";

let dir = "";
let file = "";
let clock = T0;
let taken = new Set<string>();

function write(overrides: Partial<KubernetesDiscoveryExport> = {}): void {
  writeFileSync(file, JSON.stringify(kubernetesExport(clock, overrides)));
}

function deps(extra: KubernetesDiscoveryDeps = {}): KubernetesDiscoveryDeps {
  return { now: () => clock, fileSeedIds: async () => taken, ...extra };
}

async function statusNow(extra: KubernetesDiscoveryDeps = {}): Promise<KubernetesDiscoveryStatus> {
  const status = await getKubernetesDiscoveryStatus(deps(extra));
  if (status === null) throw new Error("discovery is off");
  return status;
}

async function ids(): Promise<string[]> {
  return (await getKubernetesDiscoveredConnections(deps())).map((entry) => entry.connection.id);
}

describe("kubernetes-discovery-loader", () => {
  beforeEach(() => {
    resetKubernetesDiscoveryCache();
    resetCache();
    for (const logger of [debug, info, warn, error]) logger.mockClear();
    clock = T0;
    taken = new Set<string>();
    dir = mkdtempSync(path.join(tmpdir(), "kubernetes-discovery-loader-"));
    file = path.join(dir, "export.json");
    process.env.SEED_KUBERNETES_DISCOVERY_PATH = file;
    process.env.SEED_CACHE_TTL_MS = "10000";
    delete process.env.SEED_KUBERNETES_DISCOVERY_MAX_AGE_MS;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SEED_KUBERNETES_DISCOVERY_PATH;
    delete process.env.SEED_KUBERNETES_DISCOVERY_MAX_AGE_MS;
    delete process.env.SEED_CACHE_TTL_MS;
    resetKubernetesDiscoveryCache();
  });

  describe("the off switch", () => {
    it.each([[undefined], [""], ["   "]])("is off when SEED_KUBERNETES_DISCOVERY_PATH is %p", async (value) => {
      if (value === undefined) delete process.env.SEED_KUBERNETES_DISCOVERY_PATH;
      else process.env.SEED_KUBERNETES_DISCOVERY_PATH = value;
      write();
      expect(await getKubernetesDiscoveredConnections(deps())).toEqual([]);
      expect(await getKubernetesDiscoveryStatus(deps())).toBeNull();
    });
  });

  describe("state", () => {
    it("lists the databases of a fresh export, each with the Secret its credentials came from", async () => {
      write();
      const listed = await getKubernetesDiscoveredConnections(deps());
      expect(listed.map((entry) => [entry.connection.id, entry.secret])).toEqual([
        ["k8s-cnpg-75c1a60b898072af828207cff435c7e5", { namespace: "team-a", name: "orders-app" }],
        ["k8s-cnpg-d0659002649870172fb93e83e6bfda2d", { namespace: "team-b", name: "analytics-app" }],
        ["k8s-cnpg-37c1c823437fce5734f68e0b5f65b3d3", { namespace: "prod", name: "billing-owner" }],
      ]);
      expect(listed[0].connection).toMatchObject({ roles: ["admin"], managed: true, ssl: { mode: "require" } });
      expect(await statusNow()).toEqual({
        state: "ok",
        message: OK,
        generatedAt: new Date(T0).toISOString(),
        checkedAt: new Date(T0).toISOString(),
        error: null,
        namespaces: [
          { name: "prod", error: null },
          { name: "team-a", error: null },
          { name: "team-b", error: null },
        ],
        connected: [
          { name: "team-a/orders (CloudNativePG)", type: "postgres" },
          { name: "team-b/analytics (CloudNativePG)", type: "postgres" },
          { name: "prod/billing-db (CloudNativePG)", type: "postgres" },
        ],
        skipped: [],
      });
    });

    it("shows a namespace the exporter could not read with its code and message", async () => {
      write({
        namespaces: [
          { name: "team-a", status: { ok: true } },
          {
            name: "team-b",
            status: { ok: false, code: "forbidden", httpStatus: 403, message: "the exporter may not list clusters" },
          },
        ],
        databases: goldenDatabases().slice(0, 1),
      });
      const status = await statusNow();
      expect(status.state).toBe("ok");
      expect(status.namespaces).toEqual([
        { name: "team-a", error: null },
        { name: "team-b", error: { code: "forbidden", message: "the exporter may not list clusters" } },
      ]);
      expect(await ids()).toEqual(["k8s-cnpg-75c1a60b898072af828207cff435c7e5"]);
    });

    it("waits while the export file is missing, then hints at its placement after twice the maximum age", async () => {
      expect(await statusNow()).toMatchObject({ state: "waiting", message: WAITING, namespaces: [], connected: [] });
      clock = T0 + 2 * MAX_AGE_MS + 1;
      expect(await statusNow()).toMatchObject({ state: "waiting", message: HINT });
    });

    it("refuses an export that does not parse as invalid_export, without quoting it", async () => {
      writeFileSync(file, JSON.stringify({ ...kubernetesExport(clock), platform: "caprover" }));
      const status = await statusNow();
      expect(status).toMatchObject({
        state: "error",
        error: {
          code: "invalid_export",
          message:
            "The export file is not a valid discovery export: the file does not match the export schema at platform (invalid_value)",
        },
      });
      expect(await ids()).toEqual([]);
    });

    it("refuses an export file over 1 MiB by its size, without reading it", async () => {
      writeFileSync(file, " ".repeat(1024 * 1024 + 1));
      expect((await statusNow()).error).toEqual({
        code: "invalid_export",
        message: "The export file is over the 1048576-byte limit, so it was not read",
      });
    });

    it("reports the exporter's error before its first successful scan", async () => {
      write({
        generatedAt: null,
        status: { ok: false, code: "api_error", httpStatus: 500, message: "the API server answered HTTP 500" },
        namespaces: [],
        databases: [],
      });
      expect(await statusNow()).toMatchObject({
        state: "error",
        message: "the API server answered HTTP 500",
        generatedAt: null,
        error: { code: "api_error", message: "the API server answered HTTP 500" },
      });
    });

    it("serves the last good scan while the exporter reports an error", async () => {
      write({ status: { ok: false, code: "api_unreachable", message: "ECONNREFUSED" } });
      expect(await statusNow()).toMatchObject({
        state: "error",
        message: "ECONNREFUSED",
        error: { code: "api_unreachable", message: "ECONNREFUSED" },
      });
      expect(await ids()).toHaveLength(3);
    });

    it("withdraws every connection once the last successful scan is older than 180 seconds by default", async () => {
      write();
      clock = T0 + MAX_AGE_MS;
      expect(await ids()).toHaveLength(3);
      clock = T0 + MAX_AGE_MS + 1;
      expect(await statusNow()).toEqual({
        state: "stale",
        message:
          "The last successful scan is older than SEED_KUBERNETES_DISCOVERY_MAX_AGE_MS (180000 ms), so its connections are withdrawn",
        generatedAt: new Date(T0).toISOString(),
        checkedAt: new Date(T0).toISOString(),
        error: null,
        namespaces: [],
        connected: [],
        skipped: [],
      });
      expect(await ids()).toEqual([]);
    });

    it("takes its maximum age from SEED_KUBERNETES_DISCOVERY_MAX_AGE_MS", async () => {
      process.env.SEED_KUBERNETES_DISCOVERY_MAX_AGE_MS = "30000";
      write();
      clock = T0 + 30_001;
      expect((await statusNow()).state).toBe("stale");
    });

    it.each([["0"], ["-1"], ["soon"]])("keeps the default maximum age when the variable is %p", async (value) => {
      process.env.SEED_KUBERNETES_DISCOVERY_MAX_AGE_MS = value;
      write();
      clock = T0 + 30_001;
      expect((await statusNow()).state).toBe("ok");
    });

    it("re-reads the export at most once per SEED_CACHE_TTL_MS", async () => {
      write();
      expect(await ids()).toHaveLength(3);
      write({ databases: goldenDatabases().slice(0, 1) });
      clock = T0 + 9_999;
      expect(await ids()).toHaveLength(3);
      clock = T0 + 10_000;
      expect(await ids()).toHaveLength(1);
    });
  });

  describe("skipped databases", () => {
    it("skips a database whose mapping fails, by <namespace>/<name> with the reason, and lists the others", async () => {
      const [orders, ...rest] = goldenDatabases();
      write({ databases: [{ ...orders, secret: { name: "orders-app", problem: "not_found" } }, ...rest] });
      expect(await ids()).toEqual([
        "k8s-cnpg-d0659002649870172fb93e83e6bfda2d",
        "k8s-cnpg-37c1c823437fce5734f68e0b5f65b3d3",
      ]);
      expect((await statusNow()).skipped).toEqual([
        { resource: "team-a/orders", reason: "the credential Secret orders-app does not exist" },
      ]);
    });

    it("skips a discovered id the seed file already uses", async () => {
      taken = new Set(["k8s-cnpg-75c1a60b898072af828207cff435c7e5"]);
      write();
      expect(await ids()).toEqual([
        "k8s-cnpg-d0659002649870172fb93e83e6bfda2d",
        "k8s-cnpg-37c1c823437fce5734f68e0b5f65b3d3",
      ]);
      expect((await statusNow()).skipped).toEqual([{ resource: "team-a/orders", reason: "id taken by the seed file" }]);
    });

    // A MongoDB row's key names its user but not the database the user authenticates against, so two users of one
    // name in two databases of one resource share an id, and neither may stand for the other.
    it("refuses both MongoDB users of one name that authenticate against different databases", async () => {
      const [appuser] = goldenDatabases(["mongo"]);
      const other = structuredClone(appuser);
      (other.resource.spec as { users: { db?: string }[] }).users[0].db = "catalog";
      other.secret = { ...other.secret, name: "catalog-catalog-appuser" };
      write({ namespaces: [{ name: "team-m", status: { ok: true } }], databases: [appuser, other] });
      expect(await ids()).toEqual([]);
      expect((await statusNow()).skipped).toEqual([
        { resource: "team-m/catalog/appuser", reason: SHARED },
        { resource: "team-m/catalog/appuser", reason: SHARED },
      ]);
    });

    it("refuses both of two entries for the same database", async () => {
      const [orders] = goldenDatabases();
      write({ databases: [orders, orders] });
      expect(await ids()).toEqual([]);
      expect((await statusNow()).skipped).toEqual([
        { resource: "team-a/orders", reason: SHARED },
        { resource: "team-a/orders", reason: SHARED },
      ]);
    });

    // List order is the namespaces' editors' to choose, so neither of two rows sharing an id may win.
    it("two rows with one id are both refused, with the digest seam forcing it", async () => {
      write();
      const digest = (key: string) => (key === "prod/billing-db" ? "b" : "a").repeat(64);
      const listed = await getKubernetesDiscoveredConnections(deps({ digest }));
      expect(listed.map((entry) => entry.connection.id)).toEqual([`k8s-cnpg-${"b".repeat(32)}`]);
      expect((await statusNow({ digest })).skipped).toEqual([
        { resource: "team-a/orders", reason: SHARED },
        { resource: "team-b/analytics", reason: SHARED },
      ]);
    });

    it("a seed-file id still wins over discovered rows that share it", async () => {
      write();
      const digest = () => "c".repeat(64);
      taken = new Set([`k8s-cnpg-${"c".repeat(32)}`]);
      expect(await getKubernetesDiscoveredConnections(deps({ digest }))).toEqual([]);
      expect((await statusNow({ digest })).skipped).toEqual([
        { resource: "team-a/orders", reason: "id taken by the seed file" },
        { resource: "team-b/analytics", reason: "id taken by the seed file" },
        { resource: "prod/billing-db", reason: "id taken by the seed file" },
      ]);
    });

    it("skipped resource is the id key, in the export's order", async () => {
      const [orders, ...rest] = goldenDatabases();
      const analyst = {
        kind: "pgo" as const,
        resource: { metadata: { namespace: "team-b", name: "analytics" }, spec: { users: [{ name: "analyst" }] } },
        secret: { name: "analytics-pguser-analyst", problem: "not_found" as const },
      };
      write({ databases: [orders, analyst, orders, ...rest] });
      expect((await statusNow()).skipped).toEqual([
        { resource: "team-a/orders", reason: SHARED },
        {
          resource: "team-b/analytics/analyst",
          reason: "the credential Secret analytics-pguser-analyst does not exist",
        },
        { resource: "team-a/orders", reason: SHARED },
      ]);
    });

    it("reads the taken ids from the seed file by default", async () => {
      const seedFile = path.join(dir, "seed-connections.yaml");
      writeFileSync(
        seedFile,
        [
          'version: "1"',
          "connections:",
          "  - id: k8s-cnpg-75c1a60b898072af828207cff435c7e5",
          "    name: File seed",
          "    type: postgres",
          "    host: db.internal",
          "    roles: [admin]",
          "",
        ].join("\n"),
      );
      process.env.SEED_CONFIG_PATH = seedFile;
      try {
        write();
        const status = await getKubernetesDiscoveryStatus({ now: () => clock });
        expect(status?.skipped).toEqual([{ resource: "team-a/orders", reason: "id taken by the seed file" }]);
      } finally {
        delete process.env.SEED_CONFIG_PATH;
        resetCache();
      }
    });
  });

  describe("logging", () => {
    it("logs each skipped database once while it stays skipped, and a source error once", async () => {
      const [orders, ...rest] = goldenDatabases();
      write({ databases: [{ ...orders, secret: { name: "orders-app", problem: "forbidden" } }, ...rest] });
      await ids();
      clock = T0 + 10_000;
      write({ databases: [{ ...orders, secret: { name: "orders-app", problem: "forbidden" } }, ...rest] });
      await ids();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("Kubernetes-discovered database skipped", {
        route: ROUTE,
        resource: "team-a/orders",
        reason: "the exporter may not read the credential Secret orders-app",
      });

      warn.mockClear();
      writeFileSync(file, "{");
      clock = T0 + 20_000;
      await ids();
      clock = T0 + 30_000;
      await ids();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("Kubernetes discovery source error", {
        route: ROUTE,
        path: file,
        code: "invalid_export",
        reason: "The export file is not a valid discovery export: the file is not valid JSON",
      });
    });

    it("never writes a Secret value to a log line or to the status", async () => {
      const [orders, ...rest] = goldenDatabases();
      write({ databases: [{ ...orders, secret: { name: "orders-app", data: { password: PASSWORDS[0] } } }, ...rest] });
      const status = JSON.stringify(await statusNow());
      const logged = JSON.stringify(warn.mock.calls);
      for (const password of PASSWORDS) {
        expect(status).not.toContain(password);
        expect(logged).not.toContain(password);
      }
      expect(status).toContain("has no username");
    });
  });
});

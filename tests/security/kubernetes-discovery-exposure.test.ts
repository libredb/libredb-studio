/**
 * Kubernetes discovery exposure (docs/SECURITY.md rows 3.32 to 3.35).
 *
 * The discovery exporter's token can get every Secret of the namespaces it discovers, and the editors of those
 * namespaces choose the resources it reads, their user names and their Services. One adversarial fake cluster holds
 * the golden resources and, beside them, a resource for each way a namespace editor could try to have a Secret sent
 * where it does not belong: an ExternalName Service, a selector-less Service not controlled by the resource, one
 * controlled by another kind, a PGO user or a MongoDB user and database that compose another resource's key Secret
 * name, an initdb Secret that names the operator's key material, a Secret whose host was moved, and an SRV or foreign
 * MongoDB connection string.
 *
 * The exporter runs against it once, and Studio's discovery source reads what it wrote. What must hold: no reserved
 * or key-bearing Secret is requested and Secrets and Services are never listed or watched (row 3.32), no value of a
 * refused Secret reaches a log line, the export, Studio's skipped reasons or its connections (row 3.33), a refused
 * Service costs no Secret read (row 3.34), and Studio lists exactly the golden connections (row 3.35).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logged: unknown[] = [];
const record = mock((...args: unknown[]) => {
  logged.push(args);
});
mock.module("@/lib/logger", () => ({
  logger: { debug: record, info: record, warn: record, error: record },
}));

import {
  getKubernetesDiscoveredConnections,
  getKubernetesDiscoveryStatus,
  resetKubernetesDiscoveryCache,
} from "@/lib/seed/kubernetes-discovery-loader";
import { main } from "../../docker/discover-kubernetes.mjs";
import {
  FAKE_DISCOVERY_TOKEN,
  type FakeDiscoveryApi,
  ownerReference,
  startFakeDiscoveryApi,
} from "../helpers/kubernetes-discovery/fake-api";
import { GOLDEN_CASES } from "../helpers/kubernetes-discovery-fixture";

const T0 = Date.parse("2026-10-29T08:00:00.000Z");
const EXPORT_PATH = "/api/v1/namespaces/libredb-studio/secrets/libredb-studio-discovery-export";

let api: FakeDiscoveryApi;
let dir = "";
const out: string[] = [];

/** The values of every Secret no row may export: a password unique to each, and a private key. */
const REFUSED_VALUES: string[] = [];
/** The values of the Secrets the exporter exports but Studio refuses to map: a moved host, an SRV or foreign string. */
const UNMAPPED_VALUES: string[] = [];

/** A full CloudNativePG `<name>-app` Secret, tied to its Cluster, holding a password unique to `tag`. */
function appSecret(namespace: string, name: string, secretName: string, tag: string, owner?: Record<string, unknown>) {
  const password = `not-a-real-password-${tag}`;
  REFUSED_VALUES.push(password);
  api.addSecret(
    namespace,
    secretName,
    { username: `user-${tag}`, password, dbname: "app", port: "5432" },
    "kubernetes.io/basic-auth",
    {
      labels: { "cnpg.io/cluster": name },
      ...(owner === undefined ? {} : { ownerReferences: [owner] }),
    },
  );
}

/** A Secret holding key material, which a reserved name must keep out of every request. */
function keySecret(namespace: string, name: string, type = "kubernetes.io/tls") {
  const key = `not-a-real-private-key-${name}`;
  REFUSED_VALUES.push(key);
  api.addSecret(namespace, name, { "tls.key": key, "tls.crt": "not-a-real-certificate" }, type);
}

function seedAdversaries(): void {
  // An ExternalName Service in place of the read-write Service.
  const alias = api.addResource("cnpg", "team-a", "alias");
  api.addService("team-a", "alias-rw", { type: "ExternalName", owners: [ownerReference(alias)] });
  appSecret("team-a", "alias", "alias-app", "f1", ownerReference(alias));
  // A selector-less Service the Cluster does not control, as hand-made Endpoints would need.
  const endpoints = api.addResource("cnpg", "team-a", "endpoints");
  api.addService("team-a", "endpoints-rw", { selector: null });
  appSecret("team-a", "endpoints", "endpoints-app", "f2", ownerReference(endpoints));
  // A selector-less Service whose controller reference names another kind.
  const forged = api.addResource("cnpg", "team-a", "forged");
  api.addService("team-a", "forged-rw", { selector: null, owners: [{ ...ownerReference(forged), kind: "Pooler" }] });
  appSecret("team-a", "forged", "forged-app", "f3", ownerReference(forged));
  // A PGO user whose Secret name is another cluster's certificate Secret.
  const a = api.addResource("pgo", "team-b", "a", { users: [{ name: "b-cluster-cert", databases: ["a"] }] });
  api.addService("team-b", "a-primary", { selector: null, owners: [ownerReference(a)] });
  keySecret("team-b", "a-pguser-b-cluster-cert");
  keySecret("team-b", "analytics-cluster-cert");
  keySecret("team-b", "pgo-root-cacert", "Opaque");
  // MongoDB users whose computed or chosen Secret name is the operator's agent password or keyfile.
  api.addResource("mongo", "team-m", "vault", {
    users: [
      { name: "password", db: "agent", roles: [] },
      { name: "appuser", db: "admin", connectionStringSecretName: "catalog-keyfile", roles: [] },
    ],
  });
  keySecret("team-m", "vault-agent-password", "Opaque");
  keySecret("team-m", "catalog-keyfile", "Opaque");
  // initdb Secrets that name another Cluster's superuser Secret, and a CA the Cluster's spec names.
  api.addCluster("team-a", "sneaky", { bootstrap: { initdb: { secret: { name: "orders-superuser" } } } });
  appSecret("team-a", "orders", "orders-superuser", "f6-superuser");
  api.addCluster("team-a", "sneaky-ca", {
    certificates: { serverCASecret: "trust-store" },
    bootstrap: { initdb: { secret: { name: "trust-store" } } },
  });
  keySecret("team-a", "trust-store", "kubernetes.io/basic-auth");
  // A PGO Secret whose host was moved; the exporter keeps it, Studio refuses to map it.
  const moved = api.addResource("pgo", "team-f", "moved");
  api.addService("team-f", "moved-primary", { selector: null, owners: [ownerReference(moved)] });
  UNMAPPED_VALUES.push("not-a-real-password-f7");
  api.addSecret(
    "team-f",
    "moved-pguser-moved",
    {
      user: "moved",
      password: "not-a-real-password-f7",
      host: "evil.example.com",
      port: "5432",
      dbname: "moved",
    },
    "Opaque",
    { ownerReferences: [ownerReference(moved)] },
  );
  // MongoDB connection strings that name an SRV record or a host outside the resource's pods.
  const srv = api.addResource("mongo", "team-f", "srv", {
    users: [
      { name: "srvuser", db: "admin", roles: [{ db: "srv" }] },
      { name: "outuser", db: "admin", roles: [{ db: "srv" }] },
    ],
  });
  api.addService("team-f", "srv-svc", { selector: { app: "srv-svc" }, owners: [ownerReference(srv)] });
  for (const [user, uri] of [
    ["srvuser", "mongodb+srv://srvuser:not-a-real-password-f8a@srv-svc.team-f.svc.cluster.local/admin"],
    ["outuser", "mongodb://outuser:not-a-real-password-f8b@evil.example.com:27017/admin?proxyHost=evil.example.com"],
  ]) {
    UNMAPPED_VALUES.push(`not-a-real-password-${user === "srvuser" ? "f8a" : "f8b"}`);
    api.addSecret(
      "team-f",
      `srv-admin-${user}`,
      {
        "connectionString.standard": uri,
        username: user,
        password: `not-a-real-password-${user === "srvuser" ? "f8a" : "f8b"}`,
      },
      "Opaque",
      { ownerReferences: [ownerReference(srv)] },
    );
  }
}

/** Every Secret name no request may name. */
const NEVER_REQUESTED = [
  "alias-app",
  "endpoints-app",
  "forged-app",
  "a-pguser-b-cluster-cert",
  "analytics-cluster-cert",
  "pgo-root-cacert",
  "vault-agent-password",
  "catalog-keyfile",
  "orders-superuser",
  "trust-store",
];

let written = "";
let exportText = "";

beforeAll(async () => {
  api = await startFakeDiscoveryApi();
  for (const c of GOLDEN_CASES) api.addGoldenCase(c);
  seedAdversaries();
  const namespaces = [...new Set([...GOLDEN_CASES.map((c) => c.resource.metadata.namespace), "team-f"])].join(",");
  const code = await main({
    env: api.env({ KUBERNETES_DISCOVERY_NAMESPACES: namespaces, KUBERNETES_DISCOVERY_KINDS: "cnpg,edbpg,pgo,mongo" }),
    now: () => T0,
    stdout: (chunk: string) => out.push(chunk),
    stderr: (chunk: string) => out.push(chunk),
  });
  expect(code).toBe(0);
  exportText = JSON.stringify(api.writtenExport());
  dir = mkdtempSync(join(tmpdir(), "kubernetes-discovery-exposure-"));
  written = join(dir, "export.json");
  writeFileSync(written, exportText);
  process.env.SEED_KUBERNETES_DISCOVERY_PATH = written;
  delete process.env.SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN;
  resetKubernetesDiscoveryCache();
});

afterAll(async () => {
  delete process.env.SEED_KUBERNETES_DISCOVERY_PATH;
  rmSync(dir, { recursive: true, force: true });
  await api.close();
});

const deps = { now: () => T0, fileSeedIds: async () => new Set<string>() };

describe("Kubernetes discovery exposure", () => {
  test("no reserved or key-bearing Secret is requested, whatever the resource says (row 3.32)", () => {
    const requested = api.seen
      .map((seen) => seen.path)
      .filter((path) => path.startsWith("/api/v1/namespaces/") && path.includes("/secrets/") && path !== EXPORT_PATH)
      .map((path) => path.split("/").pop());
    for (const name of NEVER_REQUESTED) expect(requested).not.toContain(name);
    const expected = [
      ...GOLDEN_CASES.map((c) => c.secretName),
      "moved-pguser-moved",
      "srv-admin-srvuser",
      "srv-admin-outuser",
    ];
    expect([...requested].sort()).toEqual([...new Set(expected)].sort());
  });

  test("Secrets and Services are never listed or watched, and nothing but the export is written (row 3.32)", () => {
    for (const seen of api.seen) {
      expect(seen.path).not.toMatch(/\/(secrets|services)(\?|$)/);
      expect(seen.path).not.toContain("watch");
      if (seen.method !== "GET") expect(`${seen.method} ${seen.path}`).toBe(`PUT ${EXPORT_PATH}`);
    }
  });

  test("a row whose Service is ExternalName or not controlled by its resource is refused before its Secret (row 3.34)", () => {
    const exported = JSON.parse(exportText) as {
      databases: { resource: { metadata: { name: string } }; secret: unknown }[];
    };
    const secretOf = (name: string) =>
      exported.databases.find((entry) => entry.resource.metadata.name === name)?.secret;
    expect(secretOf("alias")).toEqual({ name: "alias-app", problem: "service_external_name" });
    expect(secretOf("endpoints")).toEqual({ name: "endpoints-app", problem: "service_not_controlled" });
    expect(secretOf("forged")).toEqual({ name: "forged-app", problem: "service_not_controlled" });
  });

  test("no value of a refused Secret reaches the exporter's log, the export, Studio's status, logs or connections (row 3.33)", async () => {
    const connections = await getKubernetesDiscoveredConnections(deps);
    const status = await getKubernetesDiscoveryStatus(deps);
    const studio = JSON.stringify({ status, logged });
    const everywhere = [out.join(""), exportText, studio, JSON.stringify(connections)];
    for (const value of REFUSED_VALUES) {
      for (const text of everywhere) expect(text).not.toContain(value);
    }
    // A Secret the exporter kept but Studio refused to map leaves its values in the export alone.
    for (const value of UNMAPPED_VALUES) {
      expect(studio).not.toContain(value);
      expect(JSON.stringify(connections)).not.toContain(value);
      expect(out.join("")).not.toContain(value);
    }
    for (const text of [...everywhere, JSON.stringify(api.seen.map((seen) => [seen.path, seen.body]))]) {
      expect(text).not.toContain(FAKE_DISCOVERY_TOKEN);
    }
    expect(studio).not.toContain("evil.example.com");
  });

  test("Studio lists exactly the golden connections, and skips every adversarial row by its id key (row 3.35)", async () => {
    const connections = await getKubernetesDiscoveredConnections(deps);
    expect(connections.map((entry) => entry.connection.id).sort()).toEqual(
      GOLDEN_CASES.map((c) => c.connectionId).sort(),
    );
    for (const c of GOLDEN_CASES) {
      const listed = connections.find((entry) => entry.connection.id === c.connectionId);
      expect(listed?.connection).toMatchObject(c.connection);
      expect(listed?.secret).toEqual({ namespace: c.resource.metadata.namespace, name: c.secretName });
    }
    const status = await getKubernetesDiscoveryStatus(deps);
    expect(status?.skipped.map((entry) => entry.resource).sort()).toEqual(
      [
        "team-a/alias",
        "team-a/endpoints",
        "team-a/forged",
        "team-a/sneaky",
        "team-a/sneaky-ca",
        "team-b/a/b-cluster-cert",
        "team-m/vault/password",
        "team-m/vault/appuser",
        "team-f/moved/moved",
        "team-f/srv/srvuser",
        "team-f/srv/outuser",
      ].sort(),
    );
  });
});

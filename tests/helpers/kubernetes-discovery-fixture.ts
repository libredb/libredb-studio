/**
 * Export files for the tests of the Kubernetes discovery source (docs/SEED_CONNECTIONS.md, "Platform discovery
 * (Kubernetes)").
 *
 * Each one is written to its own temporary directory in the exporter's shape and read back through the real loader,
 * so a test that lists or opens a discovered connection exercises the parse, the mapping and the merge it depends on
 * rather than a stand-in for them. The golden fixture's cases are the databases unless a test names others.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import golden from "../fixtures/kubernetes-discovery-golden.json";
import type { KubernetesDiscoveredDatabase, KubernetesDiscoveryExport } from "@/lib/seed/kubernetes-discovery-export";

export interface KubernetesDiscoveryExportFixture {
  /** The export file: what SEED_KUBERNETES_DISCOVERY_PATH names. */
  readonly path: string;
  /** Rewrites the file with another export, as the kubelet does when the Secret changes. */
  write(overrides?: Partial<KubernetesDiscoveryExport>): void;
  /** Removes the temporary directory and everything in it. */
  remove(): void;
}

/** The golden fixture's databases as the exporter writes them: the contract's fields and kept keys only. */
export function goldenDatabases(): KubernetesDiscoveredDatabase[] {
  return golden.cases.map((c) => {
    const initdb = (c.resource.spec as { bootstrap?: { initdb?: { database?: string; secret?: { name: string } } } })
      .bootstrap?.initdb;
    const { username, password, dbname, port } = c.secretData as Record<string, string | undefined>;
    return {
      kind: "cnpg",
      resource: {
        metadata: { namespace: c.resource.metadata.namespace, name: c.resource.metadata.name },
        ...(initdb === undefined
          ? {}
          : {
              spec: {
                bootstrap: {
                  initdb: {
                    ...(initdb.database === undefined ? {} : { database: initdb.database }),
                    ...(initdb.secret === undefined ? {} : { secret: { name: initdb.secret.name } }),
                  },
                },
              },
            }),
      },
      secret: {
        name: c.secretName,
        data: Object.fromEntries(
          Object.entries({ username, password, dbname, port }).filter(([, value]) => value !== undefined),
        ),
      },
    };
  });
}

/** A fresh export at `now`: an ok scan of the golden namespaces and databases, unless overridden. */
export function kubernetesExport(
  now: number,
  overrides: Partial<KubernetesDiscoveryExport> = {},
): KubernetesDiscoveryExport {
  const at = new Date(now).toISOString();
  const databases = goldenDatabases();
  const namespaces = [...new Set(databases.map((entry) => entry.resource.metadata.namespace))]
    .sort()
    .map((name) => ({ name, status: { ok: true as const } }));
  return {
    version: 2,
    platform: "kubernetes",
    generatedAt: at,
    checkedAt: at,
    status: { ok: true },
    namespaces,
    databases,
    ...overrides,
  };
}

/** Writes an export into a temporary directory, fresh against the real clock unless overridden. */
export function writeKubernetesDiscoveryExport(
  overrides: Partial<KubernetesDiscoveryExport> = {},
): KubernetesDiscoveryExportFixture {
  const dir = mkdtempSync(join(tmpdir(), "libredb-kubernetes-discovery-"));
  const path = join(dir, "export.json");
  const write = (next: Partial<KubernetesDiscoveryExport> = {}) =>
    writeFileSync(path, JSON.stringify(kubernetesExport(Date.now(), next)));
  write(overrides);
  return { path, write, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

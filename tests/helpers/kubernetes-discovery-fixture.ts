/**
 * Export files for the tests of the Kubernetes discovery source (docs/SEED_CONNECTIONS.md, "Platform discovery
 * (Kubernetes)").
 *
 * Each one is written to its own temporary directory in the exporter's shape and read back through the real loader,
 * so a test that lists or opens a discovered connection exercises the parse, the mapping and the merge it depends on
 * rather than a stand-in for them. The golden fixture's CloudNativePG cases are the databases unless a test names other
 * kinds or other databases.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import golden from "../fixtures/kubernetes-discovery-golden.json";
import { KUBERNETES_CONTRACT, type KubernetesContractRow } from "@/lib/seed/kubernetes-discovery-contract";
import type { KubernetesDiscoveredDatabase, KubernetesDiscoveryExport } from "@/lib/seed/kubernetes-discovery-export";

export interface KubernetesDiscoveryExportFixture {
  /** The export file: what SEED_KUBERNETES_DISCOVERY_PATH names. */
  readonly path: string;
  /** Rewrites the file with another export, as the kubelet does when the Secret changes. */
  write(overrides?: Partial<KubernetesDiscoveryExport>): void;
  /** Removes the temporary directory and everything in it. */
  remove(): void;
}

/** One golden case: a resource as the API server lists it, its Service and Secret, and what Studio makes of them. */
export interface GoldenCase {
  readonly resource: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly metadata: { readonly namespace: string; readonly name: string; readonly uid: string };
    readonly spec: Record<string, unknown>;
  };
  /** The database user of a per-user row. */
  readonly user?: string;
  /** The Service the row checks; `controller` means an ownerReference with controller true to the resource. */
  readonly service: {
    readonly name: string;
    readonly type: string;
    readonly selector: Record<string, string> | null;
    readonly controller: boolean;
  };
  readonly secretName: string;
  readonly secretType: string;
  /** The Secret's whole key set as the operator writes it, with fake values. */
  readonly secretData: Record<string, string>;
  readonly connectionId: string;
  readonly connection: Record<string, unknown>;
  readonly toURL: string;
  readonly link: string;
}

/** The golden fixture's cases, typed. */
export const GOLDEN_CASES = golden.cases as unknown as readonly GoldenCase[];

/** The contract row of a golden case's resource. */
export function goldenRow(c: GoldenCase): KubernetesContractRow {
  const row = KUBERNETES_CONTRACT.find(
    (candidate) =>
      c.resource.apiVersion === `${candidate.group}/${candidate.version}` && c.resource.kind === candidate.kind,
  );
  if (row === undefined) throw new Error(`no contract row serves ${c.resource.apiVersion} ${c.resource.kind}`);
  return row;
}

interface MongoUserSpec {
  name: string;
  db?: string;
  connectionStringSecretName?: string;
  roles?: { db: string }[];
}

/** The resource of a golden case as the exporter prunes it for its row: only the fields Studio reads. */
function prunedResource(c: GoldenCase, row: KubernetesContractRow): KubernetesDiscoveredDatabase["resource"] {
  const { namespace, name } = c.resource.metadata;
  const metadata = { namespace, name };
  const spec = c.resource.spec as {
    bootstrap?: { initdb?: { database?: string; secret?: { name: string } } };
    users?: MongoUserSpec[];
    security?: { tls?: { enabled?: boolean } };
    statefulSet?: { spec?: { serviceName?: string } };
  };
  if (row.slug === "pgo") {
    return spec.users?.some((user) => user.name === c.user)
      ? { metadata, spec: { users: [{ name: c.user as string }] } }
      : { metadata };
  }
  if (row.slug === "mongo") {
    const user = spec.users?.find((candidate) => candidate.name === c.user) as MongoUserSpec;
    const tls = spec.security?.tls?.enabled;
    const serviceName = spec.statefulSet?.spec?.serviceName;
    return {
      metadata,
      spec: {
        users: [
          {
            name: user.name,
            ...(user.db === undefined ? {} : { db: user.db }),
            ...(user.connectionStringSecretName === undefined
              ? {}
              : { connectionStringSecretName: user.connectionStringSecretName }),
            roles: (user.roles ?? []).slice(0, 64).map((role) => ({ db: role.db })),
          },
        ],
        ...(typeof tls === "boolean" ? { security: { tls: { enabled: tls } } } : {}),
        ...(serviceName === undefined ? {} : { statefulSet: { spec: { serviceName } } }),
      },
    };
  }
  const initdb = spec.bootstrap?.initdb;
  return {
    metadata,
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
  };
}

/** A golden case as the exporter writes it: its row's kind, the pruned resource and its row's kept keys only. */
export function goldenEntry(c: GoldenCase): KubernetesDiscoveredDatabase {
  const row = goldenRow(c);
  const data = Object.fromEntries(
    row.secretKeys.filter((key) => c.secretData[key] !== undefined).map((key) => [key, c.secretData[key]]),
  );
  return {
    kind: row.slug,
    resource: prunedResource(c, row),
    secret: { name: c.secretName, data },
  } as KubernetesDiscoveredDatabase;
}

/**
 * The golden fixture's databases of the kinds `slugs` names as the exporter writes them. CloudNativePG alone by
 * default, the three cases the discovery source, route and admin tests list.
 */
export function goldenDatabases(slugs: readonly string[] = ["cnpg"]): KubernetesDiscoveredDatabase[] {
  return GOLDEN_CASES.filter((c) => slugs.includes(goldenRow(c).slug)).map(goldenEntry);
}

/** A fresh export at `now`: an ok scan of the golden namespaces and databases of `slugs`, unless overridden. */
export function kubernetesExport(
  now: number,
  overrides: Partial<KubernetesDiscoveryExport> = {},
  slugs: readonly string[] = ["cnpg"],
): KubernetesDiscoveryExport {
  const at = new Date(now).toISOString();
  const databases = goldenDatabases(slugs);
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
  slugs: readonly string[] = ["cnpg"],
): KubernetesDiscoveryExportFixture {
  const dir = mkdtempSync(join(tmpdir(), "libredb-kubernetes-discovery-"));
  const path = join(dir, "export.json");
  const write = (next: Partial<KubernetesDiscoveryExport> = {}) =>
    writeFileSync(path, JSON.stringify(kubernetesExport(Date.now(), next, slugs)));
  write(overrides);
  return { path, write, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

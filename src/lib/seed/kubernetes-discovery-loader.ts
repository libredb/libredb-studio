/**
 * The Kubernetes discovery source (docs/SEED_CONNECTIONS.md, "Platform discovery (Kubernetes)"): the databases the
 * exporter, docker/discover-kubernetes.mjs, found in the namespaces a cluster owner opted in, as seed connections.
 *
 * Off unless SEED_KUBERNETES_DISCOVERY_PATH is set. The exporter writes its export into a Secret, and the kubelet
 * projects that Secret into Studio's pod as a read-only file, which is what this source reads. The file is untrusted
 * input: every database is mapped and validated alone through the contract table (kubernetes-discovery-contract.ts),
 * which forces managed, the TLS mode and the absence of MCP. How the file is read, cached and judged fresh, stale or
 * failed, and what is logged, is the code every platform discovery source shares (discovery-source.ts).
 *
 * A changed Secret reaches the pod only at the kubelet's next sync, measured at 41 to 85 seconds, so the export may
 * be up to one exporter interval plus that delay old when it is read: the default maximum age, 180 seconds, covers
 * the exporter's 30-second default with room to spare. Each connection comes back with the Secret its credentials
 * came from, which the Kubernetes access review asks about; src/lib/seed/index.ts sets the roles, the literal marker
 * and that Secret marker after filterByRoles.
 */
import {
  KUBERNETES_DISCOVERY_FILE_MAX_BYTES,
  parseKubernetesDiscoveryExport,
  type KubernetesDiscoveryExport,
} from "./kubernetes-discovery-export";
import { mapKubernetesDatabase, type KubernetesSecretRef } from "./kubernetes-discovery-contract";
import {
  createDiscoverySource,
  operatorSeedIds,
  type DiscoveryError,
  type DiscoverySourceDeps,
  type DiscoveryState,
} from "./discovery-source";
import type { SeedConnection } from "./types";

const ROUTE = "seed/kubernetes-discovery-loader";
const DEFAULT_MAX_AGE_MS = 180_000;
const ID_TAKEN = "id taken by the seed file";
const ID_DUPLICATE = "id taken by another discovered database";
const OK_MESSAGE = "The Kubernetes discovery exporter's last scan is current";
const WAITING_MESSAGE = "Waiting for the Kubernetes discovery exporter's export";
const PLACEMENT_HINT =
  "No export yet: the exporter may not be running, or its export Secret may not be mounted into Studio's pod";

/**
 * What GET /api/admin/discovery shows an admin: namespaces, database names and engine types, never a host or a Secret
 * value. The namespaces are those of the export that is served, each with the exporter's error for it.
 */
export interface KubernetesDiscoveryStatus {
  state: DiscoveryState;
  message: string;
  generatedAt: string | null;
  checkedAt: string | null;
  error: DiscoveryError | null;
  namespaces: { name: string; error: DiscoveryError | null }[];
  connected: { name: string; type: string }[];
  skipped: { resource: string; reason: string }[];
}

/** A discovered database's seed connection, with the Secret its credentials came from. */
export interface KubernetesDiscoveredConnection {
  readonly connection: SeedConnection;
  readonly secret: KubernetesSecretRef;
}

/** The seams of the shared source, and the seed-file ids, which tests pin. */
export interface KubernetesDiscoveryDeps extends DiscoverySourceDeps {
  fileSeedIds?: () => Promise<ReadonlySet<string>>;
}

interface Skipped {
  readonly resource: string;
  readonly reason: string;
}

function discoveryPath(): string | undefined {
  return process.env.SEED_KUBERNETES_DISCOVERY_PATH?.trim() || undefined;
}

function maxAgeMs(): number {
  const raw = Number(process.env.SEED_KUBERNETES_DISCOVERY_MAX_AGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_MS;
}

async function buildConnections(
  data: KubernetesDiscoveryExport,
  deps: KubernetesDiscoveryDeps,
): Promise<{ connections: KubernetesDiscoveredConnection[]; skipped: Skipped[] }> {
  const taken = await (deps.fileSeedIds ?? operatorSeedIds)();
  const connections: KubernetesDiscoveredConnection[] = [];
  const skipped: Skipped[] = [];
  const accepted = new Set<string>();
  for (const entry of data.databases) {
    const resource = `${entry.resource.metadata.namespace}/${entry.resource.metadata.name}`;
    const mapped = mapKubernetesDatabase(entry);
    if (!mapped.ok) {
      skipped.push({ resource, reason: mapped.reason });
      continue;
    }
    const { id } = mapped.connection;
    if (taken.has(id)) {
      skipped.push({ resource, reason: ID_TAKEN });
      continue;
    }
    // The exporter lists each resource once; an export that lists one twice keeps the first, as the operator
    // loader refuses a repeated id.
    if (accepted.has(id)) {
      skipped.push({ resource, reason: ID_DUPLICATE });
      continue;
    }
    accepted.add(id);
    connections.push({ connection: mapped.connection, secret: mapped.secret });
  }
  return { connections, skipped };
}

const source = createDiscoverySource<
  KubernetesDiscoveryExport,
  KubernetesDiscoveredConnection,
  Skipped,
  KubernetesDiscoveryDeps,
  KubernetesDiscoveryStatus
>({
  route: ROUTE,
  path: discoveryPath,
  maxAgeMs,
  maxAgeVariable: "SEED_KUBERNETES_DISCOVERY_MAX_AGE_MS",
  maxBytes: KUBERNETES_DISCOVERY_FILE_MAX_BYTES,
  parse: parseKubernetesDiscoveryExport,
  build: buildConnections,
  status: ({ state, message, data, error, connections, skipped, served }) => ({
    state,
    message,
    generatedAt: data === null ? null : data.generatedAt,
    checkedAt: data === null ? null : data.checkedAt,
    error,
    namespaces:
      served && data !== null
        ? data.namespaces.map(({ name, status }) => ({
            name,
            error: status.ok ? null : { code: status.code, message: status.message },
          }))
        : [],
    connected: connections.map(({ connection }) => ({ name: connection.name, type: connection.type })),
    skipped: [...skipped],
  }),
  messages: { ok: OK_MESSAGE, waiting: WAITING_MESSAGE, placementHint: PLACEMENT_HINT },
  errorLog: "Kubernetes discovery source error",
  skippedLog: "Kubernetes-discovered database skipped",
});

/** Drops the cached export and any recompute in flight. Tests call this between cases. */
export function resetKubernetesDiscoveryCache(): void {
  source.reset();
}

/** The discovered databases while the export is served, each with the Secret its credentials came from. */
export async function getKubernetesDiscoveredConnections(
  deps: KubernetesDiscoveryDeps = {},
): Promise<KubernetesDiscoveredConnection[]> {
  return source.connections(deps);
}

/** The source's status for the admin Overview card, or null while SEED_KUBERNETES_DISCOVERY_PATH is unset. */
export async function getKubernetesDiscoveryStatus(
  deps: KubernetesDiscoveryDeps = {},
): Promise<KubernetesDiscoveryStatus | null> {
  return source.status(deps);
}

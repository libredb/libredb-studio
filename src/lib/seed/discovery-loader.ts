/**
 * The CapRover discovery source: the databases the discovery companion app found, as seed
 * connections (docs/superpowers/specs/2026-10-04-caprover-auto-connect-design.md, section 9).
 *
 * Off unless SEED_DISCOVERY_PATH is set. The export file is untrusted input: every service is
 * fingerprinted, mapped and validated alone, and managed, roles, mcp and the TLS mode are forced in
 * discovery-fingerprint.ts, never read from the file. How the file is read, cached and judged fresh,
 * stale or failed, and what is logged, is the code every platform discovery source shares
 * (discovery-source.ts); the connections are withdrawn once the file is older than
 * SEED_DISCOVERY_MAX_AGE_MS.
 */
import { DISCOVERY_FILE_MAX_BYTES, parseDiscoveryExport, type DiscoveryExport } from "./discovery-export";
import { detectEngine, mapToSeedConnection } from "./discovery-fingerprint";
import { defaultProbe } from "./discovery-probe";
import {
  createDiscoverySource,
  operatorSeedIds,
  type DiscoveryError,
  type DiscoverySourceDeps,
  type DiscoveryState,
} from "./discovery-source";
import type { SeedConnection } from "./types";

export type { DiscoveryState } from "./discovery-source";

const ROUTE = "seed/discovery-loader";
const DEFAULT_MAX_AGE_MS = 60_000;
const ID_TAKEN = "id taken by the seed file";
const ID_DUPLICATE = "id taken by another discovered service";
const EXCLUDED_REASON = "listed in Apps to skip";
const OK_MESSAGE = "The discovery app's last scan is current";
const WAITING_MESSAGE = "Waiting for the discovery app to write its export file";
const PLACEMENT_HINT =
  "No export file yet: the discovery app may not be running, or it may run on another node than Studio";

/** What GET /api/admin/discovery shows an admin: app names and engine types, never a host or an env value. */
export interface DiscoveryStatus {
  platform: "caprover";
  state: DiscoveryState;
  message: string;
  generatedAt: string | null;
  checkedAt: string | null;
  error: DiscoveryError | null;
  connected: { name: string; type: string }[];
  skipped: { appName: string; reason: string }[];
}

/**
 * Injectable seams, in the style of VaultDeps: tests pin the clock, the file read, the probe and the
 * seed-file ids, so TTL and staleness boundaries are exercised without sleeping or opening sockets.
 */
export interface DiscoveryDeps extends DiscoverySourceDeps {
  probe?: (host: string, port: number) => Promise<boolean>;
  fileSeedIds?: () => Promise<ReadonlySet<string>>;
}

interface Skipped {
  readonly appName: string;
  readonly reason: string;
}

interface Candidate {
  appName: string;
  host: string;
  connection: SeedConnection;
  probed: boolean;
}

function discoveryPath(): string | undefined {
  return process.env.SEED_DISCOVERY_PATH?.trim() || undefined;
}

function maxAgeMs(): number {
  const raw = Number(process.env.SEED_DISCOVERY_MAX_AGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_MS;
}

const source = createDiscoverySource<DiscoveryExport, SeedConnection, Skipped, DiscoveryDeps, DiscoveryStatus>({
  route: ROUTE,
  path: discoveryPath,
  maxAgeMs,
  maxAgeVariable: "SEED_DISCOVERY_MAX_AGE_MS",
  maxBytes: DISCOVERY_FILE_MAX_BYTES,
  parse: parseDiscoveryExport,
  build: buildCandidates,
  // The apps the last good scan left out because of DISCOVERY_EXCLUDE.
  servedSkipped: (data) => data.excluded.map((appName) => ({ appName, reason: EXCLUDED_REASON })),
  status: ({ state, message, data, error, connections, skipped }) => ({
    platform: "caprover",
    state,
    message,
    generatedAt: data === null ? null : data.generatedAt,
    checkedAt: data === null ? null : data.checkedAt,
    error,
    connected: connections.map((conn) => ({ name: conn.name, type: conn.type })),
    skipped: [...skipped],
  }),
  messages: { ok: OK_MESSAGE, waiting: WAITING_MESSAGE, placementHint: PLACEMENT_HINT },
  errorLog: "Discovery source error",
  skippedLog: "Discovered service skipped",
  onReset: () => defaultProbe.reset(),
});

/** Drops the cached export, any recompute in flight and the default probe's cached answers. Tests call this between cases. */
export function resetDiscoveryCache(): void {
  source.reset();
}

export async function getDiscoveredConnections(deps: DiscoveryDeps = {}): Promise<SeedConnection[]> {
  return source.connections(deps);
}

export async function getDiscoveryStatus(deps: DiscoveryDeps = {}): Promise<DiscoveryStatus | null> {
  return source.status(deps);
}

async function buildCandidates(
  data: DiscoveryExport,
  deps: DiscoveryDeps,
): Promise<{ connections: SeedConnection[]; skipped: Skipped[] }> {
  const taken = await (deps.fileSeedIds ?? operatorSeedIds)();
  const probe = deps.probe ?? probeWithDefault;
  const skipped: Skipped[] = [];
  const candidates: Candidate[] = [];
  for (const service of data.services) {
    const match = detectEngine(service);
    // Any other image is ignored without being counted as skipped.
    if (match === null) continue;
    const mapped = mapToSeedConnection(service, match);
    if (!mapped.ok) {
      skipped.push({ appName: service.appName, reason: mapped.reason });
      continue;
    }
    if (taken.has(mapped.connection.id)) {
      skipped.push({ appName: service.appName, reason: ID_TAKEN });
      continue;
    }
    candidates.push({
      appName: service.appName,
      host: service.host,
      connection: mapped.connection,
      probed: match.via === "env",
    });
  }
  // Only an environment-fallback candidate is probed: a repository match is listed even while its
  // database is down, so a stopped database shows a connection error instead of leaving the list.
  // mapToSeedConnection always sets the port.
  const answers = await Promise.all(
    candidates.map((candidate) =>
      candidate.probed ? probe(candidate.host, candidate.connection.port as number) : Promise.resolve(true),
    ),
  );
  const connections: SeedConnection[] = [];
  // appNameOf strips srv-captain--, so a service named srv-captain--foo and one named foo share an id.
  // The operator loader refuses duplicate ids, so here the first one in the export's order keeps it.
  const accepted = new Set<string>();
  candidates.forEach((candidate, index) => {
    if (!answers[index]) {
      skipped.push({ appName: candidate.appName, reason: `did not answer on port ${candidate.connection.port}` });
      return;
    }
    if (accepted.has(candidate.connection.id)) {
      skipped.push({ appName: candidate.appName, reason: ID_DUPLICATE });
      return;
    }
    accepted.add(candidate.connection.id);
    connections.push(candidate.connection);
  });
  return { connections, skipped };
}

function probeWithDefault(host: string, port: number): Promise<boolean> {
  return defaultProbe.check(host, port);
}

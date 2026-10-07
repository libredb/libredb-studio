/**
 * The CapRover discovery source: the databases the discovery companion app found, as seed
 * connections (docs/superpowers/specs/2026-10-04-caprover-auto-connect-design.md, section 9).
 *
 * Off unless SEED_DISCOVERY_PATH is set. The export file is untrusted input: every service is
 * fingerprinted, mapped and validated alone, and managed, roles, mcp and the TLS mode are forced in
 * discovery-fingerprint.ts, never read from the file. The file is re-read at most once per
 * SEED_CACHE_TTL_MS, by one recompute shared between concurrent callers, while staleness is
 * evaluated on every call against the cached export. A cached copy is already up to one scan old
 * when it is read, so it can turn stale inside the TTL while the exporter keeps writing: a stale copy
 * is re-read, at most every STALE_REREAD_MS (or once per SEED_CACHE_TTL_MS when that is shorter), and
 * the connections are withdrawn only once the file itself is older than SEED_DISCOVERY_MAX_AGE_MS,
 * without waiting for the TTL.
 *
 * Never throws, except that an error thrown by the logger itself is raised, not swallowed: it rejects
 * every caller that shares that recompute, and the cache stored before logging serves later calls. Any
 * other failure is caught here, because it would turn into the 500 of GET /api/connections/managed and
 * hide the seed-file connections and the samples along with the discovered ones.
 */
import { open } from "fs/promises";
import { logger } from "@/lib/logger";
import { loadOperatorSources } from "./operator-loader";
import {
  DISCOVERY_FILE_MAX_BYTES,
  parseDiscoveryExport,
  type DiscoveryExport,
  type ExporterStatus,
} from "./discovery-export";
import { detectEngine, mapToSeedConnection } from "./discovery-fingerprint";
import { defaultProbe } from "./discovery-probe";
import type { SeedConnection } from "./types";

const ROUTE = "seed/discovery-loader";
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_AGE_MS = 60_000;
/** How often a cached export that has turned stale may be re-read, whatever SEED_CACHE_TTL_MS says. */
const STALE_REREAD_MS = 5_000;
const ID_TAKEN = "id taken by the seed file";
const ID_DUPLICATE = "id taken by another discovered service";
const EXCLUDED_REASON = "listed in Apps to skip";
const OK_MESSAGE = "The discovery app's last scan is current";
const WAITING_MESSAGE = "Waiting for the discovery app to write its export file";
const PLACEMENT_HINT =
  "No export file yet: the discovery app may not be running, or it may run on another node than Studio";

export type DiscoveryState = "ok" | "waiting" | "stale" | "error";

/** What GET /api/admin/discovery shows an admin: app names and engine types, never a host or an env value. */
export interface DiscoveryStatus {
  platform: "caprover";
  state: DiscoveryState;
  message: string;
  generatedAt: string | null;
  checkedAt: string | null;
  error: { code: string; message: string } | null;
  connected: { name: string; type: string }[];
  skipped: { appName: string; reason: string }[];
}

/**
 * Injectable seams, in the style of VaultDeps: tests pin the clock, the file read, the probe and the
 * seed-file ids, so TTL and staleness boundaries are exercised without sleeping or opening sockets.
 */
export interface DiscoveryDeps {
  now?: () => number;
  readFile?: (path: string) => Promise<string>;
  probe?: (host: string, port: number) => Promise<boolean>;
  fileSeedIds?: () => Promise<ReadonlySet<string>>;
}

interface DiscoveryError {
  code: string;
  message: string;
}

interface Skipped {
  appName: string;
  reason: string;
}

type FileOutcome =
  | { kind: "missing"; since: number }
  | { kind: "error"; error: DiscoveryError }
  | { kind: "parsed"; data: DiscoveryExport };

interface Snapshot {
  readAt: number;
  file: FileOutcome;
  connections: SeedConnection[];
  skipped: Skipped[];
}

interface Evaluation {
  status: DiscoveryStatus;
  connections: SeedConnection[];
}

interface Candidate {
  appName: string;
  host: string;
  connection: SeedConnection;
  probed: boolean;
}

let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;

function discoveryPath(): string | undefined {
  return process.env.SEED_DISCOVERY_PATH?.trim() || undefined;
}

function cacheTtlMs(): number {
  const raw = Number(process.env.SEED_CACHE_TTL_MS);
  return Number.isFinite(raw) ? raw : DEFAULT_CACHE_TTL_MS;
}

function maxAgeMs(): number {
  const raw = Number(process.env.SEED_DISCOVERY_MAX_AGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_MS;
}

/** Drops the cached export, any recompute in flight and the default probe's cached answers. Tests call this between cases. */
export function resetDiscoveryCache(): void {
  cache = null;
  inflight = null;
  defaultProbe.reset();
}

export async function getDiscoveredConnections(deps: DiscoveryDeps = {}): Promise<SeedConnection[]> {
  const evaluation = await current(deps);
  return evaluation === null ? [] : evaluation.connections;
}

export async function getDiscoveryStatus(deps: DiscoveryDeps = {}): Promise<DiscoveryStatus | null> {
  const evaluation = await current(deps);
  return evaluation === null ? null : evaluation.status;
}

async function current(deps: DiscoveryDeps): Promise<Evaluation | null> {
  const path = discoveryPath();
  if (path === undefined) return null;
  const now = deps.now ?? Date.now;
  const snapshot = await snapshotFor(path, now(), deps);
  return evaluate(snapshot, now());
}

function snapshotFor(path: string, at: number, deps: DiscoveryDeps): Promise<Snapshot> {
  // readAt comes from this same clock, so a negative age can only mean the clock stepped back: the cache has expired.
  // A copy is already up to one scan interval old when it is read, so it can turn stale inside the TTL while
  // the exporter keeps writing fresh files: a stale copy is re-read, at most every STALE_REREAD_MS
  // (or once per SEED_CACHE_TTL_MS when that is shorter).
  const ttl =
    cache !== null && cache.file.kind === "parsed" && !isFresh(cache.file.data.generatedAt, at)
      ? Math.min(cacheTtlMs(), STALE_REREAD_MS)
      : cacheTtlMs();
  if (cache !== null && at >= cache.readAt && at - cache.readAt < ttl) return Promise.resolve(cache);
  if (inflight !== null) return inflight;
  const previous = cache;
  const pending: Promise<Snapshot> = recompute(path, at, previous, deps).then((next) => {
    // A resetDiscoveryCache() while this ran began a new generation, so this result is not cached.
    if (inflight === pending) {
      // The cache is complete before anything is logged, so a logger that throws fails only the callers
      // that share this recompute, never a later call.
      cache = next;
      inflight = null;
      reportChanges(previous, next, path);
    }
    return next;
  });
  inflight = pending;
  return pending;
}

async function recompute(path: string, at: number, previous: Snapshot | null, deps: DiscoveryDeps): Promise<Snapshot> {
  try {
    let raw: string;
    try {
      raw = await (deps.readFile ?? readExportFile)(path);
    } catch (err) {
      if (err instanceof ExportFileTooLarge) return failed(at, "invalid_export", err.message);
      // A path that is not a regular file reads as a read failure, with its reason where an errno code would stand.
      const code = err instanceof ExportFileNotRegular ? err.message : (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          readAt: at,
          file: { kind: "missing", since: missingSince(previous, at) },
          connections: [],
          skipped: [],
        };
      }
      return failed(at, "invalid_export", `The export file could not be read (${code ?? "unknown error"})`);
    }
    const parsed = parseDiscoveryExport(raw);
    if (!parsed.ok) {
      return failed(at, "invalid_export", `The export file is not a valid discovery export: ${parsed.reason}`);
    }
    const data = parsed.value;
    // An export that is stale when read cannot turn fresh before the next read, so it is never probed.
    const built = isFresh(data.generatedAt, at) ? await buildCandidates(data, deps) : { connections: [], skipped: [] };
    return { readAt: at, file: { kind: "parsed", data }, ...built };
  } catch (err) {
    // The name only: a dependency's message may quote a value taken from the export.
    const name = err instanceof Error ? err.name : "non-error value";
    return failed(at, "discovery_failed", `Discovery failed inside Studio (${name})`);
  }
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

async function operatorSeedIds(): Promise<ReadonlySet<string>> {
  try {
    return (await loadOperatorSources()).declaredIds;
  } catch {
    // An operator source's failure is reported by GET /api/connections/managed and the admin seed-sources card; here it only means no id is taken.
    return new Set<string>();
  }
}

function probeWithDefault(host: string, port: number): Promise<boolean> {
  return defaultProbe.check(host, port);
}

/**
 * An export file over DISCOVERY_FILE_MAX_BYTES, refused by the size its handle reports before any of it is read.
 * The message names no size: a growing file would change it on every recompute, and each change is logged.
 */
class ExportFileTooLarge extends Error {
  constructor() {
    super(`The export file is over the ${DISCOVERY_FILE_MAX_BYTES}-byte limit, so it was not read`);
    this.name = "ExportFileTooLarge";
  }
}

/** An export path that names a directory or another file that is not a regular one, refused before any read. */
class ExportFileNotRegular extends Error {
  constructor() {
    super("not a regular file");
    this.name = "ExportFileNotRegular";
  }
}

/**
 * Reads the export file through one handle after checking its size, so a SEED_DISCOVERY_PATH that
 * names a log or a dump is refused instead of read whole into memory on every recompute. A short read
 * only truncates the text, which parseDiscoveryExport then refuses, and the next recompute reads again.
 */
async function readExportFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stats = await handle.stat();
    // A directory reports size 0 on Windows and on some filesystems, and a read of 0 bytes never reaches
    // the OS, so it would come back as empty text instead of EISDIR. The type is checked first.
    if (!stats.isFile()) throw new ExportFileNotRegular();
    const { size } = stats;
    if (size > DISCOVERY_FILE_MAX_BYTES) throw new ExportFileTooLarge();
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isFresh(generatedAt: string | null, now: number): boolean {
  if (generatedAt === null) return false;
  // A generatedAt ahead of this clock (the exporter's clock runs fast) is fresh. An unparsable one
  // gives NaN, which compares false, so it counts as stale.
  return now - Date.parse(generatedAt) <= maxAgeMs();
}

function exporterErrorOf(status: ExporterStatus): DiscoveryError | null {
  return status.ok ? null : { code: status.code, message: status.message };
}

function failed(at: number, code: string, message: string): Snapshot {
  return { readAt: at, file: { kind: "error", error: { code, message } }, connections: [], skipped: [] };
}

/** When the current run of missing-file reads began, so the placement hint survives re-reads. */
function missingSince(previous: Snapshot | null, at: number): number {
  const file = previous?.file;
  return file?.kind === "missing" ? file.since : at;
}

function evaluate(snapshot: Snapshot, now: number): Evaluation {
  const { file } = snapshot;
  if (file.kind === "missing") {
    const hinted = now - file.since > 2 * maxAgeMs();
    return withdrawn("waiting", hinted ? PLACEMENT_HINT : WAITING_MESSAGE, null, null);
  }
  if (file.kind === "error") return withdrawn("error", file.error.message, null, file.error);
  const { data } = file;
  const exporterError = exporterErrorOf(data.status);
  // DiscoveryExportSchema refuses generatedAt null with an ok status: a file from before the first
  // successful scan always carries the exporter's error.
  if (data.generatedAt === null && exporterError !== null) {
    return withdrawn("error", exporterError.message, data, exporterError);
  }
  if (!isFresh(data.generatedAt, now)) {
    const message = `The last successful scan is older than SEED_DISCOVERY_MAX_AGE_MS (${maxAgeMs()} ms), so its connections are withdrawn`;
    return withdrawn("stale", message, data, exporterError);
  }
  // A fresh export whose last attempt failed still carries the last good scan, which is served,
  // together with the apps that scan left out because of DISCOVERY_EXCLUDE.
  const state = exporterError === null ? "ok" : "error";
  const message = exporterError === null ? OK_MESSAGE : exporterError.message;
  const excluded = data.excluded.map((appName) => ({ appName, reason: EXCLUDED_REASON }));
  return {
    status: buildStatus(state, message, data, exporterError, snapshot.connections, [...snapshot.skipped, ...excluded]),
    connections: [...snapshot.connections],
  };
}

function withdrawn(
  state: DiscoveryState,
  message: string,
  data: DiscoveryExport | null,
  error: DiscoveryError | null,
): Evaluation {
  return { status: buildStatus(state, message, data, error, [], []), connections: [] };
}

function buildStatus(
  state: DiscoveryState,
  message: string,
  data: DiscoveryExport | null,
  error: DiscoveryError | null,
  connections: SeedConnection[],
  skipped: Skipped[],
): DiscoveryStatus {
  return {
    platform: "caprover",
    state,
    message,
    generatedAt: data === null ? null : data.generatedAt,
    checkedAt: data === null ? null : data.checkedAt,
    error,
    connected: connections.map((conn) => ({ name: conn.name, type: conn.type })),
    skipped: [...skipped],
  };
}

/**
 * Logs what changed since the previous recompute, once: a new source error, and each newly skipped
 * service. With SEED_CACHE_TTL_MS at 5000 a log line per re-read would repeat every five seconds.
 * Codes, app names and reasons only: no reason quotes an env value or the file's content.
 */
function reportChanges(previous: Snapshot | null, next: Snapshot, path: string): void {
  const { file } = next;
  if (file.kind === "error" && !sameError(previous, file.error)) {
    logger.warn("Discovery source error", { route: ROUTE, path, code: file.error.code, reason: file.error.message });
  }
  const known = new Set((previous?.skipped ?? []).map(skipKey));
  for (const entry of next.skipped) {
    if (known.has(skipKey(entry))) continue;
    logger.warn("Discovered service skipped", { route: ROUTE, appName: entry.appName, reason: entry.reason });
  }
}

function sameError(previous: Snapshot | null, error: DiscoveryError): boolean {
  const file = previous?.file;
  return file?.kind === "error" && file.error.code === error.code && file.error.message === error.message;
}

function skipKey(entry: Skipped): string {
  return `${entry.appName}\n${entry.reason}`;
}

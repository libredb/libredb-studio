/**
 * What every platform discovery source shares (docs/SEED_CONNECTIONS.md, "Platform discovery"): an exporter writes
 * an export file, and Studio reads it here with the same freshness, staleness, state, cache and logging rules,
 * whichever platform the exporter scanned. A source supplies what differs: where the file is, how old it may get, how
 * it is parsed, which connections it becomes and how its status reads.
 *
 * The export file is untrusted input. It is checked for type and size before it is read, and a source's parser
 * refuses it whole when it does not match the source's schema. The file is re-read at most once per
 * SEED_CACHE_TTL_MS, by one recompute shared between concurrent callers, while staleness is evaluated on every call
 * against the cached export. A cached copy is already up to one scan old when it is read, so it can turn stale inside
 * the TTL while the exporter keeps writing: a stale copy is re-read, at most every STALE_REREAD_MS (or once per
 * SEED_CACHE_TTL_MS when that is shorter), and the connections are withdrawn only once the file itself is older than
 * the source's maximum age, without waiting for the TTL.
 *
 * Never throws, except that an error thrown by the logger itself is raised, not swallowed: it rejects every caller
 * that shares that recompute, and the cache stored before logging serves later calls. Any other failure is caught
 * here, because it would turn into the 500 of GET /api/connections/managed and hide the seed-file connections and the
 * samples along with the discovered ones.
 */
import { open } from "fs/promises";
import { logger } from "@/lib/logger";
import { loadOperatorSources } from "./operator-loader";

const DEFAULT_CACHE_TTL_MS = 60_000;
/** How often a cached export that has turned stale may be re-read, whatever SEED_CACHE_TTL_MS says. */
const STALE_REREAD_MS = 5_000;

export type DiscoveryState = "ok" | "waiting" | "stale" | "error";

export interface DiscoveryError {
  code: string;
  message: string;
}

/** The fields of a parsed export this module reads; each source's schema declares them. */
export interface DiscoveryExportHeader {
  readonly generatedAt: string | null;
  readonly checkedAt: string;
  readonly status: { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string };
}

/** The seams every source takes, in the style of VaultDeps: tests pin the clock and the file read. */
export interface DiscoverySourceDeps {
  now?: () => number;
  readFile?: (path: string) => Promise<string>;
}

/** What a source's status is built from. */
export interface DiscoveryStatusView<E, C, S> {
  state: DiscoveryState;
  message: string;
  /** The parsed export, or null when none was read. */
  data: E | null;
  error: DiscoveryError | null;
  connections: C[];
  skipped: S[];
  /** True while the export is served: fresh, with an ok status or the exporter's error over its last good scan. */
  served: boolean;
}

/** A skipped entry: the names and reason a source reports, all of them text a log line may carry. */
export type DiscoverySkipped = Readonly<Record<string, string>>;

export interface DiscoverySourceSpec<
  E extends DiscoveryExportHeader,
  C,
  S extends DiscoverySkipped,
  D extends DiscoverySourceDeps,
  T,
> {
  /** The `route` field of this source's log lines. */
  route: string;
  /** The export file, or undefined while the source is off. */
  path(): string | undefined;
  /** How old the last successful scan may be before its connections are withdrawn. */
  maxAgeMs(): number;
  /** The variable that sets maxAgeMs, as the stale message names it. */
  maxAgeVariable: string;
  /** The largest export file read; a larger one is refused by the size its handle reports. */
  maxBytes: number;
  parse(raw: string): { ok: true; value: E } | { ok: false; reason: string };
  /** The connections and skipped entries of a fresh export. */
  build(data: E, deps: D): Promise<{ connections: C[]; skipped: S[] }>;
  /** Skipped entries the export itself carries, reported after the others while the export is served. */
  servedSkipped?(data: E): S[];
  status(view: DiscoveryStatusView<E, C, S>): T;
  messages: { ok: string; waiting: string; placementHint: string };
  /** The message of the log line for a new source error. */
  errorLog: string;
  /** The message of the log line for each newly skipped entry, which carries the entry's fields. */
  skippedLog: string;
  /** Runs with every reset, for a cache of the source's own. */
  onReset?(): void;
}

export interface DiscoverySource<C, D, T> {
  /** The connections of the export while it is served; none while the source is off. */
  connections(deps?: D): Promise<C[]>;
  /** The source's status, or null while it is off. */
  status(deps?: D): Promise<T | null>;
  /** Drops the cached export and any recompute in flight. Tests call this between cases. */
  reset(): void;
}

type FileOutcome<E> =
  | { kind: "missing"; since: number }
  | { kind: "error"; error: DiscoveryError }
  | { kind: "parsed"; data: E };

interface Snapshot<E, C, S> {
  readAt: number;
  file: FileOutcome<E>;
  connections: C[];
  skipped: S[];
}

interface Evaluation<C, T> {
  status: T;
  connections: C[];
}

function cacheTtlMs(): number {
  const raw = Number(process.env.SEED_CACHE_TTL_MS);
  return Number.isFinite(raw) ? raw : DEFAULT_CACHE_TTL_MS;
}

/**
 * An export file over the source's byte limit, refused by the size its handle reports before any of it is read.
 * The message names no size: a growing file would change it on every recompute, and each change is logged.
 */
class ExportFileTooLarge extends Error {
  constructor(maxBytes: number) {
    super(`The export file is over the ${maxBytes}-byte limit, so it was not read`);
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
 * Reads the export file through one handle after checking its size, so a path that names a log or a dump is refused
 * instead of read whole into memory on every recompute. A short read only truncates the text, which the parser then
 * refuses, and the next recompute reads again.
 */
async function readExportFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stats = await handle.stat();
    // A directory reports size 0 on Windows and on some filesystems, and a read of 0 bytes never reaches
    // the OS, so it would come back as empty text instead of EISDIR. The type is checked first.
    if (!stats.isFile()) throw new ExportFileNotRegular();
    const { size } = stats;
    if (size > maxBytes) throw new ExportFileTooLarge(maxBytes);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The ids an operator source declares, which a discovered connection never takes. */
export async function operatorSeedIds(): Promise<ReadonlySet<string>> {
  try {
    return (await loadOperatorSources()).declaredIds;
  } catch {
    // An operator source's failure is reported by GET /api/connections/managed and the admin seed-sources card;
    // here it only means no id is taken.
    return new Set<string>();
  }
}

function failed<E, C, S>(at: number, code: string, message: string): Snapshot<E, C, S> {
  return { readAt: at, file: { kind: "error", error: { code, message } }, connections: [], skipped: [] };
}

/** When the current run of missing-file reads began, so the placement hint survives re-reads. */
function missingSince<E, C, S>(previous: Snapshot<E, C, S> | null, at: number): number {
  const file = previous?.file;
  return file?.kind === "missing" ? file.since : at;
}

function exporterErrorOf(status: DiscoveryExportHeader["status"]): DiscoveryError | null {
  return status.ok ? null : { code: status.code, message: status.message };
}

function sameError<E, C, S>(previous: Snapshot<E, C, S> | null, error: DiscoveryError): boolean {
  const file = previous?.file;
  return file?.kind === "error" && file.error.code === error.code && file.error.message === error.message;
}

function skipKey(entry: DiscoverySkipped): string {
  return JSON.stringify(entry);
}

export function createDiscoverySource<
  E extends DiscoveryExportHeader,
  C,
  S extends DiscoverySkipped,
  D extends DiscoverySourceDeps,
  T,
>(spec: DiscoverySourceSpec<E, C, S, D, T>): DiscoverySource<C, D, T> {
  let cache: Snapshot<E, C, S> | null = null;
  let inflight: Promise<Snapshot<E, C, S>> | null = null;

  function isFresh(generatedAt: string | null, now: number): boolean {
    if (generatedAt === null) return false;
    // A generatedAt ahead of this clock (the exporter's clock runs fast) is fresh. An unparsable one
    // gives NaN, which compares false, so it counts as stale.
    return now - Date.parse(generatedAt) <= spec.maxAgeMs();
  }

  async function current(deps: D): Promise<Evaluation<C, T> | null> {
    const path = spec.path();
    if (path === undefined) return null;
    const now = deps.now ?? Date.now;
    const snapshot = await snapshotFor(path, now(), deps);
    return evaluate(snapshot, now());
  }

  function snapshotFor(path: string, at: number, deps: D): Promise<Snapshot<E, C, S>> {
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
    const pending: Promise<Snapshot<E, C, S>> = recompute(path, at, previous, deps).then((next) => {
      // A reset while this ran began a new generation, so this result is not cached.
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

  async function recompute(
    path: string,
    at: number,
    previous: Snapshot<E, C, S> | null,
    deps: D,
  ): Promise<Snapshot<E, C, S>> {
    try {
      let raw: string;
      try {
        raw = await (deps.readFile ?? ((target: string) => readExportFile(target, spec.maxBytes)))(path);
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
      const parsed = spec.parse(raw);
      if (!parsed.ok) {
        return failed(at, "invalid_export", `The export file is not a valid discovery export: ${parsed.reason}`);
      }
      const data = parsed.value;
      // An export that is stale when read cannot turn fresh before the next read, so it is never built.
      const built = isFresh(data.generatedAt, at) ? await spec.build(data, deps) : { connections: [], skipped: [] };
      return { readAt: at, file: { kind: "parsed", data }, ...built };
    } catch (err) {
      // The name only: a dependency's message may quote a value taken from the export.
      const name = err instanceof Error ? err.name : "non-error value";
      return failed(at, "discovery_failed", `Discovery failed inside Studio (${name})`);
    }
  }

  function evaluate(snapshot: Snapshot<E, C, S>, now: number): Evaluation<C, T> {
    const { file } = snapshot;
    if (file.kind === "missing") {
      const hinted = now - file.since > 2 * spec.maxAgeMs();
      return withdrawn("waiting", hinted ? spec.messages.placementHint : spec.messages.waiting, null, null);
    }
    if (file.kind === "error") return withdrawn("error", file.error.message, null, file.error);
    const { data } = file;
    const exporterError = exporterErrorOf(data.status);
    // Every source's schema refuses generatedAt null with an ok status: a file from before the first
    // successful scan always carries the exporter's error.
    if (data.generatedAt === null && exporterError !== null) {
      return withdrawn("error", exporterError.message, data, exporterError);
    }
    if (!isFresh(data.generatedAt, now)) {
      const message = `The last successful scan is older than ${spec.maxAgeVariable} (${spec.maxAgeMs()} ms), so its connections are withdrawn`;
      return withdrawn("stale", message, data, exporterError);
    }
    // A fresh export whose last attempt failed still carries the last good scan, which is served,
    // together with the skipped entries the export itself carries.
    const state = exporterError === null ? "ok" : "error";
    const message = exporterError === null ? spec.messages.ok : exporterError.message;
    const skipped = [...snapshot.skipped, ...(spec.servedSkipped?.(data) ?? [])];
    return {
      status: spec.status({
        state,
        message,
        data,
        error: exporterError,
        connections: [...snapshot.connections],
        skipped,
        served: true,
      }),
      connections: [...snapshot.connections],
    };
  }

  function withdrawn(
    state: DiscoveryState,
    message: string,
    data: E | null,
    error: DiscoveryError | null,
  ): Evaluation<C, T> {
    return {
      status: spec.status({ state, message, data, error, connections: [], skipped: [], served: false }),
      connections: [],
    };
  }

  /**
   * Logs what changed since the previous recompute, once: a new source error, and each newly skipped entry. With
   * SEED_CACHE_TTL_MS at 5000 a log line per re-read would repeat every five seconds. Codes, names and reasons only:
   * no reason quotes a credential or the file's content.
   */
  function reportChanges(previous: Snapshot<E, C, S> | null, next: Snapshot<E, C, S>, path: string): void {
    const { file } = next;
    if (file.kind === "error" && !sameError(previous, file.error)) {
      logger.warn(spec.errorLog, { route: spec.route, path, code: file.error.code, reason: file.error.message });
    }
    const known = new Set((previous?.skipped ?? []).map(skipKey));
    for (const entry of next.skipped) {
      if (known.has(skipKey(entry))) continue;
      logger.warn(spec.skippedLog, { route: spec.route, ...entry });
    }
  }

  return {
    async connections(deps = {} as D) {
      const evaluation = await current(deps);
      return evaluation === null ? [] : evaluation.connections;
    },
    async status(deps = {} as D) {
      const evaluation = await current(deps);
      return evaluation === null ? null : evaluation.status;
    },
    reset() {
      cache = null;
      inflight = null;
      spec.onReset?.();
    },
  };
}

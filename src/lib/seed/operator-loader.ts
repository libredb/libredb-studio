/**
 * The operator seed sources, loaded together (Spec A, section 5.2).
 *
 * One fill runs the enabled sources in their fixed order (sources/registry.ts), refuses two entries with one id,
 * resolves every `${NAME}` of a non-literal entry once, and records what each source delivered, skipped and noted.
 * The result is cached for SEED_CACHE_TTL_MS and shared by concurrent callers through the one fill in flight.
 * Environment variables are fixed for the process lifetime, so resolving in the fill equals resolving per request;
 * a `${vault:...}` is still left for resolveConnection to read when one connection is opened.
 *
 * The literal mode (SEED_LITERAL_VALUES) is read on every call, and a fill records the mode it ran with: a call that
 * reads another mode does not take that fill's cache or join it in flight, so a warm cache never pins the mode.
 *
 * A source that throws fails the fill: its error status is recorded, the sources after it still run for their
 * status only, so the admin view shows every enabled source, and the first error is rethrown once all have run.
 * The failure is never cached, so the next call reads again. A fill that resetCache() or a fill for the other
 * literal mode superseded while it ran stores neither its load nor its status.
 */
import { logger } from "@/lib/logger";
import { resolveConnectionCredentials, seedValuesAreLiteral, UndefinedSeedVariableError } from "./credential-resolver";
import { seedConfigPath } from "./sources/file";
import { enabledOperatorSources, resetOperatorSourceCaches } from "./sources/registry";
import {
  OperatorSourceError,
  type OperatorEntry,
  type OperatorSkip,
  type OperatorSourceName,
  type OperatorSourceReport,
} from "./sources/types";

const ROUTE = "seed/operator-loader";
const DEFAULT_CACHE_TTL_MS = 60_000;
const SKIPPED_MESSAGE = "Seed connection skipped due to credential resolution failure";

const duplicateIdMessage = (id: string, first: string, second: string): string =>
  `Seed connection id "${id}" is declared by both ${first} and ${second}`;

export interface OperatorLoad {
  /** Resolved entries in source order; literal ones untouched by resolution. */
  readonly entries: readonly OperatorEntry[];
  /** Resolution skips of this fill plus every source's own skips. */
  readonly skips: readonly OperatorSkip[];
  /** Every id any source declared, kept, skipped by a source or dropped by resolution. */
  readonly declaredIds: ReadonlySet<string>;
  readonly reports: readonly OperatorSourceReport[];
}

interface Fill {
  readonly literalValues: boolean;
  readonly promise: Promise<OperatorLoad>;
}

let cache: { load: OperatorLoad; filledAt: number; literalValues: boolean } | null = null;
let inflight: Fill | null = null;
let statusCache: OperatorSourceReport[] | null = null;

function cacheTtlMs(): number {
  const raw = Number(process.env.SEED_CACHE_TTL_MS);
  return Number.isFinite(raw) ? raw : DEFAULT_CACHE_TTL_MS;
}

/** The path the admin view names for a source: the seed file's for SEED_CONFIG_PATH, none for the others in A1. */
function sourceLocation(name: OperatorSourceName): string | null {
  return name === "SEED_CONFIG_PATH" ? seedConfigPath().path : null;
}

function errorReport(
  source: OperatorSourceName,
  location: string | null,
  checkedAt: string,
  err: unknown,
): OperatorSourceReport {
  const code = err instanceof OperatorSourceError ? err.code : "unreadable";
  const message = err instanceof Error ? err.message : String(err);
  return {
    source,
    location,
    state: "error",
    checkedAt,
    error: { code, message },
    connected: [],
    skipped: [],
    notes: [],
  };
}

/** Clears the operator cache, the in-flight fill, the status cache and every source-level state. */
export function resetCache(): void {
  cache = null;
  inflight = null;
  statusCache = null;
  resetOperatorSourceCaches();
}

/** Cached for SEED_CACHE_TTL_MS; throws on any source error after recording it in the status cache. */
export async function loadOperatorSources(): Promise<OperatorLoad> {
  const now = Date.now();
  const literalValues = seedValuesAreLiteral();
  // A fill time ahead of now can only mean the clock stepped back: the cache has expired.
  const fresh = cache !== null && now >= cache.filledAt && now - cache.filledAt < cacheTtlMs();
  if (cache !== null && fresh && cache.literalValues === literalValues) return cache.load;
  if (inflight !== null && inflight.literalValues === literalValues) return inflight.promise;
  // The fill starts on the next microtask, after `inflight` names it, so even a fill with no source to await sees
  // itself as current when it stores.
  const fill: Fill = {
    literalValues,
    promise: Promise.resolve()
      .then(() => runFill(fill, now))
      .catch((err: unknown) => forgetFailedFill(fill, err)),
  };
  inflight = fill;
  return fill.promise;
}

/**
 * Rethrows a fill's error after clearing `inflight` when it still names that fill. A throw runFill does not catch
 * itself (the source list, a source's location) must not leave the fill in flight, or every later call of its mode
 * would join the rejection until resetCache(); a failed fill is never cached either way.
 */
function forgetFailedFill(fill: Fill, err: unknown): never {
  if (inflight === fill) inflight = null;
  throw err;
}

/** Runs or reuses a load, catches its error (already recorded), and returns the status cache. */
export async function getOperatorSourceStatus(): Promise<OperatorSourceReport[]> {
  try {
    await loadOperatorSources();
  } catch {
    // Not a silent recovery: the fill recorded the failing source's error in statusCache before it threw, and that
    // status is what this returns. GET /api/connections/managed still fails on the same error.
  }
  return statusCache ?? [];
}

/** The entry with its `${NAME}` references resolved, or null after recording why it was dropped. */
function resolveEntry(entry: OperatorEntry, skips: OperatorSkip[]): OperatorEntry | null {
  try {
    return { ...entry, connection: resolveConnectionCredentials(entry.connection) };
  } catch (err) {
    if (!(err instanceof UndefinedSeedVariableError)) throw err;
    const reason = `Environment variable ${err.variable} is not defined`;
    skips.push({ id: entry.connection.id, origin: entry.origin, reason, variable: err.variable, field: err.field });
    logger.error(SKIPPED_MESSAGE, err, { route: ROUTE, connectionId: entry.connection.id });
    return null;
  }
}

async function runFill(fill: Fill, now: number): Promise<OperatorLoad> {
  const checkedAt = new Date(now).toISOString();
  const entries: OperatorEntry[] = [];
  const skips: OperatorSkip[] = [];
  const declaredIds = new Set<string>();
  const origins = new Map<string, string>();
  const reports: OperatorSourceReport[] = [];
  // The first source error: the sources after it still run, for their status only, and the fill rethrows it at the end.
  let failure: { readonly error: unknown } | null = null;

  for (const source of enabledOperatorSources()) {
    const location = sourceLocation(source.name);
    try {
      // oxlint-disable-next-line no-await-in-loop -- the sources run in their fixed order, one after the other.
      const result = await source.load({ literalValues: fill.literalValues });
      for (const skip of result.skips) declaredIds.add(skip.id);
      const kept: OperatorEntry[] = [];
      const resolutionSkips: OperatorSkip[] = [];
      for (const entry of result.entries) {
        const id = entry.connection.id;
        const first = origins.get(id);
        if (first !== undefined) {
          throw new OperatorSourceError("duplicate-id", duplicateIdMessage(id, first, entry.origin));
        }
        origins.set(id, entry.origin);
        declaredIds.add(id);
        const resolved = entry.literal ? entry : resolveEntry(entry, resolutionSkips);
        if (resolved !== null) kept.push(resolved);
      }
      const state = kept.length > 0 ? "ok" : result.status.state === "missing" ? "missing" : "empty";
      const connected = kept.map(({ connection }) => ({
        id: connection.id,
        name: connection.name,
        type: connection.type,
      }));
      const skipped = [...result.skips, ...resolutionSkips];
      reports.push({
        source: source.name,
        location,
        state,
        checkedAt,
        error: null,
        connected,
        skipped,
        notes: result.notes,
      });
      entries.push(...kept);
      skips.push(...skipped);
    } catch (err) {
      reports.push(errorReport(source.name, location, checkedAt, err));
      failure ??= { error: err };
    }
  }

  if (failure !== null) {
    // Every enabled source has its report, so the admin view shows the sources after the failing one too; the load
    // itself fails and is never cached.
    if (inflight === fill) {
      statusCache = reports;
      inflight = null;
    }
    throw failure.error;
  }

  const load: OperatorLoad = { entries, skips, declaredIds, reports };
  if (inflight === fill) {
    cache = { load, filledAt: now, literalValues: fill.literalValues };
    statusCache = reports;
    inflight = null;
  }
  return load;
}

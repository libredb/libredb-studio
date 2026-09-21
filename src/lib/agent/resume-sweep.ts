/**
 * The producer `docs/BACKLOG.md` B9 asked for: a sweep that finds runs a dead
 * process left `running` and drives each one again, in-process.
 *
 * A run is driven exactly once, by the process that opened it; if that process
 * dies mid-run the run stays `running` with nobody to pick it up. This module
 * closes the loop for the local, single-instance backend: at boot and then on a
 * timer it lists the ledger streams, finds the ones that are stale, and drives
 * them through the same `driveAgentRun` the start route uses.
 *
 * Single-flight is the drive's own durable claim (`docs/BACKLOG.md` B5), not a
 * sweep bookkeeping flag: the sweep holds no claim, so `runInvestigation`'s
 * `claimDrive` is what refuses a run another drive already owns.
 *
 * **Scope:** automatic resume is guaranteed for the `local` backend only. The
 * multi-replica Postgres world is absent from the shipped artifacts
 * (`docs/BACKLOG.md` B16), so no cross-replica sweep exists yet; stating "the
 * run is picked up automatically" must not be read as a promise on every
 * backend this application supports.
 *
 * **Resume latency:** a run orphaned by a crash is picked up only AFTER its
 * claim expires (run deadline plus grace) — this is EVENTUAL resume, not
 * immediate. The sweep's staleness threshold is wider than the claim expiry,
 * so a still-live drive always refuses the sweep's drive at claim time first.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "@/lib/logger";
import {
  agentResumeSweepIntervalMs,
  agentStaleRunAfterMs,
  isAgentRuntimeEnabled,
  resolveAgentLedgerDirectory,
} from "./config";
import { AGENT_LEDGER_STREAM_PREFIX } from "./run-store";
import type { AgentRunService, AgentRunStatusReport } from "./run-service";

/** The outcome of one sweep pass, for the operator's log line. */
export interface ResumeSweepOutcome {
  readonly claimed: number;
  readonly skipped: number;
}

/**
 * Whether a run is a candidate for the sweep: still `running`, and its last
 * ledger activity is old enough that the process which drove it is gone.
 * "Unclaimed" is deliberately NOT decided here — the claim attempt is the
 * authority, so a still-live drive refuses the sweep at `claimDrive` instead of
 * a staleness reading being asked to outguess it.
 */
export function isStaleRun(report: AgentRunStatusReport, nowMs: number, staleAfterMs: number): boolean {
  if (report.record.status !== "running") return false;
  // The last EVENT's timestamp, not `updatedAtMs`: a drive claim is a control
  // record, and taking it would let a claim refresh a run's staleness — the
  // sweep must ask "did the run DO anything recently", not "did the ledger move".
  const events = report.record.events;
  const lastActivityMs = events.length > 0 ? events[events.length - 1].atMs : report.record.createdAtMs;
  return lastActivityMs + staleAfterMs <= nowMs;
}

/**
 * Lists the run ids this server's local ledger holds.
 *
 * Read from the world's OWN registry, `streams/runs/<id>.json`, each of which
 * holds `{ "streams": [...] }` — the stream names that run wrote. The agent
 * ledger is the entry carrying `AGENT_LEDGER_STREAM_PREFIX`, and the run id is
 * what follows it. Not from `readdir(streams/)`: that directory holds exactly
 * two entries, `runs` and `chunks`, and never one named per stream, so matching
 * the prefix against it finds nothing whatever the ledger actually holds.
 *
 * Returns `[]` when the registry does not exist yet or cannot be read — a first
 * boot has nothing to sweep, and a permission fault is the ledger's problem to
 * report, not the sweep's. A single unreadable or malformed registry file is
 * skipped for the same reason, rather than failing the whole pass.
 */
export async function listLocalAgentRunIds(directory = resolveAgentLedgerDirectory()): Promise<string[]> {
  const runsDir = path.join(directory, "streams", "runs");
  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let streams: unknown;
    try {
      streams = JSON.parse(await readFile(path.join(runsDir, name), "utf8"))?.streams;
    } catch {
      continue;
    }
    if (!Array.isArray(streams)) continue;
    for (const stream of streams) {
      if (typeof stream !== "string" || !stream.startsWith(AGENT_LEDGER_STREAM_PREFIX)) continue;
      const runId = stream.slice(AGENT_LEDGER_STREAM_PREFIX.length);
      if (runId.length > 0) ids.add(runId);
    }
  }
  return [...ids];
}

/**
 * One pass over the candidate run ids: stale running runs are driven, and the
 * drive is the single-flight — `runInvestigation` claims the run before it
 * steps, so a run another drive already owns refuses with `RUN_ALREADY_DRIVEN`
 * and is skipped, not failed. The sweep holds no claim of its own: holding one
 * here would make the drive refuse itself. Each drive is tried in its own
 * `try/catch`, so one run's throw never prevents a later run id from being
 * reached.
 */
export async function sweepStaleRuns(options: {
  readonly service: AgentRunService;
  readonly drive: (runId: string) => Promise<unknown>;
  readonly runIds: readonly string[];
  readonly now?: () => number;
  readonly staleAfterMs: number;
}): Promise<ResumeSweepOutcome> {
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs;
  let claimed = 0;
  let skipped = 0;

  for (const runId of options.runIds) {
    const report = await options.service.status(runId);
    if (report === null || !isStaleRun(report, now(), staleAfterMs)) continue;

    try {
      await options.drive(runId);
      claimed += 1;
    } catch {
      skipped += 1;
    }
  }

  return { claimed, skipped };
}

/**
 * One full sweep against the real service and drive. Exported so a test can
 * drive it once; `startAgentResumeSweep` is the timer around it.
 */
/**
 * One sweep against injected dependencies — the seam a test drives without a
 * real model, connection or world. `runResumeSweepOnce` supplies the real ones.
 */
export async function sweepOnce(options: {
  readonly service: AgentRunService;
  readonly drive: (runId: string) => Promise<unknown>;
  readonly now?: () => number;
  readonly staleAfterMs?: number;
  readonly listRunIds?: () => Promise<string[]>;
}): Promise<ResumeSweepOutcome> {
  const runIds = await (options.listRunIds ?? listLocalAgentRunIds)();
  return sweepStaleRuns({
    service: options.service,
    drive: options.drive,
    runIds,
    now: options.now,
    staleAfterMs: options.staleAfterMs ?? agentStaleRunAfterMs(),
  });
}

/**
 * The pieces `runResumeSweepOnce` needs from the real runtime, kept as one seam
 * so a test can drive the glue without a model, a connection or a world.
 */
export interface ResumeSweepRuntime {
  readonly driveAgentRun: (runId: string) => Promise<unknown>;
  readonly getAgentRunService: () => Promise<AgentRunService>;
}

/**
 * One full sweep against the real service and drive. Every dependency is
 * injectable: `runtime` supplies the drive and the service, `enabled` is the
 * availability gate, and `sweep` is the pass itself. `startAgentResumeSweep` is
 * the timer around the real version.
 */
export async function runResumeSweepOnce(
  runtime: () => Promise<ResumeSweepRuntime> = () => import("./runtime"),
  enabled: () => boolean = isAgentRuntimeEnabled,
  sweep: typeof sweepOnce = sweepOnce,
): Promise<ResumeSweepOutcome> {
  if (!enabled()) return { claimed: 0, skipped: 0 };
  try {
    const { driveAgentRun, getAgentRunService } = await runtime();
    const service = await getAgentRunService();
    const outcome = await sweep({ service, drive: driveAgentRun });
    if (outcome.claimed > 0 || outcome.skipped > 0) {
      logger.info("agent resume sweep finished", { route: "agent-resume-sweep", ...outcome });
    }
    return outcome;
  } catch (error) {
    logger.error("agent resume sweep failed", error, { route: "agent-resume-sweep" });
    return { claimed: 0, skipped: 0 };
  }
}

/**
 * Starts the resume sweep: once now, then on the configured interval. The
 * scheduler is injectable so the test can assert both halves without waiting.
 * Returns the timer handle, or `undefined` when the interval is disabled.
 */
export function startAgentResumeSweep(
  schedule: (run: () => void, intervalMs: number) => unknown = (run, intervalMs) => {
    const timer = setInterval(run, intervalMs);
    // The sweep must never hold the process open on its own: a ref'd timer
    // would keep a test worker (and a short-lived CLI process) alive after its
    // work is done.
    timer.unref?.();
    return timer;
  },
): unknown {
  const intervalMs = agentResumeSweepIntervalMs();
  const run = (): void => {
    void runResumeSweepOnce();
  };
  void run();
  return schedule(run, intervalMs);
}

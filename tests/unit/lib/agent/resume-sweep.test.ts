import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { logger } from "@/lib/logger";
import { agentResumeSweepIntervalMs, agentStaleRunAfterMs } from "@/lib/agent/config";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import {
  isStaleRun,
  listLocalAgentRunIds,
  runResumeSweepOnce,
  startAgentResumeSweep,
  sweepOnce,
  sweepStaleRuns,
} from "@/lib/agent/resume-sweep";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import type { QueryResult } from "@/lib/types";

const ACTOR = { sessionId: "sess_1", role: "admin" } as const;

const START_INPUT = {
  mode: "agent",
  actor: ACTOR,
  connectionId: "conn_1",
  objective: "Why is the orders report slow?",
} as const;

const dataDirs: string[] = [];

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resume-sweep-"));
  dataDirs.push(dir);
  return dir;
}

function fakeClock(startAt = 1_700_000_000_000): { read: () => number; set: (value: number) => void } {
  let current = startAt;
  return {
    read: () => current,
    set: (value: number) => {
      current = value;
    },
  };
}

function harness(clock?: () => number): { service: AgentRunService; dataDir: string } {
  const dataDir = freshDataDir();
  const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }), clock });
  const tracker = new ExecutionBudgetTracker();
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 20 });
  return { service: new AgentRunService({ store, resources: { tracker, artifacts }, clock }), dataDir };
}

afterEach(() => {
  while (dataDirs.length > 0) {
    const dir = dataDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("isStaleRun", () => {
  test("only a running run whose ledger activity is old enough is stale", async () => {
    const clock = fakeClock();
    const h = harness(clock.read);
    const { runId } = await h.service.start(START_INPUT);

    const queued = await h.service.status(runId);
    expect(isStaleRun(queued!, clock.read(), 60_000)).toBe(false);

    await h.service.markRunning(runId);
    const running = await h.service.status(runId);
    expect(isStaleRun(running!, clock.read(), 60_000)).toBe(false);

    clock.set(clock.read() + 60_001);
    expect(isStaleRun(running!, clock.read(), 60_000)).toBe(true);
  });
});

describe("listLocalAgentRunIds", () => {
  test("lists only agent-ledger streams, by run id", async () => {
    const dir = freshDataDir();
    fs.mkdirSync(path.join(dir, "streams", "agent-ledger-arun_a"), { recursive: true });
    fs.mkdirSync(path.join(dir, "streams", "agent-history-sess_1"), { recursive: true });
    fs.mkdirSync(path.join(dir, "streams", "other"), { recursive: true });

    expect(await listLocalAgentRunIds(dir)).toEqual(["arun_a"]);
  });

  test("returns an empty list when the streams directory is absent", async () => {
    expect(await listLocalAgentRunIds(freshDataDir())).toEqual([]);
  });
});

describe("sweepStaleRuns", () => {
  test("claims and drives a stale running run, then releases the claim", async () => {
    const clock = fakeClock();
    const h = harness(clock.read);
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    clock.set(clock.read() + 60_001);

    const driven: string[] = [];
    const outcome = await sweepStaleRuns({
      service: h.service,
      drive: async (id) => {
        driven.push(id);
      },
      runIds: [runId],
      now: clock.read,
      staleAfterMs: 60_000,
    });

    expect(outcome).toEqual({ claimed: 1, skipped: 0 });
    expect(driven).toEqual([runId]);
    // The release is durable: a fresh claim succeeds after the sweep.
    await h.service.claimDrive(runId);
    await h.service.releaseDrive(runId);
  });

  test("skips a stale run whose claim is held elsewhere", async () => {
    const clock = fakeClock();
    const h = harness(clock.read);
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    clock.set(clock.read() + 60_001);
    await h.service.claimDrive(runId);

    const outcome = await sweepStaleRuns({
      service: h.service,
      drive: async () => {},
      runIds: [runId],
      now: clock.read,
      staleAfterMs: 60_000,
    });

    expect(outcome).toEqual({ claimed: 0, skipped: 1 });
    await h.service.releaseDrive(runId);
  });

  test("ignores run ids it does not know", async () => {
    const h = harness();

    const outcome = await sweepStaleRuns({
      service: h.service,
      drive: async () => {},
      runIds: ["arun_missing"],
      staleAfterMs: 60_000,
    });

    expect(outcome).toEqual({ claimed: 0, skipped: 0 });
  });

  test("a terminal run is never swept, even with a claim still recorded", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    // The claim is recorded but never released: the run ends first, and
    // `releaseDrive` skips the durable release for a terminal run.
    await h.service.claimDrive(runId);
    await h.service.finish(runId, "succeeded");

    const driven: string[] = [];
    const outcome = await sweepStaleRuns({
      service: h.service,
      drive: async (id) => {
        driven.push(id);
      },
      runIds: [runId],
      staleAfterMs: 1,
    });

    expect(outcome).toEqual({ claimed: 0, skipped: 0 });
    expect(driven).toEqual([]);
  });
});

describe("sweepOnce", () => {
  test("lists ids through the injected source and sweeps with the injected drive", async () => {
    const clock = fakeClock();
    const h = harness(clock.read);
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    clock.set(clock.read() + 60_001);

    const driven: string[] = [];
    const outcome = await sweepOnce({
      service: h.service,
      drive: async (id) => {
        driven.push(id);
      },
      now: clock.read,
      staleAfterMs: 60_000,
      listRunIds: async () => [runId],
    });

    expect(outcome).toEqual({ claimed: 1, skipped: 0 });
    expect(driven).toEqual([runId]);
  });
});

describe("startAgentResumeSweep", () => {
  test("runs once immediately and schedules on the configured interval", () => {
    const saved = process.env.LIBREDB_AGENT_RESUME_SWEEP_INTERVAL_MS;
    delete process.env.LIBREDB_AGENT_RESUME_SWEEP_INTERVAL_MS;
    try {
      const scheduled: { fn: () => void; ms: number }[] = [];
      const timer = startAgentResumeSweep((fn, ms) => {
        scheduled.push({ fn, ms });
        return "timer";
      });

      expect(timer).toBe("timer");
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.ms).toBe(60_000);
    } finally {
      if (saved !== undefined) process.env.LIBREDB_AGENT_RESUME_SWEEP_INTERVAL_MS = saved;
    }
  });
});

describe("runResumeSweepOnce", () => {
  test("does nothing while the runtime is disabled", async () => {
    const outcome = await runResumeSweepOnce(
      async () => {
        throw new Error("the runtime must not be touched");
      },
      () => false,
      async () => {
        throw new Error("the sweep must not run");
      },
    );

    expect(outcome).toEqual({ claimed: 0, skipped: 0 });
  });

  test("drives a sweep and logs when something was claimed or skipped", async () => {
    const h = harness();
    const info = spyOn(logger, "info");
    try {
      const outcome = await runResumeSweepOnce(
        async () => ({ driveAgentRun: async () => {}, getAgentRunService: async () => h.service }),
        () => true,
        async () => ({ claimed: 1, skipped: 1 }),
      );

      expect(outcome).toEqual({ claimed: 1, skipped: 1 });
      expect(info).toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  test("stays quiet for a sweep that found nothing to do", async () => {
    const h = harness();
    const info = spyOn(logger, "info");
    try {
      const outcome = await runResumeSweepOnce(
        async () => ({ driveAgentRun: async () => {}, getAgentRunService: async () => h.service }),
        () => true,
        async () => ({ claimed: 0, skipped: 0 }),
      );

      expect(outcome).toEqual({ claimed: 0, skipped: 0 });
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  test("reports a failure and keeps the sweep claimable instead of throwing", async () => {
    const error = spyOn(logger, "error");
    try {
      const outcome = await runResumeSweepOnce(
        async () => {
          throw new Error("world unavailable");
        },
        () => true,
        async () => ({ claimed: 0, skipped: 0 }),
      );

      expect(outcome).toEqual({ claimed: 0, skipped: 0 });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe("the sweep env knobs", () => {
  afterEach(() => {
    delete process.env.LIBREDB_AGENT_RESUME_SWEEP_INTERVAL_MS;
    delete process.env.LIBREDB_AGENT_STALE_RUN_AFTER_MS;
  });

  test("the interval falls back to the default for a non-positive-whole value and honours a valid one", () => {
    process.env.LIBREDB_AGENT_RESUME_SWEEP_INTERVAL_MS = "not-a-number";
    expect(agentResumeSweepIntervalMs()).toBe(60_000);
    process.env.LIBREDB_AGENT_RESUME_SWEEP_INTERVAL_MS = "0";
    expect(agentResumeSweepIntervalMs()).toBe(60_000);
    process.env.LIBREDB_AGENT_RESUME_SWEEP_INTERVAL_MS = "4321";
    expect(agentResumeSweepIntervalMs()).toBe(4321);
  });

  test("the stale threshold falls back to its default and honours a valid one", () => {
    delete process.env.LIBREDB_AGENT_STALE_RUN_AFTER_MS;
    const defaultMs = agentStaleRunAfterMs();

    process.env.LIBREDB_AGENT_STALE_RUN_AFTER_MS = "garbage";
    expect(agentStaleRunAfterMs()).toBe(defaultMs);
    process.env.LIBREDB_AGENT_STALE_RUN_AFTER_MS = "4321";
    expect(agentStaleRunAfterMs()).toBe(4321);
  });
});

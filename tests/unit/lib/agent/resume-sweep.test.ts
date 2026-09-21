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
  /**
   * Writes the registry the way `@workflow/world-local` writes it: one
   * `streams/runs/<id>.json` per run, holding the stream names that run wrote.
   * Built here rather than by hand-making `streams/<name>` directories, which
   * the world never creates — a fixture in that shape passes while the real
   * ledger returns nothing.
   */
  function writeRunRegistry(dir: string, id: string, streams: readonly string[]): void {
    const runsDir = path.join(dir, "streams", "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, `${id}.json`), JSON.stringify({ streams }, null, 2));
  }

  test("lists only agent-ledger streams, by run id", async () => {
    const dir = freshDataDir();
    writeRunRegistry(dir, "arun_a", ["agent-ledger-arun_a"]);
    writeRunRegistry(dir, "sess_1", ["agent-history-sess_1"]);
    writeRunRegistry(dir, "other", ["other"]);

    expect(await listLocalAgentRunIds(dir)).toEqual(["arun_a"]);
  });

  test("reads the run id out of a registry that names several streams", async () => {
    const dir = freshDataDir();
    writeRunRegistry(dir, "arun_b", ["agent-history-sess_2", "agent-ledger-arun_b"]);

    expect(await listLocalAgentRunIds(dir)).toEqual(["arun_b"]);
  });

  test("a real local world's ledger is discoverable, not just a hand-built fixture", async () => {
    const dir = freshDataDir();
    const store = new AgentRunStore({ world: createLocalWorld({ dataDir: dir, recoverActiveRuns: false }) });
    const service = new AgentRunService({
      store,
      resources: {
        tracker: new ExecutionBudgetTracker(),
        artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 20 }),
      },
    });
    const { runId } = await service.start(START_INPUT);

    // The point of this case: the layout is the world's, never the test's.
    expect(await listLocalAgentRunIds(dir)).toEqual([runId]);
  });

  test("skips a registry file that is unreadable or not the shape it should be", async () => {
    const dir = freshDataDir();
    const runsDir = path.join(dir, "streams", "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, "broken.json"), "{ not json");
    fs.writeFileSync(path.join(runsDir, "wrong-shape.json"), JSON.stringify({ streams: "nope" }));
    fs.writeFileSync(path.join(runsDir, "not-a-registry.txt"), "ignored");
    writeRunRegistry(dir, "arun_c", ["agent-ledger-arun_c"]);

    expect(await listLocalAgentRunIds(dir)).toEqual(["arun_c"]);
  });

  test("returns an empty list when the streams directory is absent", async () => {
    expect(await listLocalAgentRunIds(freshDataDir())).toEqual([]);
  });
});

describe("sweepStaleRuns", () => {
  test("drives a stale running run through the drive's own claim", async () => {
    const clock = fakeClock();
    const h = harness(clock.read);
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    clock.set(clock.read() + 60_001);

    const driven: string[] = [];
    const outcome = await sweepStaleRuns({
      service: h.service,
      // The real drive claims before it steps (`runInvestigation`), so the mock
      // does too: the sweep must NOT hold a claim of its own, or this refuses.
      drive: async (id) => {
        await h.service.claimDrive(id);
        try {
          driven.push(id);
        } finally {
          await h.service.releaseDrive(id);
        }
      },
      runIds: [runId],
      now: clock.read,
      staleAfterMs: 60_000,
    });

    expect(outcome).toEqual({ claimed: 1, skipped: 0 });
    expect(driven).toEqual([runId]);
    // The drive released durably: a fresh claim succeeds after the sweep.
    await h.service.claimDrive(runId);
    await h.service.releaseDrive(runId);
  });

  test("skips a stale run whose claim is held elsewhere", async () => {
    const clock = fakeClock();
    const h = harness(clock.read);
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    clock.set(clock.read() + 60_001);
    // A live drive already holds the claim.
    await h.service.claimDrive(runId);

    const outcome = await sweepStaleRuns({
      service: h.service,
      // The drive's own claim is refused because another drive holds it.
      drive: async () => {
        await h.service.claimDrive(runId);
      },
      runIds: [runId],
      now: clock.read,
      staleAfterMs: 60_000,
    });

    expect(outcome).toEqual({ claimed: 0, skipped: 1 });
    await h.service.releaseDrive(runId);
  });

  test("a run whose drive throws does not prevent a later run from being swept", async () => {
    const clock = fakeClock();
    const h = harness(clock.read);
    const { runId: first } = await h.service.start(START_INPUT);
    await h.service.markRunning(first);
    const { runId: second } = await h.service.start({ ...START_INPUT, objective: "another question" });
    await h.service.markRunning(second);
    clock.set(clock.read() + 60_001);

    const driven: string[] = [];
    const outcome = await sweepStaleRuns({
      service: h.service,
      drive: async (id) => {
        if (id === first) throw new Error("boom");
        driven.push(id);
      },
      runIds: [first, second],
      now: clock.read,
      staleAfterMs: 60_000,
    });

    expect(outcome).toEqual({ claimed: 1, skipped: 1 });
    expect(driven).toEqual([second]);
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

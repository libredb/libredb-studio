/**
 * A dashboard read whose panels never answer, with a real deadline and a real host core, in a bounded Node child
 * (src/lib/api/provider-monitoring.ts; docs/providers/CONTRACT.md, clause C-74): each panel read waits until its own
 * deadline, so the dashboard answers `StudioTimeoutRefusal` naming the panel read within the child's spawn timeout.
 * Without the wait the child waits until the spawn timeout kills it, and the case fails within seconds; the child holds
 * a referenced interval, so Node cannot exit early on the unsettled reads (tests/helpers/bounded-node-child.ts).
 *
 * `provider-monitoring.test.ts` holds the same rule with caller-driven aborts and a core of the test's own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { EXECUTE_SLACK_MS } from "@/lib/api/editor-query";
import type { providerMonitoring } from "@/lib/api/provider-monitoring";
import type { errorKind, errorOutcome } from "@/lib/db/error-record";
import type { createHostCore } from "@/lib/provider-host/core/host-core";
import type { installHostCore } from "@/lib/provider-host/instance";
import { boundedChild } from "../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly providerMonitoring: typeof providerMonitoring;
  readonly EXECUTE_SLACK_MS: typeof EXECUTE_SLACK_MS;
  readonly createHostCore: typeof createHostCore;
  readonly installHostCore: typeof installHostCore;
  readonly errorKind: typeof errorKind;
  readonly errorOutcome: typeof errorOutcome;
}

const SRC = path.join(import.meta.dir, "..", "..", "..", "..", "src");

const child = boundedChild({
  label: "provider-monitoring-bounds",
  imports: [
    { from: path.join(SRC, "lib", "api", "provider-monitoring.ts"), names: ["providerMonitoring"] },
    { from: path.join(SRC, "lib", "api", "editor-query.ts"), names: ["EXECUTE_SLACK_MS"] },
    { from: path.join(SRC, "lib", "provider-host", "core", "host-core.ts"), names: ["createHostCore"] },
    { from: path.join(SRC, "lib", "provider-host", "instance.ts"), names: ["installHostCore"] },
    { from: path.join(SRC, "lib", "db", "error-record.ts"), names: ["errorKind", "errorOutcome"] },
  ],
  runCase: async (deps: ChildDeps) => {
    deps.installHostCore(deps.createHostCore(), "test");
    const never = () => new Promise<never>(() => {});
    const queryTimeout = 1_000;
    const provider = {
      type: "postgres",
      config: { id: "c1", name: "Prod", type: "postgres", host: "db", queryTimeout },
      getOverview: never,
      getPerformanceMetrics: never,
      getSlowQueries: never,
      getActiveSessions: never,
      getTableStats: never,
      getIndexStats: never,
      getStorageStats: never,
      runMaintenance: never,
      getCapabilities: () => ({}),
    } as unknown as Parameters<typeof deps.providerMonitoring>[0];
    // The clock sets each read's deadline 50 ms from now: the statement timeout and the slack already spent.
    const clock = () => Date.now() + 50 - queryTimeout - deps.EXECUTE_SLACK_MS;
    try {
      await deps.providerMonitoring(provider, new AbortController().signal, "bounds", clock).readDashboard({});
      return "answered";
    } catch (error) {
      return `${(error as Error).name} ${deps.errorKind(error)} ${deps.errorOutcome(error)} ${(error as Error).message}`;
    }
  },
  heapLimitMiB: 256,
  timeoutMs: 3_000,
});

beforeAll(async () => {
  await child.build();
});

afterAll(() => {
  child.remove();
});

describe("a monitoring dashboard read in a bounded child", () => {
  test("a dashboard read whose panels never answer is stopped at their deadline, StudioTimeoutRefusal naming the panel read", async () => {
    expect(await child.run<unknown>("dashboard")).toBe(
      "TimeoutError studio-timeout-refusal unknown A monitoring panel read did not answer within the statement timeout of 1 second and 10 seconds more for the engine's own answer, so Studio stopped waiting for it.",
    );
  });
});

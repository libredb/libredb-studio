/**
 * A maintenance run that never answers, with real timers, in a bounded Node child (src/lib/api/provider-maintenance.ts;
 * docs/providers/CONTRACT.md, clause C-70): the run's deadline, the statement timeout plus the slack, is set 50 ms out
 * through the facade's clock, so the child answers within its spawn timeout. Without the host's wait the child waits
 * until the spawn timeout kills it, and the case fails within seconds; the child holds a referenced interval, so Node
 * cannot exit early on the unsettled run (tests/helpers/bounded-node-child.ts).
 *
 * `provider-maintenance.test.ts` holds the same rule with a core of the test's own, in the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { EXECUTE_SLACK_MS } from "@/lib/api/editor-query";
import type { providerMaintenance } from "@/lib/api/provider-maintenance";
import type { errorKind, errorOutcome } from "@/lib/db/error-record";
import type { createHostCore } from "@/lib/provider-host/core/host-core";
import type { installHostCore } from "@/lib/provider-host/instance";
import { boundedChild } from "../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly EXECUTE_SLACK_MS: typeof EXECUTE_SLACK_MS;
  readonly providerMaintenance: typeof providerMaintenance;
  readonly errorKind: typeof errorKind;
  readonly errorOutcome: typeof errorOutcome;
  readonly createHostCore: typeof createHostCore;
  readonly installHostCore: typeof installHostCore;
}

const SOURCE = path.join(import.meta.dir, "..", "..", "..", "..", "src");

const child = boundedChild({
  label: "provider-maintenance-bounds",
  imports: [
    { from: path.join(SOURCE, "lib", "api", "editor-query.ts"), names: ["EXECUTE_SLACK_MS"] },
    { from: path.join(SOURCE, "lib", "api", "provider-maintenance.ts"), names: ["providerMaintenance"] },
    { from: path.join(SOURCE, "lib", "db", "error-record.ts"), names: ["errorKind", "errorOutcome"] },
    { from: path.join(SOURCE, "lib", "provider-host", "core", "host-core.ts"), names: ["createHostCore"] },
    { from: path.join(SOURCE, "lib", "provider-host", "instance.ts"), names: ["installHostCore"] },
  ],
  runCase: async (deps: ChildDeps) => {
    deps.installHostCore(deps.createHostCore(), "test");
    const queryTimeout = 1_000;
    const declared = { maintenanceOperations: ["vacuum"], maintenanceOperationSpecs: {} };
    // A provider whose maintenance run never settles.
    const provider = {
      type: "postgres",
      config: { id: "c", name: "c", type: "postgres", createdAt: new Date(0), queryTimeout },
      getCapabilities: () => ({ supportsMaintenance: true, ...declared }),
      runMaintenance: () => new Promise<never>(() => {}),
    } as never;
    const maintenance = deps.providerMaintenance(
      provider,
      declared as never,
      new AbortController().signal,
      "bounds",
      // The run's deadline, the statement timeout plus the slack, ends 50 ms from now.
      () => Date.now() - queryTimeout - deps.EXECUTE_SLACK_MS + 50,
    );
    const outcome = await maintenance.run("vacuum");
    if (outcome.kind === "answered") return "answered";
    const { error } = outcome;
    return `${outcome.kind} ${error.name} ${deps.errorKind(error)} ${deps.errorOutcome(error)} ${error.message}`;
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

describe("a maintenance run in a bounded child", () => {
  test("a maintenance run that never answers is stopped at its deadline, StudioTimeoutRefusal naming the run", async () => {
    expect(await child.run<unknown>("never-answers")).toBe(
      "stopped TimeoutError studio-timeout-refusal unknown The maintenance run did not answer within the statement timeout of 1 second and 10 seconds more for the engine's own answer, so Studio stopped waiting for it.",
    );
  });
});

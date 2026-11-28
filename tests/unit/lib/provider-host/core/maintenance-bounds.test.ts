/**
 * A maintenance run and a maintenance preview that never settle, with a real deadline, in a bounded Node child
 * (src/lib/provider-host/core/maintenance.ts; docs/providers/CONTRACT.md, clause C-69): each call's wait ends at the
 * deadline's signal and answers a stop, so the child answers within its spawn timeout. Without the wait the child
 * waits until the spawn timeout kills it, and the case fails within seconds; the child holds a referenced interval, so
 * Node cannot exit early on the unsettled call (tests/helpers/bounded-node-child.ts).
 *
 * `maintenance.test.ts` holds the same rule with caller-driven aborts in the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { maintenancePreviewCall, maintenanceRunCall } from "@/lib/provider-host/core/maintenance";
import { boundedChild } from "../../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly maintenanceRunCall: typeof maintenanceRunCall;
  readonly maintenancePreviewCall: typeof maintenancePreviewCall;
}

const CORE = path.join(import.meta.dir, "..", "..", "..", "..", "..", "src", "lib", "provider-host", "core");

const child = boundedChild({
  label: "maintenance-bounds",
  imports: [{ from: path.join(CORE, "maintenance.ts"), names: ["maintenanceRunCall", "maintenancePreviewCall"] }],
  runCase: async (deps: ChildDeps, name: string) => {
    const never = () => new Promise<never>(() => {});
    const session = {
      calls: {
        console: {
          execute: { honours: [] },
          cancel: "not-offered",
          endScope: "not-offered",
          transaction: "not-offered",
        },
        objects: { tree: "not-offered", source: "not-offered" },
        maintenance: { run: "offered", preview: "offered" },
        monitoring: { panel: "not-offered", poolStats: "not-offered" },
      },
      maintenance: {
        maintenance: ["release"],
        maintenanceSpecs: [
          {
            operation: "release",
            label: "Release",
            perEntity: true,
            global: true,
            title: null,
            description: null,
            confirmation: null,
            preview: true,
            kinds: null,
          },
        ],
      },
      run: never,
      preview: never,
    } as unknown as Parameters<typeof deps.maintenanceRunCall>[0];
    const ctx = { deadline: Date.now() + 50, signal: AbortSignal.timeout(50), env: { get: () => undefined } };
    const record =
      name === "run"
        ? await deps.maintenanceRunCall(session, { operation: "release" }, ctx, { late: () => {} })
        : await deps.maintenancePreviewCall(session, { operation: "release", path: ["a"] }, ctx, { late: () => {} });
    return record.kind === "stopped" ? `stopped ${(record.reason as Error).name}` : record.kind;
  },
  heapLimitMiB: 128,
  timeoutMs: 3_000,
});

beforeAll(async () => {
  await child.build();
});

afterAll(() => {
  child.remove();
});

describe("a maintenance call in a bounded child", () => {
  test("a maintenance run that never settles is stopped at the call's deadline", async () => {
    expect(await child.run<unknown>("run")).toBe("stopped TimeoutError");
  });

  test("a maintenance preview that never settles is stopped at the call's deadline", async () => {
    expect(await child.run<unknown>("preview")).toBe("stopped TimeoutError");
  });
});

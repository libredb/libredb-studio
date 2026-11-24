/**
 * Test connection's deadline with a real timer, in a bounded Node child (src/lib/api/test-connection.ts;
 * docs/providers/CONTRACT.md, clauses C-56 and C-75): a connect that never settles, and a health read through the host
 * core that never settles, are each cut at the test's deadline, its engine's connect budget, and answered as the
 * test's `ConnectionError`, so the child answers within its spawn timeout. Without
 * the deadline the child waits until the spawn timeout kills it, and the case fails within seconds; the child holds a
 * referenced interval, so Node cannot exit early on the unsettled wait (tests/helpers/bounded-node-child.ts).
 *
 * The provider factory reaches ssh2's native addon, which the child's bundle cannot load, so the child takes a stub
 * of it: a provider whose connect never settles, or, for the health case, whose connect resolves and whose health
 * never settles, no open single-writer handle, and a tunnel scope that runs its function on the connection as it is.
 * The case reaches the stub through one global the case sets before the test starts, `__testConnectionBoundsCase`,
 * since the stub is bundled in place of the factory and the case imports nothing from it. The child installs a host
 * core, as the extension's child and the server's instrumentation do.
 *
 * `test-connection.test.ts` holds the same rule with a mocked factory in the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { testConnection } from "@/lib/api/test-connection";
import type { connectBudgetFor } from "@/lib/db/connect-budget";
import type { createHostCore } from "@/lib/provider-host/core/host-core";
import type { installHostCore } from "@/lib/provider-host/instance";
import { boundedChild } from "../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly testConnection: typeof testConnection;
  readonly connectBudgetFor: typeof connectBudgetFor;
  readonly createHostCore: typeof createHostCore;
  readonly installHostCore: typeof installHostCore;
}

const SOURCE = path.join(import.meta.dir, "..", "..", "..", "..", "src");

/** The factory the child bundles in place of the real one. */
const FACTORY_STUB = `
const never = () => new Promise(() => {});
const healthCase = () => globalThis.__testConnectionBoundsCase === "never-answers-health";
const provider = {
  type: "postgres",
  config: { id: "bounds", name: "bounds", type: "postgres", host: "127.0.0.1", port: 5432 },
  connect: () => (healthCase() ? Promise.resolve() : never()),
  disconnect: async () => {},
  getHealth: () => (healthCase() ? never() : Promise.resolve({})),
  getCapabilities: () => ({}),
  runMaintenance: never,
};
export const createDatabaseProvider = async () => provider;
export const findOpenSingleWriterProvider = () => null;
export const isSingleWriterFileOpen = () => false;
export const withOneShotTunnel = async (connection, run) => run(connection);
`;

const child = boundedChild({
  label: "test-connection-bounds",
  imports: [
    { from: path.join(SOURCE, "lib", "api", "test-connection.ts"), names: ["testConnection"] },
    { from: path.join(SOURCE, "lib", "db", "connect-budget.ts"), names: ["connectBudgetFor"] },
    { from: path.join(SOURCE, "lib", "provider-host", "core", "host-core.ts"), names: ["createHostCore"] },
    { from: path.join(SOURCE, "lib", "provider-host", "instance.ts"), names: ["installHostCore"] },
  ],
  stubs: [{ specifier: "@/lib/db/factory", source: FACTORY_STUB }],
  runCase: async (deps: ChildDeps, name: string) => {
    (globalThis as { __testConnectionBoundsCase?: string }).__testConnectionBoundsCase = name;
    deps.installHostCore(deps.createHostCore(), "test");
    const connection = { id: "bounds", name: "bounds", type: "postgres", host: "127.0.0.1", port: 5432 };
    try {
      await deps.testConnection(
        connection as never,
        { allowExternalFileAccess: false },
        "bounds",
        // The test's deadline, the engine's connect budget, ends 50 ms from now.
        Date.now() - deps.connectBudgetFor("postgres") + 50,
      );
      return "answered";
    } catch (error) {
      return (error as Error).name;
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

describe("Test connection's deadline in a bounded child", () => {
  test("a connect that never settles is cut at the test's deadline", async () => {
    expect(await child.run<string>("never-connects")).toBe("ConnectionError");
  });

  test("a health read that never settles is cut at the test's deadline", async () => {
    expect(await child.run<string>("never-answers-health")).toBe("ConnectionError");
  });
});

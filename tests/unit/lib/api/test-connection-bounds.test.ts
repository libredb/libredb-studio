/**
 * Test connection's deadline with a real timer, in a bounded Node child (src/lib/api/test-connection.ts;
 * docs/providers/CONTRACT.md, clause C-56): a connect that never settles is cut at the test's deadline, its engine's
 * connect budget, and answered as the test's `ConnectionError`, so the child answers within its spawn timeout. Without
 * the deadline the child waits until the spawn timeout kills it, and the case fails within seconds; the child holds a
 * referenced interval, so Node cannot exit early on the unsettled wait (tests/helpers/bounded-node-child.ts).
 *
 * The provider factory reaches ssh2's native addon, which the child's bundle cannot load, so the child takes a stub
 * of it: a provider whose connect never settles, no open single-writer handle, and a tunnel scope that runs its
 * function on the connection as it is.
 *
 * `test-connection.test.ts` holds the same rule with a mocked factory in the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { testConnection } from "@/lib/api/test-connection";
import type { connectBudgetFor } from "@/lib/db/connect-budget";
import { boundedChild } from "../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly testConnection: typeof testConnection;
  readonly connectBudgetFor: typeof connectBudgetFor;
}

const SOURCE = path.join(import.meta.dir, "..", "..", "..", "..", "src");

/** The factory the child bundles in place of the real one. */
const FACTORY_STUB = `
const provider = {
  type: "postgres",
  connect: () => new Promise(() => {}),
  disconnect: async () => {},
  getHealth: async () => ({}),
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
  ],
  stubs: [{ specifier: "@/lib/db/factory", source: FACTORY_STUB }],
  runCase: async (deps: ChildDeps) => {
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
});

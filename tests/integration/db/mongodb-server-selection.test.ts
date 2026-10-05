/**
 * The wall-clock bound on MongoDB's server selection during `connect()` (#1458).
 *
 * This file drives the REAL driver, and that is the point. The defect was a deadline the
 * driver enforces on its own retry loop, and a double of `MongoClient` cannot hold one:
 * `mongodb-provider.test.ts` can only assert which number reached the options object, so
 * nothing there can show that a closed port now answers in half a minute rather than a
 * full one.
 *
 * No server is started and none is needed - the case is a host and port nothing listens on,
 * which is exactly what a typo in the port produces.
 */
import { describe, expect, test } from "bun:test";
import { type AddressInfo, createServer } from "node:net";
import { MongoDBProvider } from "@/lib/db/providers/document/mongodb";

/** A port that was open a moment ago and is closed now, rather than a guessed number. */
async function portNothingListensOn(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("MongoDB server selection bound (#1458)", () => {
  test("a closed port is refused well under a minute, not after the pool acquire timeout", async () => {
    const port = await portNothingListensOn();
    // The shape `/api/db/test-connection` builds: a request's own query timeout, which
    // `connect()` does not read, over the default pool `acquireTimeout` of 60000.
    const provider = new MongoDBProvider(
      {
        id: "closed-port",
        name: "closed port",
        type: "mongodb",
        host: "127.0.0.1",
        port,
        database: "repro",
        createdAt: new Date(),
      },
      { queryTimeout: 10000 },
    );

    const started = Date.now();
    let refusal = "";
    try {
      await provider.connect();
      refusal = "connect() returned against a port nothing listens on";
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    const elapsed = Date.now() - started;
    await provider.disconnect();

    expect(refusal).toContain("ECONNREFUSED");
    // 45 s is the assertion and 30 s is the bound: the margin is there so a slow machine
    // cannot fail a correct change. The defect answers at 60 s, so it fails here.
    expect(elapsed).toBeLessThan(45_000);
  }, 90_000);
});

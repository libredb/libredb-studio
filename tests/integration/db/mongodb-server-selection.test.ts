/**
 * The wall-clock bound on MongoDB's server selection during `connect()` (#1458, #1573).
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
    // The shape `/api/db/test-connection` builds: a request's own query timeout above
    // the driver's 30 s selection bound, so the 30 s is what the measurement pins.
    // `connect()` reads the request's timeout (#1573), but only the deadline below
    // the driver's own 30 s changes the answer, and a 60000 mutant fails this test
    // only if the read itself is gone - the deadline pin lives in the #1573 test below.
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
      { queryTimeout: 60000 },
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
    // 45 s is the assertion and 30 s is the driver's bound: the margin is there so a
    // slow machine cannot fail a correct change. The old defect answered at 60 s.
    expect(elapsed).toBeLessThan(45_000);
  }, 90_000);

  // #1573: the request's own deadline now bounds the connect, so the same closed port is
  // refused within the request's query timeout rather than the driver's own 30 s
  // selection bound. The message still names the refusal the driver's monitoring saw.
  test("a closed port is refused within the request's query timeout, still naming the refusal", async () => {
    const port = await portNothingListensOn();
    const provider = new MongoDBProvider(
      {
        id: "deadline-port",
        name: "deadline port",
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
    // The deadline is the request's query timeout (10 s) with a margin for a slow
    // machine; the driver's own selection bound alone answers at 30 s, so it fails here.
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);
});

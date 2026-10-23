import assert from "node:assert/strict";

describe("the unit leg's environment", () => {
  it("runs under NODE_ENV=test, so loading the factory installs no signal handler", async () => {
    assert.equal(process.env.NODE_ENV, "test");
    const before = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
    await import("@/lib/db/factory");
    assert.deepEqual([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")], before);
  });
});

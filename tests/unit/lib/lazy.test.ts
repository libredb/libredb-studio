import { describe, test, expect } from "bun:test";
import { ChunkLoadError, lazyRetry } from "@/lib/lazy";

describe("lazyRetry", () => {
  test("loads once when the chunk arrives", async () => {
    let calls = 0;
    const load = lazyRetry(async () => {
      calls += 1;
      return "module";
    });

    expect(await load()).toBe("module");
    expect(calls).toBe(1);
  });

  // A chunk request that fails once and succeeds on a retry is the common shape of a
  // flaky proxy or a dropped connection — the case where retrying is the whole fix.
  test("retries once and returns what the second attempt loaded", async () => {
    let calls = 0;
    const load = lazyRetry(async () => {
      calls += 1;
      if (calls === 1) throw new Error("Loading chunk 42 failed");
      return "module";
    });

    expect(await load()).toBe("module");
    expect(calls).toBe(2);
  });

  // Twice is enough to tell a blip from a file that is genuinely gone — which is what
  // an upgrade under an open tab produces. The rejection has to reach the boundary
  // above, or the view suspends forever.
  test("gives the second failure to the boundary rather than retrying forever", async () => {
    let calls = 0;
    const load = lazyRetry(async () => {
      calls += 1;
      throw new Error(`attempt ${calls}`);
    });

    // Awaited, and no sleep. `Bun.sleep(600)` was a bet that the loader's own 400ms retry delay
    // had elapsed, with 200ms of margin that one bun process per CPU spends; and the assertion
    // above was never awaited, so a rejection that arrived late or never was not asserted at all.
    // The returned promise settles only after the SECOND attempt has failed, so awaiting it is
    // both the wait and the fact.
    await expect(load()).rejects.toThrow("attempt 2");
    expect(calls).toBe(2);
  });

  // The boundary tells a chunk that never arrived from a view that threw while drawing
  // by this class, never by sniffing a message: a production render error can have none.
  test("reports the second failure as a chunk load failure that keeps the original as its cause", async () => {
    const original = new Error("Loading chunk 7 failed");
    const load = lazyRetry(async () => {
      throw original;
    });

    const error = await load().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect((error as ChunkLoadError).message).toBe("Loading chunk 7 failed");
    expect((error as ChunkLoadError).cause).toBe(original);
  });

  test("a rejection that is not an Error still becomes a chunk load failure", async () => {
    const load = lazyRetry(async () => {
      throw "network down";
    });

    const error = await load().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect((error as ChunkLoadError).message).toBe("network down");
  });
});

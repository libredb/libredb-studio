import { describe, test, expect } from "bun:test";
import { lazyRetry } from "@/lib/lazy";

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

    expect(load()).rejects.toThrow("attempt 2");
    await Bun.sleep(600);
    expect(calls).toBe(2);
  });
});

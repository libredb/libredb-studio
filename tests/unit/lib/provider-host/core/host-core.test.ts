/**
 * The host core instance (src/lib/provider-host/core/host-core.ts; docs/providers/CONTRACT.md, clause C-52): what a
 * composition root installs once per process holds the core's console calls by identity, frozen, and nothing else, so
 * a caller in any bundle reaches the same plain functions and no class or port of the bundle that created it.
 */
import { describe, expect, test } from "bun:test";
import { cancelCall, executeCall } from "@/lib/provider-host/core/console";
import { createHostCore } from "@/lib/provider-host/core/host-core";

describe("the host core instance", () => {
  test("the host core holds the core's console calls, frozen, and nothing else", () => {
    const core = createHostCore();

    expect(Object.keys(core).sort()).toEqual(["cancelCall", "executeCall"]);
    expect(core.executeCall).toBe(executeCall);
    expect(core.cancelCall).toBe(cancelCall);
    expect(Object.isFrozen(core)).toBe(true);
    expect(createHostCore()).not.toBe(core);
  });
});

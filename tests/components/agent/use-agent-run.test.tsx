import "../../setup-dom";

import { describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { useAgentRun } from "@/components/agent/use-agent-run";

/**
 * The rail's ledger follower, at the one property the rest of the suite cannot see
 * (the data-analyst design, §1.4).
 *
 * `foldLedgerEntries` walks the whole accumulated ledger — items, status, gauges,
 * artifact map and statement map — and it used to be called in the hook's return
 * expression, so it re-ran on every render of the rail rather than on every new
 * event. That cost nothing while a drive was sixteen turns and is worth removing now
 * that one may take forty-eight turns and forty-five statements. What is asserted is
 * the property, not the mechanism: the folded timeline is the SAME object across a
 * render that added no entry.
 */
describe("useAgentRun — the fold is memoised on the entries", () => {
  test("a re-render that added no ledger entry re-uses the timeline it already folded", () => {
    const { result, rerender } = renderHook(() => useAgentRun());
    const first = result.current.timeline;

    rerender();

    expect(result.current.timeline).toBe(first);
    cleanup();
  });
});

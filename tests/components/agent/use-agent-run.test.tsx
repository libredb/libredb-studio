import "../../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import React from "react";
import ReactDOMServer from "react-dom/server";
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

/**
 * What this browser remembers about the conversation it was in (#B69).
 *
 * A reload clears `runId`, so the next question starts a new thread. The hook holds the
 * READING — the stored id, and nothing inferred from it — and the rail owns the sentence.
 * Driven through the hook rather than against the helpers directly: the storage key is an
 * implementation detail of this module, and a test that reached past it would pin the key
 * rather than the behaviour.
 */
describe("useAgentRun — the conversation a reload interrupted", () => {
  const KEY = "libredb_agent_thread";

  afterEach(() => {
    localStorage.clear();
    cleanup();
  });

  test("reports the stored conversation, counting the run that stored it", () => {
    localStorage.setItem(KEY, JSON.stringify({ threadId: "arun_a", steps: 3 }));

    const { result } = renderHook(() => useAgentRun());

    expect(result.current.interrupted).toEqual({ threadId: "arun_a", steps: 3 });
  });

  test("reports nothing when this browser has held no conversation", () => {
    const { result } = renderHook(() => useAgentRun());

    expect(result.current.interrupted).toBeNull();
  });

  test("reports nothing for a stored value this build cannot read", () => {
    // Not a guess and not a throw: a value written by a build that shaped it differently
    // has to read as absent, or a sentence about a conversation would stand over a
    // half-read object. Both classes land here — unparseable, and parsed but off-shape.
    localStorage.setItem(KEY, "{ not json");
    const { result: unparseable } = renderHook(() => useAgentRun());
    expect(unparseable.current.interrupted).toBeNull();
    cleanup();

    localStorage.setItem(KEY, JSON.stringify({ threadId: "arun_a" }));
    const { result: offShape } = renderHook(() => useAgentRun());
    expect(offShape.current.interrupted).toBeNull();
  });

  test("assumes nothing was interrupted during server rendering, where no localStorage exists", () => {
    /*
      There is no localStorage on the server, so `useSyncExternalStore` must take the
      SERVER snapshot — a `getSnapshot` that ran there would dereference localStorage and
      500 the page, which is why the reading is an external store rather than a mount
      effect in the first place.

      A conversation is stored first ON PURPOSE: the suite's DOM gives the server render a
      working localStorage, so with nothing stored both snapshots answer null and the
      assertion could not tell them apart.
    */
    localStorage.setItem(KEY, JSON.stringify({ threadId: "arun_a", steps: 3 }));
    function Probe() {
      return React.createElement("span", null, useAgentRun().interrupted === null ? "none" : "some");
    }

    expect(ReactDOMServer.renderToString(React.createElement(Probe))).toContain("none");
  });

  test("reports nothing where the store refuses to be read at all", () => {
    // Safari private mode and a browser configured to block site data both land here. The
    // notice is what is lost; the rail still opens runs, which is the whole of the policy.
    const realGetItem = localStorage.getItem.bind(localStorage);
    localStorage.getItem = () => {
      throw new Error("SecurityError");
    };

    try {
      const { result } = renderHook(() => useAgentRun());
      expect(result.current.interrupted).toBeNull();
    } finally {
      localStorage.getItem = realGetItem;
    }
  });
});

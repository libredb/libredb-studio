import "../setup-dom";

import { describe, test, expect, afterEach, mock } from "bun:test";
import { cleanup, render, renderHook } from "@testing-library/react";
import React, { useEffect } from "react";

import { useStableCallback } from "@/hooks/use-stable-callback";

afterEach(cleanup);

describe("useStableCallback", () => {
  test("keeps one identity while the function it wraps changes", () => {
    const { result, rerender } = renderHook(({ n }) => useStableCallback(() => n), { initialProps: { n: 1 } });
    const first = result.current;

    rerender({ n: 2 });

    expect(result.current).toBe(first);
  });

  test("runs the latest function, with its arguments", () => {
    const { result, rerender } = renderHook(({ n }) => useStableCallback((x: number) => x + n), {
      initialProps: { n: 1 },
    });

    rerender({ n: 10 });

    expect(result.current(5)).toBe(15);
  });

  // The agent rail calls the shell's hand-over handlers from its own effect, and a
  // child's passive effect runs before its parent's. The wrapper has to be current by
  // then, or the rail would run the previous render's handler.
  test("is current by the time a child's effect calls it", () => {
    const seen = mock((value: string) => value);

    function Child({ run }: { run: () => void }) {
      useEffect(() => {
        run();
      });
      return null;
    }

    function Parent({ value }: { value: string }) {
      const run = useStableCallback(() => seen(value));
      return <Child run={run} />;
    }

    const { rerender } = render(<Parent value="first" />);
    rerender(<Parent value="second" />);

    expect(seen.mock.calls.map(([value]) => value)).toEqual(["first", "second"]);
  });
});

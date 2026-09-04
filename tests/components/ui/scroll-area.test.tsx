import "../../setup-dom";
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { cleanup, render } from "@testing-library/react";

// Radix's ScrollArea observes its viewport. The DOM shim has no ResizeObserver, and
// the component mounts one on first render, so a stand-in goes in before the import.
if (typeof globalThis.ResizeObserver === "undefined") {
  // Nothing here measures real geometry; the observer only has to exist.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const { ScrollArea } = await import("@/components/ui/scroll-area");

/**
 * The sidebar's clipping bug, pinned at the primitive that caused it.
 *
 * Radix renders its own wrapper div inside the viewport with an inline
 * `display: table; min-width: 100%`. That is a shrink-to-fit box, so it grows past
 * the viewport whenever a child's max-content width does, and the viewport's
 * `overflow-x: hidden` slices off the excess. Measured in a browser on 2026-09-04:
 * an object browser listing `pg_ext_aux.pg_pax_fastsequence` rendered the wrapper
 * 327px wide inside a 299px viewport, and every row lost its last 28px — a row count
 * of `2.0k` read `2.0`, and the Explorer's count badge was sliced mid-glyph.
 *
 * A DOM shim does no layout, so these tests cannot re-measure that. What they CAN
 * hold is the two facts the fix rests on, both of which a refactor could quietly
 * drop: that the viewport carries the rule pinning its child, and that the child the
 * rule selects is really Radix's direct-child wrapper rather than the content.
 */
describe("ui/scroll-area against the real @radix-ui/react-scroll-area", () => {
  afterEach(() => {
    cleanup();
  });

  test("the viewport takes its direct child out of table layout", () => {
    const { container } = render(
      <ScrollArea>
        <div data-testid="content">pg_ext_aux.pg_pax_fastsequence</div>
      </ScrollArea>,
    );

    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]');
    expect(viewport).not.toBeNull();
    // The rule, not merely "some class": `[&>div]:block!` is what keeps Radix's
    // table-layout wrapper from outgrowing the box that clips it.
    expect(viewport?.className).toContain("[&>div]:block!");
  });

  test("the child that rule selects is Radix's wrapper, not the content", () => {
    const { container, getByTestId } = render(
      <ScrollArea>
        <div data-testid="content">pg_ext_aux.pg_pax_fastsequence</div>
      </ScrollArea>,
    );

    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]');
    const wrapper = viewport?.firstElementChild;
    // Radix's wrapper sits BETWEEN the viewport and the content. If a future version
    // stopped rendering it, `[&>div]:block!` would land on the content instead and
    // the fix would silently change meaning.
    expect(wrapper).not.toBeNull();
    expect(wrapper).not.toBe(getByTestId("content"));
    expect(wrapper?.contains(getByTestId("content"))).toBe(true);
  });

  test("the scrollbar is vertical unless a call site asks otherwise", () => {
    // Neutralising the table layout is only safe while nothing here scrolls sideways. This is the
    // default that makes that true; no call site in this repo overrides it.
    // `type="always"` only forces the bar to mount with no layout to hover over; the
    // orientation it mounts with is the component's own default either way.
    const { container } = render(
      <ScrollArea type="always">
        <div>pg_ext_aux.pg_pax_fastsequence</div>
      </ScrollArea>,
    );
    const bar = container.querySelector('[data-slot="scroll-area-scrollbar"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("data-orientation")).toBe("vertical");
  });
});

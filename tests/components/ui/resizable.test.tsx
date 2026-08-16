import "../../setup-dom";
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { cleanup, render } from "@testing-library/react";

// react-resizable-panels 4 reaches for DOMRect, which this DOM shim does not
// provide. Global, which is why this file runs in its own execution group.
if (typeof globalThis.DOMRect === "undefined") {
  // @ts-expect-error - minimal stand-in; nothing here measures real geometry
  globalThis.DOMRect = class {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
    top = 0;
    left = 0;
    right = 0;
    bottom = 0;
  };
}

const { ResizablePanelGroup, ResizablePanel, ResizableHandle } = await import("@/components/ui/resizable");

/**
 * Every other suite mocks `@/components/ui/resizable` away, so nothing else
 * renders the real library. These tests exist because the v3 -> v4 upgrade
 * broke this wrapper in two ways a type-checker cannot see: the orientation
 * signal moved from a `data-panel-group-direction` attribute on the group to
 * `aria-orientation` on the separator, and it is *inverted* there.
 */
describe("ui/resizable against the real react-resizable-panels", () => {
  afterEach(() => {
    cleanup();
  });

  const renderGroup = (orientation: "horizontal" | "vertical") =>
    render(
      <ResizablePanelGroup id={`g-${orientation}`} orientation={orientation}>
        <ResizablePanel id="a" defaultSize="30" minSize="10" />
        <ResizableHandle withHandle />
        <ResizablePanel id="b" defaultSize="70" />
      </ResizablePanelGroup>,
    );

  test("a horizontal group is split by a separator that reports itself as vertical", () => {
    const { container } = renderGroup("horizontal");

    const group = container.querySelector("[data-slot=resizable-panel-group]") as HTMLElement;
    const handle = container.querySelector("[data-slot=resizable-handle]") as HTMLElement;

    expect(group.style.flexDirection).toBe("row");
    // The inversion: the line drawn across a horizontal group runs vertically.
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
  });

  test("a vertical group is split by a separator that reports itself as horizontal", () => {
    const { container } = renderGroup("vertical");

    const group = container.querySelector("[data-slot=resizable-panel-group]") as HTMLElement;
    const handle = container.querySelector("[data-slot=resizable-handle]") as HTMLElement;

    expect(group.style.flexDirection).toBe("column");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
  });

  test("the handle styles the vertical-group case off the attribute the library actually writes", () => {
    const { container } = renderGroup("vertical");
    const handle = container.querySelector("[data-slot=resizable-handle]") as HTMLElement;

    // Keyed to `aria-orientation`, not v3's `data-panel-group-direction`, and
    // keyed to "horizontal" because of the inversion asserted above. Get either
    // half wrong and the vertical splitter silently loses its styling.
    expect(handle.className).toContain("aria-[orientation=horizontal]:h-px");
    expect(handle.className).toContain("aria-[orientation=horizontal]:w-full");
    expect(handle.className).not.toContain("panel-group-direction");
  });

  test("panels take unitless strings, which v4 reads as percentages rather than pixels", () => {
    const { container } = renderGroup("horizontal");
    const panels = container.querySelectorAll("[data-slot=resizable-panel]");

    expect(panels).toHaveLength(2);
    // A bare number would mean pixels in v4 - a 22-pixel sidebar rather than a
    // 22-percent one - and would type-check either way.
    for (const panel of panels) {
      expect(panel.getAttribute("style")).toContain("flex-grow");
    }
  });

  test("a conditional sibling appears and disappears without detaching the other panels", () => {
    // This is what v3's `order` prop existed for, and v4 removed it: layout is
    // keyed by panel id instead. Studio mounts a third panel (the agent rail)
    // conditionally, so the ids have to survive the toggle.
    const Layout = ({ withRail }: { withRail: boolean }) => (
      <ResizablePanelGroup id="g-conditional" orientation="horizontal">
        <ResizablePanel id="sidebar" defaultSize="22" />
        <ResizableHandle />
        <ResizablePanel id="body" defaultSize={withRail ? "54" : "78"} />
        {withRail && (
          <>
            <ResizableHandle />
            <ResizablePanel id="rail" defaultSize="24" />
          </>
        )}
      </ResizablePanelGroup>
    );

    const ids = (c: HTMLElement) => Array.from(c.querySelectorAll("[data-slot=resizable-panel]")).map((p) => p.id);

    const { container, rerender } = render(<Layout withRail={false} />);
    expect(ids(container)).toEqual(["sidebar", "body"]);

    rerender(<Layout withRail={true} />);
    expect(ids(container)).toEqual(["sidebar", "body", "rail"]);

    rerender(<Layout withRail={false} />);
    expect(ids(container)).toEqual(["sidebar", "body"]);
  });

  test("withHandle renders the grip, and omitting it renders none", () => {
    const withGrip = render(
      <ResizablePanelGroup id="g-grip" orientation="horizontal">
        <ResizablePanel id="a" />
        <ResizableHandle withHandle />
        <ResizablePanel id="b" />
      </ResizablePanelGroup>,
    );
    expect(withGrip.container.querySelector("[data-slot=resizable-handle] svg")).not.toBeNull();
    cleanup();

    const withoutGrip = render(
      <ResizablePanelGroup id="g-nogrip" orientation="horizontal">
        <ResizablePanel id="a" />
        <ResizableHandle />
        <ResizablePanel id="b" />
      </ResizablePanelGroup>,
    );
    expect(withoutGrip.container.querySelector("[data-slot=resizable-handle] svg")).toBeNull();
  });
});

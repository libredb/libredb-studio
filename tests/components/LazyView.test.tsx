import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

import { ChunkBoundary, ViewLoading } from "@/components/LazyView";

afterEach(() => {
  cleanup();
});

describe("ViewLoading", () => {
  test("announces what is loading in a live region", () => {
    const { getByTestId } = render(<ViewLoading label="Loading the panel" />);

    const region = getByTestId("view-loading");
    // `output` carries the live region natively, which is what jsx-a11y's
    // prefer-tag-over-role asks for instead of a div with role="status".
    expect(region.tagName).toBe("OUTPUT");
    expect(region.getAttribute("aria-label")).toBe("Loading the panel");
  });

  test("takes the caller's positioning, so the diagram can cover its own overlay", () => {
    const { getByTestId } = render(<ViewLoading label="Loading the diagram" className="absolute inset-0" />);

    expect(getByTestId("view-loading").className).toContain("absolute inset-0");
  });
});

function Boom(): React.ReactElement {
  throw new Error("Loading chunk 42 failed");
}

describe("ChunkBoundary", () => {
  test("renders its children while nothing has failed", () => {
    const { getByText, queryByTestId } = render(
      <ChunkBoundary label="This view">
        <p>the chart</p>
      </ChunkBoundary>,
    );

    expect(getByText("the chart")).toBeTruthy();
    expect(queryByTestId("chunk-error")).toBeNull();
  });

  // The failure this exists for: the view is no longer in the bundle that already
  // loaded, so its arrival is a request — and a request that never completes used to
  // leave a spinner running with nothing said.
  test("names the view that could not be loaded instead of leaving a spinner", () => {
    const { getByTestId, getByText } = render(
      <ChunkBoundary label="Charts">
        <Boom />
      </ChunkBoundary>,
    );

    expect(getByTestId("chunk-error")).toBeTruthy();
    expect(getByText("Charts could not be loaded.")).toBeTruthy();
  });

  test("offers the remedy that actually works: re-fetching the document", () => {
    const reload = mock(() => {});
    const original = window.location.reload;
    Object.defineProperty(window.location, "reload", { value: reload, configurable: true });
    try {
      const { getByText } = render(
        <ChunkBoundary label="Charts">
          <Boom />
        </ChunkBoundary>,
      );
      fireEvent.click(getByText("Reload"));
    } finally {
      Object.defineProperty(window.location, "reload", { value: original, configurable: true });
    }

    expect(reload).toHaveBeenCalledTimes(1);
  });
});

import { describe, test, expect, afterEach, mock, spyOn } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

import { ChunkBoundary, RENDER_ERROR_HINT, ViewLoading } from "@/components/LazyView";
import { ChunkLoadError } from "@/lib/lazy";
import { logger } from "@/lib/logger";

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

// A chunk that never arrived, as `lazyRetry` reports it after its retry.
function Boom(): React.ReactElement {
  throw new ChunkLoadError("Loading chunk 42 failed");
}

// Any other render error, the way a component in the panel throws one.
function RenderBoom({ message }: { message: string }): React.ReactElement {
  throw new Error(message);
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

  // A dialog's chunk failing has no place of its own in the layout, so the caller
  // positions the notice, the same way ViewLoading takes its className.
  test("takes the caller's positioning for the notice", () => {
    const { getByTestId } = render(
      <ChunkBoundary label="The connection dialog" className="fixed inset-0">
        <Boom />
      </ChunkBoundary>,
    );

    expect(getByTestId("chunk-error").className).toContain("fixed inset-0");
  });

  test("offers Close only when the caller can take the view away", () => {
    const onDismiss = mock(() => {});
    const withClose = render(
      <ChunkBoundary label="The diagram" onDismiss={onDismiss}>
        <Boom />
      </ChunkBoundary>,
    );
    fireEvent.click(withClose.getByText("Close"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    withClose.unmount();

    const without = render(
      <ChunkBoundary label="Charts">
        <Boom />
      </ChunkBoundary>,
    );
    expect(without.queryByText("Close")).toBeNull();
  });

  // TanStack Table, for one, throws in render when it is handed a column it cannot build.
  // That is not a request that failed, so the chunk copy and its Reload would be a false
  // diagnosis; the notice says the view could not be displayed. The error's own words go to
  // the log only: a message may quote a value (a JSON.parse SyntaxError quotes its input),
  // and the screen must not show one past masking.
  test("names a render error as one, in a fixed sentence, and logs the message instead of showing it", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { getByTestId, getByText, queryByText } = render(
        <ChunkBoundary label="This view">
          <RenderBoom message="Columns require an id: alice@example.com" />
        </ChunkBoundary>,
      );

      expect(getByTestId("render-error")).toBeTruthy();
      expect(getByText("This view could not be displayed.")).toBeTruthy();
      expect(getByText(RENDER_ERROR_HINT)).toBeTruthy();
      expect(getByTestId("render-error").textContent).not.toContain("alice@example.com");
      expect(queryByText("Reload")).toBeNull();
      expect(queryByText(/is fetched when it is first opened/)).toBeNull();
      expect(warn).toHaveBeenCalledWith("A view failed to render", {
        route: "ChunkBoundary",
        view: "This view",
        error: "Columns require an id: alice@example.com",
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("a render error with no message reads the same as one with a message", () => {
    const { getByTestId } = render(
      <ChunkBoundary label="This view">
        <RenderBoom message="" />
      </ChunkBoundary>,
    );

    expect(getByTestId("render-error").textContent).toContain("This view could not be displayed.");
    expect(getByTestId("render-error").textContent).toContain(RENDER_ERROR_HINT);
  });

  test("a thrown value that is not an Error is still a render error, and only the log carries it", () => {
    function Thrower(): React.ReactElement {
      throw "not an error object";
    }
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { getByTestId } = render(
        <ChunkBoundary label="This view">
          <Thrower />
        </ChunkBoundary>,
      );

      expect(getByTestId("render-error").textContent).not.toContain("not an error object");
      expect(warn.mock.calls[0]?.[1]).toMatchObject({ error: "not an error object" });
    } finally {
      warn.mockRestore();
    }
  });

  test("Try again renders the children once more, and a view that still throws is shown failing again", () => {
    let throws = true;
    function Flaky(): React.ReactElement {
      if (throws) throw new Error("first render failed");
      return <p>the view</p>;
    }
    const { getByText, queryByTestId } = render(
      <ChunkBoundary label="This view">
        <Flaky />
      </ChunkBoundary>,
    );
    fireEvent.click(getByText("Try again"));
    expect(queryByTestId("render-error")).toBeTruthy();

    throws = false;
    fireEvent.click(getByText("Try again"));
    expect(getByText("the view")).toBeTruthy();
    expect(queryByTestId("render-error")).toBeNull();
  });

  test("offers Close on a render error when the caller can take the view away", () => {
    const onDismiss = mock(() => {});
    const { getByText } = render(
      <ChunkBoundary label="The diagram" onDismiss={onDismiss}>
        <RenderBoom message="boom" />
      </ChunkBoundary>,
    );
    fireEvent.click(getByText("Close"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // The panel mounts one boundary for every result, every mode and every tab, so a
  // boundary that never resets turns one bad result into a failed panel until a reload.
  test("a changed reset key renders the new children instead of the old failure", () => {
    const { getByText, queryByTestId, rerender } = render(
      <ChunkBoundary label="This view" resetKeys={["results", { first: true }]}>
        <RenderBoom message="first result" />
      </ChunkBoundary>,
    );
    expect(queryByTestId("render-error")).toBeTruthy();

    rerender(
      <ChunkBoundary label="This view" resetKeys={["results", { second: true }]}>
        <p>the next result</p>
      </ChunkBoundary>,
    );
    expect(getByText("the next result")).toBeTruthy();
    expect(queryByTestId("render-error")).toBeNull();
  });

  test("the same reset keys keep the failure, so a re-render alone does not hide it", () => {
    const key = { result: 1 };
    const { queryByTestId, rerender } = render(
      <ChunkBoundary label="This view" resetKeys={["results", key]}>
        <RenderBoom message="still failing" />
      </ChunkBoundary>,
    );
    rerender(
      <ChunkBoundary label="This view" resetKeys={["results", key]}>
        <p>not shown</p>
      </ChunkBoundary>,
    );
    expect(queryByTestId("render-error")).toBeTruthy();
  });

  test("a reset key list of a different length is a change", () => {
    const { getByText, rerender } = render(
      <ChunkBoundary label="This view" resetKeys={["results"]}>
        <RenderBoom message="x" />
      </ChunkBoundary>,
    );
    rerender(
      <ChunkBoundary label="This view" resetKeys={["results", "charts"]}>
        <p>recovered</p>
      </ChunkBoundary>,
    );
    expect(getByText("recovered")).toBeTruthy();
  });

  // A real chunk failure that recurs after a reset throws again, and is named again.
  test("a chunk failure after a reset is shown as a chunk failure again", () => {
    const { getByTestId, rerender } = render(
      <ChunkBoundary label="Charts" resetKeys={[1]}>
        <Boom />
      </ChunkBoundary>,
    );
    rerender(
      <ChunkBoundary label="Charts" resetKeys={[2]}>
        <Boom />
      </ChunkBoundary>,
    );
    expect(getByTestId("chunk-error").textContent).toContain("Charts could not be loaded.");
  });
});

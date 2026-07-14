import "../setup-dom";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import ErrorPage from "@/app/error";
import AdminError from "@/app/admin/error";
import GlobalError from "@/app/global-error";
import NotFound from "@/app/not-found";

function makeError(digest?: string): Error & { digest?: string } {
  const error = new Error("boom") as Error & { digest?: string };
  if (digest) error.digest = digest;
  return error;
}

describe("ErrorPage (app/error)", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders the error message and calls reset on Try Again", () => {
    const reset = mock(() => {});
    const { getByText } = render(<ErrorPage error={makeError()} reset={reset} />);

    expect(getByText("Something went wrong")).not.toBeNull();
    fireEvent.click(getByText("Try Again"));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  test("shows the digest when present and hides it otherwise", () => {
    const reset = mock(() => {});
    const withDigest = render(<ErrorPage error={makeError("abc123")} reset={reset} />);
    expect(withDigest.getByText("Error ID: abc123")).not.toBeNull();
    cleanup();

    const withoutDigest = render(<ErrorPage error={makeError()} reset={reset} />);
    expect(withoutDigest.queryByText(/Error ID:/)).toBeNull();
  });
});

describe("AdminError (app/admin/error)", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders the admin error message and calls reset on Try Again", () => {
    const reset = mock(() => {});
    const { getByText } = render(<AdminError error={makeError("admin-1")} reset={reset} />);

    expect(getByText("Admin Dashboard Error")).not.toBeNull();
    expect(getByText("Error ID: admin-1")).not.toBeNull();
    fireEvent.click(getByText("Try Again"));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  test("Back to Studio navigates to the root path", () => {
    const savedDescriptor = Object.getOwnPropertyDescriptor(window, "location");
    const locationMock = { href: "", assign: mock(() => {}), replace: mock(() => {}) };
    Object.defineProperty(window, "location", {
      value: locationMock,
      writable: true,
      configurable: true,
    });

    try {
      const reset = mock(() => {});
      const { getByText } = render(<AdminError error={makeError()} reset={reset} />);
      fireEvent.click(getByText("Back to Studio"));
      expect(locationMock.href).toBe("/");
    } finally {
      if (savedDescriptor) {
        Object.defineProperty(window, "location", savedDescriptor);
      }
    }
  });
});

describe("GlobalError (app/global-error)", () => {
  // GlobalError renders its own <html>/<body>, so render to a string instead of
  // mounting into the happy-dom document (which would nest html inside a div).
  test("renders the fallback shell with the digest", () => {
    const html = ReactDOMServer.renderToString(<GlobalError error={makeError("g-1")} reset={() => {}} />);
    expect(html).toContain("Something went wrong");
    // React SSR separates adjacent text segments with a comment marker.
    expect(html).toContain("Error ID:");
    expect(html).toContain("g-1");
    expect(html).toContain("Refresh Page");
  });

  test("omits the digest line when absent", () => {
    const html = ReactDOMServer.renderToString(<GlobalError error={makeError()} reset={() => {}} />);
    expect(html).not.toContain("Error ID:");
  });
});

describe("NotFound (app/not-found)", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders the 404 page with studio and login links", () => {
    const { getByText } = render(<NotFound />);
    expect(getByText("404")).not.toBeNull();
    expect(getByText("Page Not Found")).not.toBeNull();
    expect(getByText("Go to Studio").closest("a")?.getAttribute("href")).toBe("/");
    expect(getByText("Sign In").closest("a")?.getAttribute("href")).toBe("/login");
  });
});

import "../../setup-dom";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";

mock.module("@/components/admin/tabs/OverviewTab", () => ({
  OverviewTab: ({ user }: { user?: { username?: string } | null }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement(
      "div",
      { "data-testid": "overview-tab" },
      `OverviewTab${user?.username ? ` - ${user.username}` : ""}`,
    );
  },
}));

import { afterEach, beforeEach, describe, expect, test, mock as bunMock } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

const { default: AdminOverviewPage } = await import("@/app/admin/overview/page");

const AUTH_ME = {
  json: {
    authenticated: true,
    user: { username: "admin", role: "admin" },
  },
};

const DISCOVERY = {
  json: {
    discovery: {
      platform: "caprover",
      state: "ok",
      message: "Discovery is running",
      generatedAt: "2026-10-04T12:00:00.000Z",
      checkedAt: "2026-10-04T12:00:10.000Z",
      error: null,
      connected: [{ name: "pgtest (PostgreSQL)", type: "postgres" }],
      skipped: [],
    },
    transport: { plainHttp: false, cookieSecureOff: false },
  },
};

describe("AdminOverviewPage", () => {
  let fetchMock: ReturnType<typeof mockGlobalFetch>;

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  beforeEach(() => {
    fetchMock = mockGlobalFetch({ "/api/auth/me": AUTH_ME });
  });

  test("renders overview content and passes fetched user", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminOverviewPage />);
    });

    expect(renderResult!.getByTestId("admin-content-overview")).not.toBeNull();

    await waitFor(() => {
      expect(renderResult!.getByTestId("overview-tab").textContent).toContain("admin");
    });
  });

  test("renders the discovery card above the overview tab when discovery is enabled", async () => {
    mockGlobalFetch({ "/api/auth/me": AUTH_ME, "/api/admin/discovery": DISCOVERY });

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminOverviewPage />);
    });

    await renderResult!.findByTestId("platform-discovery-card");
    const order = Array.from(
      renderResult!.container.querySelectorAll('[data-testid="platform-discovery-card"], [data-testid="overview-tab"]'),
    ).map((element) => element.getAttribute("data-testid"));

    expect(order).toEqual(["platform-discovery-card", "overview-tab"]);
  });

  test("renders no discovery card when the status route answers 404", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminOverviewPage />);
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/admin/discovery"))).toBe(true);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(renderResult!.queryByTestId("platform-discovery-card")).toBeNull();
    expect(renderResult!.getByTestId("overview-tab")).not.toBeNull();
  });

  test("logs error when auth fetch fails", async () => {
    mockGlobalFetch({
      "/api/auth/me": () => {
        throw new Error("network down");
      },
    });

    const originalConsoleError = console.error;
    const consoleErrorMock = bunMock(() => {});
    console.error = consoleErrorMock;

    try {
      await act(async () => {
        render(<AdminOverviewPage />);
      });

      await waitFor(() => {
        expect(consoleErrorMock).toHaveBeenCalledWith("Failed to fetch user:", expect.any(Error));
      });
    } finally {
      console.error = originalConsoleError;
    }
  });
});

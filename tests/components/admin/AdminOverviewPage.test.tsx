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

describe("AdminOverviewPage", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  beforeEach(() => {
    mockGlobalFetch({
      "/api/auth/me": {
        json: {
          authenticated: true,
          user: { username: "admin", role: "admin" },
        },
      },
    });
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

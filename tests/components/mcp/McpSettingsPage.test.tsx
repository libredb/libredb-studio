import "../../setup-dom";
import { mockRouterPush } from "../../helpers/mock-navigation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import McpSettingsPage from "@/app/settings/mcp/page";

describe("/settings/mcp page", () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("renders 'Back to the editor' link leading to / when loaded", async () => {
    mockGlobalFetch({
      "/api/auth/me": { json: { authenticated: true, user: { username: "admin", role: "admin" } } },
      "/api/mcp/token": {
        json: {
          state: "ready",
          problems: [],
          url: "https://studio.example.com/api/mcp",
          tokenTtlDays: 30,
          visibleConnections: 1,
        },
      },
    });

    render(<McpSettingsPage />);
    const link = await screen.findByRole("link", { name: /Back to the editor/i });
    expect(link.getAttribute("href")).toBe("/");
  });

  test("renders 'Back to the editor' link leading to / when status read fails", async () => {
    mockGlobalFetch({
      "/api/auth/me": { json: { authenticated: true, user: { username: "admin", role: "admin" } } },
      "/api/mcp/token": { status: 500, json: { error: "Failed" } },
    });

    render(<McpSettingsPage />);
    const link = await screen.findByRole("link", { name: /Back to the editor/i });
    expect(link.getAttribute("href")).toBe("/");
  });

  test("a session the server no longer accepts sends the tab to /login (#1196)", async () => {
    mockGlobalFetch({
      "/api/auth/me": { status: 401, json: { authenticated: false } },
      "/api/mcp/token": { status: 401, json: { error: "Authentication required" } },
    });
    window.history.replaceState(null, "", "/settings/mcp");
    try {
      render(<McpSettingsPage />);
      await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith("/login?next=%2Fsettings%2Fmcp"));
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  test("a live session stays on the page", async () => {
    mockGlobalFetch({
      "/api/auth/me": { json: { authenticated: true, user: { username: "admin", role: "admin" } } },
      "/api/mcp/token": {
        json: {
          state: "ready",
          problems: [],
          url: "https://studio.example.com/api/mcp",
          tokenTtlDays: 30,
          visibleConnections: 1,
        },
      },
    });
    window.history.replaceState(null, "", "/settings/mcp");
    try {
      render(<McpSettingsPage />);
      await screen.findByRole("link", { name: /Back to the editor/i });
      expect(mockRouterPush).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});

import "../../setup-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import McpSettingsPage from "@/app/settings/mcp/page";

describe("/settings/mcp page", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("renders 'Back to the editor' link leading to / when loaded", async () => {
    mockGlobalFetch({
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
      "/api/mcp/token": { status: 500, json: { error: "Failed" } },
    });

    render(<McpSettingsPage />);
    const link = await screen.findByRole("link", { name: /Back to the editor/i });
    expect(link.getAttribute("href")).toBe("/");
  });
});

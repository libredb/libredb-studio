import "../setup-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

import SettingsLayout from "@/app/settings/layout";
import McpSettingsPage from "@/app/settings/mcp/page";

const MCP_STATUS = {
  state: "ready",
  problems: [],
  url: "https://studio.example.com/api/mcp",
  tokenTtlDays: 30,
  visibleConnections: 1,
};

describe("/settings layout", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("libredb_connections", JSON.stringify([{ id: "c1", name: "Warehouse" }]));
    localStorage.setItem("libredb_workspace_owner", "admin@libredb.org");
    localStorage.setItem("libredb_server_migrated", "2026-10-07");
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
    localStorage.clear();
  });

  test("server mode: a settings page records the signed-in account as the owner of the browser copy", async () => {
    mockGlobalFetch({
      "/api/storage/config": { json: { provider: "postgres", serverMode: true } },
      "/api/auth/me": { json: { user: { username: "user@libredb.org" } } },
      "/api/mcp/token": { json: MCP_STATUS },
    });

    const view = render(
      <SettingsLayout>
        <McpSettingsPage />
      </SettingsLayout>,
    );

    expect(await view.findByRole("link", { name: /Back to the editor/i })).not.toBeNull();
    expect(localStorage.getItem("libredb_workspace_owner")).toBe("user@libredb.org");
    expect(localStorage.getItem("libredb_connections")).toBeNull();
  });

  test("local mode: a settings page renders and leaves the browser copy as it is", async () => {
    mockGlobalFetch({
      "/api/storage/config": { json: { provider: "local", serverMode: false } },
      "/api/mcp/token": { json: MCP_STATUS },
    });

    const view = render(
      <SettingsLayout>
        <McpSettingsPage />
      </SettingsLayout>,
    );

    expect(await view.findByRole("link", { name: /Back to the editor/i })).not.toBeNull();
    expect(localStorage.getItem("libredb_workspace_owner")).toBe("admin@libredb.org");
    expect(localStorage.getItem("libredb_connections")).toBe(JSON.stringify([{ id: "c1", name: "Warehouse" }]));
  });
});

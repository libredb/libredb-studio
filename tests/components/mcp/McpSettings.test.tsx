import "../../setup-dom";

import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { McpSettings } from "@/components/mcp/McpSettings";
import { mcpClientConfigs } from "@/lib/mcp/client-config";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

/**
 * The MCP settings screen (#246), in its simplest form: the channel's three states, the zero-state
 * explanation, a token shown once with a copy button and written nowhere, and the client snippets
 * exactly as client-config.ts builds them for the deployment's URL.
 */

const URL = "https://studio.example.com/api/mcp";
const READY = { state: "ready", problems: [], url: URL, tokenTtlDays: 30, visibleConnections: 2 };
const TOKEN = "minted-token-value-written-in-words";
const MINTED = { token: TOKEN, expiresAt: "2026-10-26T12:00:00.000Z", url: URL };
const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");

function serve(status: object, mint: { status: number; json: unknown } = { status: 200, json: MINTED }) {
  return mockGlobalFetch({
    "/api/mcp/token": (request) => (request.method === "POST" ? mint : { json: status }),
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText: mock(async () => {}) },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  restoreGlobalFetch();
  if (originalClipboard) Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
});

describe("the three states", () => {
  test("off says what an operator sets, and offers no token", async () => {
    serve({
      state: "off",
      problems: ["LIBREDB_MCP_ENABLED is off: set it to true, on or 1 to enable MCP"],
      url: null,
      tokenTtlDays: 30,
      visibleConnections: 1,
    });
    const { findByText, queryByRole } = render(<McpSettings />);
    expect(await findByText(/MCP is off on this server/)).toBeTruthy();
    expect(await findByText("LIBREDB_MCP_ENABLED is off: set it to true, on or 1 to enable MCP")).toBeTruthy();
    expect(queryByRole("button", { name: "Create token" })).toBeNull();
  });

  test("misconfigured lists every problem, and offers no token", async () => {
    const problems = [
      "LIBREDB_MCP_URL is not set: set it to the address clients use, such as https://studio.example.com/api/mcp",
      "LIBREDB_MCP_TOKEN_LABEL is not set: set it to any value, and change it to revoke every MCP token at once",
    ];
    serve({ state: "misconfigured", problems, url: null, tokenTtlDays: 30, visibleConnections: 0 });
    const { findByText, getByText, queryByRole } = render(<McpSettings />);
    expect(await findByText(/MCP is not ready on this server/)).toBeTruthy();
    for (const problem of problems) expect(getByText(problem)).toBeTruthy();
    expect(queryByRole("button", { name: "Create token" })).toBeNull();
  });

  test("ready shows the address, the connection count and the Create token button", async () => {
    serve(READY);
    const { findByText, findByRole } = render(<McpSettings />);
    expect(await findByText(URL)).toBeTruthy();
    expect(await findByText("Your role can reach 2 opted-in connections.")).toBeTruthy();
    expect(await findByRole("button", { name: "Create token" })).toBeTruthy();
  });
});

describe("the connection count", () => {
  test("at zero explains the empty list and the fix", async () => {
    serve({ ...READY, visibleConnections: 0 });
    const { findByText } = render(<McpSettings />);
    expect(
      await findByText(
        "No connection is opted in for your role: an operator adds mcp: true to a seed connection, and until then list_connections answers an empty list.",
      ),
    ).toBeTruthy();
  });

  test("says it is unknown when the seed file cannot be read", async () => {
    serve({ ...READY, visibleConnections: null });
    const { findByText } = render(<McpSettings />);
    expect(
      await findByText("The connections your role can reach are unknown, because the seed file could not be read."),
    ).toBeTruthy();
  });
});

describe("minting", () => {
  test("shows the token once with a copy button and its expiry, and writes it to no storage and no URL", async () => {
    const fetches = serve(READY);
    const localWrites = spyOn(globalThis.localStorage, "setItem");
    try {
      const { findByRole, findByTestId, findByText } = render(<McpSettings />);
      fireEvent.click(await findByRole("button", { name: "Create token" }));
      expect((await findByTestId("mcp-token-value")).textContent).toBe(TOKEN);
      expect(await findByText(/It expires on 2026-10-26\./)).toBeTruthy();
      expect(await findByText(/it is not shown again/)).toBeTruthy();
      fireEvent.click(await findByTestId("mcp-token-copy"));
      await waitFor(() => expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(TOKEN));
      expect(fetches.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(localWrites).not.toHaveBeenCalled();
      expect(globalThis.location.href).not.toContain(TOKEN);
    } finally {
      localWrites.mockRestore();
    }
  });

  test("the component's source names no browser storage", () => {
    const source = readFileSync(join(import.meta.dir, "../../../src/components/mcp/McpSettings.tsx"), "utf8");
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  test("shows the server's reason and problems when minting is refused", async () => {
    serve(READY, {
      status: 409,
      json: {
        error: "MCP tokens cannot be issued on this server",
        problems: [
          "LIBREDB_MCP_TOKEN_LABEL is not set: set it to any value, and change it to revoke every MCP token at once",
        ],
      },
    });
    const { findByRole, findByText } = render(<McpSettings />);
    fireEvent.click(await findByRole("button", { name: "Create token" }));
    expect((await findByRole("alert")).textContent).toContain("MCP tokens cannot be issued on this server");
    expect(await findByText(/LIBREDB_MCP_TOKEN_LABEL is not set/)).toBeTruthy();
  });

  test("says the status could not be read when the status request fails", async () => {
    mockGlobalFetch({ "/api/mcp/token": { status: 500, json: { error: "server fault" } } });
    const { findByText } = render(<McpSettings />);
    expect(await findByText("The MCP status could not be read. Reload the page to try again.")).toBeTruthy();
  });

  test("says the token could not be created when the minting request itself fails", async () => {
    mockGlobalFetch({
      "/api/mcp/token": (request) => {
        if (request.method === "POST") throw new TypeError("the network is unreachable");
        return { json: READY };
      },
    });
    const { findByRole, queryByTestId } = render(<McpSettings />);
    fireEvent.click(await findByRole("button", { name: "Create token" }));
    expect((await findByRole("alert")).textContent).toBe("The token could not be created. Try again.");
    expect(queryByTestId("mcp-token-value")).toBeNull();
  });
});

describe("the client configuration", () => {
  test("renders every snippet exactly as client-config.ts builds it for the deployment's URL", async () => {
    serve(READY);
    const { findByText, getByTestId } = render(<McpSettings />);
    expect(await findByText("Client configuration")).toBeTruthy();
    const configs = mcpClientConfigs(URL);
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      expect(getByTestId(`mcp-snippet-${config.id}`).textContent).toBe(config.snippet);
    }
  });
});

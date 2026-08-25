import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import { setupRechartssMock, setupFramerMotionMock } from "../../helpers/mock-monaco";

setupRechartssMock();
setupFramerMotionMock();

// Mock date-fns to avoid complex date computations in tests
mock.module("date-fns", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  format: (date: Date, fmt: string) => "Mon",
  subDays: (date: Date, days: number) => new Date(date.getTime() - days * 86400000),
  startOfDay: (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()),
}));

// Reassignable so a test can render the Queries/Stats tabs against an empty
// history (the idiom OperationsTab.test.tsx uses for mockConnectionsList).
// `beforeEach` restores the two-item default before every test.
const defaultHistory = () => [
  {
    id: "h1",
    query: "SELECT 1",
    executedAt: new Date(),
    executionTime: 10,
    rowCount: 1,
    status: "success",
    connectionId: "c1",
    connectionName: "TestDB",
  },
  {
    id: "h2",
    query: "DROP TABLE x",
    executedAt: new Date(),
    executionTime: 5,
    rowCount: 0,
    status: "error",
    error: "denied",
    connectionId: "c1",
    connectionName: "TestDB",
  },
];

let mockHistory: ReturnType<typeof defaultHistory> = defaultHistory();

mock.module("@/lib/storage", () => ({
  storage: {
    getHistory: mock(() => mockHistory),
  },
}));

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, waitFor, act, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

import { AuditTab } from "@/components/admin/tabs/AuditTab";

// =============================================================================
// AuditTab Tests
// =============================================================================

/** Every `/api/admin/audit` URL requested so far, in call order. */
function auditCalls(fetchMock: ReturnType<typeof mockGlobalFetch>): string[] {
  return fetchMock.mock.calls
    .map((c: unknown[]) => (typeof c[0] === "string" ? c[0] : ""))
    .filter((url: string) => url.includes("/api/admin/audit"));
}

describe("AuditTab", () => {
  afterEach(() => {
    cleanup();
  });

  let fetchMock: ReturnType<typeof mockGlobalFetch>;

  beforeEach(() => {
    mockHistory = defaultHistory();
    fetchMock = mockGlobalFetch({
      "/api/admin/audit": {
        json: {
          events: [
            {
              id: "a1",
              timestamp: new Date().toISOString(),
              type: "maintenance",
              action: "VACUUM",
              target: "users",
              connectionName: "TestDB",
              user: "admin",
              result: "success",
              duration: 120,
            },
            {
              id: "a2",
              timestamp: new Date().toISOString(),
              type: "kill_session",
              action: "KILL",
              target: "PID:5678",
              connectionName: "TestDB",
              user: "admin",
              result: "failure",
              duration: 50,
            },
          ],
        },
      },
    });
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  test("renders 3 tabs (Operations, Queries, Stats)", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("Operations")).not.toBeNull();
    expect(queryByText("Queries")).not.toBeNull();
    expect(queryByText("Stats")).not.toBeNull();
  });

  test("operations tab fetches audit events", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText } = renderResult!;

    // Wait for the fetch to complete and events to render
    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      const auditCall = calls.find((c: unknown[]) => {
        const url = typeof c[0] === "string" ? c[0] : "";
        return url.includes("/api/admin/audit");
      });
      expect(auditCall).not.toBeUndefined();
    });

    // Events should render after fetch
    await waitFor(() => {
      expect(queryByText("VACUUM")).not.toBeNull();
      expect(queryByText("KILL")).not.toBeNull();
    });
  });

  test("queries tab shows query history", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, container } = renderResult!;

    // Click the Queries tab trigger (must use userEvent for Radix tabs in happy-dom)
    const allTriggers = container.querySelectorAll('[role="tab"]');
    const queriesTab = Array.from(allTriggers).find((t) => t.textContent?.includes("Queries")) as HTMLElement;
    await user.click(queriesTab);

    // Query history from mock storage
    await waitFor(() => {
      expect(queryByText("SELECT 1")).not.toBeNull();
      expect(queryByText("DROP TABLE x")).not.toBeNull();
    });
  });

  test("stats tab shows summary cards", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, container } = renderResult!;

    // Click the Stats tab trigger (must use userEvent for Radix tabs in happy-dom)
    const allTriggers = container.querySelectorAll('[role="tab"]');
    const statsTab = Array.from(allTriggers).find((t) => t.textContent?.includes("Stats")) as HTMLElement;
    await user.click(statsTab);

    // Summary cards show total queries, success rate, etc.
    await waitFor(() => {
      expect(queryByText("Total Queries")).not.toBeNull();
      expect(queryByText("Success Rate")).not.toBeNull();
      expect(queryByText("Avg Duration")).not.toBeNull();
      expect(queryByText("Failed")).not.toBeNull();
    });
  });

  /**
   * The query-activity chart's tooltip is inline-styled by recharts, so it cannot
   * read the CSS tokens. Left hardcoded it stayed a black card on a white page —
   * which is exactly how it shipped until it was reported.
   */
  async function statsTooltipUnder(theme: "dark" | "light") {
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(theme);

    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { container } = renderResult!;

    const statsTab = Array.from(container.querySelectorAll('[role="tab"]')).find((t) =>
      t.textContent?.includes("Stats"),
    ) as HTMLElement;
    await user.click(statsTab);

    const tooltip = await waitFor(() => {
      const el = container.querySelector("[data-testid='mock-tooltip']");
      expect(el).not.toBeNull();
      return el!;
    });
    return { bg: tooltip.getAttribute("data-bg"), color: tooltip.getAttribute("data-color") };
  }

  test("the stats chart tooltip keeps its dark card in the dark theme", async () => {
    expect(await statsTooltipUnder("dark")).toEqual({ bg: "#18181b", color: "#a1a1aa" });
  });

  test("and turns into a white card in the light theme", async () => {
    expect(await statsTooltipUnder("light")).toEqual({ bg: "#ffffff", color: "#3f3f46" });
  });

  test("search filter works in operations tab", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, getByPlaceholderText } = renderResult!;

    // Wait for events to load
    await waitFor(() => {
      expect(queryByText("VACUUM")).not.toBeNull();
    });

    // Find the search input and type a search query
    const searchInput = getByPlaceholderText("Search...");
    expect(searchInput).not.toBeNull();

    // Use userEvent for proper input handling in happy-dom
    await user.clear(searchInput);
    await user.type(searchInput, "VACUUM");

    // VACUUM should still be visible, KILL should be filtered out
    await waitFor(() => {
      expect(queryByText("VACUUM")).not.toBeNull();
      expect(queryByText("KILL")).toBeNull();
    });
  });

  test("type filter dropdown present", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText } = renderResult!;

    // The type filter select should show "All Types" by default
    expect(queryByText("All Types")).not.toBeNull();
  });

  test("shows empty state when audit fetch fails", async () => {
    // Override the fetch installed in beforeEach with one that rejects,
    // exercising the catch path (setEvents([])) and the empty-state UI.
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      expect(queryByText("No audit events found.")).not.toBeNull();
      expect(queryByText(/maintenance tasks are run/)).not.toBeNull();
    });
  });

  test("search filter works in queries tab", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, getByPlaceholderText, container } = renderResult!;

    // Switch to the Queries tab
    const allTriggers = container.querySelectorAll('[role="tab"]');
    const queriesTab = Array.from(allTriggers).find((t) => t.textContent?.includes("Queries")) as HTMLElement;
    await user.click(queriesTab);

    await waitFor(() => {
      expect(queryByText("SELECT 1")).not.toBeNull();
    });

    // Type a search query — only matching history items remain
    const searchInput = getByPlaceholderText("Search query...");
    await user.type(searchInput, "select");

    await waitFor(() => {
      expect(queryByText("SELECT 1")).not.toBeNull();
      expect(queryByText("DROP TABLE x")).toBeNull();
    });
  });

  test("status filter works in queries tab", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, container, baseElement } = renderResult!;

    // Switch to the Queries tab
    const allTriggers = container.querySelectorAll('[role="tab"]');
    const queriesTab = Array.from(allTriggers).find((t) => t.textContent?.includes("Queries")) as HTMLElement;
    await user.click(queriesTab);

    await waitFor(() => {
      expect(queryByText("SELECT 1")).not.toBeNull();
      expect(queryByText("DROP TABLE x")).not.toBeNull();
    });

    // Open the status select via keyboard (happy-dom lacks full pointer support)
    const selectTrigger = container.querySelector('[data-slot="select-trigger"]') as HTMLElement;
    expect(selectTrigger).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(selectTrigger, { key: "ArrowDown" });
    });

    // Pick the "Error" option from the portaled listbox
    const options = Array.from(baseElement.querySelectorAll('[role="option"]'));
    const errorOption = options.find((o) => o.textContent?.trim() === "Error") as HTMLElement;
    expect(errorOption).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(errorOption, { key: "Enter" });
    });

    // Only the error-status history item remains
    await waitFor(() => {
      expect(queryByText("DROP TABLE x")).not.toBeNull();
      expect(queryByText("SELECT 1")).toBeNull();
    });
  });
  test("changing the type filter refetches with the type param", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { container, baseElement } = renderResult!;

    await waitFor(() => {
      expect(auditCalls(fetchMock).length).toBe(1);
    });

    // Open the type select via keyboard (happy-dom lacks full pointer support)
    const selectTrigger = container.querySelector('[data-slot="select-trigger"]') as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(selectTrigger, { key: "ArrowDown" });
    });

    const options = Array.from(baseElement.querySelectorAll('[role="option"]'));
    const killOption = options.find((o) => o.textContent?.trim() === "Kill Session") as HTMLElement;
    expect(killOption).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(killOption, { key: "Enter" });
    });

    // A second request goes out, carrying the picked type as a query param.
    await waitFor(() => {
      const calls = auditCalls(fetchMock);
      expect(calls.length).toBe(2);
      expect(calls[1]).toContain("type=kill_session");
    });
  });

  test("the Refresh button refetches the audit events", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { getByText } = renderResult!;

    await waitFor(() => {
      expect(auditCalls(fetchMock).length).toBe(1);
    });

    await user.click(getByText("Refresh"));

    await waitFor(() => {
      expect(auditCalls(fetchMock).length).toBe(2);
    });
  });

  test("queries tab shows the empty state when nothing matches the search", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, getByPlaceholderText, container } = renderResult!;

    const allTriggers = container.querySelectorAll('[role="tab"]');
    const queriesTab = Array.from(allTriggers).find((t) => t.textContent?.includes("Queries")) as HTMLElement;
    await user.click(queriesTab);

    await waitFor(() => {
      expect(queryByText("SELECT 1")).not.toBeNull();
    });

    await user.type(getByPlaceholderText("Search query..."), "zzzz");

    await waitFor(() => {
      expect(queryByText("No query history found.")).not.toBeNull();
    });
  });

  test("stats tab shows the empty states when there is no query history", async () => {
    mockHistory = [];
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, container } = renderResult!;

    const allTriggers = container.querySelectorAll('[role="tab"]');
    const statsTab = Array.from(allTriggers).find((t) => t.textContent?.includes("Stats")) as HTMLElement;
    await user.click(statsTab);

    await waitFor(() => {
      expect(queryByText("No query history yet.")).not.toBeNull();
      expect(queryByText("No data yet.")).not.toBeNull();
    });
  });

  /**
   * A refresh that is still in flight when the Type filter changes must not be
   * allowed to overwrite the newer filter's rows: the settled table has to agree
   * with the Type control, whichever response comes back last.
   */
  test("a refresh overtaken by a type change does not put back the old filter's rows", async () => {
    const allEvents = [
      {
        id: "a1",
        timestamp: new Date().toISOString(),
        type: "maintenance",
        action: "VACUUM",
        target: "users",
        connectionName: "TestDB",
        user: "admin",
        result: "success",
        duration: 120,
      },
      {
        id: "a2",
        timestamp: new Date().toISOString(),
        type: "kill_session",
        action: "KILL",
        target: "PID:5678",
        connectionName: "TestDB",
        user: "admin",
        result: "failure",
        duration: 50,
      },
    ];
    const killEvents = [allEvents[1]];

    // Held open so the "all" refresh can be made to resolve AFTER the newer
    // kill_session request — the overtaking order the race needs.
    let releaseAll: (() => void) | null = null;
    let holdAll: Promise<void> | null = null;

    fetchMock = mockGlobalFetch({
      "/api/admin/audit": async (req: Request) => {
        if (new URL(req.url).searchParams.get("type") === "kill_session") {
          return { json: { events: killEvents } };
        }
        if (holdAll) await holdAll;
        return { json: { events: allEvents } };
      },
    });

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, getByText, container, baseElement } = renderResult!;

    // The Action cell of every rendered row — compared as a list so a failure
    // names the rows on screen instead of dumping a DOM node.
    const rowActions = () =>
      Array.from(container.querySelectorAll("tbody tr td:nth-child(3)")).map((c) => c.textContent);

    await waitFor(() => {
      expect(queryByText("VACUUM")).not.toBeNull();
    });

    holdAll = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    // Refresh under type=all — this request is the one that will lose the race.
    await act(async () => {
      fireEvent.click(getByText("Refresh"));
    });
    await waitFor(() => {
      expect(auditCalls(fetchMock).length).toBe(2);
    });

    // While it hangs, switch the Type filter to Kill Session.
    const selectTrigger = container.querySelector('[data-slot="select-trigger"]') as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(selectTrigger, { key: "ArrowDown" });
    });
    const killOption = Array.from(baseElement.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent?.trim() === "Kill Session",
    ) as HTMLElement;
    expect(killOption).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(killOption, { key: "Enter" });
    });

    // The newer request wins first: only kill-session rows on screen.
    await waitFor(() => {
      expect(rowActions()).toEqual(["KILL"]);
    });

    // Now let the stale refresh land. It must change nothing.
    await act(async () => {
      releaseAll!();
      await holdAll;
    });

    expect(selectTrigger.textContent).toContain("Kill Session");
    expect(rowActions()).toEqual(["KILL"]);
  });
});

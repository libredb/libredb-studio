import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PoolTab } from "@/components/monitoring/tabs/PoolTab";

const mockFetch = mock(() =>
  Promise.resolve(
    new Response(JSON.stringify({ total: 10, idle: 6, active: 3, waiting: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ),
);
globalThis.fetch = mockFetch as never;

const conn = {
  id: "1",
  name: "test",
  type: "postgres" as const,
  host: "localhost",
  port: 5432,
  database: "db",
  user: "u",
  password: "p",
  createdAt: new Date(),
};

describe("PoolTab", () => {
  afterEach(() => {
    cleanup();
    mockFetch.mockClear();
  });

  test("shows empty state when no connection", () => {
    const { queryByText } = render(<PoolTab connection={null} />);
    expect(queryByText("Select a connection to view pool statistics")).not.toBeNull();
  });

  test("renders pool stats after fetch", async () => {
    const { queryByText } = render(<PoolTab connection={conn} />);
    await waitFor(() => {
      expect(queryByText("Connection Pool")).not.toBeNull();
      expect(queryByText("10")).not.toBeNull();
    });
  });

  test("shows error state on fetch failure", async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Pool not available" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const { queryByText } = render(<PoolTab connection={conn} />);
    await waitFor(() => {
      expect(queryByText("Pool not available")).not.toBeNull();
    });
  });

  // Both buttons are the only way a reader asks for the figures again, so each
  // one is pinned: a click must reach the route, not just re-render the tab.
  test("clicking Try Again re-issues the request", async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Pool not available" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const { getByText, queryByText } = render(<PoolTab connection={conn} />);
    await waitFor(() => {
      expect(queryByText("Pool not available")).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(getByText("Try Again"));
    });

    await waitFor(() => {
      expect(queryByText("10")).not.toBeNull();
    });
    expect(mockFetch.mock.calls.length).toBe(2);
  });

  test("the refresh button re-issues the request", async () => {
    const { container, queryByText } = render(<PoolTab connection={conn} />);
    await waitFor(() => {
      expect(queryByText("10")).not.toBeNull();
    });

    // The header refresh control is the only button on the settled tab.
    const refreshButton = container.querySelector("button");
    expect(refreshButton).not.toBeNull();

    await act(async () => {
      fireEvent.click(refreshButton!);
    });

    await waitFor(() => {
      expect(mockFetch.mock.calls.length).toBe(2);
    });
  });

  // Absence and zero are different inputs. `/api/db/pool-stats` answers a literal
  // all-zero body plus `message` for every provider without `getPoolStats` (Cassandra,
  // MySQL, SQLite, ClickHouse, Druid, Trino, Mongo, Redis, Couchbase), so those zeros
  // are the route's, not the engine's, and must not be rendered as measurements.
  test("renders absence as words when the provider reports no pool statistics", async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            total: 0,
            idle: 0,
            active: 0,
            waiting: 0,
            message: "Pool statistics not available for this provider",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const { queryAllByText, queryByText } = render(<PoolTab connection={conn} />);
    await waitFor(() => {
      expect(queryByText("Pool statistics not available for this provider")).not.toBeNull();
    });
    // One "N/A" per card: Total, Active, Idle, Waiting.
    expect(queryAllByText("N/A").length).toBe(4);
    // The sub-labels each assert a fact about a pool nobody inspected.
    expect(queryByText("Max pool size")).toBeNull();
    expect(queryByText("Available")).toBeNull();
    expect(queryByText("0% utilized")).toBeNull();
    expect(queryByText("No queue")).toBeNull();
  });

  // The pin for the other input: postgres with no pool opened yet returns a real
  // all-zero reading and no `message`. That is a measurement, and its rendering must
  // stay byte-for-byte what it is today so the two inputs can never be collapsed.
  test("keeps today's rendering for a measured zero", async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ total: 0, idle: 0, active: 0, waiting: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const { queryAllByText, queryByText } = render(<PoolTab connection={conn} />);
    await waitFor(() => {
      expect(queryByText("Max pool size")).not.toBeNull();
    });
    expect(queryByText("Available")).not.toBeNull();
    expect(queryByText("0% utilized")).not.toBeNull();
    expect(queryByText("No queue")).not.toBeNull();
    // Four card values plus the Waiting badge.
    expect(queryAllByText("0").length).toBe(5);
    expect(queryAllByText("N/A").length).toBe(0);
  });
  // A managed (seed) connection reaches the browser with `password` and
  // `connectionString` stripped, so the object alone no longer identifies a
  // database - a seed defined by connection string has nothing left at all, and
  // `/api/db/pool-stats` answers 400 CONFIG_ERROR for it whenever the provider
  // cache is cold. Every other connection-bearing call sends the seed id and lets
  // the server resolve it (`buildConnectionPayload`).
  test("sends connectionId for a managed seed connection", async () => {
    const seedConn = { ...conn, id: "seed:mongo-local", managed: true, seedId: "mongo-local" };
    render(<PoolTab connection={seedConn} />);

    await waitFor(() => {
      expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
    });

    const [, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.connectionId).toBe("seed:mongo-local");
    expect(body.connection).toBeUndefined();
  });
});

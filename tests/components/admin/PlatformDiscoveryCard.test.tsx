import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../../helpers/mock-fetch";
import type { DiscoveryStatus } from "@/lib/seed/discovery-loader";
import { PlatformDiscoveryCard } from "@/components/admin/PlatformDiscoveryCard";

// Verbatim from the spec: a change to this text is a reviewed change, so the test pins it.
const COOKIE_WARNING =
  "The Studio session cookie can travel over plain HTTP, and it unlocks every discovered database. Enable HTTPS and Force HTTPS for this app in CapRover, then set AUTH_COOKIE_SECURE to true and restart.";
const GENERATED_AT = "2026-10-04T12:00:00.000Z";

function status(overrides: Partial<DiscoveryStatus> = {}): DiscoveryStatus {
  return {
    platform: "caprover",
    state: "ok",
    message: "Discovery is running",
    generatedAt: GENERATED_AT,
    checkedAt: "2026-10-04T12:00:10.000Z",
    error: null,
    connected: [{ name: "pgtest (PostgreSQL)", type: "postgres" }],
    skipped: [{ appName: "legacy", reason: "host does not match the allowed pattern" }],
    ...overrides,
  };
}

function answer(
  discovery: DiscoveryStatus,
  transport = { plainHttp: false, cookieSecureOff: false },
): MockFetchResponse {
  return { json: { discovery, transport } };
}

async function renderCard() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<PlatformDiscoveryCard />);
  });
  return result;
}

/** Lets a resolved fetch's continuation run inside act. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Captures the card's own 60 s refresh so a test can fire it on demand. Every other interval
 * (testing-library's waitFor polls on one) stays real. Pattern: tests/components/admin/OverviewTab.test.tsx.
 */
function captureAutoRefresh() {
  const realSetInterval = globalThis.setInterval;
  const captured: { fire?: () => void } = {};
  globalThis.setInterval = ((handler: () => void, timeout?: number) => {
    if (timeout === 60000) {
      captured.fire = handler;
      return realSetInterval(() => {}, 100000);
    }
    return realSetInterval(handler, timeout);
  }) as unknown as typeof setInterval;
  return {
    captured,
    restore: () => {
      globalThis.setInterval = realSetInterval;
    },
  };
}

describe("PlatformDiscoveryCard", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("fetches /api/admin/discovery and renders nothing on a 404", async () => {
    const fetchMock = mockGlobalFetch({});
    const { container } = await renderCard();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await flush();

    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/admin/discovery");
    expect(container.innerHTML).toBe("");
  });

  test("renders nothing when discovery is off", async () => {
    const fetchMock = mockGlobalFetch({ "/api/admin/discovery": { json: { discovery: null } } });
    const { container } = await renderCard();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await flush();

    expect(container.innerHTML).toBe("");
  });

  test("renders nothing when the request fails", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/admin/discovery": () => {
        throw new Error("network down");
      },
    });
    const { container } = await renderCard();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await flush();

    expect(container.innerHTML).toBe("");
  });

  test("shows the ok state, the last scan, and the connected and skipped lists", async () => {
    mockGlobalFetch({ "/api/admin/discovery": answer(status()) });
    const { findByTestId, getByText, queryByTestId, queryByRole } = await renderCard();

    await findByTestId("platform-discovery-card");

    expect(getByText("Platform Discovery (CapRover)")).not.toBeNull();
    expect(getByText("Running")).not.toBeNull();
    expect(getByText("Discovery is running")).not.toBeNull();
    expect(getByText(new Date(GENERATED_AT).toLocaleString())).not.toBeNull();
    expect(getByText("Connected (1)")).not.toBeNull();
    expect(getByText("pgtest (PostgreSQL)")).not.toBeNull();
    expect(getByText("postgres")).not.toBeNull();
    expect(getByText("Skipped (1)")).not.toBeNull();
    expect(getByText("legacy")).not.toBeNull();
    expect(getByText("host does not match the allowed pattern")).not.toBeNull();
    expect(queryByTestId("platform-discovery-error")).toBeNull();
    expect(queryByRole("alert")).toBeNull();
  });

  // The exporter strips srv-captain-- from a service name and does not dedupe on the result, so a
  // legacy srv-captain--foo and a bare foo both arrive as "foo" and can be skipped for the same
  // reason. Two rows then have the same app name and reason, and must not share a React key.
  test("renders two identical skipped entries as two rows without a duplicate-key warning", async () => {
    const twin = { appName: "foo", reason: "id taken by the seed file" };
    mockGlobalFetch({ "/api/admin/discovery": answer(status({ skipped: [twin, { ...twin }] })) });
    const errors = spyOn(console, "error").mockImplementation(() => {});

    try {
      const { findByTestId, getByText, getAllByText } = await renderCard();
      await findByTestId("platform-discovery-card");

      expect(getByText("Skipped (2)")).not.toBeNull();
      expect(getAllByText("foo")).toHaveLength(2);
      expect(getAllByText("id taken by the seed file")).toHaveLength(2);
      // React reports a duplicate key through console.error; any other error fails this as well.
      expect(errors.mock.calls.map((call) => call.map(String).join(" "))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  test("shows the waiting state with Never and empty lists", async () => {
    mockGlobalFetch({
      "/api/admin/discovery": answer(
        status({
          state: "waiting",
          message: "Waiting for the export file",
          generatedAt: null,
          connected: [],
          skipped: [],
        }),
      ),
    });
    const { findByTestId, getByText, getAllByText } = await renderCard();

    await findByTestId("platform-discovery-card");

    expect(getByText("Waiting")).not.toBeNull();
    expect(getByText("Waiting for the export file")).not.toBeNull();
    expect(getByText("Never")).not.toBeNull();
    expect(getByText("Connected (0)")).not.toBeNull();
    expect(getByText("Skipped (0)")).not.toBeNull();
    expect(getAllByText("None")).toHaveLength(2);
  });

  test("shows the stale state with the exporter's error", async () => {
    mockGlobalFetch({
      "/api/admin/discovery": answer(
        status({
          state: "stale",
          message: "The export is stale",
          connected: [],
          error: { code: "socket_unavailable", message: "connect ENOENT /var/run/docker.sock" },
        }),
      ),
    });
    const { findByTestId, getByText } = await renderCard();

    await findByTestId("platform-discovery-card");

    expect(getByText("Stale")).not.toBeNull();
    expect(getByText("Last error")).not.toBeNull();
    expect((await findByTestId("platform-discovery-error")).textContent).toBe(
      "socket_unavailable: connect ENOENT /var/run/docker.sock",
    );
  });

  test("shows the error state", async () => {
    mockGlobalFetch({
      "/api/admin/discovery": answer(
        status({
          state: "error",
          message: "The export file is invalid",
          error: { code: "invalid_export", message: "bad" },
        }),
      ),
    });
    const { findByTestId, getByText } = await renderCard();

    await findByTestId("platform-discovery-card");

    expect(getByText("Failed")).not.toBeNull();
    expect((await findByTestId("platform-discovery-error")).textContent).toBe("invalid_export: bad");
  });

  test("warns about the cookie when the request is plain HTTP and a database is connected", async () => {
    mockGlobalFetch({ "/api/admin/discovery": answer(status(), { plainHttp: true, cookieSecureOff: false }) });
    const { findByRole } = await renderCard();

    expect((await findByRole("alert")).textContent).toBe(COOKIE_WARNING);
  });

  test("warns about the cookie when AUTH_COOKIE_SECURE is off and a database is connected", async () => {
    mockGlobalFetch({ "/api/admin/discovery": answer(status(), { plainHttp: false, cookieSecureOff: true }) });
    const { findByRole } = await renderCard();

    expect((await findByRole("alert")).textContent).toBe(COOKIE_WARNING);
  });

  test("does not warn while no database is connected", async () => {
    mockGlobalFetch({
      "/api/admin/discovery": answer(status({ connected: [] }), { plainHttp: true, cookieSecureOff: true }),
    });
    const { findByTestId, queryByRole } = await renderCard();

    await findByTestId("platform-discovery-card");

    expect(queryByRole("alert")).toBeNull();
  });

  test("refreshes every 60 seconds and hides itself when the route stops answering", async () => {
    const answers: MockFetchResponse[] = [
      answer(status()),
      answer(status({ connected: [{ name: "mysqltest (MySQL)", type: "mysql" }] })),
      { status: 404, json: { error: "Not found" } },
    ];
    let calls = 0;
    const fetchMock = mockGlobalFetch({
      "/api/admin/discovery": () => answers[Math.min(calls++, answers.length - 1)],
    });
    const { captured, restore } = captureAutoRefresh();

    try {
      const { findByText, queryByTestId } = await renderCard();
      await findByText("pgtest (PostgreSQL)");

      await act(async () => {
        captured.fire!();
      });
      await findByText("mysqltest (MySQL)");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        captured.fire!();
      });
      await waitFor(() => {
        expect(queryByTestId("platform-discovery-card")).toBeNull();
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      restore();
    }
  });
});

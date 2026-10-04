import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
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
 * fire() runs the handler whatever happened to the interval; elapse() is one 60 s period passing, so it
 * runs the handler only while the card has not cleared the interval, as a real timer would.
 */
function captureAutoRefresh() {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let timer: unknown;
  let cleared = false;
  const captured: { fire?: () => void; elapse: () => void } = {
    elapse: () => {
      if (!cleared) captured.fire?.();
    },
  };
  globalThis.setInterval = ((handler: () => void, timeout?: number) => {
    if (timeout === 60000) {
      captured.fire = handler;
      timer = realSetInterval(() => {}, 100000);
      return timer;
    }
    return realSetInterval(handler, timeout);
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id?: unknown) => {
    if (id !== undefined && id === timer) cleared = true;
    realClearInterval(id as Parameters<typeof clearInterval>[0]);
  }) as typeof clearInterval;
  return {
    captured,
    restore: () => {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
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
    const { findByTestId, getByRole, getByText, queryByTestId, queryByRole } = await renderCard();

    const card = await findByTestId("platform-discovery-card");

    // The section is a landmark named by its heading, as the other admin sections are.
    expect(getByRole("region", { name: "Platform Discovery (CapRover)" })).toBe(card);
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

  // The route sends names and types only. The card must hold that line itself: given a payload that
  // also carries a host name and an environment value per entry, it still shows neither.
  test("never renders a host name or an environment value, even when the payload carries them", async () => {
    const extra = { host: "srv-captain--secret-host", env: { POSTGRES_PASSWORD: "SECRET_VALUE" } };
    mockGlobalFetch({
      "/api/admin/discovery": answer(
        status({
          connected: [{ name: "pgtest (PostgreSQL)", type: "postgres", ...extra }],
          skipped: [{ appName: "legacy", reason: "did not answer on port 5432", ...extra }],
        }),
      ),
    });
    const { findByTestId, getByText } = await renderCard();

    const card = await findByTestId("platform-discovery-card");

    // Both entries are on screen, so the absences below are not an empty card.
    expect(getByText("pgtest (PostgreSQL)")).not.toBeNull();
    expect(getByText("legacy")).not.toBeNull();
    expect(card.innerHTML).not.toContain("srv-captain--secret-host");
    expect(card.innerHTML).not.toContain("SECRET_VALUE");
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
    const { findByTestId, getByText, queryByText } = await renderCard();

    await findByTestId("platform-discovery-card");

    expect(getByText("Failed")).not.toBeNull();
    expect((await findByTestId("platform-discovery-error")).textContent).toBe("invalid_export: bad");
    // The payload carries the last good scan, so the row shows when it was and not Never.
    expect(getByText("Last successful scan")).not.toBeNull();
    expect(getByText(new Date(GENERATED_AT).toLocaleString())).not.toBeNull();
    expect(queryByText("Never")).toBeNull();
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

  // The request is held open by hand, so it is still in flight when the card unmounts. A stub of
  // its own rather than mockGlobalFetch, because the test has to see the moment the card reads the
  // late answer: only after that does "nothing happened" say anything. React 19 neither warns about
  // nor shows an update to an unmounted component, so the late answer can only be checked against an
  // empty container and a silent console. The timer assertion is the one a missing cleanup fails.
  test("unmounting mid-request leaves nothing behind: no render, no warning, no further refresh", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let read = false;
    const fetchMock = mock(async () => {
      await gate;
      return {
        ok: true,
        json: async () => {
          read = true;
          return { discovery: status(), transport: { plainHttp: false, cookieSecureOff: false } };
        },
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { captured, restore } = captureAutoRefresh();
    const errors = spyOn(console, "error").mockImplementation(() => {});

    try {
      const { container, unmount } = await renderCard();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(captured.fire).toBeDefined();

      unmount();
      release();
      await waitFor(() => {
        expect(read).toBe(true);
      });
      await flush();

      expect(container.innerHTML).toBe("");
      expect(errors.mock.calls.map((call) => call.map(String).join(" "))).toEqual([]);

      // A 60 s period passes with the card gone: a cleared interval does not run, so no second request.
      await act(async () => {
        captured.elapse();
      });
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
      restore();
    }
  });
});

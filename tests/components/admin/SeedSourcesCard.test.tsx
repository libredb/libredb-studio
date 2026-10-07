import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import React from "react";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../../helpers/mock-fetch";
import type { SeedSourcesResponse } from "@/app/api/admin/seed-sources/route";
import type { OperatorSkip, OperatorSourceReport, SourceNote } from "@/lib/seed/sources/types";
import { SeedSourcesCard } from "@/components/admin/SeedSourcesCard";

const SEED_PATH = "/app/config/seed-connections.yaml";

const SKIP: OperatorSkip = {
  id: "billing",
  origin: SEED_PATH,
  reason: "Environment variable BILLING_PASSWORD is not defined",
  variable: "BILLING_PASSWORD",
  field: "password",
};

function report(overrides: Partial<OperatorSourceReport> = {}): OperatorSourceReport {
  return {
    source: "SEED_CONFIG_PATH",
    location: SEED_PATH,
    state: "ok",
    checkedAt: "2026-10-05T09:00:00.000Z",
    error: null,
    connected: [{ id: "reporting", name: "Reporting", type: "postgres" }],
    skipped: [],
    notes: [],
    ...overrides,
  };
}

function answer(...sources: OperatorSourceReport[]): MockFetchResponse {
  const body: SeedSourcesResponse = { sources };
  return { json: body };
}

async function renderCard() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<SeedSourcesCard />);
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
 * Captures the card's own 60 s refresh so a test can fire it on demand; every other interval (waitFor polls on
 * one) stays real. fire() runs the handler whatever happened to the interval; elapse() is one period passing,
 * so it runs the handler only while the card has not cleared the interval.
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

describe("SeedSourcesCard", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("fetches /api/admin/seed-sources and renders nothing on a 404", async () => {
    const fetchMock = mockGlobalFetch({});
    const { container } = await renderCard();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await flush();

    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/admin/seed-sources");
    expect(container.innerHTML).toBe("");
  });

  test("renders nothing when the request fails", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/admin/seed-sources": () => {
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

  // A zero-config install: the default path holds no file, so the one source is empty with nothing to say.
  test.each([
    ["an empty source list", [] as OperatorSourceReport[]],
    ["one empty source with nothing skipped or ignored", [report({ state: "empty", connected: [] })]],
  ])("renders nothing for %s", async (_label, sources) => {
    const fetchMock = mockGlobalFetch({ "/api/admin/seed-sources": answer(...sources) });
    const { container } = await renderCard();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await flush();

    expect(container.innerHTML).toBe("");
  });

  test("shows an empty source that ignored a name, because the operator set something", async () => {
    const note: SourceNote = { kind: "ignored-variable", name: "SEED_CONNECTION_REPORTING_PORT" };
    mockGlobalFetch({ "/api/admin/seed-sources": answer(report({ state: "empty", connected: [], notes: [note] })) });
    const { findByTestId } = await renderCard();

    expect((await findByTestId("seed-source-note")).textContent).toBe(
      "Ignored variable SEED_CONNECTION_REPORTING_PORT",
    );
  });

  test("shows a loaded seed file with its path and its connections", async () => {
    mockGlobalFetch({ "/api/admin/seed-sources": answer(report()) });
    const { findByTestId, getByRole, getByText, queryByTestId } = await renderCard();

    const card = await findByTestId("seed-sources-card");

    // The section is a landmark named by its heading, as the other admin sections are.
    expect(getByRole("region", { name: "Seed sources" })).toBe(card);
    const row = await findByTestId("seed-source-SEED_CONFIG_PATH");
    expect(within(row).getByText("Seed file")).not.toBeNull();
    expect(within(row).getByText("Loaded")).not.toBeNull();
    expect(within(row).getByText(SEED_PATH)).not.toBeNull();
    expect(getByText("Connected (1)")).not.toBeNull();
    expect(getByText("Reporting")).not.toBeNull();
    expect(getByText("postgres")).not.toBeNull();
    expect(queryByTestId("seed-source-error")).toBeNull();
    expect(queryByTestId("seed-source-skip")).toBeNull();
    expect(queryByTestId("seed-source-note")).toBeNull();
  });

  test.each([
    ["ok", "Loaded"],
    ["empty", "Empty"],
    ["missing", "Not found"],
    ["error", "Failed"],
  ] as const)("labels the %s state %s", async (state, label) => {
    // A skip keeps an empty source visible, so every state renders.
    mockGlobalFetch({ "/api/admin/seed-sources": answer(report({ state, connected: [], skipped: [SKIP] })) });
    const { findByTestId } = await renderCard();

    const row = await findByTestId("seed-source-SEED_CONFIG_PATH");
    expect(within(row).getByText(label)).not.toBeNull();
  });

  test.each([
    ["SEED_CONFIG_PATH", "Seed file"],
    ["SEED_CONFIG_DIR", "Seed directory"],
    ["SEED_CONFIG_INLINE", "Inline config"],
    ["SEED_CONFIG_BASE64", "Inline config (base64)"],
    ["SEED_CONNECTION", "Environment URLs"],
  ] as const)("labels the source %s as %s", async (source, label) => {
    mockGlobalFetch({ "/api/admin/seed-sources": answer(report({ source, location: null })) });
    const { findByTestId } = await renderCard();

    const row = await findByTestId(`seed-source-${source}`);
    expect(within(row).getByText(label)).not.toBeNull();
  });

  test("shows a failed source with its code and message", async () => {
    const message = `Invalid seed config at ${SEED_PATH}: connections.1.color: Invalid string: must match pattern /^#[0-9A-Fa-f]{6}$/`;
    mockGlobalFetch({
      "/api/admin/seed-sources": answer(report({ state: "error", connected: [], error: { code: "invalid", message } })),
    });
    const { findByTestId, getByText } = await renderCard();

    expect((await findByTestId("seed-source-error")).textContent).toBe(`invalid: ${message}`);
    expect(getByText("Failed")).not.toBeNull();
  });

  test("shows a missing explicit path as File not found with the path", async () => {
    mockGlobalFetch({ "/api/admin/seed-sources": answer(report({ state: "missing", connected: [] })) });
    const { findByText, getByText, queryByText } = await renderCard();

    expect(await findByText(`File not found: ${SEED_PATH}`)).not.toBeNull();
    expect(getByText("Not found")).not.toBeNull();
    // The path is shown once, inside the not-found line, not again as a bare location.
    expect(queryByText(SEED_PATH)).toBeNull();
  });

  test("shows a skipped connection as id, origin and reason", async () => {
    mockGlobalFetch({ "/api/admin/seed-sources": answer(report({ skipped: [SKIP] })) });
    const { findByTestId, getByText } = await renderCard();

    expect((await findByTestId("seed-source-skip")).textContent).toBe(
      `billing (${SEED_PATH}): Environment variable BILLING_PASSWORD is not defined`,
    );
    expect(getByText("Skipped (1)")).not.toBeNull();
  });

  test("shows an ignored variable and an ignored URL parameter", async () => {
    const notes: SourceNote[] = [
      { kind: "ignored-variable", name: "SEED_CONNECTION_REPORTING_PORT" },
      { kind: "ignored-parameter", origin: "SEED_CONNECTION_REPORTING_URL", name: "application_name" },
    ];
    mockGlobalFetch({
      "/api/admin/seed-sources": answer(report({ source: "SEED_CONNECTION", location: null, notes })),
    });
    const { findAllByTestId, getByText } = await renderCard();

    expect((await findAllByTestId("seed-source-note")).map((element) => element.textContent)).toEqual([
      "Ignored variable SEED_CONNECTION_REPORTING_PORT",
      "Ignored URL parameter application_name in SEED_CONNECTION_REPORTING_URL",
    ]);
    expect(getByText("Ignored (2)")).not.toBeNull();
  });

  test("lists the sources in the order the route answers", async () => {
    mockGlobalFetch({
      "/api/admin/seed-sources": answer(
        report(),
        report({ source: "SEED_CONNECTION", location: null, connected: [], skipped: [SKIP] }),
      ),
    });
    const { findByTestId, container } = await renderCard();

    await findByTestId("seed-sources-card");
    const order = Array.from(container.querySelectorAll('[data-testid^="seed-source-SEED_"]')).map((element) =>
      element.getAttribute("data-testid"),
    );
    expect(order).toEqual(["seed-source-SEED_CONFIG_PATH", "seed-source-SEED_CONNECTION"]);
  });

  test("refreshes every 60 seconds and hides itself when the route stops answering", async () => {
    const answers: MockFetchResponse[] = [
      answer(report()),
      answer(
        report({
          state: "error",
          connected: [],
          error: { code: "unreadable", message: `Cannot read seed config at ${SEED_PATH}: EISDIR` },
        }),
      ),
      { status: 404, json: { error: "Not found" } },
    ];
    let calls = 0;
    const fetchMock = mockGlobalFetch({
      "/api/admin/seed-sources": () => answers[Math.min(calls++, answers.length - 1)],
    });
    const { captured, restore } = captureAutoRefresh();

    try {
      const { findByText, findByTestId, queryByTestId } = await renderCard();
      await findByText("Reporting");

      await act(async () => {
        captured.fire!();
      });
      expect((await findByTestId("seed-source-error")).textContent).toBe(
        `unreadable: Cannot read seed config at ${SEED_PATH}: EISDIR`,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        captured.fire!();
      });
      await waitFor(() => {
        expect(queryByTestId("seed-sources-card")).toBeNull();
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      restore();
    }
  });

  // The request is held open by hand, so it is still in flight when the card unmounts (pattern:
  // tests/components/admin/PlatformDiscoveryCard.test.tsx:335-379).
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
          return { sources: [report()] };
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

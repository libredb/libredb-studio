import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../../helpers/mock-fetch";
import type { GovernanceStatusResponse } from "@/app/api/admin/governance/route";
import type { GovernanceStatus } from "@/lib/governance/status";
import { GovernanceStatusCard } from "@/components/admin/GovernanceStatusCard";

const KID = "kid-0123456789abcdef";

function status(overrides: Partial<GovernanceStatus> = {}): GovernanceStatus {
  return {
    source: "postgres",
    schema: "bridge",
    contract: { supported: [1], published: [1], active: 1 },
    freshness: "ok",
    snapshot: { loadedAt: "2026-10-15T08:00:00.000Z", ageMs: 4200 },
    lastError: null,
    admittedConnections: 3,
    skipped: [],
    keyringKids: [KID],
    canary: { [KID]: "ok" },
    listener: {
      state: "listening",
      since: "2026-10-15T07:30:00.000Z",
      heldMs: 1_804_900,
      lastNotificationAt: "2026-10-15T07:59:12.000Z",
    },
    ...overrides,
  };
}

function answer(governance: GovernanceStatus | null): MockFetchResponse {
  const body: GovernanceStatusResponse = { governance };
  return { json: body };
}

async function renderCard() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<GovernanceStatusCard />);
  });
  return result;
}

/** Lets a resolved fetch's continuation run inside act. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Captures the card's own 30 s refresh so a test can fire it on demand; every other interval stays real. */
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
    if (timeout === 30000) {
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

describe("GovernanceStatusCard", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test.each([
    ["a 404", {}],
    ["governance off", { "/api/admin/governance": answer(null) }],
    [
      "a failed request",
      {
        "/api/admin/governance": () => {
          throw new Error("network down");
        },
      },
    ],
  ] as const)("renders nothing on %s", async (_label, routes) => {
    const fetchMock = mockGlobalFetch(routes);
    const { container } = await renderCard();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await flush();

    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/admin/governance");
    expect(container.innerHTML).toBe("");
  });

  test("an unavailable state renders the snapshot age and the last error code", async () => {
    mockGlobalFetch({
      "/api/admin/governance": answer(
        status({
          freshness: "unavailable",
          snapshot: { loadedAt: "2026-10-15T08:00:00.000Z", ageMs: 150_400 },
          lastError: {
            at: "2026-10-15T08:02:30.000Z",
            kind: "transient",
            code: "ECONNREFUSED",
            message: "connect ECONNREFUSED 10.0.0.5:5432",
          },
        }),
      ),
    });
    const { findByTestId, getByTestId } = await renderCard();

    expect((await findByTestId("governance-freshness")).textContent).toBe("Unavailable");
    expect(getByTestId("governance-snapshot-age").textContent).toBe("150 s (loaded 2026-10-15T08:00:00.000Z)");
    expect(getByTestId("governance-last-error").textContent).toBe(
      "transient ECONNREFUSED at 2026-10-15T08:02:30.000Z: connect ECONNREFUSED 10.0.0.5:5432",
    );
  });

  test("a fresh state shows the source, the contract, the admitted count, the key ids and canaries, and no last error", async () => {
    mockGlobalFetch({ "/api/admin/governance": answer(status()) });
    const { findByTestId, getByTestId, queryByTestId } = await renderCard();

    expect((await findByTestId("governance-freshness")).textContent).toBe("Fresh");
    expect(getByTestId("governance-source").textContent).toBe("postgres, schema bridge");
    expect(getByTestId("governance-contract").textContent).toBe("active 1; supported 1; published 1");
    expect(getByTestId("governance-admitted").textContent).toBe("3");
    expect(getByTestId("governance-kids").textContent).toBe(KID);
    expect(getByTestId("governance-canary").textContent).toBe(`${KID}: ok`);
    expect(getByTestId("governance-listener").textContent).toBe(
      "listening for 1804 s (since 2026-10-15T07:30:00.000Z)",
    );
    expect(getByTestId("governance-last-notification").textContent).toBe("2026-10-15T07:59:12.000Z");
    expect(queryByTestId("governance-last-error")).toBeNull();
    expect(queryByTestId("governance-skip")).toBeNull();
  });

  test("a listener that has heard no change shows none yet, and a process without a listener says so", async () => {
    const answers = [
      answer(
        status({
          listener: { state: "polling", since: "2026-10-15T08:00:00.000Z", heldMs: 61_000, lastNotificationAt: null },
        }),
      ),
      answer(status({ listener: null })),
    ];
    let calls = 0;
    mockGlobalFetch({ "/api/admin/governance": () => answers[Math.min(calls++, answers.length - 1)] });
    const { captured, restore } = captureAutoRefresh();

    try {
      const { findByText, getByTestId } = await renderCard();
      await findByText("polling for 61 s (since 2026-10-15T08:00:00.000Z)");
      expect(getByTestId("governance-last-notification").textContent).toBe("none yet");

      await act(async () => {
        captured.fire!();
      });
      await findByText("not started");
      expect(getByTestId("governance-last-notification").textContent).toBe("none yet");
    } finally {
      restore();
    }
  });

  test("before the first load it shows loading with no snapshot, and a failure without a code by its kind", async () => {
    mockGlobalFetch({
      "/api/admin/governance": answer(
        status({
          freshness: "misconfigured",
          contract: { supported: [1], published: null, active: null },
          snapshot: null,
          admittedConnections: null,
          canary: null,
          lastError: {
            at: "2026-10-15T08:00:01.000Z",
            kind: "misconfigured",
            code: null,
            message: "GOVERNANCE_PRIVATE_KEYS_FILE is not set",
          },
        }),
      ),
    });
    const { findByTestId, getByTestId } = await renderCard();

    expect((await findByTestId("governance-freshness")).textContent).toBe("Misconfigured");
    expect(getByTestId("governance-contract").textContent).toBe("active none yet; supported 1; published none yet");
    expect(getByTestId("governance-snapshot-age").textContent).toBe("none yet");
    expect(getByTestId("governance-admitted").textContent).toBe("none yet");
    expect(getByTestId("governance-canary").textContent).toBe("none yet");
    expect(getByTestId("governance-last-error").textContent).toBe(
      "misconfigured at 2026-10-15T08:00:01.000Z: GOVERNANCE_PRIVATE_KEYS_FILE is not set",
    );
  });

  test("shows each key id's canary result, and says so when the governance source publishes none", async () => {
    const answers = [
      answer(status({ canary: { [KID]: "ok", fedcba9876543210: "UNKNOWN_KID" } })),
      answer(status({ canary: {} })),
    ];
    let calls = 0;
    mockGlobalFetch({ "/api/admin/governance": () => answers[Math.min(calls++, answers.length - 1)] });
    const { captured, restore } = captureAutoRefresh();

    try {
      const { findByText } = await renderCard();
      await findByText(`${KID}: ok, fedcba9876543210: UNKNOWN_KID`);

      await act(async () => {
        captured.fire!();
      });
      await findByText("none published");
    } finally {
      restore();
    }
  });

  test("lists each skipped row with its level, path, code and envelope code", async () => {
    mockGlobalFetch({
      "/api/admin/governance": answer(
        status({
          skipped: [
            {
              kind: "connection",
              id: "billing",
              level: "write",
              code: "WRITE_SECRET_UNOPENABLE",
              envelopeCode: "AUTH_FAILED",
            },
            { kind: "connection", id: "crm", path: "password", code: "DEFINITION_HAS_SECRET" },
            { kind: "connection", id: "files", code: "ENGINE_UNSUPPORTED" },
          ],
        }),
      ),
    });
    const { findAllByTestId } = await renderCard();

    expect((await findAllByTestId("governance-skip")).map((item) => item.textContent)).toEqual([
      "billing [write]: WRITE_SECRET_UNOPENABLE (AUTH_FAILED)",
      "crm [password]: DEFINITION_HAS_SECRET",
      "files: ENGINE_UNSUPPORTED",
    ]);
  });

  test("refreshes every 30 seconds and hides itself when governance turns off", async () => {
    const answers = [answer(status()), answer(status({ freshness: "degraded" })), answer(null)];
    let calls = 0;
    const fetchMock = mockGlobalFetch({
      "/api/admin/governance": () => answers[Math.min(calls++, answers.length - 1)],
    });
    const { captured, restore } = captureAutoRefresh();

    try {
      const { findByText, queryByTestId } = await renderCard();
      await findByText("Fresh");

      await act(async () => {
        captured.fire!();
      });
      await findByText("Degraded");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        captured.fire!();
      });
      await waitFor(() => {
        expect(queryByTestId("governance-status-card")).toBeNull();
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      restore();
    }
  });

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
          return { governance: status() };
        },
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { captured, restore } = captureAutoRefresh();
    const errors = spyOn(console, "error").mockImplementation(() => {});

    try {
      const { container, unmount } = await renderCard();
      expect(fetchMock).toHaveBeenCalledTimes(1);

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

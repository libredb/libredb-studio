import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import { setupRechartssMock, setupFramerMotionMock } from "../../helpers/mock-monaco";

setupRechartssMock();
setupFramerMotionMock();

/*
 * FND-1: the admin overview posts the user's connections to the fleet health check and draws each answered item with
 * its engine's icon and colour. An item whose type names no provider threw in render and took the overview to the
 * admin error page. This file is the harness of OverviewTab.test.tsx without its `@/lib/db-ui-config` mock, so the
 * lookups meet that type for real.
 */

const unknown = {
  id: "u-1",
  name: "Acme Store",
  type: "acmefoo",
  host: "acme.example",
  port: 7000,
  createdAt: new Date(),
};

mock.module("@/lib/storage", () => ({
  storage: {
    getConnections: mock(() => [unknown]),
    getHistory: mock(() => []),
    getDismissedSeeds: mock(() => []),
  },
}));

mock.module("next/link", () => ({
  default: ({ children, href, ...props }: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement("a", { href, ...props }, children);
  },
}));

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { OverviewTab } from "@/components/admin/tabs/OverviewTab";
import { unknownTypeSentence } from "@/lib/db/type-id";

afterEach(() => {
  cleanup();
  restoreGlobalFetch();
});

describe("the admin overview fleet card", () => {
  test("draws a fleet item whose type names no provider with the unavailable icon and its refusal", async () => {
    const sentence = unknownTypeSentence("acmefoo");
    mockGlobalFetch({
      "/api/admin/audit": { json: { events: [] } },
      "/api/admin/fleet-health": {
        json: {
          results: [
            {
              connectionId: "u-1",
              connectionName: "Acme Store",
              type: "acmefoo",
              status: "error",
              latencyMs: 0,
              error: sentence,
            },
          ],
        },
      },
    });

    const { container } = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);

    await waitFor(() => {
      const card = Array.from(container.querySelectorAll("[href]")).find((element) =>
        element.textContent?.includes("Acme Store"),
      );
      expect(card?.textContent).toContain(sentence);
      expect(card?.querySelector("svg.lucide-unplug")).not.toBeNull();
      // Nothing was dialled, so nothing timed out: the latency slot is the Unavailable marker, whose tooltip is the
      // refusal, and the error line keeps the whole sentence in its own tooltip when it is cut short.
      expect(card?.textContent).not.toContain("timeout");
      const marker = Array.from(card?.querySelectorAll("span") ?? []).find(
        (span) => span.textContent === "Unavailable",
      );
      expect(marker?.getAttribute("title")).toBe(sentence);
      const errorLine = Array.from(card?.querySelectorAll("div") ?? []).find((div) => div.textContent === sentence);
      expect(errorLine?.getAttribute("title")).toBe(sentence);
    });
  });
});

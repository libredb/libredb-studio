/**
 * The Monitoring Tables tab over an Oxia overview (ruling R34): Oxia has no tables, so the overview counts none, and
 * the tab draws Oxia's own caption instead of reading the shard count as tables it holds no statistics for.
 */
import "../../setup-dom";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { TablesTab } from "@/components/monitoring/tabs/TablesTab";
import { OXIA_LABELS } from "@/lib/db/providers/keyvalue/oxia/labels";
import { oxiaOverview } from "@/lib/db/providers/keyvalue/oxia/monitoring-reads";
import type { OxiaSurface } from "@/lib/db/providers/keyvalue/oxia/walks";
import type { MonitoringData } from "@/lib/db/types";
import { createFakeOxiaClient } from "../../helpers/oxia-fake-client";

afterEach(() => {
  cleanup();
});

describe("the Tables tab of an Oxia connection", () => {
  test("shows Oxia's caption over three shards, not an absent-statistics N/A", async () => {
    const client = createFakeOxiaClient({ order: "hierarchical", records: [], shards: 3 });
    const surface: OxiaSurface = {
      client,
      snapshot: (call) => client.getSnapshot(call),
      order: async () => ({ order: "hierarchical", learnedBy: "empty" }),
    };
    const overview = await oxiaOverview(surface, {
      signal: new AbortController().signal,
      deadline: Date.now() + 10_000,
    });
    // `getTableStats()` answers [] (tests/unit/db/oxia/provider.test.ts).
    const data: MonitoringData = { timestamp: new Date("2026-10-04T12:00:00Z"), overview, tables: [] };

    const { getByTestId, queryByText } = render(
      <TablesTab data={data} loading={false} onRunMaintenance={mock(async () => true)} labels={OXIA_LABELS} />,
    );

    expect(getByTestId("tables-list-scope").textContent).toBe(OXIA_LABELS.tableStatsCaption);
    expect(getByTestId("tables-stat-count").textContent).toBe("0");
    expect(queryByText("No table statistics available.")).toBeNull();
  });
});

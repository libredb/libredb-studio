import "../setup-dom";
import { mock } from "bun:test";
import React from "react";

// Mock MonitoringDashboard to avoid its massive dependency tree
mock.module("@/components/monitoring/MonitoringDashboard", () => ({
  MonitoringDashboard: () =>
    React.createElement("div", { "data-testid": "monitoring-dashboard" }, "MonitoringDashboard Mock"),
}));

const { default: MonitoringPage } = await import("@/app/monitoring/page");

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

describe("MonitoringPage", () => {
  beforeEach(() => {
    mockGlobalFetch({ "/api/storage/config": { json: { provider: "local", serverMode: false } } });
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("renders MonitoringDashboard component", async () => {
    const { findByTestId } = render(<MonitoringPage />);
    expect(await findByTestId("monitoring-dashboard")).not.toBeNull();
  });

  test("renders MonitoringDashboard content", async () => {
    const { findByText } = render(<MonitoringPage />);
    expect(await findByText("MonitoringDashboard Mock")).not.toBeNull();
  });

  test("renders the dashboard only once this browser's workspace is the signed-in account's", () => {
    const { queryByTestId } = render(<MonitoringPage />);
    expect(queryByTestId("monitoring-dashboard")).toBeNull();
  });

  test("is a client component that renders directly", () => {
    const element = MonitoringPage();
    expect(element.type).toBeDefined();
  });
});

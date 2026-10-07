import "../setup-dom";
import { mock } from "bun:test";
import React from "react";

// Mock Studio to avoid its massive dependency tree
mock.module("@/components/Studio", () => ({
  default: () => React.createElement("div", { "data-testid": "studio" }, "Studio Mock"),
}));

const { default: Page } = await import("@/app/page");

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

describe("Page", () => {
  beforeEach(() => {
    mockGlobalFetch({ "/api/storage/config": { json: { provider: "local", serverMode: false } } });
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("renders Studio component", async () => {
    const { findByTestId } = render(<Page />);
    expect(await findByTestId("studio")).not.toBeNull();
  });

  test("renders Studio content", async () => {
    const { findByText } = render(<Page />);
    expect(await findByText("Studio Mock")).not.toBeNull();
  });

  test("renders Studio only once this browser's workspace is the signed-in account's", () => {
    const { queryByTestId } = render(<Page />);
    expect(queryByTestId("studio")).toBeNull();
  });

  test("is a valid React component (returns JSX)", () => {
    const element = Page();
    expect(element).not.toBeNull();
    expect(element.type).toBeDefined();
  });
});

import "../../setup-dom";
import { mock } from "bun:test";
import React from "react";

mock.module("@/components/admin/AdminDashboard", () => ({
  default: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "admin-shell" }, children),
}));

const { default: AdminLayout } = await import("@/app/admin/layout");

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

describe("AdminLayout", () => {
  beforeEach(() => {
    mockGlobalFetch({ "/api/storage/config": { json: { provider: "local", serverMode: false } } });
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("wraps children in AdminDashboard shell", async () => {
    const { findByTestId, getByText } = render(
      <AdminLayout>
        <span>section content</span>
      </AdminLayout>,
    );
    expect(await findByTestId("admin-shell")).not.toBeNull();
    expect(getByText("section content")).not.toBeNull();
  });

  test("renders the shell only once this browser's workspace is the signed-in account's", () => {
    const { queryByTestId } = render(
      <AdminLayout>
        <span>section content</span>
      </AdminLayout>,
    );
    expect(queryByTestId("admin-shell")).toBeNull();
  });

  test("returns a Suspense boundary", () => {
    const element = AdminLayout({ children: React.createElement("div") });
    expect(element.type).toBe(React.Suspense);
  });
});

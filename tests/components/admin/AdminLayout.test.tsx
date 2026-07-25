import "../../setup-dom";
import { mock } from "bun:test";
import React from "react";

mock.module("@/components/admin/AdminDashboard", () => ({
  default: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "admin-shell" }, children),
}));

const { default: AdminLayout } = await import("@/app/admin/layout");

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

describe("AdminLayout", () => {
  afterEach(() => {
    cleanup();
  });

  test("wraps children in AdminDashboard shell", () => {
    const { getByTestId, getByText } = render(
      <AdminLayout>
        <span>section content</span>
      </AdminLayout>,
    );
    expect(getByTestId("admin-shell")).not.toBeNull();
    expect(getByText("section content")).not.toBeNull();
  });

  test("returns a Suspense boundary", () => {
    const element = AdminLayout({ children: React.createElement("div") });
    expect(element.type).toBe(React.Suspense);
  });
});

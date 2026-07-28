import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import React from "react";

mock.module("next/link", () => ({
  default: ({
    href,
    children,
    className,
    ...props
  }: {
    href: string;
    children?: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => {
    return React.createElement("a", { href, className, ...props }, children);
  },
}));

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, act, cleanup } from "@testing-library/react";

import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { mockRouterPush, mockRouterRefresh, setMockPathname, resetMockPathname } from "../../helpers/mock-navigation";
import { mockToastSuccess } from "../../helpers/mock-sonner";

const { default: AdminDashboard } = await import("@/components/admin/AdminDashboard");

describe("AdminDashboard", () => {
  afterEach(() => {
    cleanup();
    resetMockPathname();
    // Restore via the shared helper: this file shares a process with the other
    // admin tests (run-components.sh Group 4), and an un-restored global fetch
    // leaks into whichever file runs next.
    restoreGlobalFetch();
  });

  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRouterRefresh.mockClear();
    mockToastSuccess.mockClear();
    setMockPathname("/admin/overview");
    mockGlobalFetch({ "/api/auth/logout": { json: { success: true } } });
  });

  test("renders admin dashboard title", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(
        <AdminDashboard>
          <div data-testid="admin-child">child</div>
        </AdminDashboard>,
      );
    });
    expect(renderResult!.queryByText("Admin Dashboard")).not.toBeNull();
  });

  test("shows 5 section nav links with routes", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminDashboard>content</AdminDashboard>);
    });
    const { getByText, getByRole } = renderResult!;

    expect(getByText("Overview").closest("a")?.getAttribute("href")).toBe("/admin/overview");
    expect(getByText("Operations").closest("a")?.getAttribute("href")).toBe("/admin/operations");
    expect(getByText("Monitoring").closest("a")?.getAttribute("href")).toBe("/admin/monitoring");
    expect(getByText("Security").closest("a")?.getAttribute("href")).toBe("/admin/security");
    expect(getByText("Audit").closest("a")?.getAttribute("href")).toBe("/admin/audit");
    expect(getByRole("navigation", { name: "Admin sections" })).not.toBeNull();
  });

  test("marks active section from pathname", async () => {
    setMockPathname("/admin/operations");
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminDashboard>content</AdminDashboard>);
    });
    const operations = renderResult!.getByText("Operations").closest("a");
    expect(operations?.getAttribute("aria-current")).toBe("page");
    const overview = renderResult!.getByText("Overview").closest("a");
    expect(overview?.getAttribute("aria-current")).toBeNull();
  });

  test("renders children in content area", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(
        <AdminDashboard>
          <div data-testid="section-body">Operations body</div>
        </AdminDashboard>,
      );
    });
    expect(renderResult!.getByTestId("section-body").textContent).toBe("Operations body");
  });

  test("logout button present", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminDashboard>content</AdminDashboard>);
    });
    expect(renderResult!.queryByText("Logout")).not.toBeNull();
  });

  test("editor button links to home", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminDashboard>content</AdminDashboard>);
    });
    const editorButton = renderResult!.getByText("Editor").closest("button");
    fireEvent.click(editorButton!);
    expect(mockRouterPush).toHaveBeenCalledWith("/");
  });

  test("logout button triggers logout flow", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminDashboard>content</AdminDashboard>);
    });
    const logoutButton = renderResult!.getByText("Logout").closest("button");

    await act(async () => {
      fireEvent.click(logoutButton!);
    });

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/login");
    });
  });
});

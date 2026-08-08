import "../setup-dom";
import React from "react";
import { mockRouterPush, mockRouterRefresh } from "../helpers/mock-navigation";
import { mockToastError } from "../helpers/mock-sonner";
import { mock } from "bun:test";

const { default: LoginForm } = await import("@/app/login/login-form");

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const DEMO_LABEL = "Explore the live demo";

function mockFetchOnce(body: unknown, ok = true) {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: ok ? 200 : 503 })),
  ) as never;
}

describe("LoginPage — live demo button", () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRouterRefresh.mockClear();
    mockToastError.mockClear();
    mockFetchOnce({ success: true, role: "user" });
  });

  afterEach(() => {
    cleanup();
  });

  test("is absent when the server has no demo account configured", () => {
    const { queryByText } = render(<LoginForm authProvider="local" />);
    expect(queryByText(DEMO_LABEL)).toBeNull();
  });

  test("is rendered in local auth mode when a demo account is configured", () => {
    const { getByText } = render(<LoginForm authProvider="local" demoEnabled />);
    expect(getByText(DEMO_LABEL)).not.toBeNull();
  });

  test("is rendered in OIDC mode too — a visitor without an IdP account still needs a way in", () => {
    const { getByText } = render(<LoginForm authProvider="oidc" demoEnabled />);
    expect(getByText(DEMO_LABEL)).not.toBeNull();
  });

  test("signs the visitor in and routes to the workspace", async () => {
    const user = userEvent.setup();
    const { getByText } = render(<LoginForm authProvider="oidc" demoEnabled />);

    await user.click(getByText(DEMO_LABEL));

    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith("/"));
    expect(mockRouterRefresh).toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/auth/demo", { method: "POST" });
  });

  test("routes an admin demo account to the admin area", async () => {
    mockFetchOnce({ success: true, role: "admin" });
    const user = userEvent.setup();
    const { getByText } = render(<LoginForm authProvider="local" demoEnabled />);

    await user.click(getByText(DEMO_LABEL));

    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith("/admin"));
  });

  test("surfaces the server's message when the demo is misconfigured", async () => {
    mockFetchOnce({ success: false, message: "Demo access is misconfigured: DEMO_EMAIL ..." }, false);
    const user = userEvent.setup();
    const { getByText } = render(<LoginForm authProvider="local" demoEnabled />);

    await user.click(getByText(DEMO_LABEL));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Demo access is misconfigured: DEMO_EMAIL ..."));
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  test("falls back to a generic message when the server sends none", async () => {
    mockFetchOnce({ success: false }, false);
    const user = userEvent.setup();
    const { getByText } = render(<LoginForm authProvider="local" demoEnabled />);

    await user.click(getByText(DEMO_LABEL));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("The demo is unavailable right now"));
  });

  test("shows an error toast when the request itself fails", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("network down"))) as never;
    const user = userEvent.setup();
    const { getByText } = render(<LoginForm authProvider="local" demoEnabled />);

    await user.click(getByText(DEMO_LABEL));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("An error occurred. Please try again."));
  });

  test("shows a pending label while the demo session is being created", async () => {
    let release: (value: Response) => void = () => {};
    globalThis.fetch = mock(() => new Promise<Response>((resolve) => (release = resolve))) as never;
    const user = userEvent.setup();
    const { getByText, queryByText } = render(<LoginForm authProvider="local" demoEnabled />);

    await user.click(getByText(DEMO_LABEL));

    await waitFor(() => expect(queryByText("Opening the demo...")).not.toBeNull());
    release(new Response(JSON.stringify({ success: true, role: "user" })));
    await waitFor(() => expect(queryByText(DEMO_LABEL)).not.toBeNull());
  });
});

import "../setup-dom";
import React from "react";
import { mockRouterPush, mockRouterRefresh } from "../helpers/mock-navigation";
import { mockToastSuccess, mockToastError } from "../helpers/mock-sonner";
import { mock } from "bun:test";

// sonner and next/navigation are mocked via preload
// lucide-react resolves fine natively — no mock needed

const { default: LoginForm } = await import("@/app/login/login-form");

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

function renderLogin() {
  const user = userEvent.setup();
  const result = render(<LoginForm authProvider="local" />);
  const form = result.container.querySelector("form")!;
  const emailInput = result.container.querySelector('input[type="email"]')! as HTMLInputElement;
  const passwordInput = result.container.querySelector('input[type="password"]')! as HTMLInputElement;
  return { ...result, form, emailInput, passwordInput, user };
}

describe("LoginPage", () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRouterRefresh.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    globalThis.fetch = mock(() => Promise.resolve(new Response("{}"))) as never;
  });

  afterEach(() => {
    cleanup();
  });

  test("renders login form with email and password inputs", () => {
    const { emailInput, passwordInput } = renderLogin();
    expect(emailInput).not.toBeNull();
    expect(emailInput.type).toBe("email");
    expect(passwordInput).not.toBeNull();
    expect(passwordInput.type).toBe("password");
  });

  test("renders Sign In button", () => {
    const { getByText } = renderLogin();
    expect(getByText("Sign In")).not.toBeNull();
  });

  test("renders LibreDB Studio title", () => {
    const { getAllByText } = renderLogin();
    expect(getAllByText("LibreDB Studio").length).toBeGreaterThanOrEqual(1);
  });

  test("shows error toast when submitting empty form", () => {
    const { form } = renderLogin();
    fireEvent.submit(form);
    expect(mockToastError).toHaveBeenCalledWith("Please enter email and password");
  });

  test("calls fetch with correct payload on form submit", async () => {
    const mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify({ success: true, role: "admin" }))));
    globalThis.fetch = mockFetch as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "admin@libredb.org");
    await user.type(passwordInput, "LibreDB.2026");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [url, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({ email: "admin@libredb.org", password: "LibreDB.2026" });
  });

  test("redirects admin to /admin on success", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, role: "admin" }))),
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "admin@libredb.org");
    await user.type(passwordInput, "LibreDB.2026");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/admin");
    });
    expect(mockRouterRefresh).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith("Welcome back, admin!");
  });

  test("redirects user to / on success", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, role: "user" }))),
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "user@libredb.org");
    await user.type(passwordInput, "LibreDB.2026");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/");
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Welcome back, user!");
  });

  test("shows error toast on failed login", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: false, message: "Invalid email or password" }))),
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "wrong@example.com");
    await user.type(passwordInput, "wrong");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Invalid email or password");
    });
  });

  test("falls back to the response's error field when message is absent (origin-mismatch/rate-limit shape)", async () => {
    // The proxy's Origin-mismatch 403 and the shared 429 envelope both carry `error`, not
    // `message` - unlike the login route's own body. Without the fallback this reads as
    // `data.message || "Invalid email or password"`, so a rate-limited or origin-refused caller
    // would incorrectly be told their password is wrong.
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "Request origin is not allowed for this deployment. Set ALLOWED_ORIGINS.",
            code: "ORIGIN_MISMATCH",
          }),
        ),
      ),
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "admin@libredb.org");
    await user.type(passwordInput, "correct-password");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Request origin is not allowed for this deployment. Set ALLOWED_ORIGINS.",
      );
    });
  });

  test("shows generic error toast on network failure", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Network error"))) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "test@example.com");
    await user.type(passwordInput, "test");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("An error occurred. Please try again.");
    });
  });

  test("shows Authenticating... text while loading", async () => {
    let resolveFetch!: (v: Response) => void;
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as never;

    const { form, emailInput, passwordInput, user, queryByText } = renderLogin();
    await user.type(emailInput, "test@example.com");
    await user.type(passwordInput, "test");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(queryByText("Authenticating...")).not.toBeNull();
    });

    resolveFetch(new Response(JSON.stringify({ success: false })));
    await waitFor(() => {
      expect(queryByText("Sign In")).not.toBeNull();
    });
  });
});

describe("LoginPage route (app/login/page)", () => {
  const savedAuthProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER;

  afterEach(() => {
    if (savedAuthProvider === undefined) {
      delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    } else {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = savedAuthProvider;
    }
    cleanup();
  });

  test("forces dynamic rendering so the auth provider is read at runtime", async () => {
    const { dynamic } = await import("@/app/login/page");
    expect(dynamic).toBe("force-dynamic");
  });

  test("defaults to the local login form when no auth provider is set", async () => {
    delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    const { default: LoginPageRoute } = await import("@/app/login/page");

    const { container } = render(<LoginPageRoute />);
    expect(container.querySelector("form")).not.toBeNull();
  });

  test("renders the SSO login when NEXT_PUBLIC_AUTH_PROVIDER is oidc", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    const { default: LoginPageRoute } = await import("@/app/login/page");

    const { queryByText, container } = render(<LoginPageRoute />);
    expect(queryByText("Login with SSO")).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });
});

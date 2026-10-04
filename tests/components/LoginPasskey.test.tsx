import "../setup-dom";
import React from "react";
import { mock } from "bun:test";
import {
  mockRouterPush,
  mockRouterRefresh,
  resetMockSearchParams,
  setMockSearchParams,
} from "../helpers/mock-navigation";
import { mockToastSuccess, mockToastError } from "../helpers/mock-sonner";
import type { PasskeySignInResult } from "@/lib/passkey/client";

// The browser ceremony is the client module's own concern (tests/unit/lib/passkey/client.test.ts);
// here only what the login form does with its answers is under test.
const ORIGIN = "https://studio.example.com";
// Any text: the form under test never checks it. A named placeholder, so secret scanners do not read it as a credential.
const TEST_PASSWORD = "password-typed-in-the-form";
let usableHere = true;
const mockPasskeysUsableHere = mock((origin: string) => usableHere && origin === ORIGIN);
const mockSignInWithPasskey = mock((): Promise<PasskeySignInResult> => Promise.resolve({ ok: true, role: "admin" }));
mock.module("@/lib/passkey/client", () => ({
  passkeysUsableHere: mockPasskeysUsableHere,
  signInWithPasskey: mockSignInWithPasskey,
}));

const { default: LoginForm } = await import("@/app/login/login-form");

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const PASSKEY_BUTTON = "Use a passkey";

function renderLogin(passkey: { origin: string } | null = { origin: ORIGIN }) {
  const user = userEvent.setup();
  const result = render(<LoginForm authProvider="local" passkey={passkey} />);
  const form = result.container.querySelector("form")!;
  const emailInput = result.container.querySelector('input[type="email"]')! as HTMLInputElement;
  const passwordInput = result.container.querySelector('input[type="password"]')! as HTMLInputElement;
  return { ...result, form, emailInput, passwordInput, user };
}

async function passkeyButton(result: ReturnType<typeof renderLogin>) {
  return (await result.findByRole("button", { name: PASSKEY_BUTTON })) as HTMLButtonElement;
}

describe("LoginPage passkey sign-in", () => {
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    usableHere = true;
    mockPasskeysUsableHere.mockClear();
    mockSignInWithPasskey.mockReset();
    mockSignInWithPasskey.mockImplementation(() => Promise.resolve({ ok: true, role: "admin" }));
    mockRouterPush.mockClear();
    mockRouterRefresh.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockFetch = mock(() => Promise.resolve(new Response("{}")));
    globalThis.fetch = mockFetch as never;
  });

  afterEach(() => {
    cleanup();
  });

  test("shows Use a passkey only when passkeys are ready, supported and on the configured origin", async () => {
    const off = renderLogin(null);
    await waitFor(() => expect(off.getByRole("button", { name: "Sign in" })).not.toBeNull());
    expect(off.queryByRole("button", { name: PASSKEY_BUTTON })).toBeNull();
    off.unmount();

    usableHere = false;
    const elsewhere = renderLogin();
    await waitFor(() => expect(mockPasskeysUsableHere).toHaveBeenCalledWith(ORIGIN));
    expect(elsewhere.queryByRole("button", { name: PASSKEY_BUTTON })).toBeNull();
    elsewhere.unmount();

    usableHere = true;
    const ready = renderLogin();
    expect((await passkeyButton(ready)).textContent?.trim()).toBe(PASSKEY_BUTTON);
  });

  test("the passkey button's accessible name does not contain sign in", async () => {
    const result = renderLogin();
    await passkeyButton(result);
    expect(result.getAllByRole("button", { name: /sign in/i })).toHaveLength(1);
  });

  test("a passkey sign-in routes by role like a password sign-in", async () => {
    const admin = renderLogin();
    fireEvent.click(await passkeyButton(admin));
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith("/admin"));
    expect(mockToastSuccess).toHaveBeenCalledWith("Welcome back, admin!");
    expect(mockRouterRefresh).toHaveBeenCalled();
    admin.unmount();

    mockRouterPush.mockClear();
    mockSignInWithPasskey.mockImplementation(() => Promise.resolve({ ok: true, role: "user" }));
    const user = renderLogin();
    fireEvent.click(await passkeyButton(user));
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith("/"));
    expect(mockToastSuccess).toHaveBeenCalledWith("Welcome back, user!");
  });

  test("a passkey sign-in returns to the page the session ended on (#1420)", async () => {
    setMockSearchParams(new URLSearchParams({ next: "/admin/audit" }));
    try {
      mockSignInWithPasskey.mockImplementation(() => Promise.resolve({ ok: true, role: "user" }));
      const result = renderLogin();
      fireEvent.click(await passkeyButton(result));
      await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith("/admin/audit"));
    } finally {
      resetMockSearchParams();
    }
  });

  test("a failed or cancelled passkey keeps the password form and never submits it", async () => {
    const message = "That passkey could not sign you in.";
    mockSignInWithPasskey.mockImplementation(() => Promise.resolve({ ok: false, message }));
    const result = renderLogin();
    await result.user.type(result.emailInput, "admin@libredb.org");
    await result.user.type(result.passwordInput, TEST_PASSWORD);

    const button = await passkeyButton(result);
    fireEvent.click(button);
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(message));
    await waitFor(() => expect(button.disabled).toBe(false));

    mockToastError.mockClear();
    mockSignInWithPasskey.mockImplementation(() => Promise.resolve({ ok: false, message: null }));
    fireEvent.click(button);
    await waitFor(() => expect(mockSignInWithPasskey).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(mockToastError).not.toHaveBeenCalled();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(result.emailInput.value).toBe("admin@libredb.org");
    expect(result.passwordInput.value).toBe(TEST_PASSWORD);
  });

  test("the passkey button is hidden while the code step is showing", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: false, mfaRequired: true }))),
    ) as never;
    const result = renderLogin();
    await passkeyButton(result);
    await result.user.type(result.emailInput, "admin@libredb.org");
    await result.user.type(result.passwordInput, TEST_PASSWORD);
    fireEvent.submit(result.form);

    await waitFor(() => expect(result.container.querySelector("#totp")).not.toBeNull());
    expect(result.queryByRole("button", { name: PASSKEY_BUTTON })).toBeNull();
  });

  test("the button is disabled while a sign-in is running", async () => {
    let finish: (value: PasskeySignInResult) => void = () => {};
    mockSignInWithPasskey.mockImplementation(
      () =>
        new Promise<PasskeySignInResult>((resolve) => {
          finish = resolve;
        }),
    );
    const result = renderLogin();
    const button = await passkeyButton(result);
    fireEvent.click(button);

    await waitFor(() => expect(button.disabled).toBe(true));
    expect((result.getByRole("button", { name: /authenticating/i }) as HTMLButtonElement).disabled).toBe(true);

    finish({ ok: false, message: null });
    await waitFor(() => expect(button.disabled).toBe(false));
  });
});

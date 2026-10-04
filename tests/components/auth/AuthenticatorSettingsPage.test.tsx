import "../../setup-dom";
import "../../helpers/mock-sonner";
import { mockRouterPush } from "../../helpers/mock-navigation";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

// happy-dom has no WebAuthn, so the page is told the browser can run passkeys here.
const real = { ...(await import("@/lib/passkey/client")) };
mock.module("@/lib/passkey/client", () => ({ ...real, passkeysUsableHere: () => true }));
const { default: AuthenticatorSettingsPage } = await import("@/app/settings/authenticator/page");

const PASSKEY_STATUS = {
  available: true,
  canAdd: true,
  origin: "http://localhost:3000",
  rpId: "localhost",
  passkeys: [],
};

describe("/settings/authenticator", () => {
  beforeEach(() => mockRouterPush.mockClear());

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("frames the authenticator and the passkeys with a heading and a way back to the editor", async () => {
    mockGlobalFetch({
      "/api/auth/totp": { json: { available: true, enabled: false } },
      "/api/auth/passkey": { json: { ...PASSKEY_STATUS, totpEnabled: false } },
    });
    const view = render(<AuthenticatorSettingsPage />);
    expect(view.getByRole("heading", { level: 1, name: "Sign-in security" })).toBeTruthy();
    expect(view.getByText("Passkeys and the authenticator app for your own sign-in to this server.")).toBeTruthy();
    expect(view.getByRole("link", { name: "Back to the editor" }).getAttribute("href")).toBe("/");
    expect(view.getByRole("heading", { name: "Your authenticator" })).toBeTruthy();
    expect(view.getByRole("heading", { name: "Passkeys" })).toBeTruthy();
    await waitFor(() => expect(view.getByRole("button", { name: "Set up authenticator" })).toBeTruthy());
    await waitFor(() => expect(view.getByRole("button", { name: "Add passkey" })).toBeTruthy());
  });

  test("after the authenticator is turned on on the same page, the next Add dialog asks for a code", async () => {
    let enabled = false;
    let passkeyReads = 0;
    mockGlobalFetch({
      "/api/auth/totp": async (req) => {
        if (req.method === "GET") return { json: { available: true, enabled } };
        const body = (await req.json()) as { action: string };
        if (body.action === "begin") return { json: { secret: "SECRETVALUE" } };
        enabled = true;
        return { json: { ok: true } };
      },
      "/api/auth/passkey": () => {
        passkeyReads += 1;
        return { json: { ...PASSKEY_STATUS, totpEnabled: passkeyReads > 1 } };
      },
    });
    const view = render(<AuthenticatorSettingsPage />);
    await waitFor(() => expect(view.getByRole("button", { name: "Add passkey" })).toBeTruthy());
    fireEvent.change(view.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.click(view.getByRole("button", { name: "Set up authenticator" }));
    await waitFor(() => expect(view.getByTestId("totp-secret")).toBeTruthy());
    fireEvent.change(view.getByLabelText("Authentication code"), { target: { value: "123456" } });
    fireEvent.click(view.getByRole("button", { name: "Confirm code" }));
    await waitFor(() => expect(view.getByText("On")).toBeTruthy());
    await waitFor(() => expect(passkeyReads).toBe(2));

    fireEvent.click(view.getByRole("button", { name: "Add passkey" }));
    const dialog = within(await waitFor(() => view.getByRole("dialog")));
    expect(dialog.getByLabelText("Current code")).toBeTruthy();
  });

  test("a session the server no longer accepts sends the tab to /login", async () => {
    mockGlobalFetch({
      "/api/auth/me": { status: 401, json: { authenticated: false } },
      "/api/auth/totp": { status: 401, json: { error: "Authentication required" } },
      "/api/auth/passkey": { status: 401, json: { error: "Authentication required" } },
    });
    window.history.replaceState(null, "", "/settings/authenticator");
    try {
      render(<AuthenticatorSettingsPage />);
      // Back to this page after signing in again (#1420).
      await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith("/login?next=%2Fsettings%2Fauthenticator"));
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  test("a live session stays on the page", async () => {
    let meReads = 0;
    mockGlobalFetch({
      "/api/auth/me": () => {
        meReads += 1;
        return { json: { authenticated: true, user: { username: "admin@libredb.org", role: "admin" } } };
      },
      "/api/auth/totp": { json: { available: true, enabled: false } },
      "/api/auth/passkey": { json: { ...PASSKEY_STATUS, totpEnabled: false } },
    });
    const view = render(<AuthenticatorSettingsPage />);
    await waitFor(() => expect(view.getByRole("button", { name: "Add passkey" })).toBeTruthy());
    await waitFor(() => expect(meReads).toBe(1));
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});

import "../../setup-dom";
import { mockToastError, mockToastSuccess } from "../../helpers/mock-sonner";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../../helpers/mock-fetch";
import { AccountsTab } from "@/components/admin/tabs/AccountsTab";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const ACCOUNTS = [
  {
    email: "admin@libredb.org",
    role: "admin",
    disabled: false,
    totpEnabled: false,
    passkeys: 0,
    createdAt: "2026-09-28T10:00:00Z",
  },
  {
    email: "kenji@libredb.org",
    role: "user",
    disabled: false,
    totpEnabled: true,
    passkeys: 2,
    createdAt: "2026-09-28T10:00:00Z",
  },
  {
    email: "lena@libredb.org",
    role: "user",
    disabled: false,
    totpEnabled: true,
    passkeys: 0,
    createdAt: "2026-09-28T10:00:00Z",
  },
  {
    email: "tomas@libredb.org",
    role: "user",
    disabled: false,
    totpEnabled: true,
    passkeys: 1,
    createdAt: "2026-09-28T10:00:00Z",
  },
];

function serve(respond?: (call: Call) => MockFetchResponse | undefined, accounts: unknown[] = ACCOUNTS) {
  const calls: Call[] = [];
  mockGlobalFetch({
    "/api/admin/accounts": async (req) => {
      if (req.method === "GET") return { json: { accounts } };
      const call = { method: req.method, path: new URL(req.url).pathname, body: await req.json() };
      calls.push(call);
      return respond?.(call) ?? { json: { account: ACCOUNTS[0] } };
    },
    "/api/auth/me": { json: { authenticated: true, user: { username: "admin@libredb.org", role: "admin" } } },
    "/api/auth/totp": { json: { available: true, enabled: false } },
    "/api/auth/passkey": {
      json: { available: true, canAdd: true, origin: "http://localhost:3000", totpEnabled: false, passkeys: [] },
    },
  });
  return calls;
}

async function renderList() {
  const view = render(<AccountsTab />);
  await waitFor(() => expect(view.getByText("kenji@libredb.org")).toBeTruthy());
  return view;
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, view: ReturnType<typeof render>, email: string) {
  await user.click(view.getByRole("button", { name: `Actions for ${email}` }));
  return view.findByRole("menu");
}

function row(view: ReturnType<typeof render>, email: string): HTMLElement {
  return view.getByText(email).closest("tr") as HTMLElement;
}

beforeEach(() => {
  mockToastSuccess.mockClear();
  mockToastError.mockClear();
});

afterEach(() => {
  cleanup();
  restoreGlobalFetch();
});

describe("AccountsTab passkeys", () => {
  test("shows each account's passkey count", async () => {
    serve();
    const view = await renderList();
    expect(within(view.getByRole("table")).getByRole("columnheader", { name: "Passkeys" })).toBeTruthy();
    expect(within(row(view, "kenji@libredb.org")).getByTestId("passkeys-kenji@libredb.org").textContent).toBe("2");
    expect(within(row(view, "lena@libredb.org")).getByTestId("passkeys-lena@libredb.org").textContent).toBe("None");
    // The folded mobile row carries a count badge only when there is something to count.
    expect(within(row(view, "kenji@libredb.org")).getByText("2 passkeys")).toBeTruthy();
    expect(within(row(view, "lena@libredb.org")).queryByText(/passkeys?$/)).toBeNull();
  });

  test("Remove passkeys asks for the typed email and sends clearPasskeys", async () => {
    const calls = serve();
    const user = userEvent.setup();
    const view = await renderList();
    const menu = await openMenu(user, view, "kenji@libredb.org");
    await user.click(within(menu).getByRole("menuitem", { name: "Remove passkeys" }));
    const dialog = await view.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "Remove every passkey?" })).toBeTruthy();
    expect(dialog.textContent).toContain(
      "kenji@libredb.org can no longer sign in with a passkey, and every session and MCP token they hold ends. Their password and authenticator stay.",
    );
    const confirm = within(dialog).getByRole("button", { name: "Remove passkeys" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type kenji@libredb.org to confirm"), {
      target: { value: "kenji@libredb.org" },
    });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
    expect(calls).toEqual([
      { method: "PATCH", path: "/api/admin/accounts/kenji%40libredb.org", body: { clearPasskeys: true } },
    ]);
    expect(mockToastSuccess).toHaveBeenCalledWith("Passkeys removed for kenji@libredb.org");
  });

  test("Remove passkeys on the admin's own row says this session continues", async () => {
    serve(undefined, [{ ...ACCOUNTS[0], passkeys: 1 }, ...ACCOUNTS.slice(1)]);
    const user = userEvent.setup();
    const view = await renderList();
    const menu = await openMenu(user, view, "admin@libredb.org");
    await user.click(within(menu).getByRole("menuitem", { name: "Remove passkeys" }));
    const dialog = await view.findByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "You (admin@libredb.org) can no longer sign in with a passkey. Your other sessions and MCP tokens end; this one continues. Your password and authenticator stay.",
    );
    expect(dialog.textContent).not.toContain("every session and MCP token they hold ends");
  });

  test("the action is absent when an account has no passkeys", async () => {
    serve();
    const user = userEvent.setup();
    const view = await renderList();
    const menu = await openMenu(user, view, "lena@libredb.org");
    expect(within(menu).queryByRole("menuitem", { name: "Remove passkeys" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Clear two-factor" })).toBeTruthy();
  });

  test("a refusal stays inside the dialog", async () => {
    serve(() => ({ status: 409, json: { error: "The account changed at the same time." } }));
    const user = userEvent.setup();
    const view = await renderList();
    const menu = await openMenu(user, view, "kenji@libredb.org");
    await user.click(within(menu).getByRole("menuitem", { name: "Remove passkeys" }));
    const dialog = await view.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Type kenji@libredb.org to confirm"), {
      target: { value: "kenji@libredb.org" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove passkeys" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe("The account changed at the same time."),
    );
    expect(view.getByRole("alertdialog")).toBe(dialog);
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test("Set password removes passkeys by default and names the count", async () => {
    const calls = serve();
    const user = userEvent.setup();
    const view = await renderList();
    const menu = await openMenu(user, view, "kenji@libredb.org");
    await user.click(within(menu).getByRole("menuitem", { name: "Set password" }));
    const dialog = await view.findByRole("dialog", { name: "Set a new password" });
    const box = within(dialog).getByRole("checkbox", { name: "Also remove their 2 passkeys" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(dialog.textContent).toContain(
      "Every session and MCP token they hold ends, their 2 passkeys are removed, and they sign in with the new password.",
    );
    fireEvent.change(within(dialog).getByLabelText("New password"), { target: { value: "long-enough" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Set a new password" })).toBeNull());
    expect(calls).toEqual([
      { method: "PATCH", path: "/api/admin/accounts/kenji%40libredb.org", body: { password: "long-enough" } },
    ]);

    const again = await openMenu(user, view, "kenji@libredb.org");
    await user.click(within(again).getByRole("menuitem", { name: "Set password" }));
    const second = await view.findByRole("dialog", { name: "Set a new password" });
    await user.click(within(second).getByRole("checkbox", { name: "Also remove their 2 passkeys" }));
    expect(within(second).getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
    expect(second.textContent).toContain(
      "Every session and MCP token they hold ends. They sign in with the new password or one of their 2 passkeys; keep the passkeys only when you know the account is not compromised.",
    );
    fireEvent.change(within(second).getByLabelText("New password"), { target: { value: "long-enough" } });
    fireEvent.click(within(second).getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body).toEqual({ password: "long-enough", keepPasskeys: true });
  });

  test("at zero passkeys the Set password dialog has no passkey choice and keeps its text", async () => {
    const calls = serve();
    const user = userEvent.setup();
    const view = await renderList();
    const menu = await openMenu(user, view, "lena@libredb.org");
    await user.click(within(menu).getByRole("menuitem", { name: "Set password" }));
    const dialog = await view.findByRole("dialog", { name: "Set a new password" });
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(dialog.textContent).toContain(
      "For lena@libredb.org. Every session and MCP token they hold ends, and they sign in with the new password.",
    );
    fireEvent.change(within(dialog).getByLabelText("New password"), { target: { value: "long-enough" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ password: "long-enough" });
  });

  test("on the admin's own row Set password says this session continues", async () => {
    const withMyPasskeys = [{ ...ACCOUNTS[0], passkeys: 2 }, ...ACCOUNTS.slice(1)];
    serve(undefined, withMyPasskeys);
    const user = userEvent.setup();
    const view = await renderList();
    const menu = await openMenu(user, view, "admin@libredb.org");
    await user.click(within(menu).getByRole("menuitem", { name: "Set password" }));
    const dialog = await view.findByRole("dialog", { name: "Set a new password" });
    expect(dialog.textContent).toContain(
      "Your other sessions and MCP tokens end; this one continues. Your 2 passkeys are removed, and next time you sign in with the new password.",
    );
    expect(within(dialog).getByRole("checkbox", { name: "Also remove your 2 passkeys" })).toBeTruthy();
    await user.click(within(dialog).getByRole("checkbox"));
    expect(dialog.textContent).toContain(
      "Your other sessions and MCP tokens end; this one continues. Next time you sign in with the new password or one of your 2 passkeys;",
    );
    expect(dialog.textContent).not.toContain("they hold");
  });

  test("on the admin's own row with no passkeys Set password says this session continues", async () => {
    serve();
    const user = userEvent.setup();
    const view = await renderList();
    const menu = await openMenu(user, view, "admin@libredb.org");
    await user.click(within(menu).getByRole("menuitem", { name: "Set password" }));
    const dialog = await view.findByRole("dialog", { name: "Set a new password" });
    expect(dialog.textContent).toContain(
      "For admin@libredb.org. Your other sessions and MCP tokens end; this one continues. Next time you sign in with the new password.",
    );
  });

  test("at one passkey Clear two-factor and Set password both say their passkey", async () => {
    serve();
    const user = userEvent.setup();
    const view = await renderList();
    const menu = await openMenu(user, view, "tomas@libredb.org");
    await user.click(within(menu).getByRole("menuitem", { name: "Clear two-factor" }));
    const dialog = await view.findByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "tomas@libredb.org signs in with the password alone, or with their passkey, until they set up a new authenticator.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());

    const again = await openMenu(user, view, "tomas@libredb.org");
    await user.click(within(again).getByRole("menuitem", { name: "Set password" }));
    const set = await view.findByRole("dialog", { name: "Set a new password" });
    await user.click(within(set).getByRole("checkbox"));
    expect(set.textContent).toContain("They sign in with the new password or their passkey;");
  });

  test("Clear two-factor names the passkeys that still sign in", async () => {
    serve();
    const user = userEvent.setup();
    const view = await renderList();
    const menu = await openMenu(user, view, "kenji@libredb.org");
    await user.click(within(menu).getByRole("menuitem", { name: "Clear two-factor" }));
    const dialog = await view.findByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "kenji@libredb.org signs in with the password alone, or with one of their 2 passkeys, until they set up a new authenticator. If the lost device also held a passkey, use Remove passkeys too.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());

    const other = await openMenu(user, view, "lena@libredb.org");
    await user.click(within(other).getByRole("menuitem", { name: "Clear two-factor" }));
    const plain = await view.findByRole("alertdialog");
    expect(plain.textContent).toContain(
      "lena@libredb.org signs in with the password alone until they set up a new authenticator. Use this when the device with the app is lost.",
    );
    expect(plain.textContent).not.toContain("passkey");
  });
});

import "../../setup-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { AccountsTab } from "@/components/admin/tabs/AccountsTab";

interface Account {
  email: string;
  role: "admin" | "user";
  disabled: boolean;
  totpEnabled: boolean;
  createdAt: string;
}

describe("AccountsTab", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("shows the loading line until the list returns", async () => {
    let release: (response: Response) => void = () => {};
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch;
    const view = render(<AccountsTab />);
    expect(view.getByText(/Loading accounts/)).toBeTruthy();
    release(
      new Response(JSON.stringify({ accounts: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await waitFor(() => expect(view.getByRole("heading", { name: "Accounts" })).toBeTruthy());
  });

  test("shows the server's reason when the registry is off", async () => {
    mockGlobalFetch({ "/api/admin/accounts": { status: 409, json: { error: "Needs sqlite." } } });
    const view = render(<AccountsTab />);
    await waitFor(() => expect(view.getByTestId("accounts-unavailable").textContent).toBe("Needs sqlite."));
  });

  test("shows an error when the list fails or the response is not JSON", async () => {
    mockGlobalFetch({ "/api/admin/accounts": { status: 500, json: { error: "down" } } });
    const failed = render(<AccountsTab />);
    await waitFor(() => expect(failed.getByTestId("accounts-error").textContent).toBe("down"));
    cleanup();

    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const rejected = render(<AccountsTab />);
    await waitFor(() => expect(rejected.getByTestId("accounts-error").textContent).toBe("Could not load accounts"));
    cleanup();

    globalThis.fetch = (() => Promise.resolve(new Response("nope", { status: 200 }))) as unknown as typeof fetch;
    const garbage = render(<AccountsTab />);
    await waitFor(() => expect(garbage.getByTestId("accounts-error").textContent).toBe("Could not load accounts"));
  });

  test("creates, changes, deletes, and enrols from the table", async () => {
    const accounts: Account[] = [
      { email: "admin@libredb.org", role: "admin", disabled: false, totpEnabled: true, createdAt: "t" },
      { email: "user@libredb.org", role: "user", disabled: true, totpEnabled: false, createdAt: "t" },
    ];
    let failCreate = false;
    let failBegin = false;
    let failConfirm = false;
    const calls: { method: string; path: string; body: unknown }[] = [];

    mockGlobalFetch({
      "/api/admin/accounts": async (req) => {
        const path = new URL(req.url).pathname;
        const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json();
        calls.push({ method: req.method, path, body });
        if (req.method === "GET") return { json: { accounts } };
        if (req.method === "POST") {
          if (failCreate) return { status: 400, json: { error: "duplicate" } };
          accounts.push({
            email: "new@example.com",
            role: "user",
            disabled: false,
            totpEnabled: false,
            createdAt: "t",
          });
          return { status: 201, json: { account: accounts[accounts.length - 1] } };
        }
        if (req.method === "DELETE") {
          const email = decodeURIComponent(path.split("/").pop() ?? "");
          const index = accounts.findIndex((account) => account.email === email);
          if (index >= 0) accounts.splice(index, 1);
          return { json: { ok: true } };
        }
        return { json: { account: accounts[0] } };
      },
      "/api/auth/totp": async (req) => {
        const body = (await req.json()) as { action?: string };
        calls.push({ method: req.method, path: "/api/auth/totp", body });
        if (body.action === "begin") {
          if (failBegin) return { status: 400, json: { error: "no account" } };
          return { json: { secret: "SECRETVALUE", otpauthUrl: "otpauth://totp/LibreDB" } };
        }
        if (body.action === "confirm") {
          if (failConfirm) return { status: 400, json: { error: "bad code" } };
          return { json: { ok: true } };
        }
        return { json: { ok: true } };
      },
    });

    const view = render(<AccountsTab />);
    await waitFor(() => expect(view.getByText("admin@libredb.org")).toBeTruthy());
    expect(view.getByText("Make user")).toBeTruthy();
    expect(view.getByText("Make admin")).toBeTruthy();
    expect(view.getByText("Disable")).toBeTruthy();
    expect(view.getByText("Enable")).toBeTruthy();
    expect(view.getByText("Clear MFA")).toBeTruthy();
    expect(view.getByText("On")).toBeTruthy();
    expect(view.getByText("Off")).toBeTruthy();

    fireEvent.click(view.getByTestId("role-user@libredb.org"));
    fireEvent.click(view.getByTestId("disabled-admin@libredb.org"));
    fireEvent.click(view.getByTestId("clear-totp-admin@libredb.org"));
    fireEvent.click(view.getByTestId("delete-user@libredb.org"));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));

    fireEvent.change(view.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(view.getByLabelText("Password"), { target: { value: "long-enough" } });
    fireEvent.change(view.getByLabelText("Role"), { target: { value: "admin" } });
    failCreate = true;
    fireEvent.click(view.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("duplicate"));

    failCreate = false;
    fireEvent.click(view.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(view.getByText("new@example.com")).toBeTruthy());

    failBegin = true;
    fireEvent.click(view.getByRole("button", { name: "Set up authenticator" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("no account"));

    failBegin = false;
    fireEvent.click(view.getByRole("button", { name: "Set up authenticator" }));
    await waitFor(() => expect(view.getByTestId("totp-secret").textContent).toBe("SECRETVALUE"));
    expect(view.getByText("otpauth://totp/LibreDB")).toBeTruthy();

    failConfirm = true;
    fireEvent.change(view.getByLabelText("Authentication code"), { target: { value: "000000" } });
    fireEvent.click(view.getByRole("button", { name: "Confirm code" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("bad code"));
    expect(view.getByTestId("totp-secret")).toBeTruthy();

    failConfirm = false;
    fireEvent.click(view.getByRole("button", { name: "Confirm code" }));
    await waitFor(() => expect(view.queryByTestId("totp-secret")).toBeNull());

    fireEvent.click(view.getByRole("button", { name: "Turn off authenticator" }));
    await waitFor(() =>
      expect(calls.some((call) => (call.body as { action?: string } | null)?.action === "disable")).toBe(true),
    );

    const roleCall = calls.find((call) => call.method === "PATCH" && call.path.endsWith("user%40libredb.org"));
    expect(roleCall?.body).toEqual({ role: "admin" });
  });
});

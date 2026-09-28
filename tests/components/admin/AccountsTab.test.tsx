import "../../setup-dom";
import { mockToastError, mockToastSuccess } from "../../helpers/mock-sonner";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../../helpers/mock-fetch";
import { AccountsTab } from "@/components/admin/tabs/AccountsTab";

interface Account {
  email: string;
  role: "admin" | "user";
  disabled: boolean;
  totpEnabled: boolean;
  createdAt: string;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fixture(): Account[] {
  return [
    {
      email: "admin@libredb.org",
      role: "admin",
      disabled: false,
      totpEnabled: true,
      createdAt: "2026-09-28T10:00:00Z",
    },
    {
      email: "maria@libredb.org",
      role: "admin",
      disabled: false,
      totpEnabled: false,
      createdAt: "2026-09-28T10:00:00Z",
    },
    { email: "kenji@libredb.org", role: "user", disabled: false, totpEnabled: true, createdAt: "2026-09-28T10:00:00Z" },
    // An unreadable date renders as an empty cell rather than "Invalid Date".
    { email: "lena@libredb.org", role: "user", disabled: true, totpEnabled: false, createdAt: "t" },
  ];
}

type Responder = (call: Call) => MockFetchResponse | undefined;

/**
 * A stand-in for the admin API. Every non-GET request is recorded; `respond` may answer one
 * instead of the default success, and `me` is what /api/auth/me returns.
 */
function serve(
  options: {
    accounts?: Account[];
    respond?: Responder;
    me?: MockFetchResponse | "reject";
    list?: MockFetchResponse;
  } = {},
) {
  const accounts = options.accounts ?? fixture();
  const calls: Call[] = [];
  mockGlobalFetch({
    "/api/admin/accounts": async (req) => {
      const path = new URL(req.url).pathname;
      if (req.method === "GET") return options.list ?? { json: { accounts } };
      const call = { method: req.method, path, body: req.method === "DELETE" ? null : await req.json() };
      calls.push(call);
      const answer = options.respond?.(call);
      if (answer) return answer;
      if (req.method === "POST") return { status: 201, json: { account: accounts[0] } };
      if (req.method === "DELETE") return { json: { ok: true } };
      return { json: { account: accounts[0] } };
    },
    "/api/auth/me": () => {
      if (options.me === "reject") throw new Error("offline");
      return options.me ?? { json: { authenticated: true, user: { username: "Admin@libredb.org", role: "admin" } } };
    },
    "/api/auth/totp": { json: { available: true, enabled: false } },
  });
  return calls;
}

async function renderList() {
  const view = render(<AccountsTab />);
  await waitFor(() => expect(view.getByText("kenji@libredb.org")).toBeTruthy());
  return view;
}

function visibleEmails(view: ReturnType<typeof render>): string[] {
  const rows = within(view.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((row) => row.querySelector("span[title]")?.textContent ?? "");
}

async function chooseFilter(view: ReturnType<typeof render>, label: string) {
  fireEvent.keyDown(view.getByRole("combobox", { name: "Filter accounts" }), { key: "ArrowDown" });
  fireEvent.keyDown(await view.findByRole("option", { name: label }), { key: "Enter" });
}

async function openMenuItem(
  user: ReturnType<typeof userEvent.setup>,
  view: ReturnType<typeof render>,
  email: string,
  item: string,
) {
  await user.click(view.getByRole("button", { name: `Actions for ${email}` }));
  await user.click(await view.findByRole("menuitem", { name: item }));
}

beforeEach(() => {
  mockToastSuccess.mockClear();
  mockToastError.mockClear();
});

afterEach(() => {
  cleanup();
  restoreGlobalFetch();
});

describe("AccountsTab list", () => {
  test("renders every account from the API with its role, status, two-factor and date", async () => {
    serve();
    const view = await renderList();
    expect(visibleEmails(view)).toEqual([
      "admin@libredb.org",
      "maria@libredb.org",
      "kenji@libredb.org",
      "lena@libredb.org",
    ]);
    const adminRow = view.getByText("admin@libredb.org").closest("tr") as HTMLElement;
    // The signed-in admin is marked, whatever the case of the session's email.
    expect(within(adminRow).getByText("You")).toBeTruthy();
    expect(within(adminRow).getAllByText("Admin").length).toBeGreaterThan(0);
    expect(within(adminRow).getAllByText("On").length).toBeGreaterThan(0);
    const lenaRow = view.getByText("lena@libredb.org").closest("tr") as HTMLElement;
    expect(within(lenaRow).getAllByText("Disabled").length).toBeGreaterThan(0);
    expect(within(lenaRow).getByText("Off")).toBeTruthy();
    expect(lenaRow.textContent).not.toContain("Invalid Date");
    expect(view.getByText("4 accounts · 2 admins · 1 disabled")).toBeTruthy();
    await waitFor(() => expect(view.getByRole("heading", { name: "Your authenticator" })).toBeTruthy());
  });

  test("marks nobody when the session cannot be read", async () => {
    serve({ me: "reject" });
    const first = await renderList();
    expect(first.queryByText("You")).toBeNull();
    cleanup();

    serve({ me: { json: { authenticated: true } } });
    const second = await renderList();
    expect(second.queryByText("You")).toBeNull();
    cleanup();

    serve({ me: { status: 401, json: { authenticated: false } } });
    const third = await renderList();
    expect(third.queryByText("You")).toBeNull();
  });

  test("search narrows the rows by email, ignoring case", async () => {
    serve();
    const view = await renderList();
    fireEvent.change(view.getByRole("searchbox", { name: "Search accounts by email" }), {
      target: { value: "  KENJI " },
    });
    expect(visibleEmails(view)).toEqual(["kenji@libredb.org"]);
    expect(view.getByText("1 of 4 accounts")).toBeTruthy();

    fireEvent.change(view.getByRole("searchbox", { name: "Search accounts by email" }), {
      target: { value: "nobody" },
    });
    expect(view.queryByRole("table")).toBeNull();
    expect(view.getByText("No matching accounts")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Clear search and filter" }));
    expect(visibleEmails(view)).toHaveLength(4);
    expect((view.getByRole("searchbox", { name: "Search accounts by email" }) as HTMLInputElement).value).toBe("");
  });

  test.each([
    ["Admins", ["admin@libredb.org", "maria@libredb.org"]],
    ["Users", ["kenji@libredb.org", "lena@libredb.org"]],
    ["Disabled", ["lena@libredb.org"]],
    ["Two-factor on", ["admin@libredb.org", "kenji@libredb.org"]],
    ["Two-factor off", ["maria@libredb.org", "lena@libredb.org"]],
  ])("the %s filter narrows the rows", async (label, expected) => {
    serve();
    const view = await renderList();
    await chooseFilter(view, label);
    await waitFor(() => expect(visibleEmails(view)).toEqual(expected));
    expect(view.getByText(`${expected.length} of 4 accounts`)).toBeTruthy();

    await chooseFilter(view, "All accounts");
    await waitFor(() => expect(visibleEmails(view)).toHaveLength(4));
  });

  test("search and filter combine", async () => {
    serve();
    const view = await renderList();
    await chooseFilter(view, "Admins");
    await waitFor(() => expect(visibleEmails(view)).toHaveLength(2));
    fireEvent.change(view.getByRole("searchbox", { name: "Search accounts by email" }), {
      target: { value: "maria" },
    });
    expect(visibleEmails(view)).toEqual(["maria@libredb.org"]);
    fireEvent.change(view.getByRole("searchbox", { name: "Search accounts by email" }), {
      target: { value: "kenji" },
    });
    expect(view.getByText("No matching accounts")).toBeTruthy();
  });
});

describe("AccountsTab states", () => {
  test("shows a loading placeholder until the list returns", async () => {
    let release: (response: Response) => void = () => {};
    globalThis.fetch = ((input: RequestInfo | URL) => {
      if (String(input).includes("/api/admin/accounts")) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;
    const view = render(<AccountsTab />);
    expect(view.getByText("Loading accounts")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add account" })).toBeNull();
    release(new Response(JSON.stringify({ accounts: fixture() }), { status: 200 }));
    await waitFor(() => expect(view.getByText("kenji@libredb.org")).toBeTruthy());
    expect(view.queryByText("Loading accounts")).toBeNull();
  });

  test("an empty registry offers to add the first account", async () => {
    serve({ accounts: [] });
    const view = render(<AccountsTab />);
    await waitFor(() => expect(view.getByText("No accounts yet")).toBeTruthy());
    expect(view.queryByRole("table")).toBeNull();
    const buttons = view.getAllByRole("button", { name: "Add account" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(view.getByRole("dialog", { name: "Add account" })).toBeTruthy());
  });

  test("shows the server's reason when the registry is off, and no authenticator", async () => {
    serve({ list: { status: 409, json: { error: "Needs sqlite." } } });
    const view = render(<AccountsTab />);
    await waitFor(() => expect(view.getByTestId("accounts-unavailable").textContent).toBe("Needs sqlite."));
    expect(view.getByText("The account registry is off")).toBeTruthy();
    expect(view.queryByRole("heading", { name: "Your authenticator" })).toBeNull();
    cleanup();

    serve({ list: { status: 409, json: {} } });
    const bare = render(<AccountsTab />);
    await waitFor(() =>
      expect(bare.getByTestId("accounts-unavailable").textContent).toBe("Accounts are not available on this server."),
    );
  });

  test("shows an error when the list fails, and Try again reloads it", async () => {
    let failing = true;
    mockGlobalFetch({
      "/api/admin/accounts": () =>
        failing ? { status: 500, json: { error: "down" } } : { json: { accounts: fixture() } },
    });
    const view = render(<AccountsTab />);
    await waitFor(() => expect(view.getByTestId("accounts-error").textContent).toBe("down"));
    failing = false;
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(view.getByText("kenji@libredb.org")).toBeTruthy());
    cleanup();

    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const rejected = render(<AccountsTab />);
    await waitFor(() => expect(rejected.getByTestId("accounts-error").textContent).toBe("Could not load accounts"));
    cleanup();

    globalThis.fetch = (() => Promise.resolve(new Response("nope", { status: 200 }))) as unknown as typeof fetch;
    const garbage = render(<AccountsTab />);
    await waitFor(() => expect(garbage.getByTestId("accounts-error").textContent).toBe("Could not load accounts"));
    cleanup();

    mockGlobalFetch({ "/api/admin/accounts": { status: 500, json: {} } });
    const bare = render(<AccountsTab />);
    await waitFor(() => expect(bare.getByTestId("accounts-error").textContent).toBe("Could not load accounts"));
  });
});

const DANGEROUS: {
  action: string;
  email: string;
  item: string;
  confirm: string;
  says: string;
  expected: Omit<Call, "path"> & { path: string };
}[] = [
  {
    action: "make admin",
    email: "kenji@libredb.org",
    item: "Make admin",
    confirm: "Make admin",
    says: "MCP token",
    expected: { method: "PATCH", path: "/api/admin/accounts/kenji%40libredb.org", body: { role: "admin" } },
  },
  {
    action: "make user",
    email: "maria@libredb.org",
    item: "Make user",
    confirm: "Make user",
    says: "loses the admin dashboard",
    expected: { method: "PATCH", path: "/api/admin/accounts/maria%40libredb.org", body: { role: "user" } },
  },
  {
    action: "disable",
    email: "kenji@libredb.org",
    item: "Disable account",
    confirm: "Disable account",
    says: "cannot sign in until an admin enables",
    expected: { method: "PATCH", path: "/api/admin/accounts/kenji%40libredb.org", body: { disabled: true } },
  },
  {
    action: "clear two-factor",
    email: "kenji@libredb.org",
    item: "Clear two-factor",
    confirm: "Clear two-factor",
    says: "password alone",
    expected: { method: "PATCH", path: "/api/admin/accounts/kenji%40libredb.org", body: { clearTotp: true } },
  },
  {
    action: "delete",
    email: "lena@libredb.org",
    item: "Delete account",
    confirm: "Delete account",
    says: "cannot be undone",
    expected: { method: "DELETE", path: "/api/admin/accounts/lena%40libredb.org", body: null },
  },
];

describe("AccountsTab dangerous actions", () => {
  test.each(DANGEROUS)("$action asks for the email to be typed, and Cancel sends nothing", async (row) => {
    const calls = serve();
    const user = userEvent.setup();
    const view = await renderList();

    await openMenuItem(user, view, row.email, row.item);
    const dialog = await view.findByRole("alertdialog");
    expect(dialog.textContent).toContain(row.email);
    expect(dialog.textContent).toContain(row.says);
    const input = within(dialog).getByLabelText(`Type ${row.email} to confirm`);
    const confirm = within(dialog).getByRole("button", { name: row.confirm }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: row.email.replace("@", "#") } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: ` ${row.email.toUpperCase()} ` } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
    expect(calls).toEqual([]);
  });

  test.each(DANGEROUS)("$action sends the right request once the email is typed", async (row) => {
    const calls = serve();
    const user = userEvent.setup();
    const view = await renderList();

    await openMenuItem(user, view, row.email, row.item);
    const dialog = await view.findByRole("alertdialog");
    // Reopening starts from an empty field.
    expect((within(dialog).getByLabelText(`Type ${row.email} to confirm`) as HTMLInputElement).value).toBe("");
    fireEvent.change(within(dialog).getByLabelText(`Type ${row.email} to confirm`), { target: { value: row.email } });
    fireEvent.click(within(dialog).getByRole("button", { name: row.confirm }));
    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
    expect(calls).toEqual([row.expected]);
    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
  });

  test("demoting yourself says so, and a refusal stays in the dialog", async () => {
    const calls = serve({
      respond: () => ({ status: 409, json: { error: "The last enabled admin cannot be removed." } }),
    });
    const user = userEvent.setup();
    const view = await renderList();
    await waitFor(() => expect(view.getByText("You")).toBeTruthy());

    await openMenuItem(user, view, "admin@libredb.org", "Make user");
    const dialog = await view.findByRole("alertdialog");
    expect(dialog.textContent).toContain("You (admin@libredb.org) lose the admin dashboard");
    fireEvent.change(within(dialog).getByLabelText("Type admin@libredb.org to confirm"), {
      target: { value: "admin@libredb.org" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Make user" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe("The last enabled admin cannot be removed."),
    );
    expect(view.getByRole("alertdialog")).toBe(dialog);
    expect(calls).toHaveLength(1);
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test.each([
    ["an error body without a message", { status: 500, json: {} }, "Could not delete the account"],
    ["a body that is not JSON", { status: 502, text: "Bad gateway" }, "Could not delete the account"],
  ])("a refusal with %s falls back to a plain message", async (_label, answer, message) => {
    serve({ respond: () => answer as MockFetchResponse });
    const user = userEvent.setup();
    const view = await renderList();
    await openMenuItem(user, view, "lena@libredb.org", "Delete account");
    const dialog = await view.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Type lena@libredb.org to confirm"), {
      target: { value: "lena@libredb.org" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete account" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe(message));
  });

  test("a request that never reaches the server is reported in the dialog", async () => {
    serve();
    const user = userEvent.setup();
    const view = await renderList();
    await openMenuItem(user, view, "kenji@libredb.org", "Disable account");
    const dialog = await view.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Type kenji@libredb.org to confirm"), {
      target: { value: "kenji@libredb.org" },
    });
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable account" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe("Could not update the account"));
  });
});

describe("AccountsTab actions that need no typed email", () => {
  test("Enable sends at once, with no dialog", async () => {
    const calls = serve();
    const user = userEvent.setup();
    const view = await renderList();
    await openMenuItem(user, view, "lena@libredb.org", "Enable account");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(view.queryByRole("alertdialog")).toBeNull();
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: "/api/admin/accounts/lena%40libredb.org",
      body: { disabled: false },
    });
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("lena@libredb.org is enabled"));
  });

  test("a refused Enable is reported as a toast", async () => {
    serve({ respond: () => ({ status: 409, json: { error: "Nope." } }) });
    const user = userEvent.setup();
    const view = await renderList();
    await openMenuItem(user, view, "lena@libredb.org", "Enable account");
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Nope."));
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test("Set password sends { password } and needs at least 8 characters", async () => {
    const calls = serve();
    const user = userEvent.setup();
    const view = await renderList();
    await openMenuItem(user, view, "kenji@libredb.org", "Set password");
    const dialog = await view.findByRole("dialog", { name: "Set a new password" });
    expect(dialog.textContent).toContain("kenji@libredb.org");
    const submit = within(dialog).getByRole("button", { name: "Set password" }) as HTMLButtonElement;
    const field = within(dialog).getByLabelText("New password");
    fireEvent.change(field, { target: { value: "short" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "long-enough" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Set a new password" })).toBeNull());
    expect(calls).toEqual([
      { method: "PATCH", path: "/api/admin/accounts/kenji%40libredb.org", body: { password: "long-enough" } },
    ]);
    expect(mockToastSuccess).toHaveBeenCalledWith("New password set for kenji@libredb.org");
  });

  test.each([
    [
      "the server's message",
      { status: 400, json: { error: "Password must be at least 8 characters." } },
      "Password must be at least 8 characters.",
    ],
    ["a plain message when the body says nothing", { status: 500, json: {} }, "Could not set the password"],
  ])("a refused password shows %s in the dialog", async (_label, answer, message) => {
    serve({ respond: () => answer });
    const user = userEvent.setup();
    const view = await renderList();
    await openMenuItem(user, view, "kenji@libredb.org", "Set password");
    const dialog = await view.findByRole("dialog", { name: "Set a new password" });
    fireEvent.change(within(dialog).getByLabelText("New password"), { target: { value: "long-enough" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe(message));
  });

  test("Set password reports a request that never arrives, and Cancel closes it", async () => {
    serve();
    const user = userEvent.setup();
    const view = await renderList();
    await openMenuItem(user, view, "kenji@libredb.org", "Set password");
    const dialog = await view.findByRole("dialog", { name: "Set a new password" });
    fireEvent.change(within(dialog).getByLabelText("New password"), { target: { value: "long-enough" } });
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    fireEvent.click(within(dialog).getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe("Could not set the password"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Set a new password" })).toBeNull());
  });
});

describe("AccountsTab add account", () => {
  async function openAdd(view: ReturnType<typeof render>) {
    fireEvent.click(view.getByRole("button", { name: "Add account" }));
    return view.findByRole("dialog", { name: "Add account" });
  }

  test("sends { email, password, role } and shows a 409 inside the dialog", async () => {
    let refuse = true;
    const calls = serve({
      respond: (call) =>
        call.method === "POST" && refuse
          ? { status: 409, json: { error: "An account with that email already exists." } }
          : undefined,
    });
    const view = await renderList();
    const dialog = await openAdd(view);
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "long-enough" } });
    fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "Role" }), { key: "ArrowDown" });
    fireEvent.keyDown(await view.findByRole("option", { name: "Admin" }), { key: "Enter" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe("An account with that email already exists."),
    );
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/admin/accounts",
        body: { email: "new@example.com", password: "long-enough", role: "admin" },
      },
    ]);

    refuse = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Add account" })).toBeNull());
    expect(mockToastSuccess).toHaveBeenCalledWith("Account created for new@example.com");

    // Opening it again starts from an empty form with the default role.
    const again = await openAdd(view);
    expect((within(again).getByLabelText("Email") as HTMLInputElement).value).toBe("");
    fireEvent.change(within(again).getByLabelText("Email"), { target: { value: "second@example.com" } });
    fireEvent.change(within(again).getByLabelText("Password"), { target: { value: "long-enough" } });
    fireEvent.keyDown(within(again).getByRole("combobox", { name: "Role" }), { key: "ArrowDown" });
    fireEvent.keyDown(await view.findByRole("option", { name: "User" }), { key: "Enter" });
    fireEvent.click(within(again).getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2].body).toEqual({ email: "second@example.com", password: "long-enough", role: "user" });
  });

  test("a refusal without a message, or no answer at all, still says what failed", async () => {
    serve({ respond: () => ({ status: 500, text: "oops" }) });
    const view = await renderList();
    const dialog = await openAdd(view);
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "long-enough" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe("Could not create the account"));

    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "other@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe("Could not create the account"));
  });

  test("Cancel closes the form without sending anything", async () => {
    const calls = serve();
    const view = await renderList();
    const dialog = await openAdd(view);
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Add account" })).toBeNull());
    expect(calls).toEqual([]);
  });
});

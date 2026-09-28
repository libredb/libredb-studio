import "../../setup-dom";
import { mockToastSuccess } from "../../helpers/mock-sonner";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../../helpers/mock-fetch";
import type { PasskeyStatus, PublicPasskey } from "@/lib/passkey/api-types";
import type { PasskeySetup } from "@/lib/passkey/client";
import { PASSKEY_CEREMONY_TTL_SECONDS } from "@/lib/passkey/policy";

// The real page texts stay; only the functions that touch WebAuthn or the network are replaced.
const real = { ...(await import("@/lib/passkey/client")) };
const SETUP: PasskeySetup = {
  options: {} as PasskeySetup["options"],
  // Fresh at load, so a retry within one test run is inside the ceremony lifetime.
  startedAt: Date.now(),
};
const usableHere = mock<typeof real.passkeysUsableHere>(() => true);
const pageBlocker = mock<typeof real.passkeyPageBlocker>(() => null);
const beginCreation = mock<typeof real.beginPasskeyCreation>(async () => ({ ok: true, setup: SETUP }));
const finishCreation = mock<typeof real.finishPasskeyCreation>(async () => ({ ok: true, passkey: LAPTOP }));
mock.module("@/lib/passkey/client", () => ({
  ...real,
  passkeysUsableHere: usableHere,
  passkeyPageBlocker: pageBlocker,
  beginPasskeyCreation: beginCreation,
  finishPasskeyCreation: finishCreation,
}));
const { PasskeySettings } = await import("@/components/auth/PasskeySettings");

const ORIGIN = "http://localhost:3000";
const OFF =
  "Passkeys are off on this server. An administrator turns them on by setting PASSKEY_ORIGIN to the address people open Studio at, such as https://studio.example.com.";
const OIDC = "Passkeys for this sign-in are managed by your identity provider.";
const LOCAL_STORAGE =
  "Passkeys need STORAGE_PROVIDER=sqlite or postgres: with STORAGE_PROVIDER=local there is no account registry to keep them in.";
const RETRY_TEXT = "An error occurred. Please try again.";
const PASSWORD_LINE = "Adding or removing a passkey asks for your password. Forgot it? An admin can set a new one.";

const LAPTOP: PublicPasskey = {
  id: "pk-1",
  name: "Laptop",
  createdAt: "2026-09-01T10:00:00.000Z",
  lastUsedAt: "2026-09-20T10:00:00.000Z",
  backupEligible: true,
  backupState: true,
  usable: true,
};
const YUBIKEY: PublicPasskey = {
  id: "pk-2",
  name: "YubiKey",
  createdAt: "2026-09-02T10:00:00.000Z",
  lastUsedAt: null,
  backupEligible: false,
  backupState: false,
  usable: false,
};
const PHONE: PublicPasskey = {
  ...LAPTOP,
  id: "pk-3",
  name: "Phone",
  createdAt: "2026-09-03T10:00:00.000Z",
  lastUsedAt: "2026-09-21T10:00:00.000Z",
  backupState: false,
};

function ready(overrides: Partial<Extract<PasskeyStatus, { canAdd: true }>> = {}): PasskeyStatus {
  return {
    available: true,
    canAdd: true,
    origin: ORIGIN,
    rpId: "localhost",
    totpEnabled: false,
    passkeys: [],
    ...overrides,
  };
}

type Posted = Record<string, unknown>;

/** Serves the status on GET and records every POST body; `answer` decides each POST's response. */
function serve(status: () => PasskeyStatus, answer: (body: Posted) => MockFetchResponse = () => ({ json: {} })) {
  const posted: Posted[] = [];
  let gets = 0;
  mockGlobalFetch({
    "/api/auth/passkey": async (req) => {
      if (req.method === "GET") {
        gets += 1;
        return { json: status() };
      }
      const body = (await req.json()) as Posted;
      posted.push(body);
      return answer(body);
    },
  });
  return { posted, gets: () => gets };
}

async function openAdd(view: ReturnType<typeof render>) {
  await waitFor(() => expect(view.getByRole("button", { name: "Add passkey" })).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "Add passkey" }));
  return within(await waitFor(() => view.getByRole("dialog")));
}

async function openRemove(view: ReturnType<typeof render>, name: string) {
  await waitFor(() => expect(view.getByRole("button", { name: `Remove ${name}` })).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: `Remove ${name}` }));
  return within(await waitFor(() => view.getByRole("alertdialog")));
}

describe("PasskeySettings", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    usableHere.mockReset();
    usableHere.mockImplementation(() => true);
    pageBlocker.mockReset();
    pageBlocker.mockImplementation(() => null);
    beginCreation.mockReset();
    beginCreation.mockImplementation(async () => ({ ok: true, setup: SETUP }));
    finishCreation.mockReset();
    finishCreation.mockImplementation(async () => ({ ok: true, passkey: LAPTOP }));
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("shows a placeholder while loading, and says so when the status cannot be read", async () => {
    let release: (response: Response) => void = () => {};
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch;
    const loading = render(<PasskeySettings reloadSignal={0} />);
    expect(loading.getByText("Loading passkeys")).toBeTruthy();
    release(new Response(JSON.stringify(ready()), { status: 200 }));
    await waitFor(() => expect(loading.queryByText("Loading passkeys")).toBeNull());
    cleanup();

    mockGlobalFetch({
      "/api/auth/passkey": { status: 404, json: { error: "This session has no account in the registry." } },
    });
    const refused = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() =>
      expect(refused.getByTestId("passkeys-error").textContent).toBe("This session has no account in the registry."),
    );
    cleanup();

    mockGlobalFetch({ "/api/auth/passkey": { status: 500, json: {} } });
    const bare = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() =>
      expect(bare.getByTestId("passkeys-error").textContent).toBe("Could not read the passkey status"),
    );
    cleanup();

    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const offline = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() =>
      expect(offline.getByTestId("passkeys-error").textContent).toBe("Could not read the passkey status"),
    );
  });

  test("shows the server's reason when passkeys are unavailable", async () => {
    serve(() => ({ available: false, mode: "local-storage", reason: LOCAL_STORAGE }));
    const view = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(view.getByText(LOCAL_STORAGE)).toBeTruthy());
    expect(view.queryByRole("button", { name: "Add passkey" })).toBeNull();
  });

  test("a page at an IP address or on plain http names that blocker before any server reason", async () => {
    pageBlocker.mockImplementation(() => "ip-address");
    serve(() => ({ available: true, canAdd: false, reason: OFF, totpEnabled: false, passkeys: [LAPTOP] }));
    const desktop = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(desktop.getByText(real.PAGE_IP_ADDRESS)).toBeTruthy());
    expect(desktop.queryByText(OFF)).toBeNull();
    expect(desktop.queryByText("Laptop")).toBeNull();
    cleanup();

    serve(() => ({ available: false, mode: "local-storage", reason: LOCAL_STORAGE }));
    const local = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(local.getByText(real.PAGE_IP_ADDRESS)).toBeTruthy());
    expect(local.queryByText(LOCAL_STORAGE)).toBeNull();
    cleanup();

    pageBlocker.mockImplementation(() => "plain-http");
    serve(() => ready());
    const lan = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(lan.getByText(real.PAGE_PLAIN_HTTP)).toBeTruthy());
    expect(lan.queryByRole("button", { name: "Add passkey" })).toBeNull();
    cleanup();

    pageBlocker.mockImplementation(() => "ip-address");
    serve(() => ({ available: false, mode: "oidc", reason: OIDC }));
    const oidc = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(oidc.getByText(OIDC)).toBeTruthy());
    expect(oidc.queryByText(real.PAGE_IP_ADDRESS)).toBeNull();
  });

  test("lists passkeys with name, dates, sync state and usability", async () => {
    serve(() => ready({ passkeys: [LAPTOP, YUBIKEY, PHONE] }));
    const view = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(view.getByText("Laptop")).toBeTruthy());
    expect(view.getByText("YubiKey")).toBeTruthy();
    expect(view.getByText(`Added ${new Date(LAPTOP.createdAt).toLocaleDateString()}`)).toBeTruthy();
    expect(view.getByText(`Last used ${new Date(LAPTOP.lastUsedAt as string).toLocaleDateString()}`)).toBeTruthy();
    expect(view.getByText("Never used")).toBeTruthy();
    expect(view.getByText("Synced")).toBeTruthy();
    expect(view.getByText("This device only")).toBeTruthy();
    expect(view.getByText("Not synced yet")).toBeTruthy();
    expect(view.getAllByText("Not usable on this server")).toHaveLength(1);
  });

  test("no usability badge while passkeys are off", async () => {
    serve(() => ({
      available: true,
      canAdd: false,
      reason: OFF,
      totpEnabled: false,
      passkeys: [{ ...YUBIKEY, usable: null }],
    }));
    const view = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(view.getByText("YubiKey")).toBeTruthy());
    expect(view.queryByText("Not usable on this server")).toBeNull();
  });

  test("an empty list invites adding one", async () => {
    serve(() => ready());
    const view = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() =>
      expect(view.getByText("No passkeys yet. Add one on each device you sign in from.")).toBeTruthy(),
    );
  });

  test("adding is replaced by the reason when the server cannot add", async () => {
    serve(() => ({ available: true, canAdd: false, reason: OFF, totpEnabled: false, passkeys: [LAPTOP] }));
    const view = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(view.getByText(OFF)).toBeTruthy());
    expect(view.getByText("Laptop")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add passkey" })).toBeNull();
  });

  test("a page on another address says where passkeys work", async () => {
    usableHere.mockImplementation(() => false);
    serve(() => ready({ origin: "https://studio.example.com" }));
    const view = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() =>
      expect(
        view.getByText(
          `This page is open at ${ORIGIN}, but passkeys on this server work at https://studio.example.com. Open Studio there to add or use a passkey.`,
        ),
      ).toBeTruthy(),
    );
    expect(usableHere).toHaveBeenCalledWith("https://studio.example.com");
    expect(view.queryByRole("button", { name: "Add passkey" })).toBeNull();
  });

  test("a browser without WebAuthn is told why", async () => {
    // On the configured origin, passkeysUsableHere is false only for a browser without WebAuthn.
    usableHere.mockImplementation(() => false);
    serve(() => ready());
    const view = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() =>
      expect(
        view.getByText("This browser cannot use passkeys. Try another browser, or sign in with your password."),
      ).toBeTruthy(),
    );
    expect(view.queryByRole("button", { name: "Add passkey" })).toBeNull();
  });

  test("the add dialog asks for a code when TOTP is on, and adds the passkey", async () => {
    serve(() => ready());
    const plain = render(<PasskeySettings reloadSignal={0} />);
    const plainDialog = await openAdd(plain);
    expect(plainDialog.getByLabelText("Name")).toBeTruthy();
    expect(plainDialog.getByLabelText("Current password")).toBeTruthy();
    expect(plainDialog.queryByLabelText("Current code")).toBeNull();
    expect(plainDialog.getByText(PASSWORD_LINE)).toBeTruthy();
    fireEvent.click(plainDialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(plain.queryByRole("dialog")).toBeNull());
    cleanup();

    const server = serve(() => ready({ totpEnabled: true }));
    beginCreation.mockImplementationOnce(async () => ({
      ok: false,
      message: "The current password is not correct.",
      codeRequired: false,
    }));
    const view = render(<PasskeySettings reloadSignal={0} />);
    const dialog = await openAdd(view);
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Laptop" } });
    fireEvent.change(dialog.getByLabelText("Current password"), { target: { value: "wrong" } });
    fireEvent.change(dialog.getByLabelText("Current code"), { target: { value: "123456" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create passkey" }));
    await waitFor(() => expect(dialog.getByRole("alert").textContent).toBe("The current password is not correct."));
    expect(finishCreation).not.toHaveBeenCalled();

    fireEvent.change(dialog.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.change(dialog.getByLabelText("Current code"), { target: { value: "654321" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create passkey" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Passkey added"));
    expect(beginCreation).toHaveBeenLastCalledWith({ password: "right", code: "654321" });
    expect(finishCreation).toHaveBeenCalledWith(SETUP, "Laptop");
    await waitFor(() => expect(server.gets()).toBe(2));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  test("an unnamed passkey takes the server's default name", async () => {
    serve(() => ready());
    const view = render(<PasskeySettings reloadSignal={0} />);
    const dialog = await openAdd(view);
    fireEvent.change(dialog.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create passkey" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Passkey added"));
    expect(beginCreation).toHaveBeenCalledWith({ password: "right" });
    expect(finishCreation).toHaveBeenCalledWith(SETUP, undefined);
  });

  test("the dialog reveals the code field when the server asks for one", async () => {
    serve(() => ready({ totpEnabled: false }));
    beginCreation.mockImplementationOnce(async () => ({
      ok: false,
      message: "Enter a current code from your authenticator app.",
      codeRequired: true,
    }));
    const view = render(<PasskeySettings reloadSignal={0} />);
    const dialog = await openAdd(view);
    expect(dialog.queryByLabelText("Current code")).toBeNull();
    fireEvent.change(dialog.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create passkey" }));
    await waitFor(() =>
      expect(dialog.getByRole("alert").textContent).toBe("Enter a current code from your authenticator app."),
    );
    expect(beginCreation).toHaveBeenCalledWith({ password: "right" });
    expect((dialog.getByLabelText("Current password") as HTMLInputElement).value).toBe("right");
    fireEvent.change(dialog.getByLabelText("Current code"), { target: { value: "123456" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create passkey" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Passkey added"));
    expect(beginCreation).toHaveBeenLastCalledWith({ password: "right", code: "123456" });
  });

  test("a retry after cancelling spends no login budget", async () => {
    serve(() => ready({ totpEnabled: true }));
    finishCreation.mockImplementationOnce(async () => ({
      ok: false,
      message: "No passkey was created. The request was cancelled or timed out.",
      retry: true,
    }));
    const view = render(<PasskeySettings reloadSignal={0} />);
    const dialog = await openAdd(view);
    fireEvent.change(dialog.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.change(dialog.getByLabelText("Current code"), { target: { value: "123456" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create passkey" }));
    await waitFor(() =>
      expect(dialog.getByRole("alert").textContent).toBe(
        "No passkey was created. The request was cancelled or timed out.",
      ),
    );
    fireEvent.click(dialog.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Passkey added"));
    expect(finishCreation).toHaveBeenCalledTimes(2);
    expect(finishCreation.mock.calls[1]?.[0]).toBe(SETUP);
    expect(beginCreation).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

    finishCreation.mockImplementationOnce(async () => ({
      ok: false,
      message: "The passkey setup expired or belongs to another sign-in. Start again.",
      retry: false,
    }));
    const again = await openAdd(view);
    fireEvent.change(again.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.change(again.getByLabelText("Current code"), { target: { value: "222222" } });
    fireEvent.click(again.getByRole("button", { name: "Create passkey" }));
    await waitFor(() =>
      expect(again.getByRole("alert").textContent).toBe(
        "The passkey setup expired or belongs to another sign-in. Start again.",
      ),
    );
    expect(again.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(again.getByRole("button", { name: "Create passkey" })).toBeTruthy();
    expect((again.getByLabelText("Current code") as HTMLInputElement).value).toBe("");
  });

  test("a retry leaves the freshness check to finishPasskeyCreation and acts on its answer", async () => {
    serve(() => ready({ totpEnabled: true }));
    finishCreation.mockImplementationOnce(async () => ({ ok: false, message: null, retry: true }));
    finishCreation.mockImplementationOnce(async () => ({
      ok: false,
      message: "The passkey setup expired or belongs to another sign-in. Start again.",
      retry: false,
    }));
    const view = render(<PasskeySettings reloadSignal={0} />);
    const dialog = await openAdd(view);
    fireEvent.change(dialog.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.change(dialog.getByLabelText("Current code"), { target: { value: "123456" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create passkey" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "Try again" })).toBeTruthy());
    const now = spyOn(Date, "now").mockReturnValue(SETUP.startedAt + PASSKEY_CEREMONY_TTL_SECONDS * 1000);
    try {
      fireEvent.click(dialog.getByRole("button", { name: "Try again" }));
      await waitFor(() =>
        expect(dialog.getByRole("alert").textContent).toBe(
          "The passkey setup expired or belongs to another sign-in. Start again.",
        ),
      );
    } finally {
      now.mockRestore();
    }
    expect(finishCreation).toHaveBeenCalledTimes(2);
    expect(finishCreation.mock.calls[1]?.[0]).toBe(SETUP);
    expect(dialog.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(dialog.getByRole("button", { name: "Create passkey" })).toBeTruthy();
    expect((dialog.getByLabelText("Current code") as HTMLInputElement).value).toBe("");
  });

  test("a cancelled retry can be left with Cancel", async () => {
    serve(() => ready());
    finishCreation.mockImplementationOnce(async () => ({ ok: false, message: null, retry: true }));
    const view = render(<PasskeySettings reloadSignal={0} />);
    const dialog = await openAdd(view);
    fireEvent.change(dialog.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create passkey" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "Try again" })).toBeTruthy());
    // An abort the page asked for carries no message.
    expect(dialog.queryByRole("alert")).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  test("rename sends the new name and reloads", async () => {
    let refuse = true;
    const server = serve(
      () => ready({ passkeys: [LAPTOP] }),
      () => (refuse ? { status: 400, json: { error: "Name a passkey with 1 to 64 characters." } } : { json: {} }),
    );
    const view = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(view.getByRole("button", { name: "Rename Laptop" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Rename Laptop" }));
    const dialog = within(await waitFor(() => view.getByRole("dialog")));
    expect((dialog.getByLabelText("Name") as HTMLInputElement).value).toBe("Laptop");
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: " " } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(dialog.getByRole("alert").textContent).toBe("Name a passkey with 1 to 64 characters."));

    refuse = false;
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Work laptop" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Passkey renamed"));
    expect(server.posted[1]).toEqual({ action: "rename", id: "pk-1", name: "Work laptop" });
    await waitFor(() => expect(server.gets()).toBe(2));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

    fireEvent.click(view.getByRole("button", { name: "Rename Laptop" }));
    const cancelled = within(await waitFor(() => view.getByRole("dialog")));
    fireEvent.click(cancelled.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  test("the remove dialog names MCP tokens and the password rule, warns when it is the last passkey, and reloads", async () => {
    const server = serve(() => ready({ totpEnabled: true, passkeys: [LAPTOP] }));
    const view = render(<PasskeySettings reloadSignal={0} />);
    const dialog = await openRemove(view, "Laptop");
    expect(dialog.getByText("Remove Laptop?")).toBeTruthy();
    const text = view.getByRole("alertdialog").textContent ?? "";
    expect(text).toMatch(/every other session of your account signs out/i);
    expect(text).toContain("MCP tokens you created stop working");
    expect(text).toContain(PASSWORD_LINE);
    expect(text).toContain("After this you sign in with your password and authenticator code.");
    fireEvent.change(dialog.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.change(dialog.getByLabelText("Current code"), { target: { value: "123456" } });
    fireEvent.click(dialog.getByRole("button", { name: "Remove passkey" }));
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith("Passkey removed", {
        description: expect.stringMatching(/password manager or security key.*MCP tokens you created stop working/),
      }),
    );
    expect(server.posted[0]).toEqual({ action: "remove", id: "pk-1", password: "right", code: "123456" });
    await waitFor(() => expect(server.gets()).toBe(2));
    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
    cleanup();

    serve(() => ready({ passkeys: [LAPTOP] }));
    const last = render(<PasskeySettings reloadSignal={0} />);
    await openRemove(last, "Laptop");
    const lastText = last.getByRole("alertdialog").textContent ?? "";
    expect(lastText).toContain("After this you sign in with your password.");
    expect(lastText).not.toContain("authenticator code");
  });

  test("a remove without a code on a TOTP account reveals the code field", async () => {
    let asked = false;
    const server = serve(
      () => ready({ passkeys: [LAPTOP, YUBIKEY] }),
      (body) => {
        if (body.code === undefined) {
          asked = true;
          return {
            status: 400,
            json: { error: "Enter a current code from your authenticator app.", codeRequired: true },
          };
        }
        return { json: { ok: true } };
      },
    );
    const view = render(<PasskeySettings reloadSignal={0} />);
    const dialog = await openRemove(view, "YubiKey");
    expect(view.getByRole("alertdialog").textContent).not.toContain("After this you sign in");
    expect(dialog.queryByLabelText("Current code")).toBeNull();
    fireEvent.change(dialog.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.click(dialog.getByRole("button", { name: "Remove passkey" }));
    await waitFor(() =>
      expect(dialog.getByRole("alert").textContent).toBe("Enter a current code from your authenticator app."),
    );
    expect(asked).toBe(true);
    expect(server.posted[0]).toEqual({ action: "remove", id: "pk-2", password: "right" });
    fireEvent.change(dialog.getByLabelText("Current code"), { target: { value: "123456" } });
    fireEvent.click(dialog.getByRole("button", { name: "Remove passkey" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledTimes(1));
    expect(server.posted[1]).toEqual({ action: "remove", id: "pk-2", password: "right", code: "123456" });
  });

  test("a refused remove without a message still says what failed, and Cancel closes it", async () => {
    serve(
      () => ready({ passkeys: [LAPTOP] }),
      () => ({ status: 401, json: {} }),
    );
    const view = render(<PasskeySettings reloadSignal={0} />);
    const dialog = await openRemove(view, "Laptop");
    fireEvent.click(dialog.getByRole("button", { name: "Remove passkey" }));
    await waitFor(() => expect(dialog.getByRole("alert").textContent).toBe(RETRY_TEXT));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  });

  test("a refused rename without a message still says what failed", async () => {
    serve(
      () => ready({ passkeys: [LAPTOP] }),
      () => ({ status: 500, json: {} }),
    );
    const view = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(view.getByRole("button", { name: "Rename Laptop" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Rename Laptop" }));
    const dialog = within(await waitFor(() => view.getByRole("dialog")));
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(dialog.getByRole("alert").textContent).toBe(RETRY_TEXT));
  });

  // Renders the list, then fails a rename and a remove the way `fail` arranges the network.
  async function renameAndRemoveFail(fail: () => void) {
    fail();
    const view = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(view.getByRole("button", { name: "Rename Laptop" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Rename Laptop" }));
    const rename = within(await waitFor(() => view.getByRole("dialog")));
    fireEvent.click(rename.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(rename.getByRole("alert").textContent).toBe(RETRY_TEXT));
    expect((rename.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(rename.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

    const remove = await openRemove(view, "Laptop");
    fireEvent.change(remove.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.click(remove.getByRole("button", { name: "Remove passkey" }));
    await waitFor(() => expect(remove.getByRole("alert").textContent).toBe(RETRY_TEXT));
    expect((remove.getByRole("button", { name: "Remove passkey" }) as HTMLButtonElement).disabled).toBe(false);
    expect(mockToastSuccess).not.toHaveBeenCalled();
    cleanup();
    restoreGlobalFetch();
  }

  test("a rename or remove answered with a body that is not JSON leaves the busy state and says so", async () => {
    await renameAndRemoveFail(() =>
      serve(
        () => ready({ passkeys: [LAPTOP] }),
        () => ({ status: 502, text: "<html>Bad Gateway</html>" }),
      ),
    );
  });

  test("a rename or remove that fails in transit leaves the busy state and says so", async () => {
    await renameAndRemoveFail(() => {
      serve(() => ready({ passkeys: [LAPTOP] }));
      const served = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") throw new TypeError("Failed to fetch");
        return served(input, init);
      }) as unknown as typeof fetch;
    });
  });

  test("with TOTP on and passkeys registered, the section says that passkeys skip the code", async () => {
    const NOTICE = "Your passkeys sign you in without the authenticator code. Remove any you do not recognise.";
    serve(() => ready({ totpEnabled: true, passkeys: [LAPTOP] }));
    const on = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(on.getByText(NOTICE)).toBeTruthy());
    cleanup();

    serve(() => ready({ totpEnabled: true }));
    const empty = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() =>
      expect(empty.getByText("No passkeys yet. Add one on each device you sign in from.")).toBeTruthy(),
    );
    expect(empty.queryByText(NOTICE)).toBeNull();
    cleanup();

    serve(() => ready({ totpEnabled: false, passkeys: [LAPTOP] }));
    const off = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(off.getByText("Laptop")).toBeTruthy());
    expect(off.queryByText(NOTICE)).toBeNull();
  });

  test("the section reloads its status when reloadSignal changes", async () => {
    const server = serve(() => ready());
    const view = render(<PasskeySettings reloadSignal={0} />);
    await waitFor(() => expect(server.gets()).toBe(1));
    await waitFor(() => expect(view.getByRole("button", { name: "Add passkey" })).toBeTruthy());
    view.rerender(<PasskeySettings reloadSignal={1} />);
    await waitFor(() => expect(server.gets()).toBe(2));
  });
});

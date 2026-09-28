import "../../setup-dom";
import { mockToastError, mockToastSuccess } from "../../helpers/mock-sonner";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { AuthenticatorSettings } from "@/components/auth/AuthenticatorSettings";

type Posted = { action?: string; password?: string; code?: string };

describe("AuthenticatorSettings", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("says why setup is not offered when the server has no registry", async () => {
    mockGlobalFetch({ "/api/auth/totp": { json: { available: false, reason: "Needs a server store." } } });
    const view = render(<AuthenticatorSettings />);
    await waitFor(() =>
      expect(view.getByTestId("authenticator-unavailable").textContent).toBe("Needs a server store."),
    );
    expect(view.queryByRole("button", { name: "Set up authenticator" })).toBeNull();
  });

  test("says so when the status cannot be read", async () => {
    mockGlobalFetch({ "/api/auth/totp": { status: 500, json: { error: "down" } } });
    const view = render(<AuthenticatorSettings />);
    await waitFor(() => expect(view.getByTestId("authenticator-error").textContent).toBe("down"));
    cleanup();

    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const offline = render(<AuthenticatorSettings />);
    await waitFor(() =>
      expect(offline.getByTestId("authenticator-error").textContent).toBe("Could not read the authenticator status"),
    );
  });

  test("setup sends the current password, then confirms a code", async () => {
    let enabled = false;
    let failBegin = true;
    let failConfirm = true;
    const posted: Posted[] = [];
    mockGlobalFetch({
      "/api/auth/totp": async (req) => {
        if (req.method === "GET") return { json: { available: true, enabled } };
        const body = (await req.json()) as Posted;
        posted.push(body);
        if (body.action === "begin") {
          if (failBegin) return { status: 401, json: { error: "The current password is not correct." } };
          return { json: { secret: "SECRETVALUE", otpauthUrl: "otpauth://totp/LibreDB" } };
        }
        if (failConfirm) return { status: 400, json: { error: "Invalid authentication code" } };
        enabled = true;
        return { json: { ok: true } };
      },
    });

    const view = render(<AuthenticatorSettings />);
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
    fireEvent.change(view.getByLabelText("Current password"), { target: { value: "wrong" } });
    fireEvent.click(view.getByRole("button", { name: "Set up authenticator" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("The current password is not correct."));
    expect(view.queryByTestId("totp-secret")).toBeNull();

    failBegin = false;
    fireEvent.change(view.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.click(view.getByRole("button", { name: "Set up authenticator" }));
    await waitFor(() => expect(view.getByTestId("totp-secret").textContent).toBe("SECRETVALUE"));
    expect(view.getByText("otpauth://totp/LibreDB")).toBeTruthy();
    expect(posted[1]).toEqual({ action: "begin", password: "right" });

    fireEvent.change(view.getByLabelText("Authentication code"), { target: { value: "000000" } });
    fireEvent.click(view.getByRole("button", { name: "Confirm code" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("Invalid authentication code"));
    expect(view.getByTestId("totp-secret")).toBeTruthy();

    failConfirm = false;
    fireEvent.change(view.getByLabelText("Authentication code"), { target: { value: "123456" } });
    fireEvent.click(view.getByRole("button", { name: "Confirm code" }));
    await waitFor(() => expect(view.getByText("On")).toBeTruthy());
    expect(view.queryByTestId("totp-secret")).toBeNull();
    expect(posted[posted.length - 1]).toEqual({ action: "confirm", code: "123456" });
  });

  test("turning off sends the password and a current code", async () => {
    let enabled = true;
    let failDisable = true;
    const posted: Posted[] = [];
    mockGlobalFetch({
      "/api/auth/totp": async (req) => {
        if (req.method === "GET") return { json: { available: true, enabled } };
        const body = (await req.json()) as Posted;
        posted.push(body);
        if (failDisable) return { status: 401, json: { error: "Invalid authentication code" } };
        enabled = false;
        return { json: { ok: true } };
      },
    });

    const view = render(<AuthenticatorSettings />);
    await waitFor(() => expect(view.getByText("On")).toBeTruthy());
    expect(view.queryByRole("button", { name: "Set up authenticator" })).toBeNull();
    fireEvent.change(view.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.change(view.getByLabelText("Current code"), { target: { value: "111111" } });
    fireEvent.click(view.getByRole("button", { name: "Turn off authenticator" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("Invalid authentication code"));

    failDisable = false;
    fireEvent.click(view.getByRole("button", { name: "Turn off authenticator" }));
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
    expect(posted[posted.length - 1]).toEqual({ action: "disable", password: "right", code: "111111" });
    expect(mockToastSuccess).toHaveBeenCalledWith("Authenticator is off");
  });

  test("shows a placeholder while the status loads", async () => {
    let release: (response: Response) => void = () => {};
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch;
    const view = render(<AuthenticatorSettings />);
    expect(view.getByText("Loading authenticator status")).toBeTruthy();
    expect(view.queryByLabelText("Current password")).toBeNull();
    release(new Response(JSON.stringify({ available: true, enabled: false }), { status: 200 }));
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
    expect(view.queryByText("Loading authenticator status")).toBeNull();
  });

  test("a failed status read without a message still says what failed", async () => {
    mockGlobalFetch({ "/api/auth/totp": { status: 500, json: {} } });
    const view = render(<AuthenticatorSettings />);
    await waitFor(() =>
      expect(view.getByTestId("authenticator-error").textContent).toBe("Could not read the authenticator status"),
    );
  });

  test("setup shows the key and link, copies the key, and Cancel goes back", async () => {
    mockGlobalFetch({
      "/api/auth/totp": (req) =>
        req.method === "GET"
          ? { json: { available: true, enabled: false } }
          : { json: { secret: "SECRETVALUE", otpauthUrl: "otpauth://totp/LibreDB:me" } },
    });
    const writeText = mock<(value: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const view = render(<AuthenticatorSettings />);
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
    fireEvent.change(view.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.click(view.getByRole("button", { name: "Set up authenticator" }));
    await waitFor(() => expect(view.getByTestId("totp-secret").textContent).toBe("SECRETVALUE"));
    expect(view.getByText("Setting up")).toBeTruthy();
    expect(view.getByRole("link", { name: "otpauth://totp/LibreDB:me" }).getAttribute("href")).toBe(
      "otpauth://totp/LibreDB:me",
    );

    fireEvent.click(view.getByRole("button", { name: "Copy key" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Key copied"));
    expect(writeText).toHaveBeenCalledWith("SECRETVALUE");

    writeText.mockImplementation(async () => {
      throw new Error("denied");
    });
    fireEvent.click(view.getByRole("button", { name: "Copy key" }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Could not copy the key. Select it and copy it by hand."),
    );

    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(view.queryByTestId("totp-secret")).toBeNull();
    expect(view.getByText("Off")).toBeTruthy();
    expect((view.getByLabelText("Current password") as HTMLInputElement).value).toBe("");
  });

  test("a refused code is cleared, and confirming turns it on with a toast", async () => {
    let enabled = false;
    let refuse = true;
    mockGlobalFetch({
      "/api/auth/totp": async (req) => {
        if (req.method === "GET") return { json: { available: true, enabled } };
        const body = (await req.json()) as Posted;
        if (body.action === "begin") return { json: { secret: "SECRETVALUE" } };
        if (refuse) return { status: 400, json: {} };
        enabled = true;
        return { json: { ok: true } };
      },
    });
    const view = render(<AuthenticatorSettings />);
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
    fireEvent.change(view.getByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.click(view.getByRole("button", { name: "Set up authenticator" }));
    await waitFor(() => expect(view.getByTestId("totp-secret")).toBeTruthy());
    // No link when the server sends none.
    expect(view.queryByRole("link")).toBeNull();

    fireEvent.change(view.getByLabelText("Authentication code"), { target: { value: "000000" } });
    fireEvent.click(view.getByRole("button", { name: "Confirm code" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("Invalid authentication code"));
    expect((view.getByLabelText("Authentication code") as HTMLInputElement).value).toBe("");

    refuse = false;
    fireEvent.change(view.getByLabelText("Authentication code"), { target: { value: "123456" } });
    fireEvent.click(view.getByRole("button", { name: "Confirm code" }));
    await waitFor(() => expect(view.getByText("On")).toBeTruthy());
    expect(mockToastSuccess).toHaveBeenCalledWith("Authenticator is on");
  });

  test("refusals without a message fall back to plain ones", async () => {
    let enabled = false;
    mockGlobalFetch({
      "/api/auth/totp": async (req) => {
        if (req.method === "GET") return { json: { available: true, enabled } };
        const body = (await req.json()) as Posted;
        // A begin that answers 200 without a secret is as unusable as a refusal.
        if (body.action === "begin") return { json: {} };
        return { status: 401, json: {} };
      },
    });
    const off = render(<AuthenticatorSettings />);
    await waitFor(() => expect(off.getByText("Off")).toBeTruthy());
    fireEvent.click(off.getByRole("button", { name: "Set up authenticator" }));
    await waitFor(() => expect(off.getByRole("alert").textContent).toBe("Could not start authenticator setup"));
    cleanup();

    enabled = true;
    const on = render(<AuthenticatorSettings />);
    await waitFor(() => expect(on.getByText("On")).toBeTruthy());
    fireEvent.click(on.getByRole("button", { name: "Turn off authenticator" }));
    await waitFor(() => expect(on.getByRole("alert").textContent).toBe("Could not turn off the authenticator"));
  });
});

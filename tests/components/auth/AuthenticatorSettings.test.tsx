import "../../setup-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { AuthenticatorSettings } from "@/components/auth/AuthenticatorSettings";

type Posted = { action?: string; password?: string; code?: string };

describe("AuthenticatorSettings", () => {
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
  });
});

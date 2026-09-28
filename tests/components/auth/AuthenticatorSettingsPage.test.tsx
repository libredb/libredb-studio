import "../../setup-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import AuthenticatorSettingsPage from "@/app/settings/authenticator/page";

describe("/settings/authenticator", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("frames the shared authenticator with a heading and a way back to the editor", async () => {
    mockGlobalFetch({ "/api/auth/totp": { json: { available: true, enabled: false } } });
    const view = render(<AuthenticatorSettingsPage />);
    expect(view.getByRole("heading", { level: 1, name: "Authenticator" })).toBeTruthy();
    expect(view.getByRole("link", { name: "Back to the editor" }).getAttribute("href")).toBe("/");
    await waitFor(() => expect(view.getByRole("button", { name: "Set up authenticator" })).toBeTruthy());
  });
});

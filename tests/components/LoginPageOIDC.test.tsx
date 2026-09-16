import "../setup-dom";
import React from "react";
import { mock } from "bun:test";
import { setMockSearchParams, resetMockSearchParams } from "../helpers/mock-navigation";
import { listShowcaseDatabases } from "@/lib/db-showcase";
import { LIVE_CHANNELS } from "@/lib/distribution/channels.generated";

// next/navigation is mocked via the preloaded shared helper; search params
// are driven through setMockSearchParams instead of a local mock.module call.

const { default: LoginForm } = await import("@/app/login/login-form");

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

describe("LoginPage (OIDC mode)", () => {
  afterEach(() => {
    resetMockSearchParams();
    cleanup();
  });

  test("renders Login with SSO button", () => {
    const { getByText } = render(<LoginForm authProvider="oidc" />);
    expect(getByText("Login with SSO")).not.toBeNull();
  });

  test("does not render email/password form", () => {
    const { container } = render(<LoginForm authProvider="oidc" />);
    const form = container.querySelector("form");
    expect(form).toBeNull();
  });

  test("does not render quick access buttons", () => {
    const { queryByText } = render(<LoginForm authProvider="oidc" />);
    expect(queryByText("Admin")).toBeNull();
    expect(queryByText("User")).toBeNull();
  });

  test("renders LibreDB Studio title", () => {
    // The title appears twice: desktop hero and mobile header.
    const { getAllByText } = render(<LoginForm authProvider="oidc" />);
    expect(getAllByText("LibreDB Studio").length).toBeGreaterThan(0);
  });

  test("shows error message when error param is present", () => {
    setMockSearchParams(new URLSearchParams("error=oidc_failed"));
    const { getByText } = render(<LoginForm authProvider="oidc" />);
    expect(getByText("Authentication failed. Please try again.")).not.toBeNull();
  });

  // One message per failure class. The configuration case gives no retry advice, because trying
  // again fails identically until an operator edits the deployment; the discovery case names the
  // provider as the thing that did not answer; state and exchange failures keep "try again",
  // which is the right advice for those.
  test("tells the user to contact an administrator for oidc_config", () => {
    setMockSearchParams(new URLSearchParams("error=oidc_config"));
    const { getByText } = render(<LoginForm authProvider="oidc" />);
    const message = getByText(/not configured correctly on this server/);
    expect(message.textContent).not.toMatch(/try again/i);
  });

  test("names the identity provider as unreachable for oidc_discovery", () => {
    setMockSearchParams(new URLSearchParams("error=oidc_discovery"));
    const { getByText } = render(<LoginForm authProvider="oidc" />);
    expect(getByText(/identity provider could not be reached/)).not.toBeNull();
  });

  test("renders the generic message for every other code", () => {
    for (const code of ["oidc_state_missing", "oidc_state_invalid", "oidc_no_claims", "constructor", "__proto__"]) {
      setMockSearchParams(new URLSearchParams(`error=${code}`));
      const { getByText, unmount } = render(<LoginForm authProvider="oidc" />);
      expect(getByText("Authentication failed. Please try again.")).not.toBeNull();
      unmount();
    }
  });

  test("never renders the query value itself", () => {
    // The login page is unauthenticated. A code is a class name, never the issuer's own words; if
    // anything upstream ever put error text in the query, the page must still not echo it.
    const leaked = "ClientError: only requests to HTTPS are allowed";
    setMockSearchParams(new URLSearchParams({ error: leaked }));
    const { container, getByText } = render(<LoginForm authProvider="oidc" />);
    expect(getByText("Authentication failed. Please try again.")).not.toBeNull();
    expect(container.textContent).not.toContain("HTTPS");
    expect(container.textContent).not.toContain("ClientError");
  });

  test("does not show error message when no error param", () => {
    const { queryByText } = render(<LoginForm authProvider="oidc" />);
    expect(queryByText("Authentication failed. Please try again.")).toBeNull();
  });

  test("SSO button shows Redirecting... when clicked", async () => {
    // Mock window.location to prevent navigation
    const savedDescriptor = Object.getOwnPropertyDescriptor(window, "location");
    const locationMock = { href: "", assign: mock(() => {}), replace: mock(() => {}) };
    Object.defineProperty(window, "location", {
      value: locationMock,
      writable: true,
      configurable: true,
    });

    const user = userEvent.setup();
    const { getByText, queryByText } = render(<LoginForm authProvider="oidc" />);

    await user.click(getByText("Login with SSO"));

    expect(queryByText("Redirecting...")).not.toBeNull();
    expect(locationMock.href).toBe("/api/auth/oidc/login");

    // Restore location
    if (savedDescriptor) {
      Object.defineProperty(window, "location", savedDescriptor);
    }
  });

  test("renders the same derived showcase as the local login", () => {
    // The hero is outside the auth branch, so the SSO deployment must advertise the same
    // engines and the same channel count. Asserted here as well because the two forms have
    // drifted before - the OIDC branch is the one nobody opens while editing copy.
    const { container } = render(<LoginForm authProvider="oidc" />);
    for (const db of listShowcaseDatabases()) {
      expect(container.textContent).toContain(db.label);
    }
    expect(container.textContent).toContain(`${LIVE_CHANNELS.length} install channels`);
    expect(container.textContent).not.toContain("7+");
  });

  test("states both agent modes on the SSO surface too", () => {
    const { getAllByTestId } = render(<LoginForm authProvider="oidc" />);
    const claims = getAllByTestId("agent-claim");
    expect(claims.length).toBeGreaterThanOrEqual(2);
    for (const claim of claims) {
      expect(claim.textContent).toMatch(/plan mode/i);
      expect(claim.textContent).toMatch(/agent mode/i);
    }
  });

  test("makes no bare encryption claim under the SSO button", () => {
    // Reported externally (Reddit, 2026-08-30): a lone "Encrypted" badge names no subject, and on
    // the default STORAGE_PROVIDER=local deployment - which is what the public demo runs - it has
    // no referent beyond TLS: credentials stay in the browser's localStorage in plaintext by
    // design (src/lib/storage/encryption.ts covers the sqlite/postgres store only).
    // The surviving sibling is asserted in the same test on purpose: without it, a later rename of
    // the badge row would leave this negative assertion passing forever while proving nothing.
    const { queryByText, getByText } = render(<LoginForm authProvider="oidc" />);
    expect(getByText("OIDC Protected")).not.toBeNull();
    expect(queryByText("Encrypted")).toBeNull();
  });
});

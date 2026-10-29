import "../setup-dom";
import React from "react";
import { setMockSearchParams, resetMockSearchParams } from "../helpers/mock-navigation";

// next/navigation is mocked via the preloaded shared helper; search params are driven through setMockSearchParams.

const { default: LoginForm } = await import("@/app/login/login-form");

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** The fixed sentence of each openshift_* code; nothing the cluster said is shown. */
const MESSAGES: Record<string, string> = {
  openshift_config: "OpenShift sign-in is not configured correctly on this server. Contact your administrator.",
  openshift_unreachable:
    "The OpenShift API or OAuth server could not be reached. Try again later, or contact your administrator if this continues.",
  openshift_external_oidc:
    "This cluster signs in through an external identity provider, so OpenShift sign-in cannot run here. Ask your administrator to use OIDC sign-in instead.",
  openshift_state_missing: "Your sign-in expired or was started in another browser. Sign in again.",
  openshift_state_invalid: "Your sign-in expired or was started in another browser. Sign in again.",
  openshift_denied: "You declined the permissions LibreDB Studio asked for. Sign in again and allow them to continue.",
  openshift_scope:
    "Sign-in needs both permissions on the OpenShift Authorize Access page. Sign in again and keep user:info and user:check-access checked; if the page no longer appears, ask your administrator to delete your oauthclientauthorization for LibreDB Studio.",
  openshift_no_uid:
    "This OpenShift account cannot sign in to LibreDB Studio because the cluster gives it no user id, as for a virtual account such as kube:admin. Sign in with a regular user.",
  openshift_no_access: "Your OpenShift account has no access to this LibreDB Studio. Ask your administrator.",
  openshift_failed: "OpenShift sign-in failed. Please try again.",
  openshift_session_lost:
    "This server could not keep your sign-in. Sign in again, and ask your administrator if this repeats; Studio must run as one replica.",
};

/** Replaces window.location for one navigation, so a click records where it went. */
function captureNavigation(): { location: { href: string }; restore: () => void } {
  const saved = Object.getOwnPropertyDescriptor(window, "location");
  const location = { href: "" };
  Object.defineProperty(window, "location", { value: location, writable: true, configurable: true });
  return {
    location,
    restore: () => {
      if (saved) Object.defineProperty(window, "location", saved);
    },
  };
}

describe("LoginPage (openshift mode)", () => {
  afterEach(() => {
    resetMockSearchParams();
    cleanup();
  });

  test("offers one OpenShift sign-in action and no password form or passkey", () => {
    const { getByText, getAllByText, container, queryByText } = render(
      <LoginForm authProvider="openshift" passkey={{ origin: "https://studio.apps.example.com" }} />,
    );
    expect(getAllByText("OpenShift").length).toBe(1);
    expect(getByText("Sign in with your OpenShift account")).not.toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(getByText("Sign in with OpenShift")).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(queryByText("Login with SSO")).toBeNull();
    expect(queryByText(/passkey/i)).toBeNull();
  });

  test("the button goes to the OpenShift login route, carrying the return path", async () => {
    const navigation = captureNavigation();
    try {
      const user = userEvent.setup();
      const first = render(<LoginForm authProvider="openshift" passkey={null} />);
      await user.click(first.getByText("Sign in with OpenShift"));
      expect(navigation.location.href).toBe("/api/auth/openshift/login");
      expect(first.queryByText("Redirecting...")).not.toBeNull();
      first.unmount();
      setMockSearchParams(new URLSearchParams({ next: "/admin?tab=audit" }));
      const second = render(<LoginForm authProvider="openshift" passkey={null} />);
      await user.click(second.getByText("Sign in with OpenShift"));
      expect(navigation.location.href).toBe("/api/auth/openshift/login?next=%2Fadmin%3Ftab%3Daudit");
    } finally {
      navigation.restore();
    }
  });

  test("each code shows its own sentence", () => {
    for (const [code, message] of Object.entries(MESSAGES)) {
      setMockSearchParams(new URLSearchParams(`error=${code}`));
      const { getByText, unmount } = render(<LoginForm authProvider="openshift" passkey={null} />);
      expect(getByText(message), code).not.toBeNull();
      unmount();
    }
  });

  test("an unknown code shows the generic sentence and never echoes the query", () => {
    for (const code of ["oidc_failed", "constructor", "ClientError: only requests to HTTPS are allowed"]) {
      setMockSearchParams(new URLSearchParams({ error: code }));
      const { getByText, container, unmount } = render(<LoginForm authProvider="openshift" passkey={null} />);
      expect(getByText(MESSAGES.openshift_failed)).not.toBeNull();
      expect(container.textContent).not.toContain("ClientError");
      unmount();
    }
  });

  test("no error, no message", () => {
    const { queryByText } = render(<LoginForm authProvider="openshift" passkey={null} />);
    expect(queryByText(MESSAGES.openshift_failed)).toBeNull();
  });
});

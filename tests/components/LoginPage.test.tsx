import "../setup-dom";
import React from "react";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { mockRouterPush, mockRouterRefresh } from "../helpers/mock-navigation";
import { mockToastSuccess, mockToastError } from "../helpers/mock-sonner";
import { mock } from "bun:test";
import { listShowcaseDatabases } from "@/lib/db-showcase";
import { getDBConfig } from "@/lib/db-ui-config";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { LIVE_CHANNELS, LIVE_PLATFORMS } from "@/lib/distribution/channels.generated";
import { DEPLOY_GROUP_LABELS, DEPLOY_GROUP_ORDER } from "@/lib/distribution/deploy-groups";
import { ENGINE_URI_SCHEMES, parseConnectionString } from "@/lib/connection-string-parser";
import { SIGNATURE_URIS } from "@/components/login/connection-signature";
import { EXTERNAL_DATABASE_TYPES, SHIPPED_DATABASE_TYPES, WIRE_COMPATIBLE_ENGINES } from "@/lib/db/compatibility";

// sonner and next/navigation are mocked via preload
// lucide-react resolves fine natively — no mock needed

const { default: LoginForm } = await import("@/app/login/login-form");

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

function renderLogin() {
  const user = userEvent.setup();
  const result = render(<LoginForm authProvider="local" />);
  const form = result.container.querySelector("form")!;
  const emailInput = result.container.querySelector('input[type="email"]')! as HTMLInputElement;
  const passwordInput = result.container.querySelector('input[type="password"]')! as HTMLInputElement;
  return { ...result, form, emailInput, passwordInput, user };
}

describe("LoginPage", () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRouterRefresh.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    globalThis.fetch = mock(() => Promise.resolve(new Response("{}"))) as never;
  });

  afterEach(() => {
    cleanup();
  });

  test("renders login form with email and password inputs", () => {
    const { emailInput, passwordInput } = renderLogin();
    expect(emailInput).not.toBeNull();
    expect(emailInput.type).toBe("email");
    expect(passwordInput).not.toBeNull();
    expect(passwordInput.type).toBe("password");
  });

  test("renders Sign In button", () => {
    const { getByText } = renderLogin();
    expect(getByText("Sign In")).not.toBeNull();
  });

  test("renders LibreDB Studio title", () => {
    const { getAllByText } = renderLogin();
    expect(getAllByText("LibreDB Studio").length).toBeGreaterThanOrEqual(1);
  });

  test("shows error toast when submitting empty form", () => {
    const { form } = renderLogin();
    fireEvent.submit(form);
    expect(mockToastError).toHaveBeenCalledWith("Please enter email and password");
  });

  test("calls fetch with correct payload on form submit", async () => {
    const mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify({ success: true, role: "admin" }))));
    globalThis.fetch = mockFetch as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "admin@libredb.org");
    await user.type(passwordInput, "LibreDB.2026");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [url, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({ email: "admin@libredb.org", password: "LibreDB.2026" });
  });

  test("redirects admin to /admin on success", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, role: "admin" }))),
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "admin@libredb.org");
    await user.type(passwordInput, "LibreDB.2026");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/admin");
    });
    expect(mockRouterRefresh).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith("Welcome back, admin!");
  });

  test("redirects user to / on success", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, role: "user" }))),
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "user@libredb.org");
    await user.type(passwordInput, "LibreDB.2026");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/");
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Welcome back, user!");
  });

  test("shows error toast on failed login", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: false, message: "Invalid email or password" }))),
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "wrong@example.com");
    await user.type(passwordInput, "wrong");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Invalid email or password");
    });
  });

  test("falls back to the response's error field when message is absent (origin-mismatch/rate-limit shape)", async () => {
    // The proxy's Origin-mismatch 403 and the shared 429 envelope both carry `error`, not
    // `message` - unlike the login route's own body. Without the fallback this reads as
    // `data.message || "Invalid email or password"`, so a rate-limited or origin-refused caller
    // would incorrectly be told their password is wrong.
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "Request origin is not allowed for this deployment. Set ALLOWED_ORIGINS.",
            code: "ORIGIN_MISMATCH",
          }),
        ),
      ),
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "admin@libredb.org");
    await user.type(passwordInput, "correct-password");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Request origin is not allowed for this deployment. Set ALLOWED_ORIGINS.",
      );
    });
  });

  test("shows generic error toast on network failure", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Network error"))) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "test@example.com");
    await user.type(passwordInput, "test");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("An error occurred. Please try again.");
    });
  });

  test("shows Authenticating... text while loading", async () => {
    let resolveFetch!: (v: Response) => void;
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as never;

    const { form, emailInput, passwordInput, user, queryByText } = renderLogin();
    await user.type(emailInput, "test@example.com");
    await user.type(passwordInput, "test");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(queryByText("Authenticating...")).not.toBeNull();
    });

    resolveFetch(new Response(JSON.stringify({ success: false })));
    await waitFor(() => {
      expect(queryByText("Sign In")).not.toBeNull();
    });
  });
});

describe("LoginPage route (app/login/page)", () => {
  const savedAuthProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER;

  afterEach(() => {
    if (savedAuthProvider === undefined) {
      delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    } else {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = savedAuthProvider;
    }
    cleanup();
  });

  test("forces dynamic rendering so the auth provider is read at runtime", async () => {
    const { dynamic } = await import("@/app/login/page");
    expect(dynamic).toBe("force-dynamic");
  });

  test("defaults to the local login form when no auth provider is set", async () => {
    delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    const { default: LoginPageRoute } = await import("@/app/login/page");

    const { container } = render(<LoginPageRoute />);
    expect(container.querySelector("form")).not.toBeNull();
  });

  test("renders the SSO login when NEXT_PUBLIC_AUTH_PROVIDER is oidc", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    const { default: LoginPageRoute } = await import("@/app/login/page");

    const { queryByText, container } = render(<LoginPageRoute />);
    expect(queryByText("Login with SSO")).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });
});

describe("LoginPage showcase (issue #425)", () => {
  afterEach(() => {
    cleanup();
  });

  function renderShowcase() {
    return render(<LoginForm authProvider="local" />);
  }

  test("renders every configured engine label on both surfaces", () => {
    // Driven by DB_UI_CONFIG through listShowcaseDatabases, never by a literal list: the
    // defect this issue closes was two hand-written five-item arrays that stopped tracking
    // DatabaseType. Each label must appear twice - once in the desktop hero, once in the
    // mobile block - so neither surface can quietly drop an engine.
    const { getAllByText } = renderShowcase();
    for (const db of listShowcaseDatabases()) {
      expect(getAllByText(db.label).length).toBeGreaterThanOrEqual(2);
    }
  });

  test("names no engine outside DB_UI_CONFIG", () => {
    // Reads the label node rather than the whole item: the embedded provider's pill also
    // carries an "embedded" marker, so comparing the item's full text would either fail
    // here or force the marker out of the pill it belongs in.
    const { getByTestId } = renderShowcase();
    const known = new Set(listShowcaseDatabases().map((db) => db.label));
    for (const item of getByTestId("database-showcase-desktop").querySelectorAll("li")) {
      const label = item.querySelector("[data-engine-label]")?.textContent?.trim() ?? "";
      expect(known.has(label)).toBe(true);
    }
  });

  test("marks the embedded provider in the pill list instead of dropping it", () => {
    // The hero claims 14 external engines while showing 15 pills, and this marker is what
    // reconciles the two for a reader. Hiding the pill was the alternative and it is worse:
    // libredb is a provider the connection picker offers, so a login page that never names
    // it contradicts the app - the reasoning db-showcase.ts already records for issue #425.
    const { getByTestId } = renderShowcase();
    const embedded = listShowcaseDatabases().filter((db) => db.embedded);
    expect(embedded.length).toBe(1);
    for (const testId of ["database-showcase-desktop", "database-showcase-mobile"]) {
      const marked = [...getByTestId(testId).querySelectorAll("li")].filter((item) =>
        /embedded/i.test(item.textContent ?? ""),
      );
      expect(marked.length).toBe(embedded.length);
      expect(marked[0]?.textContent).toContain(embedded[0].label);
    }
  });

  test("names every verified relative on both surfaces, with the registry's own count", () => {
    // The gap this closes: the page claimed its engine count while the product connects to
    // forty named products, and the other twenty-six were published in README.md and the
    // docs compatibility table but nowhere a visitor to the login page could see them.
    const { getByTestId } = renderShowcase();
    expect(WIRE_COMPATIBLE_ENGINES.length).toBeGreaterThan(0);
    for (const testId of ["wire-compatible-desktop", "wire-compatible-mobile"]) {
      const text = getByTestId(testId).textContent ?? "";
      expect(text).toContain(`${WIRE_COMPATIBLE_ENGINES.length}`);
      for (const engine of WIRE_COMPATIBLE_ENGINES) {
        expect(text).toContain(engine.name);
      }
    }
  });

  test("names no relative the registry does not carry", () => {
    // The same guard the engine pills have. A name typed into the JSX would be a claim no
    // gate-4 probe stands behind, which is the overclaim issue #424 exists to forbid.
    const { getByTestId } = renderShowcase();
    const known = new Set(WIRE_COMPATIBLE_ENGINES.map((engine) => engine.name));
    for (const testId of ["wire-compatible-desktop", "wire-compatible-mobile"]) {
      const named = getByTestId(testId).querySelectorAll("[data-relative-name]");
      expect(named.length).toBe(WIRE_COMPATIBLE_ENGINES.length);
      for (const node of named) {
        expect(known.has(node.textContent?.trim() ?? "")).toBe(true);
      }
    }
  });

  test("claims no parity for a relative: no tier word reaches the login page", () => {
    // WireCompatibilityHint carries the per-engine tier because the connection dialog has
    // room to qualify it. This line does not, so it may not imply the relatives behave like
    // their driver's own engine: it says what was measured and nothing more.
    const { getByTestId } = renderShowcase();
    const text = getByTestId("wire-compatible-desktop").textContent ?? "";
    expect(/partial|query-only|fully supported/i.test(text)).toBe(false);
    expect(/measured/i.test(text)).toBe(true);
  });

  test("states the live channel count and every group name, without printing channel names", () => {
    // The hero used to print all two dozen channel names, which is what made the panel
    // unreadable. What survives is the claim - a derived count plus the four group names -
    // so the count still cannot go stale while the ink is a single line.
    const { getByTestId } = renderShowcase();
    const proof = getByTestId("hero-proof");
    expect(proof.textContent).toContain(`${LIVE_CHANNELS.length}`);
    for (const group of DEPLOY_GROUP_ORDER) {
      expect(proof.textContent).toContain(DEPLOY_GROUP_LABELS[group]);
    }
  });

  test("names the operating systems a workstation reader is looking for", () => {
    const { getByTestId } = renderShowcase();
    const line = (getByTestId("platform-line").textContent ?? "").toLowerCase();
    const expected = LIVE_PLATFORMS.filter((platform) => ["linux", "macos", "windows"].includes(platform));
    expect(expected.length).toBeGreaterThan(0);
    for (const platform of expected) {
      expect(line).toContain(platform);
    }
  });

  test("cycles only schemes parseConnectionString actually accepts", () => {
    // The signature is the evidence behind the engine count, so it may only show URIs the
    // product honours. SQLite is a file, LibreDB is embedded and Druid is plain HTTP -
    // inventing a scheme for any of them would put a false claim on the front door.
    const { getByTestId } = renderShowcase();
    const scheme = (getByTestId("connection-signature").textContent ?? "").split("://")[0];
    expect(Object.values(ENGINE_URI_SCHEMES)).toContain(scheme);
    expect(SIGNATURE_URIS.length).toBe(Object.keys(ENGINE_URI_SCHEMES).length);
    for (const uri of SIGNATURE_URIS) {
      expect(parseConnectionString(`${uri.scheme}${uri.rest}`)?.type).toBe(uri.type);
    }
  });

  test("shows no pending or deprecated channel anywhere on the page", () => {
    // channels.yaml is the inventory; anything not `live` is a listing that does not exist
    // yet (or no longer does), and docs/CHANNELS.md is explicit that a deprecated channel
    // renders nothing at all. Parsed from the YAML rather than listed here, so a newly
    // promoted or newly retired row is covered without touching this test.
    const { container } = renderShowcase();
    const inventory = parseYaml(readFileSync("distribution/channels.yaml", "utf8")) as {
      channels: { status: string; name: string; short_name?: string }[];
    };
    const unlisted = inventory.channels.filter((channel) => channel.status !== "live");
    expect(unlisted.length).toBeGreaterThan(0);
    for (const channel of unlisted) {
      expect(container.textContent).not.toContain(channel.short_name ?? channel.name);
    }
  });

  test("derives the engine and channel counts instead of typing them", () => {
    const { container } = renderShowcase();
    expect(container.textContent).toContain(`${EXTERNAL_DATABASE_TYPES.length} database engines`);
    expect(container.textContent).toContain(`${LIVE_CHANNELS.length} install channels`);
  });

  test("counts external engines in the claim, never the embedded provider", () => {
    // The number this page publishes is the one README.md publishes - fourteen drivers
    // reaching forty named engines - and the embedded store is in neither half of that
    // arithmetic. Both counts are interpolated from the registry, so reverting the claim to
    // the showcase length (which includes libredb) fails the second assertion.
    // Matched with a tolerant regex rather than a substring: the desktop figure puts the
    // number and the unit in adjacent spans with no whitespace between them, so a
    // "14 database engines" substring check would pass only on the mobile line and silently
    // stop covering the surface it was written for.
    const { container, getByTestId } = renderShowcase();
    const external = new RegExp(`${EXTERNAL_DATABASE_TYPES.length}\\s*database engines`);
    const shipped = new RegExp(`${SHIPPED_DATABASE_TYPES.length}\\s*database engines`);
    // The desktop figure specifically, then the page as a whole, so neither surface can
    // carry the claim alone.
    expect(external.test(getByTestId("hero-proof").textContent ?? "")).toBe(true);
    expect(external.test(container.textContent ?? "")).toBe(true);
    expect(shipped.test(container.textContent ?? "")).toBe(false);
    expect(SHIPPED_DATABASE_TYPES.length).toBe(EXTERNAL_DATABASE_TYPES.length + 1);
  });

  test("no longer claims a stale engine count or a Docker-only install", () => {
    const { container } = renderShowcase();
    expect(container.textContent).not.toContain("7+");
    expect(container.textContent).not.toContain("deploy with Docker in seconds");
    expect(container.textContent).not.toContain("deploy anywhere with Docker in seconds");
  });

  test("pins the agent claim: two modes, and auto-execution only where agent mode runs", () => {
    // This pins the CLAIM, not the wording, so a future copy edit is free to rewrite the
    // sentence but not free to overclaim. docs/AGENT.md: plan mode executes nothing on any
    // engine, and agent mode executes only where the provider implements `queryReadOnly`.
    const { getAllByTestId } = renderShowcase();
    const claims = getAllByTestId("agent-claim");
    expect(claims.length).toBeGreaterThanOrEqual(2);

    const allowed = new Set(AGENT_EXECUTION_ENGINES.map((type) => getDBConfig(type).label));
    expect(allowed.size).toBeGreaterThan(0);

    for (const claim of claims) {
      const sentences = (claim.textContent ?? "").split(/(?<=\.)\s+/);

      const planSentence = sentences.find((sentence) => /plan mode/i.test(sentence));
      expect(planSentence).toBeDefined();
      expect(/(executes|runs) nothing/i.test(planSentence!)).toBe(true);

      const agentSentence = sentences.find((sentence) => /agent mode/i.test(sentence));
      expect(agentSentence).toBeDefined();
      for (const db of listShowcaseDatabases()) {
        if (allowed.has(db.label)) continue;
        expect(agentSentence).not.toContain(db.label);
      }
    }
  });

  test("gives the mobile surface the same claims and the full engine list", () => {
    const { getAllByTestId, getByTestId } = renderShowcase();
    const summary = getAllByTestId("agent-claim").map((node) => node.textContent ?? "");
    expect(summary.some((text) => text.includes(`${LIVE_CHANNELS.length} install channels`))).toBe(true);

    const engines = getByTestId("database-showcase-mobile");
    expect(engines.querySelectorAll("li").length).toBe(listShowcaseDatabases().length);
  });

  test("keeps the showcase decorative - no channel or engine is a link", () => {
    // The login page is unauthenticated; the maintainer's rule is that decorative showcase
    // content adds no outbound navigation there. The community section's own anchors are
    // the only links this half of the page is allowed to grow.
    const { getByTestId } = renderShowcase();
    for (const testId of [
      "database-showcase-desktop",
      "database-showcase-mobile",
      "wire-compatible-desktop",
      "wire-compatible-mobile",
      "hero-proof",
    ]) {
      expect(getByTestId(testId).querySelectorAll("a").length).toBe(0);
    }
  });
});

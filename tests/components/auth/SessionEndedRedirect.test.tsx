import { withBasePathEnv } from "../../helpers/base-path";
import "../../setup-dom";
import { mockRouterPush } from "../../helpers/mock-navigation";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

import { SessionEndedRedirect } from "@/components/auth/SessionEndedRedirect";
import { appFetch } from "@/lib/config/base-path";

const SESSION_EXPIRED = { error: "Session expired. Sign in again.", code: "AUTH_REQUIRED" };

describe("SessionEndedRedirect", () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
    window.history.replaceState(null, "", "/");
  });

  // The defect it closes (#1420): an expired session made every API call fail with a JSON parse
  // error and nothing sent the user to sign in.
  test("a session-required 401 from any API call sends the tab to sign in, returning here after", async () => {
    window.history.replaceState(null, "", "/admin?tab=audit");
    mockGlobalFetch({ "/api/db/query": { status: 401, json: SESSION_EXPIRED } });
    render(<SessionEndedRedirect />);

    const response = await appFetch("/api/db/query", { method: "POST" });

    expect(response.status).toBe(401);
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith("/login?next=%2Fadmin%3Ftab%3Daudit"));
  });

  test("a database or model 401 leaves the user where they are", async () => {
    mockGlobalFetch({
      "/api/db/query": { status: 401, json: { error: "password authentication failed", code: "AUTH_ERROR" } },
      "/api/ai/chat": { status: 401, json: { error: "Invalid API key.", code: "LLM_AUTH" } },
    });
    render(<SessionEndedRedirect />);

    await appFetch("/api/db/query");
    await appFetch("/api/ai/chat");

    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  test("on the sign-in page itself there is nowhere to go", async () => {
    window.history.replaceState(null, "", "/login?next=%2Fadmin");
    mockGlobalFetch({ "/api/mcp/token": { status: 401, json: SESSION_EXPIRED } });
    render(<SessionEndedRedirect />);

    await appFetch("/api/mcp/token");

    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  test("under a deployment prefix the return path stays app-relative, since the router adds the prefix", async () => {
    await withBasePathEnv("/tools/libredb", async () => {
      window.history.replaceState(null, "", "/tools/libredb/settings/authenticator");
      mockGlobalFetch({ "/tools/libredb/api/agent/runs": { status: 401, json: SESSION_EXPIRED } });
      render(<SessionEndedRedirect />);

      await appFetch("/api/agent/runs");

      await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith("/login?next=%2Fsettings%2Fauthenticator"));
    });
  });

  // A session refused while its token still verifies (the account registry could not be read)
  // is sent from /login straight back by the proxy; without the guard the tab would loop.
  test("a second refusal right after a redirect stays on the page instead of looping", async () => {
    mockGlobalFetch({ "/api/db/query": { status: 401, json: SESSION_EXPIRED } });
    render(<SessionEndedRedirect />);

    await appFetch("/api/db/query");
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledTimes(1));
    await appFetch("/api/db/query");

    expect(mockRouterPush).toHaveBeenCalledTimes(1);
  });

  test("once unmounted it no longer reacts", async () => {
    mockGlobalFetch({ "/api/db/query": { status: 401, json: SESSION_EXPIRED } });
    const { unmount } = render(<SessionEndedRedirect />);
    unmount();

    await appFetch("/api/db/query");

    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});

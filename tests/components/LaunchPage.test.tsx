import "../setup-dom";
import React from "react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { withBasePathEnv } from "../helpers/base-path";
import LaunchPage from "@/app/launch/page";
import { readLaunchEmail, readLaunchToken } from "@/app/launch/launch-client";

function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A token the page can read the email of, for display only; the signature is a placeholder it never checks. */
function tokenFor(email: unknown): string {
  return `${base64url(JSON.stringify({ alg: "HS256", typ: "libredb-launch+jwt" }))}.${base64url(JSON.stringify({ email }))}.placeholder-signature`;
}

const EMAIL = "bob@example.com";
const TOKEN = tokenFor(EMAIL);

interface LocationMock {
  hash: string;
  pathname: string;
  search: string;
  replace: ReturnType<typeof mock>;
}

const savedLocation = Object.getOwnPropertyDescriptor(window, "location");
let location: LocationMock;
let order: string[];
let replaceState: ReturnType<typeof spyOn>;

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SIGNED_OUT = async () => answer(401, { authenticated: false });
const SIGNED_IN = async () => answer(200, { authenticated: true, user: { username: EMAIL, role: "user" } });

/**
 * Serves GET /api/auth/me with `me` (no Studio session unless a test says otherwise) and every other request,
 * the launch exchange, with `response`; `order` records each request by its path's last segment.
 */
function serve(response: () => Promise<Response>, me: () => Promise<Response> = SIGNED_OUT): ReturnType<typeof mock> {
  const fetchMock = mock(async (url: string) => {
    const isMe = String(url).endsWith("/api/auth/me");
    order.push(isMe ? "me" : "fetch");
    return isMe ? me() : response();
  });
  globalThis.fetch = fetchMock as never;
  return fetchMock;
}

function launchCalls(fetchMock: ReturnType<typeof mock>): [string, RequestInit][] {
  return (fetchMock.mock.calls as unknown as [string, RequestInit][]).filter(([url]) => !url.endsWith("/api/auth/me"));
}

async function clickContinue(view: ReturnType<typeof render>): Promise<void> {
  fireEvent.click(await view.findByRole("button", { name: `Continue as ${EMAIL}` }));
}

beforeEach(() => {
  order = [];
  location = { hash: `#token=${TOKEN}`, pathname: "/launch", search: "", replace: mock(() => {}) };
  Object.defineProperty(window, "location", { value: location, writable: true, configurable: true });
  replaceState = spyOn(window.history, "replaceState").mockImplementation(() => {
    order.push("replaceState");
  });
});

afterEach(() => {
  cleanup();
  replaceState.mockRestore();
  if (savedLocation) Object.defineProperty(window, "location", savedLocation);
});

describe("readLaunchToken", () => {
  test("reads the token of a #token= fragment and nothing else", () => {
    expect(readLaunchToken(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(readLaunchToken(`token=${TOKEN}`)).toBe(TOKEN);
    expect(readLaunchToken("")).toBeNull();
    expect(readLaunchToken("#token=")).toBeNull();
    expect(readLaunchToken("#other=1")).toBeNull();
  });
});

describe("readLaunchEmail", () => {
  test("reads the email claim of a compact JWS without checking anything else", () => {
    expect(readLaunchEmail(TOKEN)).toBe(EMAIL);
    expect(readLaunchEmail(tokenFor("zoë@example.com"))).toBe("zoë@example.com");
  });

  test("answers null for a token it cannot read an email from", () => {
    expect(readLaunchEmail("not-a-jws")).toBeNull();
    expect(readLaunchEmail("a.%%%.c")).toBeNull();
    expect(readLaunchEmail(`a.${base64url("not json")}.c`)).toBeNull();
    expect(readLaunchEmail(`a.${base64url("null")}.c`)).toBeNull();
    expect(readLaunchEmail(tokenFor(42))).toBeNull();
    expect(readLaunchEmail(tokenFor(""))).toBeNull();
  });
});

describe("the /launch page in a browser with no Studio session", () => {
  test("names the account the link signs into and posts nothing until Continue is clicked", async () => {
    const fetchMock = serve(async () => answer(200, { success: true, redirect: "/" }));
    const view = render(<LaunchPage />);

    expect(await view.findByText(`This launch link signs you in to LibreDB Studio as ${EMAIL}.`)).not.toBeNull();
    expect(view.getByRole("button", { name: `Continue as ${EMAIL}` })).not.toBeNull();
    expect(order).toEqual(["replaceState", "me"]);
    expect(launchCalls(fetchMock)).toEqual([]);
    expect(location.replace).not.toHaveBeenCalled();
  });

  test("removes the fragment before anything else, posts the token on Continue, then replaces itself with the redirect", async () => {
    const fetchMock = serve(async () => answer(200, { success: true, redirect: "/?connection=seed%3Aorders-db" }));
    const view = render(<LaunchPage />);
    await clickContinue(view);

    await waitFor(() => expect(location.replace).toHaveBeenCalledTimes(1));
    expect(location.replace).toHaveBeenCalledWith("/?connection=seed%3Aorders-db");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/launch");
    expect(order).toEqual(["replaceState", "me", "fetch"]);
    const [[url, init]] = launchCalls(fetchMock);
    expect(url).toBe("/api/auth/launch");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN });
  });

  test("keeps the base path on the session check, the request and the redirect", async () => {
    await withBasePathEnv("/tools/libredb", async () => {
      location.pathname = "/tools/libredb/launch";
      const fetchMock = serve(async () => answer(200, { success: true, redirect: "/" }));
      const view = render(<LaunchPage />);
      await clickContinue(view);
      await waitFor(() => expect(location.replace).toHaveBeenCalledWith("/tools/libredb/"));
      const urls = (fetchMock.mock.calls as unknown as [string][]).map(([url]) => url);
      expect(urls).toEqual(["/tools/libredb/api/auth/me", "/tools/libredb/api/auth/launch"]);
      expect(replaceState).toHaveBeenCalledWith(null, "", "/tools/libredb/launch");
    });
  });

  test("shows the route's refusal and a way to sign in, and stays on the page", async () => {
    serve(async () =>
      answer(401, {
        success: false,
        message: "This launch link has already been used. Open Studio again to get a new one.",
      }),
    );
    const view = render(<LaunchPage />);
    await clickContinue(view);

    expect(await view.findByText("The launch link did not sign you in")).not.toBeNull();
    expect(
      view.getByText("This launch link has already been used. Open Studio again to get a new one."),
    ).not.toBeNull();
    expect(view.getByRole("link", { name: "Go to sign in" }).getAttribute("href")).toBe("/login");
    expect(location.replace).not.toHaveBeenCalled();
  });

  test("shows the error of an answer the route itself did not write, such as the rate limit", async () => {
    serve(async () => answer(429, { error: "Too many requests. Try again in 42 seconds.", code: "RATE_LIMITED" }));
    const view = render(<LaunchPage />);
    await clickContinue(view);
    expect(await view.findByText("Too many requests. Try again in 42 seconds.")).not.toBeNull();
  });

  test("names the failure when an answer carries neither a redirect nor a reason", async () => {
    serve(async () => answer(200, { success: true }));
    const view = render(<LaunchPage />);
    await clickContinue(view);
    expect(await view.findByText("Studio could not sign you in with this launch link.")).not.toBeNull();
    expect(location.replace).not.toHaveBeenCalled();
  });

  test("says Studio could not be reached when the request or its body fails", async () => {
    serve(async () => {
      throw new TypeError("Failed to fetch");
    });
    const unreachable = render(<LaunchPage />);
    await clickContinue(unreachable);
    expect(
      await unreachable.findByText(
        "Studio could not be reached to finish signing you in. Open Studio again from the platform.",
      ),
    ).not.toBeNull();
    cleanup();

    serve(async () => new Response("<html>gateway error</html>", { status: 502 }));
    const garbled = render(<LaunchPage />);
    await clickContinue(garbled);
    expect(
      await garbled.findByText(
        "Studio could not be reached to finish signing you in. Open Studio again from the platform.",
      ),
    ).not.toBeNull();
  });

  test("says Studio could not be reached when the session check fails, and posts nothing", async () => {
    const fetchMock = serve(
      async () => answer(200, { success: true, redirect: "/" }),
      async () => {
        throw new TypeError("Failed to fetch");
      },
    );
    const view = render(<LaunchPage />);
    expect(
      await view.findByText(
        "Studio could not be reached to finish signing you in. Open Studio again from the platform.",
      ),
    ).not.toBeNull();
    expect(launchCalls(fetchMock)).toEqual([]);
  });

  test("refuses a token it cannot read an account from, and posts nothing", async () => {
    location.hash = "#token=header.payload.signature";
    const fetchMock = serve(async () => answer(200, { success: true, redirect: "/" }));
    const view = render(<LaunchPage />);
    expect(await view.findByText("Studio could not sign you in with this launch link.")).not.toBeNull();
    expect(view.queryByRole("button")).toBeNull();
    expect(launchCalls(fetchMock)).toEqual([]);
  });

  test("without a token in the fragment posts nothing and says so", async () => {
    location.hash = "";
    const fetchMock = serve(async () => answer(200, { success: true, redirect: "/" }));
    const view = render(<LaunchPage />);
    expect(
      await view.findByText(
        "This address carries no launch token. Open Studio again from the platform that sent you, or sign in with your password.",
      ),
    ).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  test("checks the session once even when React runs the effect twice, and posts once on Continue", async () => {
    const fetchMock = serve(async () => answer(200, { success: true, redirect: "/" }));
    const view = render(
      <React.StrictMode>
        <LaunchPage />
      </React.StrictMode>,
    );
    await clickContinue(view);
    await waitFor(() => expect(location.replace).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(launchCalls(fetchMock)).toHaveLength(1);
  });

  test("shows a pending line while the session check and, after Continue, the exchange are in flight", async () => {
    serve(
      () => new Promise<Response>(() => {}),
      () => new Promise<Response>(() => {}),
    );
    const checking = render(<LaunchPage />);
    expect(checking.getByText("Signing you in to LibreDB Studio...")).not.toBeNull();
    cleanup();

    serve(() => new Promise<Response>(() => {}));
    const exchanging = render(<LaunchPage />);
    await clickContinue(exchanging);
    expect(exchanging.getByText("Signing you in to LibreDB Studio...")).not.toBeNull();
    expect(exchanging.queryByRole("button")).toBeNull();
  });
});

describe("the /launch page in a browser signed in to Studio", () => {
  test("posts the token at once, with no click, and replaces itself with the redirect", async () => {
    const fetchMock = serve(async () => answer(200, { success: true, redirect: "/" }), SIGNED_IN);
    const view = render(<LaunchPage />);

    await waitFor(() => expect(location.replace).toHaveBeenCalledWith("/"));
    expect(order).toEqual(["replaceState", "me", "fetch"]);
    expect(launchCalls(fetchMock)).toHaveLength(1);
    expect(view.queryByRole("button")).toBeNull();
  });
});

describe("the /launch page in a browser signed in as someone else", () => {
  const CONFLICT = {
    success: false,
    message:
      "This browser is already signed in to Studio as ada@example.com, and this launch link is for bob@example.com.",
    signedInAs: "ada@example.com",
    launchFor: "bob@example.com",
  };

  function serveConflict(logout: () => Promise<Response>): ReturnType<typeof mock> {
    const fetchMock = mock(async (url: string) => {
      if (String(url).endsWith("/api/auth/me")) return SIGNED_IN();
      return String(url).endsWith("/api/auth/logout") ? logout() : answer(409, CONFLICT);
    });
    globalThis.fetch = fetchMock as never;
    return fetchMock;
  }

  test("names both accounts, keeps the session and offers a sign-out", async () => {
    serveConflict(async () => answer(200, { success: true }));
    const view = render(<LaunchPage />);
    expect(await view.findByText("You are already signed in to Studio")).not.toBeNull();
    expect(
      view.getByText(
        "This browser is signed in as ada@example.com, and the launch link was for bob@example.com. A launch link works once, so this one is used up.",
      ),
    ).not.toBeNull();
    expect(
      view.getByText("Sign out, then open Studio again from the platform to continue as bob@example.com."),
    ).not.toBeNull();
    expect(view.getByRole("button", { name: "Sign out" })).not.toBeNull();
    expect(view.getByRole("link", { name: "Stay signed in as ada@example.com" }).getAttribute("href")).toBe("/");
    expect(location.replace).not.toHaveBeenCalled();
  });

  test("signs out on request and says how to continue as the launched account", async () => {
    const fetchMock = serveConflict(async () => answer(200, { success: true }));
    const view = render(<LaunchPage />);
    fireEvent.click(await view.findByRole("button", { name: "Sign out" }));
    expect(
      await view.findByText("You are signed out. Open Studio again from the platform to continue as bob@example.com."),
    ).not.toBeNull();
    const [url, init] = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/logout");
    expect(init.method).toBe("POST");
  });

  test("says so when the sign-out fails, and keeps the way back to the editor", async () => {
    serveConflict(async () => {
      throw new TypeError("Failed to fetch");
    });
    const view = render(<LaunchPage />);
    fireEvent.click(await view.findByRole("button", { name: "Sign out" }));
    expect(
      await view.findByText(
        "Studio could not sign you out. Sign out from the editor, then open Studio again from the platform.",
      ),
    ).not.toBeNull();
    expect(view.getByRole("link", { name: "Stay signed in as ada@example.com" })).not.toBeNull();
  });
});

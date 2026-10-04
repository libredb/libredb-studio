import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { PASSKEY_CEREMONY_TTL_SECONDS } from "@/lib/passkey/policy";
import { PASSKEY_SETUP_EXPIRED, type PublicPasskey } from "@/lib/passkey/api-types";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";

// The browser library is replaced so each test decides what the authenticator prompt does.
const startAuthentication = mock<(input: unknown) => Promise<unknown>>(async () => ({ id: "assertion" }));
const startRegistration = mock<(input: unknown) => Promise<unknown>>(async () => ({ id: "attestation" }));
let webAuthnSupported = true;
const browserSupportsWebAuthn = mock(() => webAuthnSupported);

mock.module("@simplewebauthn/browser", () => ({ startAuthentication, startRegistration, browserSupportsWebAuthn }));

const {
  PAGE_IP_ADDRESS,
  PAGE_PLAIN_HTTP,
  UNSUPPORTED_BROWSER,
  beginPasskeyCreation,
  ceremonyErrorMessage,
  finishPasskeyCreation,
  passkeyPageBlocker,
  passkeysUsableHere,
  removePasskey,
  renamePasskey,
  signInWithPasskey,
} = await import("@/lib/passkey/client");

const SIGN_IN_PATH = "/api/auth/passkey/sign-in";
const MANAGE_PATH = "/api/auth/passkey";
const RETRY_TEXT = "An error occurred. Please try again.";
const SIGN_IN_CANCELLED =
  "No passkey was used. The request was cancelled or timed out, or this device has no passkey for this site. Try again, or sign in with your password.";
const REGISTRATION_CANCELLED = "No passkey was created. The request was cancelled or timed out.";

const REQUEST_OPTIONS = { challenge: "c2lnbi1pbg", rpId: "studio.example.com" };
const CREATION_OPTIONS: PublicKeyCredentialCreationOptionsJSON = {
  challenge: "cmVnaXN0ZXI",
  rp: { name: "LibreDB Studio" },
  user: { id: "dXNlcg", name: "owner@example.com", displayName: "owner@example.com" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
};
const PASSKEY: PublicPasskey = {
  id: "pk-1",
  name: "Laptop",
  createdAt: "2026-09-28T00:00:00.000Z",
  lastUsedAt: null,
  backupEligible: true,
  backupState: true,
  usable: true,
};

const originalWindow = globalThis.window;

function setPage(url: string, isSecureContext: boolean): void {
  const location = new URL(url);
  Object.defineProperty(globalThis, "window", {
    value: { location, isSecureContext },
    writable: true,
    configurable: true,
  });
}

function notAllowed(): Error {
  const error = new Error("The operation either timed out or was not allowed.");
  error.name = "NotAllowedError";
  return error;
}

// Every request the client sent, with its parsed JSON body, in order.
type Sent = { path: string; method: string; body: Record<string, unknown> };
function recorder(answer: (sent: Sent) => { status?: number; json: unknown }) {
  const sent: Sent[] = [];
  const handler = async (req: Request) => {
    const entry = { path: new URL(req.url).pathname, method: req.method, body: await req.json() };
    sent.push(entry);
    return answer(entry);
  };
  return { sent, handler };
}

beforeEach(() => {
  startAuthentication.mockReset();
  startAuthentication.mockImplementation(async () => ({ id: "assertion" }));
  startRegistration.mockReset();
  startRegistration.mockImplementation(async () => ({ id: "attestation" }));
  webAuthnSupported = true;
});

afterEach(() => {
  restoreGlobalFetch();
  Object.defineProperty(globalThis, "window", { value: originalWindow, writable: true, configurable: true });
});

describe("page checks", () => {
  test("passkeysUsableHere needs WebAuthn support and the configured origin", () => {
    setPage("https://studio.example.com/login", true);
    expect(passkeysUsableHere("https://studio.example.com")).toBe(true);
    expect(passkeysUsableHere("https://other.example.com")).toBe(false);
    webAuthnSupported = false;
    expect(passkeysUsableHere("https://studio.example.com")).toBe(false);
  });

  test("passkeyPageBlocker names an IP-address page before a plain-http one", () => {
    setPage("http://127.0.0.1:41234/settings", true);
    expect(passkeyPageBlocker()).toBe("ip-address");
    setPage("https://192.168.1.5/", true);
    expect(passkeyPageBlocker()).toBe("ip-address");
    setPage("http://[::1]:3000/", true);
    expect(passkeyPageBlocker()).toBe("ip-address");
    // An IP page that is also insecure still names the address, the cause a server change cannot fix.
    setPage("http://192.168.1.5/", false);
    expect(passkeyPageBlocker()).toBe("ip-address");
    setPage("http://studio.lan/", false);
    expect(passkeyPageBlocker()).toBe("plain-http");
    setPage("http://localhost:3000/", true);
    expect(passkeyPageBlocker()).toBeNull();
    setPage("https://studio.example.com/", true);
    expect(passkeyPageBlocker()).toBeNull();
  });

  test("the page notices carry the exact text", () => {
    expect(PAGE_IP_ADDRESS).toBe(
      "This page is open at an IP address, and browsers offer passkeys only on a host name: https with your server's name, or http://localhost on this machine.",
    );
    expect(PAGE_PLAIN_HTTP).toBe(
      "This page is plain http, and browsers offer passkeys only on https, or on http://localhost.",
    );
  });
});

describe("signInWithPasskey", () => {
  test("signInWithPasskey posts options, runs the ceremony and posts the response", async () => {
    const { sent, handler } = recorder(({ body }) =>
      body.action === "options" ? { json: { options: REQUEST_OPTIONS } } : { json: { success: true, role: "admin" } },
    );
    mockGlobalFetch({ [SIGN_IN_PATH]: handler });

    expect(await signInWithPasskey()).toEqual({ ok: true, role: "admin" });
    expect(sent).toEqual([
      { path: SIGN_IN_PATH, method: "POST", body: { action: "options" } },
      { path: SIGN_IN_PATH, method: "POST", body: { action: "verify", response: { id: "assertion" } } },
    ]);
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: REQUEST_OPTIONS });
  });

  test("a refused sign-in returns the server's message", async () => {
    const message = "That passkey could not sign you in.";
    mockGlobalFetch({
      [SIGN_IN_PATH]: async (req) =>
        (await req.json()).action === "options"
          ? { json: { options: REQUEST_OPTIONS } }
          : { status: 401, json: { success: false, message } },
    });
    expect(await signInWithPasskey()).toEqual({ ok: false, message });

    mockGlobalFetch({
      [SIGN_IN_PATH]: async (req) =>
        (await req.json()).action === "options"
          ? { json: { options: REQUEST_OPTIONS } }
          : { status: 429, json: { error: "Too many requests" } },
    });
    expect(await signInWithPasskey()).toEqual({ ok: false, message: "Too many requests" });

    // A body carrying both reads its message, not its error.
    mockGlobalFetch({
      [SIGN_IN_PATH]: async (req) =>
        (await req.json()).action === "options"
          ? { json: { options: REQUEST_OPTIONS } }
          : { status: 401, json: { success: false, message, error: "Unauthorized" } },
    });
    expect(await signInWithPasskey()).toEqual({ ok: false, message });
  });

  test("an options failure never starts a ceremony", async () => {
    mockGlobalFetch({ [SIGN_IN_PATH]: { status: 409, json: { success: false, message: "Passkeys are off." } } });
    expect(await signInWithPasskey()).toEqual({ ok: false, message: "Passkeys are off." });
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  test("a refusal without a readable message falls back to the retry text", async () => {
    mockGlobalFetch({ [SIGN_IN_PATH]: { status: 500, json: [] } });
    expect(await signInWithPasskey()).toEqual({ ok: false, message: RETRY_TEXT });
    mockGlobalFetch({ [SIGN_IN_PATH]: { status: 500, json: { detail: "no message field" } } });
    expect(await signInWithPasskey()).toEqual({ ok: false, message: RETRY_TEXT });
  });

  test("a network failure reads as a retry message", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await signInWithPasskey()).toEqual({ ok: false, message: RETRY_TEXT });
  });

  test("a browser without WebAuthn is told so before any request or prompt", async () => {
    const { sent, handler } = recorder(() => ({ json: { options: REQUEST_OPTIONS } }));
    mockGlobalFetch({ [SIGN_IN_PATH]: handler });
    webAuthnSupported = false;
    expect(await signInWithPasskey()).toEqual({ ok: false, message: UNSUPPORTED_BROWSER });
    expect(startAuthentication).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  test("a cancelled prompt returns the sign-in text and posts nothing more", async () => {
    const { sent, handler } = recorder(() => ({ json: { options: REQUEST_OPTIONS } }));
    mockGlobalFetch({ [SIGN_IN_PATH]: handler });
    startAuthentication.mockImplementation(async () => {
      throw notAllowed();
    });
    expect(await signInWithPasskey()).toEqual({ ok: false, message: SIGN_IN_CANCELLED });
    expect(sent).toHaveLength(1);
  });
});

describe("passkey creation", () => {
  test("beginPasskeyCreation confirms the password and keeps the options", async () => {
    const { sent, handler } = recorder(() => ({ json: { options: CREATION_OPTIONS } }));
    mockGlobalFetch({ [MANAGE_PATH]: handler });

    expect(await beginPasskeyCreation({ password: "pw" }, () => 1234)).toEqual({
      ok: true,
      setup: { options: CREATION_OPTIONS, startedAt: 1234 },
    });
    expect(await beginPasskeyCreation({ password: "pw", code: "123456" }, () => 99)).toEqual({
      ok: true,
      setup: { options: CREATION_OPTIONS, startedAt: 99 },
    });
    expect(sent).toEqual([
      { path: MANAGE_PATH, method: "POST", body: { action: "register-options", password: "pw" } },
      { path: MANAGE_PATH, method: "POST", body: { action: "register-options", password: "pw", code: "123456" } },
    ]);
  });

  test("beginPasskeyCreation reads the clock when none is given", async () => {
    mockGlobalFetch({ [MANAGE_PATH]: { json: { options: CREATION_OPTIONS } } });
    const before = Date.now();
    const result = await beginPasskeyCreation({ password: "pw" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.setup.startedAt).toBeGreaterThanOrEqual(before);
      expect(result.setup.startedAt).toBeLessThanOrEqual(Date.now());
    }
  });

  test("a server answer that asks for a code carries codeRequired", async () => {
    const error = "Enter a current code from your authenticator app.";
    mockGlobalFetch({ [MANAGE_PATH]: { status: 400, json: { error, codeRequired: true } } });
    expect(await beginPasskeyCreation({ password: "pw" })).toEqual({ ok: false, message: error, codeRequired: true });

    mockGlobalFetch({ [MANAGE_PATH]: { status: 401, json: { error: "Wrong password" } } });
    expect(await beginPasskeyCreation({ password: "pw" })).toEqual({
      ok: false,
      message: "Wrong password",
      codeRequired: false,
    });
  });

  test("a network failure while confirming the password reads as a retry message", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await beginPasskeyCreation({ password: "pw" })).toEqual({
      ok: false,
      message: RETRY_TEXT,
      codeRequired: false,
    });
  });

  test("finishPasskeyCreation creates the credential and stores it", async () => {
    const { sent, handler } = recorder(() => ({ json: { passkey: PASSKEY } }));
    mockGlobalFetch({ [MANAGE_PATH]: handler });
    const setup = { options: CREATION_OPTIONS, startedAt: 0 };

    expect(await finishPasskeyCreation(setup, "Laptop", () => 1)).toEqual({ ok: true, passkey: PASSKEY });
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: CREATION_OPTIONS });
    expect(sent).toEqual([
      {
        path: MANAGE_PATH,
        method: "POST",
        body: { action: "register-verify", response: { id: "attestation" }, name: "Laptop" },
      },
    ]);
  });

  test("a cancelled prompt is retried without resending the password or code", async () => {
    const { sent, handler } = recorder(({ body }) =>
      body.action === "register-options" ? { json: { options: CREATION_OPTIONS } } : { json: { passkey: PASSKEY } },
    );
    mockGlobalFetch({ [MANAGE_PATH]: handler });
    const clock = () => 1000;
    startRegistration.mockImplementationOnce(async () => {
      throw notAllowed();
    });

    const begun = await beginPasskeyCreation({ password: "pw", code: "123456" }, clock);
    if (!begun.ok) throw new Error("setup failed");
    expect(await finishPasskeyCreation(begun.setup, undefined, clock)).toEqual({
      ok: false,
      message: REGISTRATION_CANCELLED,
      retry: true,
    });
    expect(await finishPasskeyCreation(begun.setup, undefined, clock)).toEqual({ ok: true, passkey: PASSKEY });

    expect(sent.filter((s) => s.body.action === "register-options")).toHaveLength(1);
    expect(sent.filter((s) => s.body.action === "register-verify")).toHaveLength(1);
    expect(startRegistration).toHaveBeenCalledTimes(2);
  });

  test("an expired setup is refused before the prompt, and never retried", async () => {
    const { sent, handler } = recorder(() => ({ json: { passkey: PASSKEY } }));
    mockGlobalFetch({ [MANAGE_PATH]: handler });
    const setup = { options: CREATION_OPTIONS, startedAt: 5000 };
    const expired = { ok: false as const, message: PASSKEY_SETUP_EXPIRED, retry: false };

    expect(await finishPasskeyCreation(setup, "x", () => 5000 + PASSKEY_CEREMONY_TTL_SECONDS * 1000)).toEqual(expired);
    // With no clock given it is judged against the real time, long after startedAt.
    expect(await finishPasskeyCreation(setup)).toEqual(expired);
    expect(startRegistration).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(PASSKEY_SETUP_EXPIRED).toBe("The passkey setup expired or belongs to another sign-in. Start again.");
  });

  test("a browser without WebAuthn never opens the prompt, and is not retried", async () => {
    const { sent, handler } = recorder(() => ({ json: { passkey: PASSKEY } }));
    mockGlobalFetch({ [MANAGE_PATH]: handler });
    webAuthnSupported = false;
    const setup = { options: CREATION_OPTIONS, startedAt: 5000 };
    expect(await finishPasskeyCreation(setup, "x", () => 5001)).toEqual({
      ok: false,
      message: UNSUPPORTED_BROWSER,
      retry: false,
    });
    expect(startRegistration).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  test("a prompt that fails after the setup expired is not retried", async () => {
    mockGlobalFetch({ [MANAGE_PATH]: { json: { passkey: PASSKEY } } });
    const setup = { options: CREATION_OPTIONS, startedAt: 5000 };
    // Fresh when the prompt opens, expired by the time it fails.
    const times = [5000, 5000 + PASSKEY_CEREMONY_TTL_SECONDS * 1000];
    const clock = () => times.shift() as number;
    startRegistration.mockImplementationOnce(async () => {
      throw notAllowed();
    });
    expect(await finishPasskeyCreation(setup, "x", clock)).toEqual({
      ok: false,
      message: REGISTRATION_CANCELLED,
      retry: false,
    });
  });

  test("a refused or unreachable verify is not retried", async () => {
    const setup = { options: CREATION_OPTIONS, startedAt: 5000 };
    mockGlobalFetch({
      [MANAGE_PATH]: { status: 400, json: { error: "The passkey could not be verified. Try again." } },
    });
    expect(await finishPasskeyCreation(setup, "x", () => 5001)).toEqual({
      ok: false,
      message: "The passkey could not be verified. Try again.",
      retry: false,
    });

    globalThis.fetch = mock(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await finishPasskeyCreation(setup, "x", () => 5001)).toEqual({
      ok: false,
      message: RETRY_TEXT,
      retry: false,
    });
  });
});

describe("ceremonyErrorMessage", () => {
  const withCode = (code: string, name = "Error") => Object.assign(new Error("x"), { code, name });
  const withName = (name: string) => Object.assign(new Error("x"), { name });
  const ALREADY = "This device already holds a passkey for your account.";
  const DOMAIN = "This address cannot use passkeys. Open Studio at the address your administrator set for passkeys.";
  const UV =
    "This authenticator cannot check a PIN, fingerprint or face, or cannot store a passkey. Use another device or security key.";
  const ALG = "This authenticator does not support the key types Studio accepts.";

  test("ceremonyErrorMessage names what happened", () => {
    expect(ceremonyErrorMessage(withCode("ERROR_CEREMONY_ABORTED", "AbortError"), "sign-in")).toBeNull();
    expect(ceremonyErrorMessage(withCode("ERROR_CEREMONY_ABORTED", "AbortError"), "registration")).toBeNull();

    expect(ceremonyErrorMessage(withName("NotAllowedError"), "sign-in")).toBe(SIGN_IN_CANCELLED);
    expect(ceremonyErrorMessage(withName("NotAllowedError"), "registration")).toBe(REGISTRATION_CANCELLED);
    const wrapped = Object.assign(new Error("x"), {
      code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
      cause: notAllowed(),
    });
    expect(ceremonyErrorMessage(wrapped, "sign-in")).toBe(SIGN_IN_CANCELLED);
    expect(ceremonyErrorMessage(wrapped, "registration")).toBe(REGISTRATION_CANCELLED);

    expect(ceremonyErrorMessage(withCode("ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"), "registration")).toBe(ALREADY);
    expect(ceremonyErrorMessage(withName("InvalidStateError"), "registration")).toBe(ALREADY);

    expect(ceremonyErrorMessage(withCode("ERROR_INVALID_DOMAIN"), "sign-in")).toBe(DOMAIN);
    expect(ceremonyErrorMessage(withCode("ERROR_INVALID_RP_ID"), "registration")).toBe(DOMAIN);
    expect(ceremonyErrorMessage(withName("SecurityError"), "sign-in")).toBe(DOMAIN);

    expect(
      ceremonyErrorMessage(withCode("ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT"), "registration"),
    ).toBe(UV);
    expect(
      ceremonyErrorMessage(withCode("ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT"), "registration"),
    ).toBe(UV);
    expect(ceremonyErrorMessage(withName("ConstraintError"), "registration")).toBe(UV);

    expect(
      ceremonyErrorMessage(withCode("ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG"), "registration"),
    ).toBe(ALG);
    expect(ceremonyErrorMessage(withName("NotSupportedError"), "registration")).toBe(ALG);

    expect(UNSUPPORTED_BROWSER).toBe(
      "This browser cannot use passkeys. Try another browser, or sign in with your password.",
    );

    const other = "The passkey request failed. Try again.";
    // The library's own wording is never read: support is checked before a ceremony starts.
    expect(ceremonyErrorMessage(new Error("WebAuthn is not supported in this browser"), "sign-in")).toBe(other);
    expect(ceremonyErrorMessage(new Error("boom"), "sign-in")).toBe(other);
    expect(ceremonyErrorMessage(withName("UnknownError"), "registration")).toBe(other);
    expect(ceremonyErrorMessage("not an error", "sign-in")).toBe(other);
    expect(ceremonyErrorMessage(null, "sign-in")).toBe(other);
    expect(
      ceremonyErrorMessage(Object.assign(new Error("x"), { code: "constructor", name: "toString" }), "sign-in"),
    ).toBe(other);
  });
});

describe("passkey rename and removal", () => {
  test("renamePasskey and removePasskey post their action", async () => {
    const { sent, handler } = recorder(() => ({ json: { ok: true } }));
    mockGlobalFetch({ [MANAGE_PATH]: handler });
    expect(await renamePasskey("pk-1", "Work laptop")).toEqual({ ok: true });
    expect(await removePasskey({ id: "pk-1", password: "pw" })).toEqual({ ok: true });
    expect(await removePasskey({ id: "pk-1", password: "pw", code: "123456" })).toEqual({ ok: true });
    expect(sent).toEqual([
      { path: MANAGE_PATH, method: "POST", body: { action: "rename", id: "pk-1", name: "Work laptop" } },
      { path: MANAGE_PATH, method: "POST", body: { action: "remove", id: "pk-1", password: "pw" } },
      { path: MANAGE_PATH, method: "POST", body: { action: "remove", id: "pk-1", password: "pw", code: "123456" } },
    ]);
  });

  test("a refusal carries the server's message and codeRequired", async () => {
    const error = "Enter a current code from your authenticator app.";
    mockGlobalFetch({ [MANAGE_PATH]: { status: 400, json: { error, codeRequired: true } } });
    expect(await removePasskey({ id: "pk-1", password: "pw" })).toEqual({
      ok: false,
      message: error,
      codeRequired: true,
    });
    mockGlobalFetch({ [MANAGE_PATH]: { status: 400, json: { error: "Name a passkey with 1 to 64 characters." } } });
    expect(await renamePasskey("pk-1", " ")).toEqual({
      ok: false,
      message: "Name a passkey with 1 to 64 characters.",
      codeRequired: false,
    });
  });

  test("a body field named ok never overrides the HTTP status", async () => {
    mockGlobalFetch({ [MANAGE_PATH]: { status: 500, json: { ok: true } } });
    expect(await renamePasskey("pk-1", "x")).toEqual({ ok: false, message: RETRY_TEXT, codeRequired: false });
  });

  test("a network failure or a body that is not JSON reads as a retry message", async () => {
    const retry = { ok: false, message: RETRY_TEXT, codeRequired: false };
    mockGlobalFetch({ [MANAGE_PATH]: { status: 502, text: "<html>Bad Gateway</html>" } });
    expect(await renamePasskey("pk-1", "x")).toEqual(retry);
    expect(await removePasskey({ id: "pk-1", password: "pw" })).toEqual(retry);

    globalThis.fetch = mock(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await renamePasskey("pk-1", "x")).toEqual(retry);
    expect(await removePasskey({ id: "pk-1", password: "pw" })).toEqual(retry);
  });
});

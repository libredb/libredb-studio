/**
 * openshift sign-in keeps the user's token in server memory only (docs/SECURITY.md, control 3.26). Across a sign-in, a
 * signed-in request, a sign-out, every refused sign-in (scope, no uid, no access, a session that cannot be minted) and
 * the two openid-client refusals of a token answer (a token type other than Bearer, a negative expiry):
 * - the access token reaches no sink (cookie, log, console, audit record, response body or header, outgoing URL) and is
 *   sent only as `Authorization: Bearer` to the API server, never to the OAuth server;
 * - the client secret reaches no sink and is sent only in the token request body to the OAuth server;
 * - the session handle reaches no log, audit record or response body;
 * - a refresh token or ID token in the token answer is never handed to the token store.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { decodeJwt } from "jose";
import type { Role } from "@/lib/auth";
import { CookieJar } from "../helpers/openshift-auth/cookie-jar";
import {
  ACCESS_TOKEN,
  CLIENT_SECRET,
  type FakeCluster,
  startFakeCluster,
  USER_PATH,
} from "../helpers/openshift-auth/fake-cluster";
import { callbackRequest } from "../helpers/openshift-auth/sign-in";

const jar = new CookieJar();
mock.module("next/headers", () => jar.module());

let role: Role | null = "user";
mock.module("@/lib/openshift-auth/role", () => ({ openShiftSignInRole: async () => role }));

const { GET: loginGET } = await import("@/app/api/auth/openshift/login/route");
const { GET: callbackGET } = await import("@/app/api/auth/openshift/callback/route");
const { GET: meGET } = await import("@/app/api/auth/me/route");
const { POST: logoutPOST } = await import("@/app/api/auth/logout/route");
const { GET: managedGET } = await import("@/app/api/connections/managed/route");
const tokenStore = await import("@/lib/openshift-auth/token-store");
const { resetOpenShiftMetadataCache } = await import("@/lib/openshift-auth/metadata");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { logger } = await import("@/lib/logger");

const REFRESH_TOKEN = "sha256~not-a-real-token-refresh";
const ID_TOKEN = "not-a-real.id-token.value";
let cluster: FakeCluster;
/** Everything that reached a sink, as text. */
let sunk: string[] = [];
let spies: { mockRestore(): void }[] = [];
let handles: string[] = [];

/** JSON with an error's name, message, stack and cause, which plain JSON.stringify drops. */
function text(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item instanceof Error ? { name: item.name, message: item.message, stack: item.stack, cause: item.cause } : item,
  );
}

async function record(res: Response): Promise<Response> {
  sunk.push(String(res.status), text([...res.headers.entries()]), await res.clone().text());
  return res;
}

beforeAll(async () => {
  cluster = await startFakeCluster();
});

afterAll(async () => {
  await cluster.close();
});

beforeEach(() => {
  cluster.reset();
  cluster.useEnv();
  jar.reset();
  resetOpenShiftMetadataCache();
  tokenStore.resetOpenShiftSessions();
  getServerAuditBuffer().clear();
  process.env.JWT_SECRET = "a-test-secret-that-is-32-chars!!";
  role = "user";
  sunk = [];
  handles = [];
  const capture = (...args: unknown[]) => {
    sunk.push(text(args));
  };
  spies = [
    ...(["debug", "info", "warn", "error"] as const).map((level) => spyOn(logger, level).mockImplementation(capture)),
    ...(["log", "info", "warn", "error", "debug"] as const).map((level) =>
      spyOn(console, level).mockImplementation(capture),
    ),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

/** A sign-in through both routes; every response is recorded as a sink. */
async function signIn(between: () => void = () => {}): Promise<Response> {
  const login = await record(await loginGET(new Request("http://localhost:3000/api/auth/openshift/login")));
  const params = cluster.authorize(new URL(login.headers.get("location") ?? ""));
  between();
  return record(await callbackGET(callbackRequest(params)));
}

/** Every cookie written, raw and with a JWT's payload decoded, so a value inside a signed cookie is seen too. */
function cookieTexts(): string[] {
  return jar.writes.flatMap((write) => {
    const value = write.value ?? "";
    let payload = "";
    try {
      payload = text(decodeJwt(value));
    } catch {
      payload = "";
    }
    return [value, payload];
  });
}

function checkCustody(): void {
  const audit = text(getServerAuditBuffer().getAll());
  const everySink = [...sunk, ...cookieTexts(), audit].join("\n");
  // INV-1 and INV-2: neither the access token nor the client secret reached a sink.
  expect(everySink).not.toContain(ACCESS_TOKEN);
  expect(everySink).not.toContain(CLIENT_SECRET);
  // INV-3: the session handle reached no log, audit record or response (the session cookie is where it belongs).
  for (const handle of handles) expect([...sunk, audit].join("\n")).not.toContain(handle);
  for (const request of cluster.requests) {
    const url = `${request.path}${request.query}`;
    expect(url).not.toContain(ACCESS_TOKEN);
    expect(url).not.toContain(CLIENT_SECRET);
    if (request.server === "oauth") {
      // INV-4: the OAuth server never sees the access token; INV-2: the secret goes only in the token request body.
      expect(text(request.headers)).not.toContain(ACCESS_TOKEN);
      expect(request.body).not.toContain(ACCESS_TOKEN);
      expect(text(request.headers)).not.toContain(CLIENT_SECRET);
    } else {
      // The API server never sees the secret, and sees the token only as the bearer of users/~.
      expect(text(request)).not.toContain(CLIENT_SECRET);
      expect(request.body).not.toContain(ACCESS_TOKEN);
      const bearer = request.headers.authorization;
      if (bearer !== undefined) {
        expect(request.path).toBe(USER_PATH);
        expect(bearer).toBe(`Bearer ${ACCESS_TOKEN}`);
      }
    }
  }
}

describe("token custody in openshift sign-in", () => {
  test("a sign-in, a signed-in request and a sign-out", async () => {
    cluster.tokenAnswer = { ...cluster.tokenAnswer, refresh_token: REFRESH_TOKEN };
    const store = spyOn(tokenStore, "storeOpenShiftSession");
    try {
      await signIn();
      // INV-28: the store receives the access token and nothing from the rest of the answer.
      expect(store).toHaveBeenCalledTimes(1);
      const [handle, stored] = store.mock.calls[0];
      handles.push(handle);
      expect(Object.keys(stored).sort()).toEqual(["expiresAtMs", "issuer", "name", "token", "uid"]);
      expect(text(store.mock.calls)).not.toContain(REFRESH_TOKEN);
    } finally {
      store.mockRestore();
    }
    const cookie = jar.written("auth-token").find((write) => write.op === "set");
    expect(cookie).toBeDefined();
    jar.values.set("auth-token", cookie?.value ?? "");
    const me = await record(await meGET());
    expect(me.status).toBe(200);
    await record(await managedGET());
    await record(await logoutPOST(new Request("http://localhost:3000/api/auth/logout", { method: "POST" }) as never));
    expect(cluster.received("api").filter((request) => request.path === USER_PATH)).toHaveLength(1);
    checkCustody();
  });

  test("an ID token in the answer fails the sign-in as malformed: nothing stored, no session cookie", async () => {
    cluster.tokenAnswer = { ...cluster.tokenAnswer, id_token: ID_TOKEN };
    const store = spyOn(tokenStore, "storeOpenShiftSession");
    try {
      const res = await signIn();
      expect(res.headers.get("location")).toBe("https://studio.apps.example.com/login?error=openshift_failed");
      expect(store).not.toHaveBeenCalled();
    } finally {
      store.mockRestore();
    }
    expect(sunk.some((line) => line.includes('"step":"token","reason":"malformed"'))).toBe(true);
    expect(jar.written("auth-token")).toEqual([]);
    checkCustody();
  });

  test("every refused sign-in", async () => {
    const refusals: [string, () => void][] = [
      ["scope", () => (cluster.tokenAnswer = { ...cluster.tokenAnswer, scope: "user:full" })],
      ["no uid", () => (cluster.user = { ...cluster.user, uid: undefined })],
      ["no access", () => (role = null)],
      ["token type", () => (cluster.tokenAnswer = { ...cluster.tokenAnswer, token_type: "mac" })],
      ["negative expiry", () => (cluster.tokenAnswer = { ...cluster.tokenAnswer, expires_in: -1 })],
    ];
    for (const [name, refuse] of refusals) {
      cluster.reset();
      role = "user";
      refuse();
      await signIn();
      expect(
        jar.written("auth-token").filter((write) => write.op === "set"),
        name,
      ).toEqual([]);
    }
    cluster.reset();
    await signIn(() => {
      jar.failNextSet = new Error(`cookie store refused ${ACCESS_TOKEN}`);
    });
    checkCustody();
  });
});

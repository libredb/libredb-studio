/**
 * Host-prefixed cookie names (docs/SECURITY.md, control 1.13).
 *
 * Whenever Studio's auth cookies carry the Secure flag, every cookie Studio sets has a `__Host-` name, so a browser
 * holds it only with Secure, host-only, at Path=/ and without a Domain; every reader and deleter uses that name alone.
 * Pinned three ways: a source guard over every module that touches a cookie store, the real routes and modules driven
 * end to end with each recorded write passed through Next's own Set-Cookie serializer, and a jar holding the plain name
 * of every Studio cookie that no reader ever looks at.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import * as realOidc from "@/lib/oidc";
import { CookieJar, type CookieWrite } from "../helpers/openshift-auth/cookie-jar";
import { type FakeCluster, startFakeCluster } from "../helpers/openshift-auth/fake-cluster";
import { approvedSignIn, callbackRequest } from "../helpers/openshift-auth/sign-in";

const jar = new CookieJar();
mock.module("next/headers", () => jar.module());

const ISSUER = "https://idp.example/realms/libredb";
mock.module("@/lib/oidc", () => ({
  ...realOidc,
  discoverProvider: async () => ({}),
  generateAuthUrl: async () => ({
    url: new URL(`${ISSUER}/authorize?state=s-1`),
    state: { code_verifier: "verifier-1", state: "s-1", nonce: "n-1" },
  }),
  exchangeCode: async () => ({
    claims: { sub: "kc-user-1", iss: ISSUER, email: "alice@example.com" },
    idToken: "header.payload.signature",
  }),
  mapOIDCRole: () => "user",
  buildLogoutUrl: async () => null,
}));

const { POST: passwordLogin } = await import("@/app/api/auth/login/route");
const { GET: oidcLogin } = await import("@/app/api/auth/oidc/login/route");
const { GET: oidcCallback } = await import("@/app/api/auth/oidc/callback/route");
const { POST: logoutRoute } = await import("@/app/api/auth/logout/route");
const { GET: openShiftLogin } = await import("@/app/api/auth/openshift/login/route");
const { GET: openShiftCallback } = await import("@/app/api/auth/openshift/callback/route");
const { getSession } = await import("@/lib/auth");
const { openRegistrationCeremony, openSignInCeremony, takeRegistrationCeremony, takeSignInCeremony } = await import(
  "@/lib/passkey/ceremony"
);
const { resetOpenShiftMetadataCache } = await import("@/lib/openshift-auth/metadata");
const { resetOpenShiftSessions } = await import("@/lib/openshift-auth/token-store");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");

/** Every cookie Studio sets, by its plain name. */
const STUDIO_COOKIES = [
  "auth-token",
  "oidc-state",
  "oidc-logout-hint",
  "openshift-state",
  "access-review-retry",
  "passkey-sign-in",
  "passkey-registration",
] as const;

const ROOT = join(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");

/** The modules that hold a cookie store; a new one fails the guard until it is listed here and scoped the same way. */
const COOKIE_STORE_MODULES = [
  "src/app/api/auth/logout/route.ts",
  "src/app/api/auth/oidc/callback/route.ts",
  "src/app/api/auth/oidc/login/route.ts",
  "src/app/api/auth/openshift/callback/route.ts",
  "src/app/api/auth/openshift/login/route.ts",
  "src/lib/auth.ts",
  "src/lib/passkey/ceremony.ts",
  "src/proxy.ts",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const relativePath = (path: string) => relative(ROOT, path).split(sep).join("/");

/** The first argument of the call whose opening parenthesis is at `open`, balanced over nested parentheses. */
function firstArgument(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if ((depth === 0 && char === ")") || (depth === 1 && char === ",")) return source.slice(open + 1, index).trim();
  }
  throw new Error("unbalanced call");
}

describe("every module that touches a cookie store takes the cookie's name from its scope", () => {
  test("the modules holding a cookie store are exactly the listed ones", () => {
    const holders = sourceFiles(SRC)
      .filter((path) => /\bcookies\(\)|\brequest\.cookies\b/.test(readFileSync(path, "utf8")))
      .map(relativePath)
      .sort();
    expect(holders).toEqual(COOKIE_STORE_MODULES);
  });

  test("each one scopes its cookies, reads and sets by the scope's name and deletes through cookieDeletion", () => {
    const wrong: string[] = [];
    for (const file of COOKIE_STORE_MODULES) {
      const source = readFileSync(join(ROOT, file), "utf8");
      if (!/\b(studioCookie|cookieScope)\(/.test(source)) wrong.push(`${file} never scopes a cookie`);
      const calls = source.matchAll(
        /\b(?:cookieStore|store|request\.cookies|\(await cookies\(\)\))\.(get|set|delete)\(/g,
      );
      let seen = 0;
      for (const call of calls) {
        seen += 1;
        const argument = firstArgument(source, (call.index ?? 0) + call[0].length - 1);
        const allowed = call[1] === "delete" ? /^cookieDeletion\(/.test(argument) : /\.name$/.test(argument);
        if (!allowed) wrong.push(`${file}: ${call[0]}${argument})`);
      }
      if (seen === 0) wrong.push(`${file} holds a cookie store but the guard matched no call on it`);
    }
    expect(wrong).toEqual([]);
  });

  test("no module outside the one that defines it writes a Studio cookie's name", () => {
    const definers: Record<string, string> = {
      "auth-token": "src/lib/auth-cookies.ts",
      "oidc-state": "src/lib/auth-cookies.ts",
      "oidc-logout-hint": "src/lib/config/oidc-logout-hint.ts",
      "openshift-state": "src/lib/openshift-auth/state.ts",
      "access-review-retry": "src/lib/kubernetes-access/session-guard.ts",
      "passkey-sign-in": "src/lib/passkey/ceremony.ts",
      "passkey-registration": "src/lib/passkey/ceremony.ts",
    };
    const wrong: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const source = readFileSync(path, "utf8");
      for (const name of STUDIO_COOKIES) {
        if (new RegExp(`["'](?:__Host-)?${name}["']`).test(source) && relativePath(path) !== definers[name]) {
          wrong.push(`${relativePath(path)} names ${name}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

/** The Set-Cookie line Next writes for one recorded cookie write. */
function serialized(write: CookieWrite): string {
  const response = new NextResponse(null);
  if (write.op === "set") response.cookies.set(write.name, write.value ?? "", write.options);
  else response.cookies.delete(write.options as { name: string });
  const [line] = response.headers.getSetCookie();
  return line;
}

/** What a browser requires of a `__Host-` cookie, set or deleted, or the reason the line falls short. */
function hostPrefixProblems(line: string): string[] {
  const problems: string[] = [];
  const attributes = line.split(";").map((part) => part.trim());
  if (!attributes[0].startsWith("__Host-")) problems.push("no __Host- name");
  if (!attributes.includes("Secure")) problems.push("no Secure");
  if (!attributes.includes("Path=/")) problems.push("not Path=/");
  if (attributes.some((part) => /^domain=/i.test(part))) problems.push("a Domain");
  return problems;
}

describe("with Secure on, every cookie the real routes write is a __Host- cookie", () => {
  let cluster: FakeCluster;
  const OIDC_ENV = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_LOGOUT_HINT", "AUTH_COOKIE_SECURE"];
  const saved = new Map<string, string | undefined>();
  let log: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    cluster = await startFakeCluster();
  });

  afterAll(async () => {
    await cluster.close();
  });

  beforeEach(() => {
    for (const name of OIDC_ENV) saved.set(name, process.env[name]);
    process.env.AUTH_COOKIE_SECURE = "true";
    jar.reset();
    clearRateLimitState();
    resetOpenShiftMetadataCache();
    resetOpenShiftSessions();
    log = spyOn(console, "log").mockImplementation(() => {});
    // The plain name of every Studio cookie, as a browser upgraded from plain names still holds them.
    for (const name of STUDIO_COOKIES) jar.values.set(name, "a-plain-named-cookie");
  });

  afterEach(() => {
    log.mockRestore();
    cluster.restoreEnv();
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function signInEveryWay(): Promise<void> {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    const password = await passwordLogin(
      new NextRequest("https://studio.example.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
        body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
      }),
    );
    expect(password.status).toBe(200);

    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    process.env.OIDC_ISSUER = ISSUER;
    process.env.OIDC_CLIENT_ID = "studio";
    process.env.OIDC_CLIENT_SECRET = "a-client-secret";
    process.env.OIDC_LOGOUT_HINT = "true";
    expect((await oidcLogin(new Request("https://studio.example.com/api/auth/oidc/login"))).status).toBe(307);
    const callback = await oidcCallback(
      new Request("https://studio.example.com/api/auth/oidc/callback?code=c-1&state=s-1"),
    );
    expect(callback.headers.get("location")).toBe("https://studio.example.com/");
    const logout = await logoutRoute(new NextRequest("https://studio.example.com/api/auth/logout", { method: "POST" }));
    expect(logout.status).toBe(200);

    cluster.reset();
    cluster.useEnv();
    const { params } = await approvedSignIn(openShiftLogin, cluster);
    expect((await openShiftCallback(callbackRequest(params))).headers.get("location")).toBe(
      "https://studio.apps.example.com/",
    );
    // A restart empties the token store, so the session is refused once and the retry marker is armed.
    resetOpenShiftSessions();
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await getSession()).toBeNull();
    } finally {
      info.mockRestore();
    }

    await openSignInCeremony("localhost");
    await takeSignInCeremony();
    await openRegistrationCeremony({
      rpId: "localhost",
      email: "owner@example.com",
      sessionVersion: 1,
      userHandle: Buffer.alloc(64, 7).toString("base64url"),
    });
    await takeRegistrationCeremony();
  }

  test("each write meets the __Host- rules through Next's serializer, and all seven cookies are written", async () => {
    await signInEveryWay();

    const problems = jar.writes.flatMap((write) => {
      const line = serialized(write);
      return hostPrefixProblems(line).map((problem) => `${write.op} ${write.name}: ${problem} in ${line}`);
    });
    expect(problems).toEqual([]);
    const written = new Set(jar.writes.filter((write) => write.op === "set").map((write) => write.name));
    expect([...written].sort()).toEqual(STUDIO_COOKIES.map((name) => `__Host-${name}`).sort());
  });

  test("the plain name of a Studio cookie is never read, whichever cookie it is", async () => {
    await signInEveryWay();

    expect(jar.reads.filter((name) => (STUDIO_COOKIES as readonly string[]).includes(name))).toEqual([]);
    // And never written over or deleted: the browser's plain-named cookie only expires.
    expect(jar.writes.filter((write) => (STUDIO_COOKIES as readonly string[]).includes(write.name))).toEqual([]);
  });
});

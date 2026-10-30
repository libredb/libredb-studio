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
import { withBasePathEnv } from "../helpers/base-path";
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

/** The modules that touch a cookie; a new one fails the guard until it is listed here and scoped the same way. */
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

/**
 * Modules that write a cookie but are no Studio cookie, each with its reason. A module listed here must stay imported
 * by nothing, so the browser never receives its cookie; the moment something imports it, the guard fails.
 */
const UNUSED_COOKIE_WRITERS: Record<string, string> = {
  // The shadcn sidebar primitive keeps its open state in a client-side cookie; nothing renders it.
  "src/components/ui/sidebar.tsx": "unused shadcn primitive, a client-side UI preference cookie",
};

/** Whether a source touches a cookie by any API: a request cookie store, a response's cookies, a Set-Cookie header or document.cookie. */
const COOKIE_API =
  /\bcookies\(\)|\.cookies\.(?:get|getAll|has|set|delete)\(|\brequest\.cookies\b|\bdocument\.cookie\b|\.(?:set|append)\(\s*["'`]set-cookie["'`]|["'`]set-cookie["'`]\s*:/i;

/** A Set-Cookie header or document.cookie: a cookie write the scoped-call guard below cannot see into. */
const RAW_COOKIE_WRITE = /\bdocument\.cookie\b|\.(?:set|append)\(\s*["'`]set-cookie["'`]|["'`]set-cookie["'`]\s*:/i;

/**
 * Every call on a cookie store in `source` that does not take its name from a scope, or delete through cookieDeletion.
 * A store is `(await cookies())`, any `<x>.cookies`, and every name `await cookies()` is assigned to or a parameter
 * typed as its result is given, whatever that name is.
 */
function unscopedCookieCalls(source: string): { calls: number; wrong: string[] } {
  const names = [
    ...source.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*await\s+cookies\(\)/g),
    ...source.matchAll(/\b([\w$]+)\s*:\s*Awaited<ReturnType<typeof cookies>>/g),
  ].map((match) => match[1]);
  const holders = ["\\(await cookies\\(\\)\\)", "[\\w$]+(?:\\.[\\w$]+)*\\.cookies", ...new Set(names)];
  const pattern = new RegExp(`(?<![\\w$.])(?:${holders.join("|")})\\.(get|getAll|has|set|delete)\\(`, "g");
  const wrong: string[] = [];
  let calls = 0;
  for (const call of source.matchAll(pattern)) {
    calls += 1;
    const argument = firstArgument(source, (call.index ?? 0) + call[0].length - 1);
    const allowed = call[1] === "delete" ? /^cookieDeletion\(/.test(argument) : /\.name$/.test(argument);
    if (!allowed) wrong.push(`${call[0]}${argument})`);
  }
  return { calls, wrong };
}

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
  test("the guard sees every cookie API, under any variable name", () => {
    for (const source of [
      "const res = NextResponse.next(); res.cookies.set('x', '1');",
      "headers.append('Set-Cookie', 'x=1');",
      'new Response(null, { headers: { "set-cookie": "x=1" } });',
      "document.cookie = 'x=1';",
      "const jar = await cookies(); jar.get('x');",
    ]) {
      expect({ source, seen: COOKIE_API.test(source) }).toEqual({ source, seen: true });
    }
    expect(RAW_COOKIE_WRITE.test("headers.set(`Set-Cookie`, line)")).toBe(true);
    expect(unscopedCookieCalls("const jar = await cookies(); jar.set('x', v);").wrong).toEqual(["jar.set('x')"]);
    expect(unscopedCookieCalls("this.response.cookies.delete('x');").wrong).toEqual([
      "this.response.cookies.delete('x')",
    ]);
    expect(unscopedCookieCalls("function f(c: Awaited<ReturnType<typeof cookies>>) { c.get('x'); }").wrong).toEqual([
      "c.get('x')",
    ]);
    expect(
      unscopedCookieCalls("const s = await cookies(); s.set(scope.name, v); s.delete(cookieDeletion(scope));"),
    ).toEqual({ calls: 2, wrong: [] });
  });

  test("the modules touching a cookie are exactly the listed ones, and the unused writers stay unimported", () => {
    const files = sourceFiles(SRC);
    const holders = files
      .filter((path) => COOKIE_API.test(readFileSync(path, "utf8")))
      .map(relativePath)
      .sort();
    expect(holders).toEqual([...COOKIE_STORE_MODULES, ...Object.keys(UNUSED_COOKIE_WRITERS)].sort());
    const importers = files.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return Object.keys(UNUSED_COOKIE_WRITERS)
        .map((writer) => writer.replace(/^src\//, "@/").replace(/\.tsx?$/, ""))
        .filter((specifier) => source.includes(`"${specifier}"`) || source.includes(`'${specifier}'`))
        .map((specifier) => `${relativePath(path)} imports ${specifier}`);
    });
    expect(importers).toEqual([]);
  });

  test("each one scopes its cookies, reads and sets by the scope's name and deletes through cookieDeletion", () => {
    const wrong: string[] = [];
    for (const file of COOKIE_STORE_MODULES) {
      const source = readFileSync(join(ROOT, file), "utf8");
      if (!/\b(studioCookie|cookieScope)\(/.test(source)) wrong.push(`${file} never scopes a cookie`);
      if (RAW_COOKIE_WRITE.test(source)) wrong.push(`${file} writes a cookie through a raw header or document.cookie`);
      const { calls, wrong: unscoped } = unscopedCookieCalls(source);
      for (const call of unscoped) wrong.push(`${file}: ${call}`);
      if (calls === 0) wrong.push(`${file} holds a cookie store but the guard matched no call on it`);
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

  async function signInEveryWay(basePath: string): Promise<void> {
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
    expect(callback.headers.get("location")).toBe(`https://studio.example.com${basePath}/`);
    const logout = await logoutRoute(new NextRequest("https://studio.example.com/api/auth/logout", { method: "POST" }));
    expect(logout.status).toBe(200);

    cluster.reset();
    cluster.useEnv();
    // The URL people open Studio at carries the base path (src/lib/openshift-auth/config.ts).
    process.env.OPENSHIFT_PUBLIC_URL = `${process.env.OPENSHIFT_PUBLIC_URL}${basePath}`;
    const { params } = await approvedSignIn(openShiftLogin, cluster);
    expect((await openShiftCallback(callbackRequest(params))).headers.get("location")).toBe(
      `https://studio.apps.example.com${basePath}/`,
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

  const isPlainName = (name: string) => (STUDIO_COOKIES as readonly string[]).includes(name);

  // At the root and under a base path, where a `__Host-` cookie still sits at Path=/ and its name carries the segments.
  for (const [basePath, suffix] of [
    ["", ""],
    ["/tools/libredb", ".tools.libredb"],
  ] as const) {
    const inBasePath = (action: () => Promise<void>) =>
      basePath === "" ? action() : withBasePathEnv(basePath, action);
    const where = basePath === "" ? "at the root" : `under ${basePath}`;

    test(`${where}, each write meets the __Host- rules through Next's serializer, and all seven are written`, async () => {
      await inBasePath(() => signInEveryWay(basePath));

      // The plain-named writes are the session cookie's legacy delete, pinned by the next case.
      const problems = jar.writes
        .filter((write) => !isPlainName(write.name))
        .flatMap((write) => {
          const line = serialized(write);
          return hostPrefixProblems(line).map((problem) => `${write.op} ${write.name}: ${problem} in ${line}`);
        });
      expect(problems).toEqual([]);
      const written = new Set(jar.writes.filter((write) => write.op === "set").map((write) => write.name));
      expect([...written].sort()).toEqual(STUDIO_COOKIES.map((name) => `__Host-${name}${suffix}`).sort());
    });

    test(`${where}, the plain name of a Studio cookie is never read, and only the plain session cookie is deleted`, async () => {
      await inBasePath(() => signInEveryWay(basePath));

      expect(jar.reads.filter(isPlainName)).toEqual([]);
      // Never written over: the one plain-named write is the delete of the session cookie at its plain path, so a
      // signed-out session cannot come back on a rollback to plain names. Every other plain-named cookie only expires.
      const plainWrites = jar.writes.filter((write) => isPlainName(write.name)).map(serialized);
      expect(plainWrites.length).toBeGreaterThan(0);
      expect([...new Set(plainWrites)]).toEqual([
        `auth-token=; Path=${basePath || "/"}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      ]);
    });
  }
});

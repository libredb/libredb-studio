import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// A session cookie alone must not change an account's second factor: whoever steals the cookie
// would remove it, or replace it with their own. So setting one up and turning it off both ask for
// the current password, turning it off also asks for a current code, and a wrong answer is charged
// to the same budget as a failed login.

const cookieStore: Record<string, { value: string } | undefined> = {};

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore[name],
    set: (name: string, value: string) => {
      cookieStore[name] = { value };
    },
    delete: () => {},
  }),
  headers: async () => ({ get: () => null }),
}));

const accountsRoute = await import("@/app/api/admin/accounts/route");
const totpRoute = await import("@/app/api/auth/totp/route");
const { POST: login } = await import("@/app/api/auth/login/route");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { clearTotpReplayState, decodeBase32, TOTP_PERIOD_SECONDS } = await import("@/lib/totp");
const { closeStorageProvider, getStorageProvider } = await import("@/lib/storage/factory");

const dir = mkdtempSync(join(tmpdir(), "libredb-totp-reauth-"));
// The suite password lives in tests/setup.ts. Repeating the literal here is what GitGuardian flags.
const adminPassword = process.env.ADMIN_PASSWORD ?? "";
const KEYS = [
  "STORAGE_PROVIDER",
  "STORAGE_SQLITE_PATH",
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "ADMIN_TOTP_SECRET",
  "USER_TOTP_SECRET",
];
const savedEnv: Record<string, string | undefined> = {};
const ALICE = "alice@example.com";
const ALICE_PASSWORD = "alice-pass-1";

function request(body: unknown, ip = "203.0.113.50") {
  return new Request("http://localhost/api/auth/totp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

async function signIn(email: string, password: string, totp?: string) {
  delete cookieStore["auth-token"];
  const res = await login(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.51" },
      body: JSON.stringify({ email, password, ...(totp ? { totp } : {}) }),
    }) as never,
  );
  return { status: res.status, token: cookieStore["auth-token"]?.value ?? "" };
}

function codeFor(secret: string, offset = 0): string {
  const key = decodeBase32(secret);
  if (!key) throw new Error("secret did not decode");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS) + offset));
  const digest = createHmac("sha1", key).update(counter).digest();
  const at = digest[digest.length - 1] & 0x0f;
  return ((digest.readUInt32BE(at) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

async function storedFactor() {
  const provider = await getStorageProvider();
  const row = await provider?.getAccount(ALICE);
  return { secret: row?.totpSecret ?? null, pending: row?.totpPending ?? null };
}

async function enrol(): Promise<string> {
  const begun = await totpRoute.POST(request({ action: "begin", password: ALICE_PASSWORD }));
  expect(begun.status).toBe(200);
  const { secret } = (await begun.json()) as { secret: string };
  expect((await totpRoute.POST(request({ action: "confirm", code: codeFor(secret) }))).status).toBe(200);
  return secret;
}

describe("changing your own second factor needs more than the session", () => {
  let alice = "";

  beforeAll(async () => {
    for (const key of KEYS) savedEnv[key] = process.env[key];
    process.env.STORAGE_PROVIDER = "sqlite";
    process.env.STORAGE_SQLITE_PATH = join(dir, "store.db");
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    delete process.env.ADMIN_TOTP_SECRET;
    delete process.env.USER_TOTP_SECRET;
    cookieStore["auth-token"] = { value: (await signIn("admin@libredb.org", adminPassword)).token };
    const created = await accountsRoute.POST(
      new Request("http://localhost/api/admin/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: ALICE, password: ALICE_PASSWORD, role: "user" }),
      }),
    );
    expect(created.status).toBe(201);
  });

  beforeEach(async () => {
    clearRateLimitState();
    clearTotpReplayState();
    const provider = await getStorageProvider();
    const row = await provider?.getAccount(ALICE);
    if (row) await provider?.updateAccount({ ...row, totpSecret: null, totpPending: null });
    alice = (await signIn(ALICE, ALICE_PASSWORD)).token;
    cookieStore["auth-token"] = { value: alice };
  });

  afterAll(async () => {
    await closeStorageProvider();
    for (const key of KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("setup without the current password is refused and writes nothing", async () => {
    const missing = await totpRoute.POST(request({ action: "begin" }));
    expect(missing.status).toBe(400);
    const wrong = await totpRoute.POST(request({ action: "begin", password: "not-alice" }));
    expect(wrong.status).toBe(401);
    expect(await storedFactor()).toEqual({ secret: null, pending: null });
  });

  test("setup with the current password returns a secret that a code confirms", async () => {
    const secret = await enrol();
    expect((await storedFactor()).secret).toBe(secret);
    // At rest the column holds the sealed envelope, never the base32 secret.
    const raw = new Database(join(dir, "store.db"), { readonly: true });
    const column = raw.prepare("SELECT totp_secret FROM accounts WHERE email = ?").get(ALICE) as {
      totp_secret: string;
    };
    raw.close();
    expect(column.totp_secret).toStartWith("v1:");
    expect(column.totp_secret).not.toContain(secret);
    expect((await signIn(ALICE, ALICE_PASSWORD)).status).toBe(401);
  });

  test("an active factor cannot be replaced, only turned off first", async () => {
    const secret = await enrol();
    const again = await totpRoute.POST(request({ action: "begin", password: ALICE_PASSWORD }));
    expect(again.status).toBe(409);
    expect(await storedFactor()).toEqual({ secret, pending: null });
  });

  test("turning an active factor off needs the password and a current code", async () => {
    const secret = await enrol();
    clearTotpReplayState();
    expect((await totpRoute.POST(request({ action: "disable" }))).status).toBe(400);
    // A missing field is not a guess: 400, and nothing is charged.
    expect((await totpRoute.POST(request({ action: "disable", password: ALICE_PASSWORD }))).status).toBe(400);
    expect(
      (await totpRoute.POST(request({ action: "disable", password: "not-alice", code: codeFor(secret) }))).status,
    ).toBe(401);
    expect(
      (await totpRoute.POST(request({ action: "disable", password: ALICE_PASSWORD, code: "000000" }))).status,
    ).toBe(401);
    expect((await storedFactor()).secret).toBe(secret);

    const off = await totpRoute.POST(
      request({ action: "disable", password: ALICE_PASSWORD, code: codeFor(secret, 1) }),
    );
    expect(off.status).toBe(200);
    expect(await storedFactor()).toEqual({ secret: null, pending: null });
    expect((await signIn(ALICE, ALICE_PASSWORD)).status).toBe(200);
  });

  test("the code that confirmed setup cannot be replayed to turn the factor off", async () => {
    const begun = await totpRoute.POST(request({ action: "begin", password: ALICE_PASSWORD }));
    const { secret } = (await begun.json()) as { secret: string };
    const code = codeFor(secret);
    expect((await totpRoute.POST(request({ action: "confirm", code }))).status).toBe(200);
    expect((await totpRoute.POST(request({ action: "disable", password: ALICE_PASSWORD, code }))).status).toBe(401);
    expect((await storedFactor()).secret).toBe(secret);
  });

  test("turning off with no factor active still needs the password", async () => {
    expect((await totpRoute.POST(request({ action: "disable", password: "not-alice" }))).status).toBe(401);
    expect((await totpRoute.POST(request({ action: "disable", password: ALICE_PASSWORD }))).status).toBe(200);
  });

  test("GET says whether this account has a factor, and needs a session", async () => {
    const status = () => totpRoute.GET(new Request("http://localhost/api/auth/totp"));
    expect(await (await status()).json()).toEqual({ available: true, enabled: false });
    await enrol();
    expect(await (await status()).json()).toEqual({ available: true, enabled: true });
    delete cookieStore["auth-token"];
    expect((await status()).status).toBe(401);
  });

  test("GET answers a registry that fails mid-request as a server error, not as a status", async () => {
    const provider = await getStorageProvider();
    if (!provider) throw new Error("sqlite provider missing");
    const row = await provider.getAccount(ALICE);
    // The session check reads the row first; the status read after it is the one that fails.
    const failure = spyOn(provider, "getAccount")
      .mockResolvedValueOnce(row)
      .mockRejectedValueOnce(new Error("database is locked"));
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await totpRoute.GET(new Request("http://localhost/api/auth/totp"));
      expect(res.status).toBe(500);
      expect(await res.json()).not.toHaveProperty("available");
    } finally {
      failure.mockRestore();
      errors.mockRestore();
    }
  });

  test("GET explains why setup is not offered under OIDC or without a server store", async () => {
    const status = async () =>
      (await (await totpRoute.GET(new Request("http://localhost/api/auth/totp"))).json()) as {
        available: boolean;
        reason?: string;
      };
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    try {
      const oidc = await status();
      expect(oidc.available).toBe(false);
      expect(oidc.reason).toContain("identity provider");
    } finally {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    }
    await closeStorageProvider();
    process.env.STORAGE_PROVIDER = "local";
    try {
      const local = await status();
      expect(local.available).toBe(false);
      expect(local.reason).toContain("ADMIN_TOTP_SECRET");
    } finally {
      process.env.STORAGE_PROVIDER = "sqlite";
    }
  });

  test("wrong answers spend the login budget, so the two routes share one guess limit", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await totpRoute.POST(request({ action: "begin", password: `guess-${i}` }))).status).toBe(401);
    }
    const throttled = await totpRoute.POST(request({ action: "begin", password: ALICE_PASSWORD }));
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).not.toBeNull();
    // Same address, the login route: the budget is already spent.
    const viaLogin = await login(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.50" },
        body: JSON.stringify({ email: ALICE, password: ALICE_PASSWORD }),
      }) as never,
    );
    expect(viaLogin.status).toBe(429);
  });
});

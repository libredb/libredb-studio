import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Once the registry is seeded the environment no longer decides the admin's password, so an
// operator who rotates ADMIN_PASSWORD, or who is locked out, needs to be told and needs a way back.
// closeStorageProvider() stands in for a restart: the next request opens a fresh provider.

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
const emailRoute = await import("@/app/api/admin/accounts/[email]/route");
const { POST: login } = await import("@/app/api/auth/login/route");
const { GET: me } = await import("@/app/api/auth/me/route");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { closeStorageProvider, getStorageProvider } = await import("@/lib/storage/factory");

const dir = mkdtempSync(join(tmpdir(), "libredb-account-recovery-"));
const ADMIN = "admin@libredb.org";
const KEYS = [
  "STORAGE_PROVIDER",
  "STORAGE_SQLITE_PATH",
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "ADMIN_PASSWORD_RESET",
  "ADMIN_TOTP_SECRET",
  "USER_TOTP_SECRET",
];
const savedEnv: Record<string, string | undefined> = {};
// A valid 160-bit base32 secret; not a credential anywhere.
const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

function request(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.40" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function attempt(email: string, password: string) {
  delete cookieStore["auth-token"];
  const res = await login(request("POST", "/api/auth/login", { email, password }) as never);
  return { status: res.status, token: cookieStore["auth-token"]?.value ?? "" };
}

async function restart() {
  await closeStorageProvider();
}

function logged(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.flat().map(String).join("\n");
}

describe("the environment admin after the registry is seeded", () => {
  let warn: ReturnType<typeof spyOn>;
  let info: ReturnType<typeof spyOn>;

  beforeAll(() => {
    for (const key of KEYS) savedEnv[key] = process.env[key];
    process.env.STORAGE_PROVIDER = "sqlite";
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    delete process.env.ADMIN_TOTP_SECRET;
    delete process.env.USER_TOTP_SECRET;
  });

  beforeEach(async () => {
    clearRateLimitState();
    // A fresh database per case, seeded from password A.
    await restart();
    process.env.STORAGE_SQLITE_PATH = join(dir, `store-${crypto.randomUUID()}.db`);
    process.env.ADMIN_EMAIL = ADMIN;
    process.env.ADMIN_PASSWORD = "password-A-000";
    delete process.env.ADMIN_PASSWORD_RESET;
    delete process.env.ADMIN_TOTP_SECRET;
    expect((await attempt(ADMIN, "password-A-000")).status).toBe(200);
    warn = spyOn(console, "warn").mockImplementation(() => {});
    info = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    info.mockRestore();
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

  test("a rotated ADMIN_PASSWORD is reported at the next start, not applied", async () => {
    process.env.ADMIN_PASSWORD = "password-B-000";
    await restart();
    expect((await attempt(ADMIN, "password-B-000")).status).toBe(401);
    expect((await attempt(ADMIN, "password-A-000")).status).toBe(200);
    expect(logged(warn)).toContain("ADMIN_PASSWORD does not match the stored password");
    expect(logged(warn)).toContain("ADMIN_PASSWORD_RESET=true");
  });

  test("an unchanged ADMIN_PASSWORD reports nothing", async () => {
    await restart();
    expect((await attempt(ADMIN, "password-A-000")).status).toBe(200);
    expect(logged(warn)).not.toContain("ADMIN_PASSWORD");
  });

  test("an ADMIN_EMAIL with no row is reported, not created", async () => {
    process.env.ADMIN_EMAIL = "new-admin@libredb.org";
    await restart();
    expect((await attempt("new-admin@libredb.org", "password-A-000")).status).toBe(401);
    expect(logged(warn)).toContain("new-admin@libredb.org is not in the account registry");
  });

  test("ADMIN_PASSWORD_RESET=true restores a disabled, demoted admin and ends its old sessions", async () => {
    const old = await attempt(ADMIN, "password-A-000");
    cookieStore["auth-token"] = { value: old.token };
    const created = await accountsRoute.POST(
      request("POST", "/api/admin/accounts", { email: "second@libredb.org", password: "second-pass-1", role: "admin" }),
    );
    expect(created.status).toBe(201);
    cookieStore["auth-token"] = { value: (await attempt("second@libredb.org", "second-pass-1")).token };
    for (const body of [{ password: "changed-in-ui-1" }, { role: "user" }, { disabled: true }]) {
      const res = await emailRoute.PATCH(request("PATCH", `/api/admin/accounts/${ADMIN}`, body), {
        params: Promise.resolve({ email: ADMIN }),
      });
      expect(res.status).toBe(200);
    }

    process.env.ADMIN_PASSWORD = "password-C-000";
    process.env.ADMIN_PASSWORD_RESET = "true";
    await restart();
    const restored = await attempt(ADMIN, "password-C-000");
    expect(restored.status).toBe(200);
    const provider = await getStorageProvider();
    const row = await provider?.getAccount(ADMIN);
    expect(row?.role).toBe("admin");
    expect(row?.disabled).toBe(false);
    cookieStore["auth-token"] = { value: old.token };
    expect((await me()).status).toBe(401);
    expect(logged(warn)).toContain("ADMIN_PASSWORD_RESET is set");
    const audit = (info.mock.calls as unknown[][])
      .map((call) => JSON.parse(String(call[0])) as { event?: string; action?: string; actor?: string; route?: string })
      .find((entry) => entry.event === "account" && entry.action === "reset");
    expect(audit).toMatchObject({ actor: "environment", route: ADMIN });
  });

  test("ADMIN_PASSWORD_RESET recreates a deleted env admin", async () => {
    cookieStore["auth-token"] = { value: (await attempt(ADMIN, "password-A-000")).token };
    await accountsRoute.POST(
      request("POST", "/api/admin/accounts", { email: "second@libredb.org", password: "second-pass-1", role: "admin" }),
    );
    cookieStore["auth-token"] = { value: (await attempt("second@libredb.org", "second-pass-1")).token };
    const removed = await emailRoute.DELETE(request("DELETE", `/api/admin/accounts/${ADMIN}`), {
      params: Promise.resolve({ email: ADMIN }),
    });
    expect(removed.status).toBe(200);

    process.env.ADMIN_PASSWORD_RESET = "1";
    await restart();
    expect((await attempt(ADMIN, "password-A-000")).status).toBe(200);
  });

  test("ADMIN_PASSWORD_RESET takes the second factor from ADMIN_TOTP_SECRET, or clears it", async () => {
    process.env.ADMIN_PASSWORD_RESET = "true";
    process.env.ADMIN_TOTP_SECRET = TOTP_SECRET;
    await restart();
    const withFactor = await attempt(ADMIN, "password-A-000");
    expect(withFactor.status).toBe(401);
    const provider = await getStorageProvider();
    expect((await provider?.getAccount(ADMIN))?.totpSecret).toBe(TOTP_SECRET);

    delete process.env.ADMIN_TOTP_SECRET;
    await restart();
    expect((await attempt(ADMIN, "password-A-000")).status).toBe(200);
    expect((await (await getStorageProvider())?.getAccount(ADMIN))?.totpSecret).toBeNull();
  });

  test("an unrecognised ADMIN_PASSWORD_RESET value is reported and ignored", async () => {
    process.env.ADMIN_PASSWORD = "password-B-000";
    process.env.ADMIN_PASSWORD_RESET = "yes please";
    await restart();
    expect((await attempt(ADMIN, "password-B-000")).status).toBe(401);
    expect(logged(warn)).toContain('unrecognized ADMIN_PASSWORD_RESET value "yes please"');
  });
});

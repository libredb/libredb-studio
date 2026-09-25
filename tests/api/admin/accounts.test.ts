import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const cookieStore: Record<string, { value: string } | undefined> = {};

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore[name],
    set: () => {},
    delete: () => {},
  }),
  headers: async () => ({ get: () => null }),
}));

const { signJWT } = await import("@/lib/auth");
const { GET, POST } = await import("@/app/api/admin/accounts/route");
const emailRoute = await import("@/app/api/admin/accounts/[email]/route");
const totpRoute = await import("@/app/api/auth/totp/route");
const { POST: login } = await import("@/app/api/auth/login/route");
const storageRoute = await import("@/app/api/storage/route");
const collectionRoute = await import("@/app/api/storage/[collection]/route");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { clearTotpReplayState, decodeBase32, TOTP_PERIOD_SECONDS } = await import("@/lib/totp");
const { closeStorageProvider, getStorageProvider } = await import("@/lib/storage/factory");
const { hashPassword, passwordVerificationCount, SCRYPT_N } = await import("@/lib/password-hash");
const { rehashStoredPassword } = await import("@/lib/local-accounts");

const dir = mkdtempSync(join(tmpdir(), "libredb-accounts-"));
// The suite password lives in tests/setup.ts. Repeating the literal here is what GitGuardian flags.
const adminPassword = process.env.ADMIN_PASSWORD ?? "";
const savedEnv: Record<string, string | undefined> = {};

function remember(keys: string[]) {
  for (const key of keys) savedEnv[key] = process.env[key];
}

function restore(keys: string[]) {
  for (const key of keys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function as(role: "admin" | "user", username: string) {
  cookieStore["auth-token"] = { value: await signJWT({ role, username }) };
}

function request(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.20" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function currentCode(secret: string): string {
  const key = decodeBase32(secret);
  if (!key) throw new Error("secret did not decode");
  const step = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated = digest.readUInt32BE(offset) & 0x7fffffff;
  return (truncated % 1_000_000).toString().padStart(6, "0");
}

describe("stored local accounts", () => {
  beforeAll(() => {
    remember([
      "STORAGE_PROVIDER",
      "STORAGE_SQLITE_PATH",
      "STORAGE_POSTGRES_URL",
      "NEXT_PUBLIC_AUTH_PROVIDER",
      "ADMIN_PASSWORD",
      "ADMIN_TOTP_SECRET",
      "USER_TOTP_SECRET",
    ]);
    process.env.STORAGE_PROVIDER = "sqlite";
    process.env.STORAGE_SQLITE_PATH = join(dir, "store.db");
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    delete process.env.ADMIN_TOTP_SECRET;
    delete process.env.USER_TOTP_SECRET;
  });

  beforeEach(async () => {
    clearRateLimitState();
    clearTotpReplayState();
    await as("admin", "admin@libredb.org");
  });

  afterAll(async () => {
    await closeStorageProvider();
    restore([
      "STORAGE_PROVIDER",
      "STORAGE_SQLITE_PATH",
      "STORAGE_POSTGRES_URL",
      "NEXT_PUBLIC_AUTH_PROVIDER",
      "ADMIN_PASSWORD",
      "ADMIN_TOTP_SECRET",
      "USER_TOTP_SECRET",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("GET without a session is 401 and a non-admin is 403", async () => {
    delete cookieStore["auth-token"];
    expect((await GET(request("GET", "/api/admin/accounts"))).status).toBe(401);
    expect((await POST(request("POST", "/api/admin/accounts", {}))).status).toBe(401);
    expect(
      (
        await emailRoute.PATCH(request("PATCH", "/api/admin/accounts/a"), {
          params: Promise.resolve({ email: "a@b.c" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await emailRoute.DELETE(request("DELETE", "/api/admin/accounts/a"), {
          params: Promise.resolve({ email: "a@b.c" }),
        })
      ).status,
    ).toBe(401);
    expect((await totpRoute.POST(request("POST", "/api/auth/totp", { action: "begin" }))).status).toBe(401);

    await as("user", "user@libredb.org");
    expect(
      (
        await emailRoute.PATCH(request("PATCH", "/api/admin/accounts/a"), {
          params: Promise.resolve({ email: "a@b.c" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await emailRoute.DELETE(request("DELETE", "/api/admin/accounts/a"), {
          params: Promise.resolve({ email: "a@b.c" }),
        })
      ).status,
    ).toBe(403);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const denied = await GET(request("GET", "/api/admin/accounts"));
      expect(denied.status).toBe(403);
      const line = logSpy.mock.calls
        .map((call) => JSON.parse(String(call[0])) as { event?: string; reason?: string; actor?: string })
        .find((entry) => entry.event === "permission_denied");
      expect(line?.reason).toBe("insufficient_role");
      expect(line?.actor).toBe("user@libredb.org");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("the empty store seeds the env accounts and does not return password hashes", async () => {
    const res = await GET(request("GET", "/api/admin/accounts"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: { email: string; role: string; password?: string; passwordHash?: string }[];
    };
    expect(body.accounts.map((account) => account.email).sort()).toEqual(["admin@libredb.org", "user@libredb.org"]);
    expect(JSON.stringify(body)).not.toContain(adminPassword);
    expect(body.accounts.every((account) => account.passwordHash === undefined)).toBe(true);

    const provider = await getStorageProvider();
    if (!provider) throw new Error("sqlite provider missing");
    const stored = await provider.getAccount("admin@libredb.org");
    expect(stored?.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(stored?.passwordHash.includes(adminPassword)).toBe(false);
    // mergeData has to run in this process: it is the one whose coverage map is the
    // authority for sqlite.ts, and an unexecuted function is reported as a coarse
    // zero-hit span that includes the SQL template's continuation lines.
    await provider.mergeData("merge@example.com", { history: [] });
    expect(await provider.getCollection("merge@example.com", "history")).toEqual([]);
  });

  test("create rejects a bad body and a duplicate, then accepts a third account", async () => {
    const broken = (method: string, path: string) =>
      new Request(`http://localhost${path}`, { method, body: "{", headers: { "content-type": "application/json" } });
    expect((await POST(broken("POST", "/api/admin/accounts"))).status).toBe(400);
    expect(
      (
        await emailRoute.PATCH(broken("PATCH", "/api/admin/accounts/admin@libredb.org"), {
          params: Promise.resolve({ email: "admin@libredb.org" }),
        })
      ).status,
    ).toBe(400);
    const cases: unknown[] = [
      null,
      { email: "nope", password: "long-enough", role: "user" },
      { email: "", password: "long-enough", role: "user" },
      { email: `${"a".repeat(250)}@b.co`, password: "long-enough", role: "user" },
      { email: "ok@example.com", password: "short", role: "user" },
      { email: "ok@example.com", password: "long-enough", role: "owner" },
      { email: "Admin@libredb.org", password: "long-enough", role: "user" },
    ];
    for (const body of cases) {
      const res = await POST(request("POST", "/api/admin/accounts", body));
      expect(res.status === 400 || res.status === 409).toBe(true);
    }

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const created = await POST(
        request("POST", "/api/admin/accounts", { email: "carol@example.com", password: "carol-pass", role: "user" }),
      );
      expect(created.status).toBe(201);
      const line = logSpy.mock.calls
        .map(
          (call) => JSON.parse(String(call[0])) as { event?: string; action?: string; actor?: string; route?: string },
        )
        .find((entry) => entry.event === "account" && entry.action === "create");
      expect(line?.actor).toBe("admin@libredb.org");
      expect(line?.route).toBe("carol@example.com");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("three accounts log in, and a cross-read returns nothing of the other session", async () => {
    delete cookieStore["auth-token"];
    for (const email of ["admin@libredb.org", "user@libredb.org", "carol@example.com"]) {
      const res = await login(
        request("POST", "/api/auth/login", {
          email,
          password: email === "carol@example.com" ? "carol-pass" : adminPassword,
        }) as never,
      );
      expect(res.status).toBe(200);
    }
    expect(
      (await login(request("POST", "/api/auth/login", { email: "Carol@Example.com", password: "carol-pass" }) as never))
        .status,
    ).toBe(200);

    await as("user", "user@libredb.org");
    expect(
      (
        await collectionRoute.PUT(request("PUT", "/api/storage/connections", { data: [{ id: "user-row" }] }) as never, {
          params: Promise.resolve({ collection: "connections" }),
        })
      ).status,
    ).toBe(200);
    await as("user", "carol@example.com");
    expect(
      (
        await collectionRoute.PUT(
          request("PUT", "/api/storage/connections", { data: [{ id: "carol-row" }] }) as never,
          { params: Promise.resolve({ collection: "connections" }) },
        )
      ).status,
    ).toBe(200);

    const carolView = (await (await storageRoute.GET(request("GET", "/api/storage") as never)).json()) as {
      connections?: { id: string }[];
    };
    expect(carolView.connections).toEqual([{ id: "carol-row" }]);
    await as("user", "user@libredb.org");
    const userView = (await (await storageRoute.GET(request("GET", "/api/storage") as never)).json()) as {
      connections?: { id: string }[];
    };
    expect(userView.connections).toEqual([{ id: "user-row" }]);
  });

  test("an unknown email and a wrong password are the same 401 and each does one verification", async () => {
    delete cookieStore["auth-token"];
    const before = passwordVerificationCount();
    const unknown = await login(
      request("POST", "/api/auth/login", { email: "nobody@example.com", password: "guess-guess" }) as never,
    );
    const known = await login(
      request("POST", "/api/auth/login", { email: "carol@example.com", password: "guess-guess" }) as never,
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.text()).toBe(await known.text());
    expect(passwordVerificationCount() - before).toBe(2);
  });

  test("disabling keeps stored rows and blocks login; deleting removes the rows", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(
        (
          await emailRoute.PATCH(request("PATCH", "/api/admin/accounts/carol@example.com", { role: "admin" }), {
            params: Promise.resolve({ email: "carol@example.com" }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await emailRoute.PATCH(
            request("PATCH", "/api/admin/accounts/carol@example.com", { role: "user", clearTotp: true }),
            { params: Promise.resolve({ email: "carol@example.com" }) },
          )
        ).status,
      ).toBe(200);
      const disabled = await emailRoute.PATCH(
        request("PATCH", "/api/admin/accounts/carol@example.com", { disabled: true }),
        { params: Promise.resolve({ email: "carol@example.com" }) },
      );
      expect(disabled.status).toBe(200);
      delete cookieStore["auth-token"];
      expect(
        (
          await login(
            request("POST", "/api/auth/login", { email: "carol@example.com", password: "carol-pass" }) as never,
          )
        ).status,
      ).toBe(401);
      await as("admin", "admin@libredb.org");
      const provider = await getStorageProvider();
      expect(JSON.stringify(await provider?.getCollection("carol@example.com", "connections"))).toContain("carol-row");

      const enabled = await emailRoute.PATCH(
        request("PATCH", "/api/admin/accounts/carol@example.com", { disabled: false, password: "carol-pass-2" }),
        { params: Promise.resolve({ email: "carol@example.com" }) },
      );
      expect(enabled.status).toBe(200);
      delete cookieStore["auth-token"];
      expect(
        (
          await login(
            request("POST", "/api/auth/login", { email: "carol@example.com", password: "carol-pass-2" }) as never,
          )
        ).status,
      ).toBe(200);

      await as("admin", "admin@libredb.org");
      const removed = await emailRoute.DELETE(request("DELETE", "/api/admin/accounts/carol@example.com"), {
        params: Promise.resolve({ email: "carol@example.com" }),
      });
      expect(removed.status).toBe(200);
      expect(await provider?.getAccount("carol@example.com")).toBeNull();
      expect(await provider?.getCollection("carol@example.com", "connections")).toBeNull();
      const actions = logSpy.mock.calls
        .map((call) => JSON.parse(String(call[0])) as { event?: string; action?: string })
        .filter((entry) => entry.event === "account")
        .map((entry) => entry.action);
      expect(actions).toEqual(
        expect.arrayContaining(["role", "totp_clear", "disable", "enable", "password", "delete"]),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  test("the last enabled admin cannot be removed, demoted, or disabled", async () => {
    const email = "admin@libredb.org";
    const params = { params: Promise.resolve({ email }) };
    expect((await emailRoute.DELETE(request("DELETE", "/api/admin/accounts/admin"), params)).status).toBe(409);
    expect(
      (await emailRoute.PATCH(request("PATCH", "/api/admin/accounts/admin", { role: "user" }), params)).status,
    ).toBe(409);
    expect(
      (await emailRoute.PATCH(request("PATCH", "/api/admin/accounts/admin", { disabled: true }), params)).status,
    ).toBe(409);
    expect(
      (
        await emailRoute.PATCH(request("PATCH", "/api/admin/accounts/missing@example.com", { role: "user" }), {
          params: Promise.resolve({ email: "missing@example.com" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await emailRoute.DELETE(request("DELETE", "/api/admin/accounts/missing@example.com"), {
          params: Promise.resolve({ email: "missing@example.com" }),
        })
      ).status,
    ).toBe(404);
    expect((await emailRoute.PATCH(request("PATCH", "/api/admin/accounts/admin", {}), params)).status).toBe(400);
    expect(
      (await emailRoute.PATCH(request("PATCH", "/api/admin/accounts/admin", { disabled: "yes" }), params)).status,
    ).toBe(400);
    expect(
      (await emailRoute.PATCH(request("PATCH", "/api/admin/accounts/admin", { clearTotp: false }), params)).status,
    ).toBe(400);
    expect((await emailRoute.PATCH(request("PATCH", "/api/admin/accounts/admin", "not-json"), params)).status).toBe(
      400,
    );
  });

  test("a successful login rewrites a hash that used an older cost", async () => {
    const provider = await getStorageProvider();
    const account = await provider?.getAccount("user@libredb.org");
    if (!account || !provider) throw new Error("seeded user missing");
    account.passwordHash = await hashPassword(adminPassword, 1024);
    await provider.updateAccount(account);

    delete cookieStore["auth-token"];
    expect(
      (await login(request("POST", "/api/auth/login", { email: "user@libredb.org", password: adminPassword }) as never))
        .status,
    ).toBe(200);
    const rewritten = await provider.getAccount("user@libredb.org");
    expect(rewritten?.passwordHash.startsWith(`scrypt$${SCRYPT_N}$`)).toBe(true);

    await rehashStoredPassword("nobody@example.com", adminPassword);
    await rehashStoredPassword("user@libredb.org", adminPassword);
  });

  test("enrolment confirms a code once, then a password alone is not enough", async () => {
    const begun = await totpRoute.POST(request("POST", "/api/auth/totp", { action: "begin" }));
    expect(begun.status).toBe(200);
    const { secret } = (await begun.json()) as { secret: string; otpauthUrl: string };
    expect(secret.length).toBeGreaterThan(0);

    const code = currentCode(secret);
    expect((await totpRoute.POST(request("POST", "/api/auth/totp", { action: "confirm", code }))).status).toBe(200);
    expect((await totpRoute.POST(request("POST", "/api/auth/totp", { action: "confirm", code }))).status).toBe(400);

    delete cookieStore["auth-token"];
    const passwordOnly = await login(
      request("POST", "/api/auth/login", { email: "admin@libredb.org", password: adminPassword }) as never,
    );
    expect(passwordOnly.status).toBe(401);
    expect(((await passwordOnly.json()) as { mfaRequired?: boolean }).mfaRequired).toBe(true);

    clearTotpReplayState();
    const withCode = await login(
      request("POST", "/api/auth/login", {
        email: "admin@libredb.org",
        password: adminPassword,
        totp: currentCode(secret),
      }) as never,
    );
    expect(withCode.status).toBe(200);

    await as("admin", "admin@libredb.org");
    expect((await totpRoute.POST(request("POST", "/api/auth/totp", { action: "disable" }))).status).toBe(200);
    await as("admin", "ghost@example.com");
    expect((await totpRoute.POST(request("POST", "/api/auth/totp", { action: "begin" }))).status).toBe(404);
    expect((await totpRoute.POST(request("POST", "/api/auth/totp", { action: "disable" }))).status).toBe(404);
    await as("admin", "admin@libredb.org");
    expect((await totpRoute.POST(request("POST", "/api/auth/totp", { action: "nope" }))).status).toBe(400);
    expect(
      (
        await totpRoute.POST(
          new Request("http://localhost/api/auth/totp", {
            method: "POST",
            body: "{",
            headers: { "content-type": "application/json" },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await totpRoute.POST(request("POST", "/api/auth/totp", { action: "confirm", code: "000000" }))).status,
    ).toBe(400);
    delete cookieStore["auth-token"];
    expect(
      (
        await login(
          request("POST", "/api/auth/login", { email: "admin@libredb.org", password: adminPassword }) as never,
        )
      ).status,
    ).toBe(200);
  });

  test("oidc mode and local storage mode both refuse the registry", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    const oidc = await GET(request("GET", "/api/admin/accounts"));
    expect(oidc.status).toBe(409);
    expect((await oidc.json()) as { error: string }).toEqual({
      error: "Accounts are managed by the identity provider in OIDC mode.",
    });
    delete cookieStore["auth-token"];
    expect(
      (
        await login(
          request("POST", "/api/auth/login", { email: "admin@libredb.org", password: adminPassword }) as never,
        )
      ).status,
    ).toBe(200);

    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    delete process.env.STORAGE_PROVIDER;
    await as("admin", "admin@libredb.org");
    const local = await GET(request("GET", "/api/admin/accounts"));
    expect(local.status).toBe(409);
    delete cookieStore["auth-token"];
    expect(
      (
        await login(
          request("POST", "/api/auth/login", { email: "admin@libredb.org", password: adminPassword }) as never,
        )
      ).status,
    ).toBe(200);

    process.env.STORAGE_PROVIDER = "sqlite";
  });
});

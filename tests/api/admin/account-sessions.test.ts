import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A session is a stateless 24-hour JWT, so the registry has to be consulted on every request or a
// disabled, demoted, deleted or password-reset account keeps what its token named until expiry.
// Each case here logs in through the real route, keeps that cookie, and replays it after the change.

const cookieStore: Record<string, { value: string } | undefined> = {};

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore[name],
    set: (name: string, value: string) => {
      cookieStore[name] = { value };
    },
    delete: (name: string | { name: string }) => {
      delete cookieStore[typeof name === "string" ? name : name.name];
    },
  }),
  headers: async () => ({ get: () => null }),
}));

const { signJWT } = await import("@/lib/auth");
const accountsRoute = await import("@/app/api/admin/accounts/route");
const emailRoute = await import("@/app/api/admin/accounts/[email]/route");
const { POST: login } = await import("@/app/api/auth/login/route");
const { GET: me } = await import("@/app/api/auth/me/route");
const storageRoute = await import("@/app/api/storage/route");
const collectionRoute = await import("@/app/api/storage/[collection]/route");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { closeStorageProvider, getStorageProvider } = await import("@/lib/storage/factory");

const dir = mkdtempSync(join(tmpdir(), "libredb-account-sessions-"));
// The suite password lives in tests/setup.ts. Repeating the literal here is what GitGuardian flags.
const adminPassword = process.env.ADMIN_PASSWORD ?? "";
const KEYS = ["STORAGE_PROVIDER", "STORAGE_SQLITE_PATH", "NEXT_PUBLIC_AUTH_PROVIDER", "ADMIN_TOTP_SECRET", "USER_TOTP_SECRET"];
const savedEnv: Record<string, string | undefined> = {};

function request(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.30" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Log in through the route and return the cookie it set. */
async function signIn(email: string, password: string): Promise<string> {
  delete cookieStore["auth-token"];
  const res = await login(request("POST", "/api/auth/login", { email, password }) as never);
  expect(res.status).toBe(200);
  const token = cookieStore["auth-token"]?.value;
  if (!token) throw new Error(`login for ${email} set no cookie`);
  return token;
}

function use(token: string) {
  cookieStore["auth-token"] = { value: token };
}

async function create(email: string, password: string, role: "admin" | "user") {
  const res = await accountsRoute.POST(request("POST", "/api/admin/accounts", { email, password, role }));
  expect(res.status).toBe(201);
}

async function patch(email: string, body: unknown) {
  return emailRoute.PATCH(request("PATCH", `/api/admin/accounts/${email}`, body), {
    params: Promise.resolve({ email }),
  });
}

async function whoami() {
  return me();
}

async function putConnections(id: string) {
  return collectionRoute.PUT(request("PUT", "/api/storage/connections", { data: [{ id }] }) as never, {
    params: Promise.resolve({ collection: "connections" }),
  });
}

describe("a live session follows its stored account", () => {
  let admin = "";

  beforeAll(() => {
    for (const key of KEYS) savedEnv[key] = process.env[key];
    process.env.STORAGE_PROVIDER = "sqlite";
    process.env.STORAGE_SQLITE_PATH = join(dir, "store.db");
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    delete process.env.ADMIN_TOTP_SECRET;
    delete process.env.USER_TOTP_SECRET;
  });

  beforeEach(() => {
    clearRateLimitState();
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

  test("a token with no session version, as minted before the registry existed, is refused", async () => {
    // Upgrade path: the cookie predates the accounts table. Signing in again once is the cost.
    use(await signJWT({ role: "admin", username: "admin@libredb.org" }));
    expect((await accountsRoute.GET(request("GET", "/api/admin/accounts"))).status).toBe(401);
    admin = await signIn("admin@libredb.org", adminPassword);
    use(admin);
    expect((await accountsRoute.GET(request("GET", "/api/admin/accounts"))).status).toBe(200);
  });

  test("a token for an email the registry does not hold is refused", async () => {
    use(await signJWT({ role: "admin", username: "ghost@example.com" }));
    expect((await whoami()).status).toBe(401);
    expect((await accountsRoute.GET(request("GET", "/api/admin/accounts"))).status).toBe(401);
  });

  test("disabling ends the live session, and enabling again does not revive it", async () => {
    use(admin);
    await create("dave@example.com", "dave-pass-1", "user");
    const dave = await signIn("dave@example.com", "dave-pass-1");
    use(dave);
    expect((await storageRoute.GET(request("GET", "/api/storage") as never)).status).toBe(200);

    use(admin);
    expect((await patch("dave@example.com", { disabled: true })).status).toBe(200);
    use(dave);
    expect((await storageRoute.GET(request("GET", "/api/storage") as never)).status).toBe(401);
    expect((await putConnections("dave-after-disable")).status).toBe(401);

    use(admin);
    expect((await patch("dave@example.com", { disabled: false })).status).toBe(200);
    use(dave);
    expect((await whoami()).status).toBe(401);
    use(await signIn("dave@example.com", "dave-pass-1"));
    expect((await whoami()).status).toBe(200);
  });

  test("a demoted admin loses the registry at the next request and cannot promote itself back", async () => {
    use(admin);
    await create("erin@example.com", "erin-pass-1", "admin");
    const erin = await signIn("erin@example.com", "erin-pass-1");
    use(erin);
    expect((await accountsRoute.GET(request("GET", "/api/admin/accounts"))).status).toBe(200);

    use(admin);
    expect((await patch("erin@example.com", { role: "user" })).status).toBe(200);
    use(erin);
    expect((await accountsRoute.GET(request("GET", "/api/admin/accounts"))).status).toBe(401);
    expect((await patch("erin@example.com", { role: "admin" })).status).toBe(401);
    const provider = await getStorageProvider();
    expect((await provider?.getAccount("erin@example.com"))?.role).toBe("user");
  });

  test("a deleted account's live session cannot write rows for a later account with the same email", async () => {
    use(admin);
    await create("frank@example.com", "frank-pass-1", "user");
    const frank = await signIn("frank@example.com", "frank-pass-1");
    use(frank);
    expect((await putConnections("frank-before-delete")).status).toBe(200);

    use(admin);
    const removed = await emailRoute.DELETE(request("DELETE", "/api/admin/accounts/frank@example.com"), {
      params: Promise.resolve({ email: "frank@example.com" }),
    });
    expect(removed.status).toBe(200);
    use(frank);
    expect((await putConnections("frank-ghost")).status).toBe(401);
    const provider = await getStorageProvider();
    expect(await provider?.getCollection("frank@example.com", "connections")).toBeNull();

    use(admin);
    await create("frank@example.com", "frank-pass-2", "user");
    // The new account shares the email, not the old one's sessions.
    use(frank);
    expect((await whoami()).status).toBe(401);
    use(await signIn("frank@example.com", "frank-pass-2"));
    const view = (await (await storageRoute.GET(request("GET", "/api/storage") as never)).json()) as {
      connections?: unknown;
    };
    expect(view.connections).toBeUndefined();
  });

  test("an admin password reset ends the account's sessions; changing your own keeps the current one", async () => {
    use(admin);
    await create("gina@example.com", "gina-pass-1", "user");
    const gina = await signIn("gina@example.com", "gina-pass-1");
    use(admin);
    expect((await patch("gina@example.com", { password: "gina-pass-2" })).status).toBe(200);
    use(gina);
    expect((await whoami()).status).toBe(401);

    const olderAdmin = await signIn("admin@libredb.org", adminPassword);
    use(admin);
    expect((await patch("admin@libredb.org", { password: "admin-pass-rotated" })).status).toBe(200);
    // The route re-issued the actor's cookie with the new session version.
    expect(cookieStore["auth-token"]?.value).not.toBe(admin);
    expect((await accountsRoute.GET(request("GET", "/api/admin/accounts"))).status).toBe(200);
    admin = cookieStore["auth-token"]?.value ?? "";
    use(olderAdmin);
    expect((await whoami()).status).toBe(401);
  });

  test("a registry that cannot be read refuses the session instead of trusting the token", async () => {
    const provider = await getStorageProvider();
    if (!provider) throw new Error("sqlite provider missing");
    const failure = spyOn(provider, "getAccount").mockRejectedValue(new Error("database is locked"));
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      use(admin);
      expect((await whoami()).status).toBe(401);
      expect(errorSpy.mock.calls.flat().map(String).join("\n")).toContain("database is locked");
    } finally {
      failure.mockRestore();
      errorSpy.mockRestore();
    }
    use(admin);
    expect((await whoami()).status).toBe(200);
  });

  test("OIDC sessions are not checked against the registry", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    try {
      use(await signJWT({ role: "user", username: "issuer-only@example.com" }));
      expect((await whoami()).status).toBe(200);
      expect((await storageRoute.GET(request("GET", "/api/storage") as never)).status).toBe(200);
    } finally {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    }
  });
});

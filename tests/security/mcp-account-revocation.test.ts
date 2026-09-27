/**
 * An MCP token outlives the session it was minted from (30 days by default), so with a server-side
 * account registry it must stop working when its account is disabled, demoted, deleted or has its
 * password reset, exactly as the session does (#784). The route reads the registry; the proxy
 * cannot, and stays a signature check.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as route from "@/app/api/mcp/route";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { changeAccount, createAccount, removeAccount, seedAccountsIfEmpty } from "@/lib/local-accounts";
import { mintMcpToken } from "@/lib/mcp/token";
import { closeStorageProvider, getStorageProvider } from "@/lib/storage/factory";
import { pinMcpTestEnvironment } from "../helpers/mcp-fixtures";
import { legacyPost } from "../helpers/mcp-harness";
import { useMcpChannel } from "../helpers/mcp-token";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-revocation-"));
const KEYS = [
  "STORAGE_PROVIDER",
  "STORAGE_SQLITE_PATH",
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "ADMIN_TOTP_SECRET",
  "USER_TOTP_SECRET",
];
const savedEnv: Record<string, string | undefined> = {};
let restoreChannel: () => void = () => {};

async function tokenFor(email: string, role: "admin" | "user", withVersion = true): Promise<string> {
  const provider = await getStorageProvider();
  const row = await provider?.getAccount(email);
  if (!row) throw new Error(`no row for ${email}`);
  const owner = withVersion ? { username: email, role, sessionVersion: row.sessionVersion } : { username: email, role };
  return (await mintMcpToken(owner)).token;
}

async function listTools(token: string): Promise<Response> {
  return route.POST(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token }));
}

async function expectRevoked(response: Response) {
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toStartWith('Bearer error="invalid_token"');
  expect(await response.json()).toEqual({
    error: "invalid_token",
    error_description: "The MCP token is invalid, expired or revoked",
  });
}

describe("an MCP token for a stored account", () => {
  beforeAll(async () => {
    for (const key of KEYS) savedEnv[key] = process.env[key];
    process.env.STORAGE_PROVIDER = "sqlite";
    process.env.STORAGE_SQLITE_PATH = join(dir, "store.db");
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    delete process.env.ADMIN_TOTP_SECRET;
    delete process.env.USER_TOTP_SECRET;
    const provider = await getStorageProvider();
    if (!provider) throw new Error("sqlite provider missing");
    await seedAccountsIfEmpty(provider);
  });

  beforeEach(() => {
    clearRateLimitState();
    restoreChannel();
    restoreChannel = useMcpChannel();
  });

  afterAll(async () => {
    restoreChannel();
    await closeStorageProvider();
    for (const key of KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("works while the account is unchanged", async () => {
    await createAccount("admin@libredb.org", { email: "mcp-ok@example.com", password: "mcp-pass-1", role: "user" });
    expect((await listTools(await tokenFor("mcp-ok@example.com", "user"))).status).toBe(200);
  });

  test("is refused once the account is disabled, with the answer an invalid token gets", async () => {
    await createAccount("admin@libredb.org", { email: "mcp-off@example.com", password: "mcp-pass-1", role: "user" });
    const token = await tokenFor("mcp-off@example.com", "user");
    await changeAccount("admin@libredb.org", "mcp-off@example.com", { disabled: true });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await expectRevoked(await listTools(token));
      const denial = log.mock.calls
        .map((call) => JSON.parse(String(call[0])) as { event?: string; reason?: string })
        .find((entry) => entry.event === "permission_denied");
      expect(denial?.reason).toBe("mcp_token_invalid");
    } finally {
      log.mockRestore();
    }
  });

  test("minted as admin is refused once the account is demoted", async () => {
    await createAccount("admin@libredb.org", { email: "mcp-admin@example.com", password: "mcp-pass-1", role: "admin" });
    const token = await tokenFor("mcp-admin@example.com", "admin");
    await changeAccount("admin@libredb.org", "mcp-admin@example.com", { role: "user" });
    await expectRevoked(await listTools(token));
  });

  test("is refused once the account is deleted, and a new account with that email does not revive it", async () => {
    await createAccount("admin@libredb.org", { email: "mcp-gone@example.com", password: "mcp-pass-1", role: "user" });
    const token = await tokenFor("mcp-gone@example.com", "user");
    await removeAccount("admin@libredb.org", "mcp-gone@example.com");
    await expectRevoked(await listTools(token));
    await createAccount("admin@libredb.org", { email: "mcp-gone@example.com", password: "mcp-pass-2", role: "user" });
    await expectRevoked(await listTools(token));
  });

  test("is refused once an admin resets the account's password", async () => {
    await createAccount("admin@libredb.org", { email: "mcp-reset@example.com", password: "mcp-pass-1", role: "user" });
    const token = await tokenFor("mcp-reset@example.com", "user");
    await changeAccount("admin@libredb.org", "mcp-reset@example.com", { password: "mcp-pass-2" });
    await expectRevoked(await listTools(token));
  });

  test("minted with no session version is refused", async () => {
    await createAccount("admin@libredb.org", { email: "mcp-nov@example.com", password: "mcp-pass-1", role: "user" });
    await expectRevoked(await listTools(await tokenFor("mcp-nov@example.com", "user", false)));
  });

  test("is refused when the registry cannot be read", async () => {
    await createAccount("admin@libredb.org", { email: "mcp-db@example.com", password: "mcp-pass-1", role: "user" });
    const token = await tokenFor("mcp-db@example.com", "user");
    const provider = await getStorageProvider();
    if (!provider) throw new Error("sqlite provider missing");
    const failure = spyOn(provider, "getAccount").mockRejectedValue(new Error("database is locked"));
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expectRevoked(await listTools(token));
      expect(errors.mock.calls.flat().map(String).join("\n")).toContain("database is locked");
    } finally {
      failure.mockRestore();
      errors.mockRestore();
    }
  });
});

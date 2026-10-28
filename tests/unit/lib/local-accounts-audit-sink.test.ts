import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountError,
  changeAccount,
  createAccount,
  disableOwnTotp,
  removeAccount,
  seedAccountsIfEmpty,
} from "@/lib/local-accounts";
import { logger } from "@/lib/logger";
import { closeStorageProvider, getStorageProvider } from "@/lib/storage/factory";

// The audit line goes to stdout. When that write throws, the account change it records has
// already been made (or refused), so the change keeps its own outcome and the lost line is
// logged as a server error instead of turning a done change into a failed request.

const dir = mkdtempSync(join(tmpdir(), "libredb-account-audit-sink-"));
const KEYS = [
  "STORAGE_PROVIDER",
  "STORAGE_SQLITE_PATH",
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "ADMIN_TOTP_SECRET",
  "USER_TOTP_SECRET",
];
const savedEnv: Record<string, string | undefined> = {};
const ENV_ADMIN = "admin@libredb.org";
const SECOND = "second@libredb.org";
const AUDIT_FAILURE = "Failed to record account audit event";

// Placeholders, not credentials: a realistic literal here is what secret scanners flag.
const TEST_PASSWORD = "password";

let restoreSpies: (() => void)[] = [];

/** Makes the stdout audit write throw, and returns the logger.error spy that should catch it. */
function breakAuditSink() {
  const log = spyOn(console, "log").mockImplementation(() => {
    throw new Error("stdout write failed");
  });
  const error = spyOn(logger, "error").mockImplementation(() => {});
  restoreSpies.push(
    () => log.mockRestore(),
    () => error.mockRestore(),
  );
  return error;
}

describe("an account change whose audit line cannot be written", () => {
  beforeAll(() => {
    for (const key of KEYS) savedEnv[key] = process.env[key];
    process.env.STORAGE_PROVIDER = "sqlite";
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    delete process.env.ADMIN_TOTP_SECRET;
    delete process.env.USER_TOTP_SECRET;
  });

  beforeEach(async () => {
    await closeStorageProvider();
    process.env.STORAGE_SQLITE_PATH = join(dir, `store-${crypto.randomUUID()}.db`);
    const provider = await getStorageProvider();
    if (!provider) throw new Error("sqlite provider missing");
    await seedAccountsIfEmpty(provider);
    await createAccount(ENV_ADMIN, { email: SECOND, password: TEST_PASSWORD, role: "admin" });
  });

  afterEach(() => {
    for (const restore of restoreSpies) restore();
    restoreSpies = [];
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

  test("still makes the change, and logs the lost audit line", async () => {
    const error = breakAuditSink();

    const changed = await changeAccount(ENV_ADMIN, SECOND, { role: "user" });

    expect(changed.account).toMatchObject({ email: SECOND, role: "user" });
    const provider = await getStorageProvider();
    expect((await provider?.getAccount(SECOND))?.role).toBe("user");
    expect(error).toHaveBeenCalledWith(AUDIT_FAILURE, expect.any(Error), { route: "accounts" });
  });

  test("still refuses an admin change with its own error, and logs the lost audit line", async () => {
    const error = breakAuditSink();

    const refusal = await removeAccount(ENV_ADMIN, "nobody@libredb.org").catch((caught: unknown) => caught);

    expect(refusal).toBeInstanceOf(AccountError);
    expect((refusal as AccountError).status).toBe(404);
    expect(error).toHaveBeenCalledWith(AUDIT_FAILURE, expect.any(Error), { route: "accounts" });
  });

  test("still refuses the owner's wrong password with a 401, and logs the lost audit line", async () => {
    const error = breakAuditSink();

    const refusal = await disableOwnTotp(SECOND, { password: "not-the-password" }).catch((caught: unknown) => caught);

    expect(refusal).toBeInstanceOf(AccountError);
    expect((refusal as AccountError).status).toBe(401);
    expect(error).toHaveBeenCalledWith(AUDIT_FAILURE, expect.any(Error), { route: "accounts" });
  });
});

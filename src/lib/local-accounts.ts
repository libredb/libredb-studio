/**
 * Local accounts once `STORAGE_PROVIDER` is sqlite or postgres (#784).
 *
 * `STORAGE_PROVIDER=local` keeps today's env-var admin and optional user: there is no server
 * database to put a row in. OIDC mode never reads or writes this table. The issuer is the only
 * source of those identities, so a stored role cannot deny or elevate someone the issuer named.
 *
 * With a server store, `ADMIN_EMAIL` / `ADMIN_PASSWORD` (and `USER_*` when set) are copied in
 * once, while the table is empty, and then ignored. Later accounts come from the admin API.
 * Passwords are scrypt hashes. Disabling keeps that account's `user_storage` rows; deleting
 * removes them, so the same email can be issued again without inheriting the previous rows.
 */
import { randomBytes, randomInt } from "node:crypto";
import { emitAuditEvent } from "@/lib/audit";
import type { Role, UserPayload } from "@/lib/auth";
import { hmacHex } from "@/lib/auth-compare";
import { getAuthUsers, type AuthUser } from "@/lib/local-auth";
import { logger } from "@/lib/logger";
import { hashPassword, needsRehash, passwordMatchesHash } from "@/lib/password-hash";
import { getStorageProvider } from "@/lib/storage/factory";
import type { ServerStorageProvider, StoredAccount } from "@/lib/storage/types";
import { encodeBase32, claimTotpStep, verifyTotp } from "@/lib/totp";

export class AccountError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AccountError";
    this.status = status;
  }
}

export interface PublicAccount {
  email: string;
  role: Role;
  disabled: boolean;
  totpEnabled: boolean;
  createdAt: string;
}

const EMAIL_INVALID = "Enter an email address.";
const PASSWORD_SHORT = "Password must be at least 8 characters.";
const ROLE_INVALID = "Role must be admin or user.";
const DUPLICATE_ACCOUNT = "An account with that email already exists.";
const ACCOUNT_NOT_FOUND = "No account with that email exists.";
const LAST_ADMIN = "The last enabled admin cannot be removed.";
const EMPTY_PATCH = "Nothing to change.";
const DISABLED_TYPE = "disabled must be true or false.";
const CLEAR_TOTP_TYPE = "clearTotp must be true.";
const OIDC_MODE = "Accounts are managed by the identity provider in OIDC mode.";
const LOCAL_MODE = "The account registry needs STORAGE_PROVIDER=sqlite or postgres.";
const TOTP_MISSING = "Start authenticator setup before confirming a code.";
const TOTP_BAD = "Invalid authentication code";
const NOT_IN_STORE = "This session has no account in the registry.";
const PASSWORD_MIN_LENGTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEmail(value: unknown): string {
  if (typeof value !== "string") throw new AccountError(400, EMAIL_INVALID);
  const email = value.trim();
  if (email.length === 0 || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new AccountError(400, EMAIL_INVALID);
  }
  return email;
}

function readPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < PASSWORD_MIN_LENGTH) throw new AccountError(400, PASSWORD_SHORT);
  return value;
}

function readRole(value: unknown): Role {
  if (value !== "admin" && value !== "user") throw new AccountError(400, ROLE_INVALID);
  return value;
}

function sameEmail(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function toPublic(account: StoredAccount): PublicAccount {
  return {
    email: account.email,
    role: account.role,
    disabled: account.disabled,
    totpEnabled: account.totpSecret !== null,
    createdAt: account.createdAt,
  };
}

function toAuthUser(account: StoredAccount): AuthUser {
  return {
    email: account.email,
    password: "",
    passwordHash: account.passwordHash,
    role: account.role,
    disabled: account.disabled,
    sessionVersion: account.sessionVersion,
    ...(account.totpSecret ? { totpSecret: account.totpSecret } : {}),
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  return code === "23505" || code === "SQLITE_CONSTRAINT_PRIMARYKEY" || /UNIQUE constraint failed/i.test(error.message);
}

function audit(actor: string, action: string, email: string): void {
  try {
    emitAuditEvent({
      type: "account",
      action,
      target: email,
      user: actor,
      result: "success",
      reason: "account_changed",
    });
  } catch (error) {
    logger.error("Failed to record account audit event", error, { route: "accounts" });
  }
}

async function requireAccountStore(): Promise<ServerStorageProvider> {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "oidc") throw new AccountError(409, OIDC_MODE);
  const provider = await getStorageProvider();
  if (!provider) throw new AccountError(409, LOCAL_MODE);
  await reconcileOnce(provider);
  await seedAccountsIfEmpty(provider);
  return provider;
}

/**
 * Where a new row's session version starts. Random rather than 0, so a session from an account
 * that was deleted, or from before the registry existed, can never match a row created later
 * under the same email. The ceiling leaves room for 2^30 increments inside a Postgres INTEGER.
 */
function initialSessionVersion(): number {
  return randomInt(1, 2 ** 30);
}

/**
 * Copy the env accounts into an empty store. A concurrent first login that loses the insert
 * race adopts the row the winner wrote instead of failing the request.
 */
async function insertSeeded(provider: ServerStorageProvider, user: AuthUser, now: string): Promise<void> {
  const account: StoredAccount = {
    email: user.email,
    passwordHash: await hashPassword(user.password),
    role: user.role,
    totpSecret: user.totpSecret ?? null,
    totpPending: null,
    disabled: false,
    sessionVersion: initialSessionVersion(),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await provider.insertAccount(account);
  } catch (error) {
    if (!isUniqueViolation(error) || !(await provider.getAccount(user.email))) throw error;
  }
}

/** Returns whether it seeded, which is also whether the env admin matches the store by construction. */
export async function seedAccountsIfEmpty(provider: ServerStorageProvider): Promise<boolean> {
  if ((await provider.listAccounts()).length > 0) return false;
  const now = new Date().toISOString();
  // getAuthUsers returns the admin and, only when USER_PASSWORD is set, one more account.
  const [admin, extra] = getAuthUsers();
  await insertSeeded(provider, admin, now);
  if (extra) await insertSeeded(provider, extra, now);
  return true;
}

const RESET_APPLIED = (email: string) =>
  `ADMIN_PASSWORD_RESET is set: ${email} is an enabled admin again and signs in with ADMIN_PASSWORD. Remove ADMIN_PASSWORD_RESET now; every start applies it again while it is set.`;
const EMAIL_NOT_STORED = (email: string) =>
  `ADMIN_EMAIL ${email} is not in the account registry. With a server store the environment only seeds an empty table; set ADMIN_PASSWORD_RESET=true and restart to create it.`;
const PASSWORD_DRIFT = (email: string) =>
  `ADMIN_PASSWORD does not match the stored password for ${email}. With a server store the environment only seeds the account; set ADMIN_PASSWORD_RESET=true and restart to apply it.`;

const RESET_ON = new Set(["true", "1", "on"]);
const RESET_OFF = new Set(["false", "0", "off"]);

function resetRequested(): boolean {
  const raw = process.env.ADMIN_PASSWORD_RESET?.trim();
  if (!raw) return false;
  const value = raw.toLowerCase();
  if (RESET_ON.has(value)) return true;
  if (!RESET_OFF.has(value)) {
    logger.warn(`unrecognized ADMIN_PASSWORD_RESET value "${raw}"; the reset is not applied (use "true")`, {
      route: "accounts",
    });
  }
  return false;
}

/**
 * The break-glass path: make ADMIN_EMAIL an enabled admin that signs in with ADMIN_PASSWORD (and
 * ADMIN_TOTP_SECRET, or no second factor), whatever the store holds. Every session it had ends.
 */
async function applyEnvironmentAdmin(
  provider: ServerStorageProvider,
  admin: AuthUser,
  stored: StoredAccount | null,
): Promise<void> {
  const now = new Date().toISOString();
  const next: StoredAccount = {
    email: stored?.email ?? admin.email,
    passwordHash: await hashPassword(admin.password),
    role: "admin",
    totpSecret: admin.totpSecret ?? null,
    totpPending: null,
    disabled: false,
    sessionVersion: stored ? stored.sessionVersion + 1 : initialSessionVersion(),
    createdAt: stored?.createdAt ?? now,
    updatedAt: now,
  };
  if (stored) await provider.updateAccount(next);
  else await provider.insertAccount(next);
  audit("environment", "reset", next.email);
  logger.warn(RESET_APPLIED(next.email), { route: "accounts" });
}

/**
 * Once the table is seeded the environment stops deciding the admin's password. An operator who
 * rotates ADMIN_PASSWORD, or who is locked out, must still see that and have a way back, so each
 * start compares the two once: a mismatch is reported, and ADMIN_PASSWORD_RESET applies the
 * environment.
 */
async function reconcileWithEnvironment(provider: ServerStorageProvider): Promise<void> {
  if (await seedAccountsIfEmpty(provider)) return;
  const [admin] = getAuthUsers();
  const stored = await provider.getAccount(admin.email);
  if (resetRequested()) {
    await applyEnvironmentAdmin(provider, admin, stored);
    return;
  }
  if (!stored) {
    logger.warn(EMAIL_NOT_STORED(admin.email), { route: "accounts" });
    return;
  }
  if (!(await passwordMatchesHash(admin.password, stored.passwordHash))) {
    logger.warn(PASSWORD_DRIFT(admin.email), { route: "accounts" });
  }
}

// One reconciliation per provider instance, which is once per process in production. A failed
// attempt is forgotten so the next request tries again rather than serving an unreconciled store.
const reconciled = new WeakMap<ServerStorageProvider, Promise<void>>();

function reconcileOnce(provider: ServerStorageProvider): Promise<void> {
  let pending = reconciled.get(provider);
  if (!pending) {
    pending = reconcileWithEnvironment(provider);
    reconciled.set(provider, pending);
    pending.catch(() => reconciled.delete(provider));
  }
  return pending;
}

/**
 * Who local login may compare against.
 * OIDC and `STORAGE_PROVIDER=local` stay on the env accounts. A server store is the registry.
 */
export async function resolveLocalAuthUsers(): Promise<AuthUser[]> {
  // OIDC returns before the store is opened, so a stored role cannot affect an issuer session.
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "oidc") return getAuthUsers();
  const provider = await getStorageProvider();
  // local mode: no server database, so the env accounts stay the registry.
  if (!provider) return getAuthUsers();
  await reconcileOnce(provider);
  await seedAccountsIfEmpty(provider);
  return (await provider.listAccounts()).map(toAuthUser);
}

/**
 * Whether a verified session still speaks for its stored account. src/lib/auth.ts getSession()
 * calls this on every request, because the token itself stays valid for 24 hours.
 *
 * OIDC and `STORAGE_PROVIDER=local` sessions have no row to consult and pass. In store mode the
 * account must exist, be enabled, hold the role the token names, and carry the token's session
 * version. A token with no version predates the registry and matches nothing: its holder signs in
 * once more.
 */
export async function storedAccountAllows(session: UserPayload): Promise<boolean> {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "oidc") return true;
  const provider = await getStorageProvider();
  if (!provider) return true;
  await reconcileOnce(provider);
  const account = await provider.getAccount(session.username);
  return (
    account !== null &&
    !account.disabled &&
    account.role === session.role &&
    account.sessionVersion === session.sessionVersion
  );
}

/** After a successful store-mode login, bring an older scrypt parameter set up to the current one. */
export async function rehashStoredPassword(email: string, password: string): Promise<void> {
  try {
    const provider = await getStorageProvider();
    if (!provider) return;
    const account = await provider.getAccount(email);
    if (!account || !needsRehash(account.passwordHash)) return;
    account.passwordHash = await hashPassword(password);
    account.updatedAt = new Date().toISOString();
    await provider.updateAccount(account);
  } catch (error) {
    logger.error("Failed to rehash account password", error, { route: "POST /api/auth/login" });
  }
}

export async function listPublicAccounts(): Promise<PublicAccount[]> {
  const provider = await requireAccountStore();
  return (await provider.listAccounts()).map(toPublic);
}

export async function createAccount(actor: string, body: unknown): Promise<PublicAccount> {
  const provider = await requireAccountStore();
  if (!isRecord(body)) throw new AccountError(400, EMAIL_INVALID);
  const email = readEmail(body.email);
  const password = readPassword(body.password);
  const role = readRole(body.role);
  const existing = await provider.listAccounts();
  if (existing.some((account) => sameEmail(account.email, email))) throw new AccountError(409, DUPLICATE_ACCOUNT);
  const now = new Date().toISOString();
  const stored: StoredAccount = {
    email,
    passwordHash: await hashPassword(password),
    role,
    totpSecret: null,
    totpPending: null,
    disabled: false,
    sessionVersion: initialSessionVersion(),
    createdAt: now,
    updatedAt: now,
  };
  await provider.insertAccount(stored);
  audit(actor, "create", stored.email);
  return toPublic(stored);
}

interface AccountPatch {
  role?: Role;
  disabled?: boolean;
  password?: string;
  clearTotp?: boolean;
}

function readPatch(body: unknown): AccountPatch {
  if (!isRecord(body)) throw new AccountError(400, EMPTY_PATCH);
  const patch: AccountPatch = {};
  if (body.role !== undefined) patch.role = readRole(body.role);
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== "boolean") throw new AccountError(400, DISABLED_TYPE);
    patch.disabled = body.disabled;
  }
  if (body.password !== undefined) patch.password = readPassword(body.password);
  if (body.clearTotp !== undefined) {
    if (body.clearTotp !== true) throw new AccountError(400, CLEAR_TOTP_TYPE);
    patch.clearTotp = true;
  }
  if (patch.role === undefined && patch.disabled === undefined && patch.password === undefined && !patch.clearTotp) {
    throw new AccountError(400, EMPTY_PATCH);
  }
  return patch;
}

function assertAdminRemains(
  accounts: StoredAccount[],
  email: string,
  next: { role: Role; disabled: boolean } | null,
): void {
  const survivors = accounts.filter((account) => {
    if (sameEmail(account.email, email)) return next !== null && next.role === "admin" && !next.disabled;
    return account.role === "admin" && !account.disabled;
  });
  if (survivors.length === 0) throw new AccountError(409, LAST_ADMIN);
}

export interface ChangedAccount {
  account: PublicAccount;
  /** The version a session for this account must now carry; the route re-issues the actor's own. */
  sessionVersion: number;
}

export async function changeAccount(actor: string, email: string, body: unknown): Promise<ChangedAccount> {
  const provider = await requireAccountStore();
  const patch = readPatch(body);
  const current = await provider.getAccount(email);
  if (!current) throw new AccountError(404, ACCOUNT_NOT_FOUND);
  const role = patch.role ?? current.role;
  const disabled = patch.disabled ?? current.disabled;
  // Each of these changes what an existing session was issued for, so each ends it.
  const endsSessions = role !== current.role || (disabled && !current.disabled) || patch.password !== undefined;
  const next: StoredAccount = {
    ...current,
    role,
    disabled,
    passwordHash: patch.password ? await hashPassword(patch.password) : current.passwordHash,
    totpSecret: patch.clearTotp ? null : current.totpSecret,
    totpPending: patch.clearTotp ? null : current.totpPending,
    sessionVersion: endsSessions ? current.sessionVersion + 1 : current.sessionVersion,
    updatedAt: new Date().toISOString(),
  };
  assertAdminRemains(await provider.listAccounts(), current.email, next);
  await provider.updateAccount(next);
  if (patch.role !== undefined && patch.role !== current.role) audit(actor, "role", current.email);
  if (patch.disabled !== undefined && patch.disabled !== current.disabled) {
    audit(actor, patch.disabled ? "disable" : "enable", current.email);
  }
  if (patch.password) audit(actor, "password", current.email);
  if (patch.clearTotp) audit(actor, "totp_clear", current.email);
  return { account: toPublic(next), sessionVersion: next.sessionVersion };
}

export async function removeAccount(actor: string, email: string): Promise<void> {
  const provider = await requireAccountStore();
  const current = await provider.getAccount(email);
  if (!current) throw new AccountError(404, ACCOUNT_NOT_FOUND);
  assertAdminRemains(await provider.listAccounts(), current.email, null);
  await provider.deleteAccount(current.email);
  audit(actor, "delete", current.email);
}

function otpauthUrl(email: string, secret: string): string {
  return `otpauth://totp/LibreDB:${encodeURIComponent(email)}?secret=${secret}&issuer=LibreDB&algorithm=SHA1&digits=6&period=30`;
}

export async function beginTotpEnrolment(email: string): Promise<{ secret: string; otpauthUrl: string }> {
  const provider = await requireAccountStore();
  const current = await provider.getAccount(email);
  if (!current) throw new AccountError(404, NOT_IN_STORE);
  const secret = encodeBase32(randomBytes(20));
  current.totpPending = secret;
  current.updatedAt = new Date().toISOString();
  await provider.updateAccount(current);
  audit(email, "totp_begin", current.email);
  return { secret, otpauthUrl: otpauthUrl(email, secret) };
}

export async function confirmTotpEnrolment(email: string, code: string): Promise<void> {
  const provider = await requireAccountStore();
  const current = await provider.getAccount(email);
  if (!current?.totpPending) throw new AccountError(400, TOTP_MISSING);
  const step = verifyTotp(current.totpPending, code);
  if (step === null || !claimTotpStep(hmacHex(email.toLowerCase()), step)) throw new AccountError(400, TOTP_BAD);
  current.totpSecret = current.totpPending;
  current.totpPending = null;
  current.updatedAt = new Date().toISOString();
  await provider.updateAccount(current);
  audit(email, "totp_enrol", current.email);
}

export async function disableOwnTotp(email: string): Promise<void> {
  const provider = await requireAccountStore();
  const current = await provider.getAccount(email);
  if (!current) throw new AccountError(404, NOT_IN_STORE);
  current.totpSecret = null;
  current.totpPending = null;
  current.updatedAt = new Date().toISOString();
  await provider.updateAccount(current);
  audit(email, "totp_clear", current.email);
}

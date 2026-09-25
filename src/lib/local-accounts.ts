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
import { randomBytes } from "node:crypto";
import { emitAuditEvent } from "@/lib/audit";
import type { Role } from "@/lib/auth";
import { hmacHex } from "@/lib/auth-compare";
import { getAuthUsers, type AuthUser } from "@/lib/local-auth";
import { logger } from "@/lib/logger";
import { hashPassword, needsRehash } from "@/lib/password-hash";
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
  await seedAccountsIfEmpty(provider);
  return provider;
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
    createdAt: now,
    updatedAt: now,
  };
  try {
    await provider.insertAccount(account);
  } catch (error) {
    if (!isUniqueViolation(error) || !(await provider.getAccount(user.email))) throw error;
  }
}

export async function seedAccountsIfEmpty(provider: ServerStorageProvider): Promise<void> {
  if ((await provider.listAccounts()).length > 0) return;
  const now = new Date().toISOString();
  // getAuthUsers returns the admin and, only when USER_PASSWORD is set, one more account.
  const [admin, extra] = getAuthUsers();
  await insertSeeded(provider, admin, now);
  if (extra) await insertSeeded(provider, extra, now);
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
  await seedAccountsIfEmpty(provider);
  return (await provider.listAccounts()).map(toAuthUser);
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

export async function changeAccount(actor: string, email: string, body: unknown): Promise<PublicAccount> {
  const provider = await requireAccountStore();
  const patch = readPatch(body);
  const current = await provider.getAccount(email);
  if (!current) throw new AccountError(404, ACCOUNT_NOT_FOUND);
  const next: StoredAccount = {
    ...current,
    role: patch.role ?? current.role,
    disabled: patch.disabled ?? current.disabled,
    passwordHash: patch.password ? await hashPassword(patch.password) : current.passwordHash,
    totpSecret: patch.clearTotp ? null : current.totpSecret,
    totpPending: patch.clearTotp ? null : current.totpPending,
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
  return toPublic(next);
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

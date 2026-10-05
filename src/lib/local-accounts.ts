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
import { emitAuditEvent, type AuditReason } from "@/lib/audit";
import type { Role, UserPayload } from "@/lib/auth";
import { hmacHex } from "@/lib/auth-compare";
import { getAuthUsers, type AuthUser } from "@/lib/local-auth";
import { logger } from "@/lib/logger";
import { hashPassword, needsRehash, passwordMatchesHash } from "@/lib/password-hash";
import { getStorageProvider } from "@/lib/storage/factory";
import {
  AccountWriteConflict,
  LastAdminError,
  type AccountUpdateOptions,
  type ServerStorageProvider,
  type StoredAccount,
} from "@/lib/storage/types";
import { encodeBase32, claimTotpStep, verifyTotp } from "@/lib/totp";

export class AccountError extends Error {
  readonly status: number;
  /** A reauthentication that needs a current TOTP code and got none; the client then asks for one. */
  readonly codeRequired: boolean;
  constructor(status: number, message: string, options: { codeRequired?: boolean } = {}) {
    super(message);
    this.name = "AccountError";
    this.status = status;
    this.codeRequired = options.codeRequired ?? false;
  }
}

export interface PublicAccount {
  email: string;
  role: Role;
  disabled: boolean;
  totpEnabled: boolean;
  /** How many passkeys the account has; the admin table shows it. */
  passkeys: number;
  createdAt: string;
}

/** A write that read the account before another change to it landed; nothing was written. */
export const ACCOUNT_CHANGED = "The account changed at the same time. Reload the page and try again.";

const EMAIL_INVALID = "Enter an email address.";
const PASSWORD_SHORT = "Password must be at least 8 characters.";
const ROLE_INVALID = "Role must be admin or user.";
const DUPLICATE_ACCOUNT = "An account with that email already exists.";
const ACCOUNT_NOT_FOUND = "No account with that email exists.";
const LAST_ADMIN = "The last enabled admin cannot be removed.";
const EMPTY_PATCH = "Nothing to change.";
const DISABLED_TYPE = "disabled must be true or false.";
const CLEAR_TOTP_TYPE = "clearTotp must be true.";
const CLEAR_PASSKEYS_TYPE = "clearPasskeys must be true.";
const KEEP_PASSKEYS_TYPE = "keepPasskeys must be true.";
const KEEP_PASSKEYS_ALONE = "keepPasskeys applies only together with a new password, and never with clearPasskeys.";
const OIDC_MODE = "Accounts are managed by the identity provider in OIDC mode.";
const LOCAL_MODE = "The account registry needs STORAGE_PROVIDER=sqlite or postgres.";
const TOTP_MISSING = "Start authenticator setup before confirming a code.";
const TOTP_BAD = "Invalid authentication code";
const NOT_IN_STORE = "This session has no account in the registry.";
const CURRENT_PASSWORD_MISSING = "Enter your current password.";
const CURRENT_PASSWORD_WRONG = "The current password is not correct.";
const CURRENT_CODE_MISSING = "Enter a current code from your authenticator app.";
const FACTOR_ACTIVE = "Turn off the current authenticator before setting up a new one.";
const FACTOR_OIDC = "Two-factor authentication for this sign-in is managed by your identity provider.";
const FACTOR_LOCAL =
  "Setting up an authenticator here needs STORAGE_PROVIDER=sqlite or postgres. With STORAGE_PROVIDER=local an operator sets ADMIN_TOTP_SECRET or USER_TOTP_SECRET instead.";
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

/** An account's email, its username, is matched without regard to case on every sign-in path. */
export function sameEmail(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function toPublic(account: StoredAccount, passkeys: number): PublicAccount {
  return {
    email: account.email,
    role: account.role,
    disabled: account.disabled,
    totpEnabled: account.totpSecret !== null,
    passkeys,
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

export type AccountRefusalReason = Extract<
  AuditReason,
  | "bad_credentials"
  | "bad_totp"
  | "account_refused"
  | "passkey_ceremony_invalid"
  | "passkey_origin_mismatch"
  | "passkey_rejected"
  | "passkey_replayed"
  | "passkey_duplicate"
>;

/** One shape for every account event, shared with the passkey services; `passkey` is the internal id. */
export function auditAccountChange(actor: string, action: string, email: string, passkey?: string): void {
  try {
    emitAuditEvent({
      type: "account",
      action,
      target: email,
      user: actor,
      result: "success",
      reason: "account_changed",
      ...(passkey ? { passkey } : {}),
    });
  } catch (error) {
    logger.error("Failed to record account audit event", error, { route: "accounts" });
  }
}

/** A refused change the owner made to their own account, shared with the passkey services. */
export function auditAccountRefusal(
  email: string,
  action: string,
  reason: AccountRefusalReason,
  passkey?: string,
): void {
  try {
    emitAuditEvent({
      type: "account",
      action,
      target: email,
      user: email,
      result: "failure",
      reason,
      ...(passkey ? { passkey } : {}),
    });
  } catch (error) {
    logger.error("Failed to record account audit event", error, { route: "accounts" });
  }
}

function readCredential(
  body: unknown,
  field: "password" | "code",
  missing: string,
  options?: { codeRequired: boolean },
): string {
  const value = isRecord(body) ? body[field] : undefined;
  if (typeof value !== "string" || value.length === 0) throw new AccountError(400, missing, options);
  return value;
}

/**
 * Changing your own second factor asks for the password again, and turning an active one off asks
 * for a current code too, so a stolen session cookie can neither remove the factor nor replace it
 * with the thief's. A 401 from here is a failed guess, and the route charges it to the login budget.
 * The passkey services reuse it before adding or removing a passkey. A missing code is marked
 * `codeRequired`, so the client asks for one instead of guessing from the message.
 */
export async function confirmOwner(
  current: StoredAccount,
  body: unknown,
  action: string,
  needsCode: boolean,
): Promise<void> {
  const password = readCredential(body, "password", CURRENT_PASSWORD_MISSING);
  const code = needsCode ? readCredential(body, "code", CURRENT_CODE_MISSING, { codeRequired: true }) : "";
  if (!(await passwordMatchesHash(password, current.passwordHash))) {
    auditAccountRefusal(current.email, action, "bad_credentials");
    throw new AccountError(401, CURRENT_PASSWORD_WRONG);
  }
  if (!needsCode || !current.totpSecret) return;
  const step = verifyTotp(current.totpSecret, code);
  if (step === null || !claimTotpStep(hmacHex(current.email.toLowerCase()), step)) {
    auditAccountRefusal(current.email, action, "bad_totp");
    throw new AccountError(401, TOTP_BAD);
  }
}

/** The reconciled server store, or 409 in OIDC and local mode; the passkey services reuse it. */
export async function requireAccountStore(): Promise<ServerStorageProvider> {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "oidc") throw new AccountError(409, OIDC_MODE);
  const provider = await getStorageProvider();
  if (!provider) throw new AccountError(409, LOCAL_MODE);
  await reconcileOnce(provider);
  await seedAccountsIfEmpty(provider);
  return provider;
}

/** The session's own stored row, or 404 when it has none; the passkey services reuse it. */
export async function requireOwnAccount(
  email: string,
): Promise<{ provider: ServerStorageProvider; current: StoredAccount }> {
  const provider = await requireAccountStore();
  const current = await provider.getAccount(email);
  if (!current) throw new AccountError(404, NOT_IN_STORE);
  return { provider, current };
}

/**
 * A write that read the row before another change landed would put the old `disabled` and
 * session version back, so the store refuses it and the caller answers 409. Not a 401, so no
 * login budget is charged for it.
 */
async function writeAccount(
  provider: ServerStorageProvider,
  next: StoredAccount,
  options: AccountUpdateOptions,
): Promise<number> {
  try {
    return await provider.updateAccount(next, options);
  } catch (error) {
    if (error instanceof AccountWriteConflict) throw new AccountError(409, ACCOUNT_CHANGED);
    throw error;
  }
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
  `ADMIN_PASSWORD_RESET is set: ${email} is an enabled admin again, signs in with ADMIN_PASSWORD, and has no passkeys. Remove ADMIN_PASSWORD_RESET now; every start applies it again while it is set.`;
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
 * ADMIN_TOTP_SECRET, or no second factor) and has no passkeys, whatever the store holds. Every
 * session it had ends. A conflicting write propagates: reconcileOnce forgets the failed attempt,
 * so the next request applies the reset again.
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
  if (stored) await provider.updateAccount(next, { expected: stored, clearPasskeys: true });
  else await provider.insertAccount(next);
  auditAccountChange("environment", "reset", next.email);
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
    const next = { ...account, passwordHash: await hashPassword(password), updatedAt: new Date().toISOString() };
    // A conflict lands in the catch below: another change won, and the next login rehashes.
    await provider.updateAccount(next, { expected: account });
  } catch (error) {
    logger.error("Failed to rehash account password", error, { route: "POST /api/auth/login" });
  }
}

/** The actor an account change made by a launch is recorded under, as "environment" is for the reset. */
const LAUNCH_ACTOR = "launch";
const LAUNCH_NOT_LINKED =
  "This email belongs to a Studio account that a launch link cannot sign in to. Sign in with that account's password, or ask a Studio admin.";
const LAUNCH_DISABLED = "This account is disabled in Studio. Ask a Studio admin to enable it.";
const LAUNCH_LAST_ADMIN =
  "Studio did not make this account a user, because it is the last enabled admin. Ask a Studio admin to make another account an admin first.";

/** What a verified launch token asks for: an account, a role, and the platform identity it speaks for. */
export interface LaunchIdentity {
  email: string;
  role: Role;
  /** The token's `iss`, which the verifier matched to LAUNCH_TOKEN_ISSUER. */
  issuer: string;
  /** The token's `sub`, the person's id on that platform. */
  subject: string;
}

/** Who a verified launch token signs in as. `sessionVersion` is set only for an account in the server store. */
export interface LaunchAccount {
  role: Role;
  username: string;
  sessionVersion?: number;
}

/**
 * What the password_hash of an account a launch created holds: not a scrypt encoding, so no password ever
 * matches it (passwordMatchesHash runs its placeholder KDF and answers false), but the issuer and subject the
 * account is bound to, base64url-encoded so that neither can write the separator. The binding lives in that
 * column because it means exactly "this account has no password": an admin who sets a password replaces it,
 * and the account is from then on a password account that no launch reaches. Adding an authenticator or a
 * passkey asks for the current password (confirmOwner), so a bound account gains neither while it is bound.
 */
function launchIdentityHash(issuer: string, subject: string): string {
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  return `launch-identity$${encode(issuer)}$${encode(subject)}`;
}

/**
 * A new account for a launched email, bound to the token's issuer and subject, with the token's role. Two
 * launches racing to create the same email leave one row, and the loser goes on with the winner's, which
 * provisionLaunchAccount then checks like any stored account.
 */
async function insertLaunchAccount(provider: ServerStorageProvider, launch: LaunchIdentity): Promise<StoredAccount> {
  const now = new Date().toISOString();
  const account: StoredAccount = {
    email: launch.email,
    passwordHash: launchIdentityHash(launch.issuer, launch.subject),
    role: launch.role,
    totpSecret: null,
    totpPending: null,
    disabled: false,
    sessionVersion: initialSessionVersion(),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await provider.insertAccount(account);
  } catch (error) {
    const winner = isUniqueViolation(error) ? await provider.getAccount(launch.email) : null;
    if (!winner) throw error;
    return winner;
  }
  auditAccountChange(LAUNCH_ACTOR, "create", launch.email);
  return account;
}

/**
 * The account a verified launch token signs in (docs/LAUNCH.md).
 *
 * The ADMIN_EMAIL address is refused in both storage modes, even while its row is missing, so a launch never
 * takes the break-glass address (contract A3.2). With STORAGE_PROVIDER=local there is no row to consult, as
 * storedAccountAllows says, and the accounts getAuthUsers() lists are the ones that sign in with a password,
 * so every one of their emails is refused: a launch session under one would share that account's transactions,
 * agent runs and audit trail. Any other email gets a session that carries the token's email and role, and
 * nothing is stored. OIDC is refused, as every account path refuses it, before the store is opened: the
 * launch route already answers 503 in that mode (src/lib/launch/config.ts).
 *
 * In the server store every session must match a stored account, so the launch provides one, and it reaches
 * only an account a launch created for the same platform identity. An email with no account gets one, bound
 * to the token's issuer and subject. An existing account is matched without regard to case, as password login
 * matches it, and is refused unless it carries that same binding and holds no authenticator and no passkey:
 * matching by email alone would hand a launch any password account with that address, the seeded ADMIN_EMAIL
 * included, and an email the platform reassigned would reach the previous owner's account. The binding is
 * checked before the disabled flag, so a refusal tells nobody but the bound person whether an account is
 * disabled. A bound account takes the token's role when it differs, which moves the session version on and
 * ends its other sessions, exactly as an admin's role change does, and the store still refuses to remove the
 * last enabled admin. A disabled account is refused and never revived: the platform says who the person is,
 * and disabling is Studio's own decision about them.
 *
 * The registry is reconciled and seeded first, as on every other sign-in path, so a launch into an empty
 * store can never take the place of the environment admin.
 *
 * @throws {AccountError} 403 for an account a launch cannot sign in to, 401 for a disabled account, 409 when
 * the role change would leave no enabled admin or the account changed while it was read, and 409 under OIDC.
 */
export async function provisionLaunchAccount(launch: LaunchIdentity): Promise<LaunchAccount> {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "oidc") throw new AccountError(409, OIDC_MODE);
  const environmentAccounts = getAuthUsers();
  // The break-glass address (contract A3.2) is never a launch account, in either mode, even while its row is missing.
  if (sameEmail(environmentAccounts[0].email, launch.email)) throw new AccountError(403, LAUNCH_NOT_LINKED);
  const provider = await getStorageProvider();
  if (!provider) {
    if (environmentAccounts.some((account) => sameEmail(account.email, launch.email))) {
      throw new AccountError(403, LAUNCH_NOT_LINKED);
    }
    return { role: launch.role, username: launch.email };
  }
  await reconcileOnce(provider);
  await seedAccountsIfEmpty(provider);
  const stored = (await provider.listAccounts()).find((account) => sameEmail(account.email, launch.email));
  const current = stored ?? (await insertLaunchAccount(provider, launch));
  const passkeys = (await provider.countPasskeys()).get(current.email) ?? 0;
  if (
    current.passwordHash !== launchIdentityHash(launch.issuer, launch.subject) ||
    current.totpSecret !== null ||
    passkeys > 0
  ) {
    throw new AccountError(403, LAUNCH_NOT_LINKED);
  }
  if (current.disabled) throw new AccountError(401, LAUNCH_DISABLED);
  if (current.role === launch.role) {
    return { role: current.role, username: current.email, sessionVersion: current.sessionVersion };
  }
  const next: StoredAccount = {
    ...current,
    role: launch.role,
    sessionVersion: current.sessionVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  try {
    await writeAccount(provider, next, {
      expected: current,
      keepEnabledAdmin: isEnabledAdmin(current) && !isEnabledAdmin(next),
    });
  } catch (error) {
    if (error instanceof LastAdminError) throw new AccountError(409, LAUNCH_LAST_ADMIN);
    throw error;
  }
  auditAccountChange(LAUNCH_ACTOR, "role", current.email);
  return { role: next.role, username: current.email, sessionVersion: next.sessionVersion };
}

export async function listPublicAccounts(): Promise<PublicAccount[]> {
  const provider = await requireAccountStore();
  const counts = await provider.countPasskeys();
  return (await provider.listAccounts()).map((account) => toPublic(account, counts.get(account.email) ?? 0));
}

async function createAccountOrRefuse(actor: string, body: unknown): Promise<PublicAccount> {
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
  auditAccountChange(actor, "create", stored.email);
  return toPublic(stored, 0);
}

interface AccountPatch {
  role?: Role;
  disabled?: boolean;
  password?: string;
  clearTotp?: boolean;
  clearPasskeys?: boolean;
  keepPasskeys?: boolean;
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
  if (body.clearPasskeys !== undefined) {
    if (body.clearPasskeys !== true) throw new AccountError(400, CLEAR_PASSKEYS_TYPE);
    patch.clearPasskeys = true;
  }
  if (body.keepPasskeys !== undefined) {
    if (body.keepPasskeys !== true) throw new AccountError(400, KEEP_PASSKEYS_TYPE);
    if (patch.password === undefined || patch.clearPasskeys) throw new AccountError(400, KEEP_PASSKEYS_ALONE);
    patch.keepPasskeys = true;
  }
  if (
    patch.role === undefined &&
    patch.disabled === undefined &&
    patch.password === undefined &&
    !patch.clearTotp &&
    !patch.clearPasskeys
  ) {
    throw new AccountError(400, EMPTY_PATCH);
  }
  return patch;
}

function isEnabledAdmin(account: StoredAccount): boolean {
  return account.role === "admin" && !account.disabled;
}

/**
 * The store decides "an enabled admin remains" inside the write's own transaction, because a
 * read-then-write check here let two concurrent requests each remove one of the last two admins.
 */
async function guardLastAdmin<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof LastAdminError) throw new AccountError(409, LAST_ADMIN);
    throw error;
  }
}

export interface ChangedAccount {
  account: PublicAccount;
  /** The version a session for this account must now carry; the route re-issues the actor's own. */
  sessionVersion: number;
}

async function changeAccountOrRefuse(actor: string, email: string, body: unknown): Promise<ChangedAccount> {
  const provider = await requireAccountStore();
  const patch = readPatch(body);
  const current = await provider.getAccount(email);
  if (!current) throw new AccountError(404, ACCOUNT_NOT_FOUND);
  const role = patch.role ?? current.role;
  const disabled = patch.disabled ?? current.disabled;
  // A password set is a recovery (docs/PASSKEYS.md, "Admin actions and recovery"): it removes passkeys unless the admin keeps them.
  const clearsPasskeys = patch.clearPasskeys === true || (patch.password !== undefined && patch.keepPasskeys !== true);
  // Each of these changes what an existing session was issued for, so each ends it.
  const endsSessions =
    role !== current.role || (disabled && !current.disabled) || patch.password !== undefined || clearsPasskeys;
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
  // Read before the write, so a failing count refuses the change instead of failing a committed one. A count
  // parses no row, so one unreadable passkey never blocks disabling the account.
  const passkeys = clearsPasskeys ? 0 : ((await provider.countPasskeys()).get(current.email) ?? 0);
  const removed = await guardLastAdmin(() =>
    writeAccount(provider, next, {
      expected: current,
      keepEnabledAdmin: isEnabledAdmin(current) && !isEnabledAdmin(next),
      ...(clearsPasskeys ? { clearPasskeys: true } : {}),
    }),
  );
  if (patch.role !== undefined && patch.role !== current.role) auditAccountChange(actor, "role", current.email);
  if (patch.disabled !== undefined && patch.disabled !== current.disabled) {
    auditAccountChange(actor, patch.disabled ? "disable" : "enable", current.email);
  }
  if (patch.password) auditAccountChange(actor, "password", current.email);
  if (patch.clearTotp) auditAccountChange(actor, "totp_clear", current.email);
  if (removed > 0) auditAccountChange(actor, "passkey_clear", current.email);
  return { account: toPublic(next, passkeys), sessionVersion: next.sessionVersion };
}

async function removeAccountOrRefuse(actor: string, email: string): Promise<void> {
  const provider = await requireAccountStore();
  const current = await provider.getAccount(email);
  if (!current) throw new AccountError(404, ACCOUNT_NOT_FOUND);
  await guardLastAdmin(() => provider.deleteAccount(current.email, { keepEnabledAdmin: isEnabledAdmin(current) }));
  auditAccountChange(actor, "delete", current.email);
}

export type OwnFactorStatus = { available: false; reason: string } | { available: true; enabled: boolean };

/** What the authenticator screen offers the signed-in account, and why when it offers nothing. */
export async function ownFactorStatus(email: string): Promise<OwnFactorStatus> {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "oidc") return { available: false, reason: FACTOR_OIDC };
  const provider = await getStorageProvider();
  if (!provider) return { available: false, reason: FACTOR_LOCAL };
  const current = await provider.getAccount(email);
  if (!current) throw new AccountError(404, NOT_IN_STORE);
  return { available: true, enabled: current.totpSecret !== null };
}

/**
 * A refused admin change is written to the audit log too, so an attempt to remove the last admin,
 * or to act on an account that does not exist, is on the record with the admin who made it.
 */
async function auditedRefusal<T>(actor: string, action: string, target: unknown, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AccountError) {
      try {
        emitAuditEvent({
          type: "account",
          action,
          target: typeof target === "string" ? target : "",
          user: actor,
          result: "failure",
          reason: "account_refused",
        });
      } catch (auditError) {
        logger.error("Failed to record account audit event", auditError, { route: "accounts" });
      }
    }
    throw error;
  }
}

export async function createAccount(actor: string, body: unknown): Promise<PublicAccount> {
  return auditedRefusal(actor, "create", isRecord(body) ? body.email : undefined, () =>
    createAccountOrRefuse(actor, body),
  );
}

export async function changeAccount(actor: string, email: string, body: unknown): Promise<ChangedAccount> {
  return auditedRefusal(actor, "change", email, () => changeAccountOrRefuse(actor, email, body));
}

export async function removeAccount(actor: string, email: string): Promise<void> {
  return auditedRefusal(actor, "delete", email, () => removeAccountOrRefuse(actor, email));
}

function otpauthUrl(email: string, secret: string): string {
  return `otpauth://totp/LibreDB:${encodeURIComponent(email)}?secret=${secret}&issuer=LibreDB&algorithm=SHA1&digits=6&period=30`;
}

export async function beginTotpEnrolment(
  email: string,
  body?: unknown,
): Promise<{ secret: string; otpauthUrl: string }> {
  const { provider, current } = await requireOwnAccount(email);
  await confirmOwner(current, body, "totp_begin", false);
  if (current.totpSecret) throw new AccountError(409, FACTOR_ACTIVE);
  const secret = encodeBase32(randomBytes(20));
  const next = { ...current, totpPending: secret, updatedAt: new Date().toISOString() };
  await writeAccount(provider, next, { expected: current });
  auditAccountChange(email, "totp_begin", current.email);
  return { secret, otpauthUrl: otpauthUrl(email, secret) };
}

export async function confirmTotpEnrolment(email: string, code: string): Promise<void> {
  const provider = await requireAccountStore();
  const current = await provider.getAccount(email);
  if (!current?.totpPending) throw new AccountError(400, TOTP_MISSING);
  const step = verifyTotp(current.totpPending, code);
  if (step === null || !claimTotpStep(hmacHex(email.toLowerCase()), step)) throw new AccountError(400, TOTP_BAD);
  const next = { ...current, totpSecret: current.totpPending, totpPending: null, updatedAt: new Date().toISOString() };
  await writeAccount(provider, next, { expected: current });
  auditAccountChange(email, "totp_enrol", current.email);
}

export async function disableOwnTotp(email: string, body?: unknown): Promise<void> {
  const { provider, current } = await requireOwnAccount(email);
  await confirmOwner(current, body, "totp_clear", current.totpSecret !== null);
  const next = { ...current, totpSecret: null, totpPending: null, updatedAt: new Date().toISOString() };
  await writeAccount(provider, next, { expected: current });
  auditAccountChange(email, "totp_clear", current.email);
}

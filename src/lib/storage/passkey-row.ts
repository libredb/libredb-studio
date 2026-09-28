import { PASSKEY_TRANSPORTS, type PasskeyTransport, type StoredPasskey } from "./types";

/** Columns of the `passkey_credentials` table, as both drivers return them. */
export interface PasskeyRow {
  id: string;
  credential_id: string;
  account_email: string;
  public_key: string;
  sign_count: number | string;
  transports: string;
  backup_eligible: number | string | boolean;
  backup_state: number | string | boolean;
  rp_id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** The column list both providers' SELECTs use, in `PasskeyRow` order. */
export const PASSKEY_COLUMNS =
  "id, credential_id, account_email, public_key, sign_count, transports, backup_eligible, backup_state, rp_id, name, created_at, last_used_at";

/** The same list qualified by the alias `c`, for both providers' `findPasskey` join. */
export const PASSKEY_COLUMNS_OF_C = PASSKEY_COLUMNS.split(", ")
  .map((column) => `c.${column}`)
  .join(", ");

// Number("") and Number(" ") are 0, so a blank string would read as a valid zero.
function numeric(value: number | string | boolean): number {
  return typeof value === "string" && value.trim() === "" ? Number.NaN : Number(value);
}

const MAX_SIGN_COUNT = 4294967295;

function flag(row: PasskeyRow, column: "backup_eligible" | "backup_state"): boolean {
  const value = numeric(row[column]);
  if (value !== 0 && value !== 1) throw new Error(`passkey_credentials row ${row.id} has ${column} ${row[column]}`);
  return value === 1;
}

function isTransport(value: unknown): value is PasskeyTransport {
  return (PASSKEY_TRANSPORTS as readonly unknown[]).includes(value);
}

// Registration filters transports once, so a stored name outside the list is a row fault, not input.
function transports(row: PasskeyRow): PasskeyTransport[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.transports);
  } catch (error) {
    throw new Error(`passkey_credentials row ${row.id} has transports that are not JSON`, { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every(isTransport)) {
    throw new Error(`passkey_credentials row ${row.id} has transports ${row.transports}`);
  }
  return parsed;
}

export function passkeyFromRow(row: PasskeyRow): StoredPasskey {
  const signCount = numeric(row.sign_count);
  if (!Number.isSafeInteger(signCount) || signCount < 0 || signCount > MAX_SIGN_COUNT) {
    throw new Error(`passkey_credentials row ${row.id} has sign_count ${row.sign_count}`);
  }
  return {
    id: row.id,
    credentialId: row.credential_id,
    accountEmail: row.account_email,
    publicKey: row.public_key,
    signCount,
    transports: transports(row),
    backupEligible: flag(row, "backup_eligible"),
    backupState: flag(row, "backup_state"),
    rpId: row.rp_id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
  };
}

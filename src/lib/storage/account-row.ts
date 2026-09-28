import type { StoredAccount } from "./types";

/** Columns of the `accounts` table, as both drivers return them. */
export interface AccountRow {
  email: string;
  password_hash: string;
  role: string;
  totp_secret: string | null;
  totp_pending: string | null;
  disabled: number | boolean | string;
  session_version: number | string;
  created_at: string;
  updated_at: string;
}

export function accountFromRow(row: AccountRow): StoredAccount {
  if (row.role !== "admin" && row.role !== "user") {
    throw new Error(`accounts row ${row.email} has role ${row.role}`);
  }
  const sessionVersion = Number(row.session_version);
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) {
    throw new Error(`accounts row ${row.email} has session_version ${row.session_version}`);
  }
  return {
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    totpSecret: row.totp_secret ?? null,
    totpPending: row.totp_pending ?? null,
    disabled: Number(row.disabled) === 1,
    sessionVersion,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

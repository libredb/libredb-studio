import { CREDENTIAL_WARNINGS, type CredentialWarning } from "@/lib/db/credential-warnings";
import type { DatabaseType } from "@/lib/types";

/**
 * Synthetic declarations: Milvus and Qdrant declare the shipped records (src/lib/db/credential-warnings.ts), and
 * each test here declares a synthetic one on another real type for its own duration, so the mechanism is exercised
 * apart from any provider's data. `etcd` carries the pair and no-secret cases because its provider enforces `readOnly`, so a
 * read-only seed of it reaches the credential check at all.
 */
/**
 * The synthetic pair's password: a named stand-in, as every new test fixture in this repository uses, and never a
 * realistic value such as a vendor's published default. It differs from the field name `password`, so a test can
 * prove that a refusal never echoes it.
 */
export const SYNTHETIC_PASSWORD = "password-second";

export const SYNTHETIC_PAIR = {
  kind: "pair",
  user: "root",
  password: SYNTHETIC_PASSWORD,
  message: "This user and password are a published default, so anyone who knows the product knows them.",
} as const satisfies CredentialWarning;

export const SYNTHETIC_NO_SECRET = {
  kind: "no-secret",
  message:
    "This connection type accepts a connection with no secret, so a read-only seed without one promises a boundary the server does not keep.",
} as const satisfies CredentialWarning;

export const SYNTHETIC_JWT = {
  kind: "jwt",
  noExp: true,
  access: ["m", "absent"],
  message: "This token declares no expiry, or manage access over everything.",
} as const satisfies CredentialWarning;

/** Declares `entries` for `type` in the shared record and returns the undo, which a test runs in `afterEach`. */
export function declareCredentialWarnings(type: DatabaseType, entries: readonly CredentialWarning[]): () => void {
  const record = CREDENTIAL_WARNINGS as Partial<Record<DatabaseType, readonly CredentialWarning[]>>;
  const before = record[type];
  record[type] = entries;
  return () => {
    if (before === undefined) delete record[type];
    else record[type] = before;
  };
}

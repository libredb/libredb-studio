/**
 * The one rule for the server's own cloud identity: a connection may use it only when it is server-written (its
 * `managed` flag is exactly true, set only on the server side, and it is not a seed-file row read in literal mode) and
 * the provider's operator opt-in is exactly "true". `managed` alone does not say the server side wrote the credential
 * text: a seed file read in literal mode (SEED_LITERAL_VALUES) is written by a platform from data its users control,
 * and its rows carry LITERAL_SEED_FILE. Each provider declares its own opt-in variable and its own three refusal
 * sentences; nothing here reads more of the environment than that one variable.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { type DatabaseConnection, type DatabaseType, LITERAL_SEED_FILE, type WithLiteralSeedFile } from "@/lib/types";

/** The environment as a value: the caller decides whether it is a snapshot or read at each call. */
export type AuthEnv = Readonly<Record<string, string | undefined>>;

/** The provider's opt-in: an environment variable whose name ends in _SERVER_CREDENTIALS, and its three refusals. */
export interface ServerIdentityGate {
  readonly optIn: `${string}_SERVER_CREDENTIALS`;
  /** Raised when the connection's managed flag is not exactly true. */
  readonly unmanaged: string;
  /** Raised when managed is exactly true and the record carries LITERAL_SEED_FILE (a seed-file row read in literal mode). */
  readonly literalSeedFile: string;
  /** Raised when the connection is server-written and env[optIn] is not exactly "true". */
  readonly withoutOptIn: string;
}

/** What the gate reads of a connection: its managed flag and the literal-mode marker. */
type ServerIdentityRecord = Pick<DatabaseConnection, "managed"> & WithLiteralSeedFile;

/** Managed exactly true, and the record does not carry LITERAL_SEED_FILE (a seed-file row read in literal mode). */
export function isServerWritten(connection: ServerIdentityRecord): boolean {
  return connection.managed === true && connection[LITERAL_SEED_FILE] !== true;
}

/**
 * Admits only when isServerWritten(connection) and env[optIn] is exactly "true". Throws DatabaseConfigError(unmanaged)
 * when managed is not exactly true, DatabaseConfigError(literalSeedFile) when the record carries the marker, then
 * DatabaseConfigError(withoutOptIn); reads nothing of the environment but env[optIn], and that only last.
 */
export function admitServerIdentity(
  gate: ServerIdentityGate,
  connection: ServerIdentityRecord,
  env: AuthEnv,
  provider: DatabaseType | undefined,
): void {
  if (!isServerWritten(connection)) {
    throw new DatabaseConfigError(connection.managed === true ? gate.literalSeedFile : gate.unmanaged, provider);
  }
  if (env[gate.optIn] !== "true") throw new DatabaseConfigError(gate.withoutOptIn, provider);
}

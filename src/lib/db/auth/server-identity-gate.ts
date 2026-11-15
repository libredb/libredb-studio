/**
 * The one rule for the server's own cloud identity: a connection may use it only when its `managed` flag is exactly
 * true (set only on the server side; a browser-sent record never carries it) and the provider's operator opt-in is
 * exactly "true". `managed` alone does not say the server side wrote the credential text. Each provider declares its own opt-in variable and its own two refusal sentences; nothing here reads more of
 * the environment than that one variable.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseType } from "@/lib/types";

/** The environment as a value: the caller decides whether it is a snapshot or read at each call. */
export type AuthEnv = Readonly<Record<string, string | undefined>>;

/** The provider's opt-in: an environment variable whose name ends in _SERVER_CREDENTIALS, and its two refusals. */
export interface ServerIdentityGate {
  readonly optIn: `${string}_SERVER_CREDENTIALS`;
  /** Raised when the connection's managed flag is not exactly true. */
  readonly unmanaged: string;
  /** Raised when managed is exactly true and env[optIn] is not exactly "true". */
  readonly withoutOptIn: string;
}

/** Throws DatabaseConfigError(unmanaged), then DatabaseConfigError(withoutOptIn); reads nothing but env[optIn]. */
export function admitServerIdentity(
  gate: ServerIdentityGate,
  managed: boolean | undefined,
  env: AuthEnv,
  provider: DatabaseType | undefined,
): void {
  if (managed !== true) throw new DatabaseConfigError(gate.unmanaged, provider);
  if (env[gate.optIn] !== "true") throw new DatabaseConfigError(gate.withoutOptIn, provider);
}

/**
 * The operator seed sources (Spec A, section 5.1): the seed file, and in A2 the seed directory, the inline config
 * and the environment URLs. Each source reads its own input and hands the operator loader validated entries;
 * the loader resolves them, refuses collisions, caches them and records each source's status for the admin view.
 * Every message, skip and note a source writes carries variable, parameter, field, file and id names only, never a
 * value.
 */
import type { DatabaseType } from "@/lib/types";
import type { SeedConnection } from "../types";

/** The variable that turns a source on, which is also its name in the admin status. */
export type OperatorSourceName =
  | "SEED_CONFIG_PATH"
  | "SEED_CONFIG_DIR"
  | "SEED_CONFIG_INLINE"
  | "SEED_CONFIG_BASE64"
  | "SEED_CONNECTION";

export type OperatorSourceState = "ok" | "empty" | "missing" | "error";

/** What one fill hands every source: the literal mode it read once, so all its sources agree. */
export interface OperatorLoadContext {
  readonly literalValues: boolean;
}

export interface OperatorSource {
  readonly name: OperatorSourceName;
  /** Throws an OperatorSourceError (or a raw error the loader reports as "unreadable") on any failure. */
  load(context: OperatorLoadContext): Promise<OperatorSourceResult>;
}

export interface OperatorEntry {
  /** Validated, with its own file's `defaults` merged; ${ENV} not yet resolved. */
  connection: SeedConnection;
  /** true: no ${ENV} or ${vault:...} resolution and no plaintext warning. */
  literal: boolean;
  /** A file path or a variable name, never a value. */
  origin: string;
}

export type SourceNote =
  | { kind: "ignored-variable"; name: string }
  | { kind: "ignored-parameter"; origin: string; name: string };

/** A connection a source or the fill dropped without failing the list. Names only, never a value. */
export interface OperatorSkip {
  id: string;
  origin: string;
  reason: string;
  variable?: string;
  field?: string;
}

export interface OperatorSourceResult {
  entries: OperatorEntry[];
  skips: OperatorSkip[];
  notes: SourceNote[];
  /** A source never reports "error": it throws, and the loader records the error status. */
  status: { state: Exclude<OperatorSourceState, "error"> };
}

export type OperatorSourceErrorCode = "unreadable" | "unparseable" | "invalid" | "duplicate-id" | "refused";

export class OperatorSourceError extends Error {
  readonly code: OperatorSourceErrorCode;
  constructor(code: OperatorSourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OperatorSourceError";
    this.code = code;
  }
}

/** One source in the admin diagnostics (spec 5.3). */
export interface OperatorSourceReport {
  source: OperatorSourceName;
  /** The file or directory path for SEED_CONFIG_PATH and SEED_CONFIG_DIR; null for the env sources. */
  location: string | null;
  state: OperatorSourceState;
  checkedAt: string;
  error: { code: OperatorSourceErrorCode; message: string } | null;
  connected: { id: string; name: string; type: DatabaseType }[];
  skipped: OperatorSkip[];
  notes: SourceNote[];
}

import type { DriverErrorClassifier } from "@/lib/db/driver-errors/types";

/**
 * SQLite primary result codes for a statement the library refused (#1427): `SQLITE_ERROR` (1,
 * a syntax error or an unknown table or column), `SQLITE_CONSTRAINT` (19), `SQLITE_MISMATCH`
 * (20) and `SQLITE_RANGE` (25, a bind index out of range). An extended code carries its primary
 * code in its low byte, which is how `SQLITE_CONSTRAINT_UNIQUE` (2067) reads as 19.
 */
const SQLITE_STATEMENT_RESULT_CODES = new Set([1, 19, 20, 25]);

/** Whether `code` is a result code `bun:sqlite` names (`SQLITE_CONSTRAINT_PRIMARYKEY`). */
const isNamedResultCode = (code: unknown): code is string => typeof code === "string" && code.startsWith("SQLITE_");

/** Whether the fields are `node:sqlite`'s: the extended code in `errcode` under `code: "ERR_SQLITE_ERROR"`. */
const isNodeSqliteError = (fields: { readonly code?: unknown; readonly errcode?: unknown }): boolean =>
  fields.code === "ERR_SQLITE_ERROR" && typeof fields.errcode === "number";

/**
 * The SQLite drivers' row. `bun:sqlite` names the result code in `code`, and a named code decides whether the
 * statement is at fault on its own, whatever it is; `node:sqlite` puts the extended code in `errcode`.
 */
export const SQLITE_DRIVER_ERRORS = Object.freeze({
  driver: "sqlite",
  carriesCode: (fields) => isNamedResultCode(fields.code) || isNodeSqliteError(fields),
  statementFault: (fields) => {
    if (isNamedResultCode(fields.code)) return /^SQLITE_(ERROR|CONSTRAINT|MISMATCH|RANGE)(_|$)/.test(fields.code);
    if (isNodeSqliteError(fields)) return SQLITE_STATEMENT_RESULT_CODES.has((fields.errcode as number) & 0xff);
    return undefined;
  },
} satisfies DriverErrorClassifier);

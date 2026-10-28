import type { AccessRefusal, DriverErrorClassifier } from "@/lib/db/driver-errors/types";

/**
 * Db2 SQLCODEs of an access refusal whose SQLSTATE is a connection class: SQL1060N, a user without the CONNECT
 * privilege (`08004`), and SQL30082N, security processing failed (`08001`).
 */
const DB2_ACCESS_REFUSALS: ReadonlyMap<number, AccessRefusal> = new Map([
  [-1060, "privilege"],
  [-30082, "credential"],
]);

/** `db2-node`'s row: the SQLSTATE in `sqlstate`, read by the shared mapping, and the SQLCODE in `sqlcode`. */
export const DB2_DRIVER_ERRORS = Object.freeze({
  driver: "db2",
  accessRefusal: (fields) => (typeof fields.sqlcode === "number" ? DB2_ACCESS_REFUSALS.get(fields.sqlcode) : undefined),
  carriesCode: (fields) => typeof fields.sqlcode === "number",
} satisfies DriverErrorClassifier);

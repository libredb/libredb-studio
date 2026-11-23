/**
 * A driver error row maps into the error record (docs/providers/CONTRACT.md, clause E-7).
 *
 * A row (`DriverErrorClassifier`, `@libredb/provider-sdk/errors`) answers questions about a driver's error, and
 * `mapDatabaseError` turns each answer into one error class, so into one kind of the record. This file plants one
 * registry whose single row answers each member for exactly one marked input, and holds the kind each answer maps to
 * and the driver's SQLSTATE the record keeps. The registry is replaced with `mock.module` before the mapping is
 * imported; the test runner gives this file its own process, so no other file sees the planted row.
 */
import { describe, expect, mock, test } from "bun:test";
import type { DriverErrorClassifier, DriverErrorFields, ErrorKind } from "@libredb/provider-sdk/errors";

const PLANTED_ROW: DriverErrorClassifier = {
  driver: "planted-driver",
  configRefusal: (message) =>
    message.includes("mark-config") ? "The planted driver refused its configuration." : null,
  missingDatabase: (message) => message.includes("mark-missing-database"),
  credentialWords: ["mark-refused-login"],
  accessRefusal: (fields: DriverErrorFields) =>
    fields.code === "MARK_PRIVILEGE" ? "privilege" : fields.code === "MARK_CREDENTIAL" ? "credential" : undefined,
  carriesCode: (fields) => typeof fields.code === "string" && fields.code.startsWith("MARK_"),
  statementFault: (fields) => (fields.code === "MARK_STATEMENT" ? true : undefined),
  timeout: (message) => message.includes("mark-elapsed"),
  cancelled: (message) => message.includes("mark-stopped"),
  late: (message) => {
    if (message.includes("mark-late-connection")) return { kind: "connection", message: "Refused by the listener." };
    if (message.includes("mark-late-query")) return { kind: "query", message: "No such object.", keepsPosition: false };
    return undefined;
  },
};

mock.module("@/lib/db/driver-errors", () => ({ DRIVER_ERROR_CLASSIFIERS: Object.freeze([PLANTED_ROW]) }));

const { mapDatabaseError } = await import("@/lib/db/map-database-error");
const { errorRecord } = await import("@/lib/db/operations/provider-text");

/** A scrub with no credential form, so no text is withheld and the record keeps every SQLSTATE the error carries. */
const EMPTY_SCRUB = { type: "postgres", forms: [] } as const;

/** A SQLSTATE no branch of the mapping reads as a class of its own, so only the row decides. */
const NEUTRAL_SQLSTATE = "HY000";

interface Case {
  readonly member: string;
  readonly message: string;
  readonly code?: string;
  readonly sqlState?: string;
  readonly kind: ErrorKind;
}

const CASES: readonly Case[] = [
  { member: "configRefusal", message: "mark-config", sqlState: NEUTRAL_SQLSTATE, kind: "config" },
  { member: "missingDatabase", message: "mark-missing-database", sqlState: NEUTRAL_SQLSTATE, kind: "connection" },
  {
    member: "accessRefusal privilege",
    message: "refused",
    code: "MARK_PRIVILEGE",
    sqlState: NEUTRAL_SQLSTATE,
    kind: "permission",
  },
  {
    member: "accessRefusal credential",
    message: "refused",
    code: "MARK_CREDENTIAL",
    sqlState: NEUTRAL_SQLSTATE,
    kind: "authentication",
  },
  // The words are read only on an error that carries no code, so this case carries no SQLSTATE either.
  { member: "credentialWords", message: "mark-refused-login", kind: "authentication" },
  {
    member: "statementFault",
    message: "bad statement",
    code: "MARK_STATEMENT",
    sqlState: NEUTRAL_SQLSTATE,
    kind: "query",
  },
  { member: "timeout", message: "mark-elapsed", sqlState: NEUTRAL_SQLSTATE, kind: "timeout" },
  { member: "cancelled", message: "mark-stopped", sqlState: NEUTRAL_SQLSTATE, kind: "cancelled" },
  { member: "late connection", message: "mark-late-connection", sqlState: NEUTRAL_SQLSTATE, kind: "connection" },
  { member: "late query", message: "mark-late-query", sqlState: NEUTRAL_SQLSTATE, kind: "query" },
];

function driverError(item: Case): Error {
  return Object.assign(new Error(item.message), {
    ...(item.code === undefined ? {} : { code: item.code }),
    ...(item.sqlState === undefined ? {} : { sqlState: item.sqlState }),
  });
}

describe("the driver error row contract", () => {
  test("each answer a driver row gives maps to one error kind, keeping the driver's SQLSTATE", () => {
    for (const item of CASES) {
      const record = errorRecord(EMPTY_SCRUB, mapDatabaseError(driverError(item), "postgres", "SELECT 1"));
      expect({ member: item.member, kind: record.kind, sqlState: record.sqlState }).toEqual({
        member: item.member,
        kind: item.kind,
        sqlState: item.sqlState,
      });
    }
  });

  test("an error no member answers keeps the generic mapping", () => {
    const record = errorRecord(EMPTY_SCRUB, mapDatabaseError(new Error("nothing marked"), "postgres"));

    expect(record.kind).toBe("database");
  });
});

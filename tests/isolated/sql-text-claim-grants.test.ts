/**
 * Each SQL text gate answers Studio's grant of its claim from the engine's register row, never the declaration or the
 * row as written (docs/providers/CONTRACT.md, clauses M-54 and S-8): the query event log redacts a statement by the
 * granted redaction, which the legacy record of its engine holds, and the browser's confirmation gate reads the
 * granted exempt forms, the granted text-not-SQL claim, the granted decides-alone claim and whether the engine's row
 * reviewed its grammar, each from `legacyEngineGrants`.
 *
 * Under tests/isolated because it replaces `@/lib/db/claim-grants` with `mock.module()` before it imports any gate or
 * the legacy records, which holds only while this file is the first in its bun process to evaluate them. The grant
 * module is the real one with `legacyEngineGrants` answering a planted copy of five shipped engines' grants, so every
 * gate below answers differently from its engine's declaration and register row, and only the grant can be what it
 * read. The factory reads only the real exports captured before the mock.
 */
import { describe, expect, mock, test } from "bun:test";
import type { EngineGrants } from "@/lib/db/claim-grants";

const realGrants = { ...(await import("@/lib/db/claim-grants")) };
const legacyEngineGrants = realGrants.legacyEngineGrants;
/** `id`'s real grants with `edit` written over them, frozen. */
const planted = (id: string, edit: Partial<EngineGrants>): EngineGrants =>
  Object.freeze({ ...legacyEngineGrants(id), ...edit });
const PLANTED: Readonly<Record<string, EngineGrants>> = Object.freeze({
  snowflake: planted("snowflake", { confirmExemptForms: Object.freeze([]) }),
  mongodb: planted("mongodb", { readsSqlText: true }),
  prometheus: planted("prometheus", { decidesAlone: false }),
  sqlite: planted("sqlite", { reviewedGrammar: false }),
  postgres: planted("postgres", { redaction: Object.freeze({ kind: "none" }) }),
});
mock.module("@/lib/db/claim-grants", () => ({
  ...realGrants,
  legacyEngineGrants: (id: string): EngineGrants => PLANTED[id] ?? legacyEngineGrants(id),
}));

const { STUDIO_GRANT_REGISTER } = realGrants;
const { LEGACY_KEY } = await import("@libredb/grant-register");
const { BUNDLED_SQL_TEXT } = await import("@/lib/db/engine-catalog/sql-text.generated");
const { NON_SQL_DESTRUCTIVE_VOCABULARY } = await import("@/lib/db/destructive-commands");
const { redactStatement } = await import("@/lib/query-events/redact");
const { hasUnreadableRun, isDangerousQuery } = await import("@/lib/sql/dangerous-query");

/** The committed register's legacy row of `engine`. */
const rowOf = (engine: string) => STUDIO_GRANT_REGISTER.rowFor({ legacy: LEGACY_KEY, engine });

describe("the SQL text gates", () => {
  test("each SQL text gate answers Studio's grant of its claim from the register, not the record or the declaration", () => {
    // The declarations and the register rows hold the values the planted grants differ from.
    expect(BUNDLED_SQL_TEXT.snowflake.grammar.confirmExemptForms?.length).toBe(2);
    expect(rowOf("snowflake")?.grants.confirmExemptForms.length).toBe(2);
    expect(BUNDLED_SQL_TEXT.mongodb.readsSqlText).toBe(false);
    expect(rowOf("mongodb")?.grants.readsSqlText).toBe(false);
    expect(NON_SQL_DESTRUCTIVE_VOCABULARY.prometheus?.decidesAlone).toBe(true);
    expect(rowOf("prometheus")?.grants.decidesAlone).toBe(true);
    expect(rowOf("sqlite")?.grants.grammarSha256).not.toBeNull();
    expect(rowOf("postgres")?.grants.redaction).toEqual({ kind: "sql", nameQuote: '"' });

    // A snowflake session form asks where its exempt forms are granted none.
    expect(isDangerousQuery("ALTER SESSION SET TIMEZONE = 'UTC'", "snowflake")).toBe(true);
    // A mongodb text granted as SQL is read as SQL: an unclosed run is unreadable, and the gate asks.
    expect(hasUnreadableRun('{"a": "\\', "mongodb")).toBe(true);
    expect(isDangerousQuery('{"a": "\\', "mongodb")).toBe(true);
    // redis's claim is still granted, so the same text is not read as SQL there.
    expect(hasUnreadableRun('{"a": "\\', "redis")).toBe(false);
    // A prometheus row granted no decides-alone claim is read beside the SQL reading, which reads a write.
    expect(isDangerousQuery("DROP TABLE t", "prometheus")).toBe(true);
    // A sqlite statement asks when its row is granted as reviewing no grammar; libsql reads the same grammar, reviewed.
    expect(isDangerousQuery("SELECT 1", "sqlite")).toBe(true);
    expect(isDangerousQuery("SELECT 1", "libsql")).toBe(false);
    // The query event log keeps nothing of a postgres statement granted none; mysql's grant is its row's.
    expect(redactStatement("SELECT 'x' FROM t", "postgres").statement).toBe("?");
    expect(redactStatement("SELECT 'x' FROM t", "mysql").statement).toBe("SELECT ? FROM t");
  });
});

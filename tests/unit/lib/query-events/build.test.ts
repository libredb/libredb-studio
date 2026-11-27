/**
 * The query event builder (docs/GOVERNANCE.md#query-events): `buildQueryEvent()` maps one executed unit, or one refused
 * request, to a row of `query_events_v1` with exactly the manifest's columns, keeping of the statement what the capture
 * policy allows.
 *
 * Every row built here is also checked against the published manifest (`tests/fixtures/governance/contract-v1.json`):
 * each value against its column's type, nullability and CHECK, and the row against the table's constraints, so a row
 * the builder makes is a row the governance source accepts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { QUERY_EVENT_COLUMNS } from "@/lib/governance/contract";
import { SETTINGS_REGISTRY } from "@/lib/governance/settings-registry";
import { validateSettings } from "@/lib/governance/settings";
import { recordGovernanceSnapshot, resetGovernanceState } from "@/lib/governance/state";
import { analyzeQuery } from "@/lib/db/utils/query-limiter";
import { buildQueryEvent, contractConnectionId, queryEventPolicy, queryEventStart } from "@/lib/query-events/build";
import { maskCredentials, redactStatement } from "@/lib/query-events/redact";
import { parseGrantRegister, type RegisterGrants } from "@libredb/grant-register";
import { UnknownProviderError } from "@/lib/db/errors";
import {
  type EngineRecord,
  forgetServerCatalog,
  installServerCatalog,
  servedEngineRecord,
} from "@/lib/db/server-catalog";
import { type EngineGrants, STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { grammarSha256 } from "@/lib/db/grammar-digest";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import type {
  QueryEventConnection,
  QueryEventInput,
  QueryEventPolicy,
  QueryEventRow,
  StatementCapture,
} from "@/lib/query-events/types";
import { grantedSnapshot } from "../../../helpers/governance/granted-snapshot";
import {
  admittedFor,
  admittedManifest,
  declaredLanguageSha256,
  type EditableEngine,
  packageRow,
  withStatementLanguageData,
} from "../../../helpers/package-catalog";

interface ManifestColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly check: {
    readonly kind: string;
    readonly values?: readonly string[];
    readonly pattern?: string;
    readonly min?: number | null;
    readonly max?: number;
  } | null;
}

interface ManifestObject {
  readonly name: string;
  readonly columns: readonly ManifestColumn[];
  readonly constraints?: readonly { readonly name: string; readonly check: string }[];
}

const MANIFEST = JSON.parse(
  readFileSync(path.join(import.meta.dir, "../../../fixtures/governance/contract-v1.json"), "utf8"),
) as { readonly objects: readonly ManifestObject[] };

const manifestObject = (name: string): ManifestObject =>
  MANIFEST.objects.find((object) => object.name === name) as ManifestObject;

const VIEW_COLUMNS = manifestObject("query_events_v1").columns;
const TABLE_CONSTRAINTS = manifestObject("query_event").constraints ?? [];

/** The rule of each table constraint, by name; a constraint the manifest gains fails the check until it is added. */
const CONSTRAINTS: Readonly<Record<string, (row: QueryEventRow) => boolean>> = {
  query_event_time_order: (row) => Date.parse(row.finished_at) >= Date.parse(row.started_at),
  query_event_not_future: (row) => Date.parse(row.started_at) <= Date.now() + 5 * 60_000,
  query_event_capture_none: (row) =>
    row.statement_capture !== "none" || (row.statement === null && row.statement_fingerprint === null),
  query_event_error_text_full_only: (row) => row.statement_capture === "full" || row.error_message === null,
  query_event_resolved: (row) => row.status === "refused" || (row.engine !== null && row.access_level !== null),
};

const INTEGER_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  smallint: [-32_768, 32_767],
  integer: [-2_147_483_648, 2_147_483_647],
  bigint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

/** Whether `value` is a value of the PostgreSQL type `type`, as the builder hands it to `pg`. */
function ofType(type: string, value: unknown): boolean {
  if (type === "uuid") return typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
  if (type === "timestamptz") return typeof value === "string" && new Date(value).toISOString() === value;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "text") return typeof value === "string";
  if (type === "inet") return typeof value === "string" && isIP(value) !== 0 && !value.includes("%");
  const range = INTEGER_RANGES[type];
  return Number.isInteger(value) && (value as number) >= range[0] && (value as number) <= range[1];
}

/** Whether `value` keeps the CHECK of `column`. NULL passes a CHECK, as in PostgreSQL. */
function keepsCheck(column: ManifestColumn, value: unknown): boolean {
  const { check } = column;
  if (check === null || value === null) return true;
  switch (check.kind) {
    case "values":
      return (check.values as readonly string[]).includes(value as string);
    case "pattern":
      return new RegExp(check.pattern as string).test(value as string);
    case "length": {
      const characters = [...(value as string)].length;
      return characters >= (check.min ?? 0) && characters <= (check.max as number);
    }
    case "bytes":
      return Buffer.byteLength(value as string, "utf8") <= (check.max as number);
    default:
      return (value as number) >= (check.min as number);
  }
}

/** The manifest rules `row` breaks, by column or constraint name; empty when the governance source accepts it. */
function brokenRules(row: QueryEventRow): string[] {
  const values = row as unknown as Readonly<Record<string, unknown>>;
  const broken = VIEW_COLUMNS.filter((column) => {
    const value = values[column.name];
    if (value === null) return !column.nullable;
    return !ofType(column.type, value) || !keepsCheck(column, value);
  }).map((column) => column.name);
  for (const { name } of TABLE_CONSTRAINTS) if (!CONSTRAINTS[name]?.(row)) broken.push(name);
  return broken;
}

const PRINCIPAL = {
  subject: "8d0f6a4e-2b1c-4f3a-9e7d-5c6b4a3f2e1d",
  username: "alice@example.com",
  role: "user",
} as const;
const ORDERS: QueryEventConnection = { id: "seed:orders-db", name: "Orders", engine: "postgres", accessLevel: "read" };
const CONTEXT = { studioInstance: "libredb-studio" };

const policy = (statementCapture: StatementCapture, maxStatementBytes = 4096): QueryEventPolicy => ({
  statementCapture,
  maxStatementBytes,
});
const NONE = policy("none");
const REDACTED = policy("redacted");
const FULL = policy("full");

function input(overrides: Partial<QueryEventInput> = {}): QueryEventInput {
  return {
    source: "editor",
    principal: PRINCIPAL,
    connection: ORDERS,
    statement: "SELECT id, total FROM orders WHERE customer_id = 42",
    status: "success",
    started: queryEventStart(),
    ...overrides,
  };
}

/** Builds a row and checks it against the manifest before a case reads it. */
function build(event: QueryEventInput, capture: QueryEventPolicy = NONE): QueryEventRow {
  const row = buildQueryEvent(event, capture, CONTEXT);
  expect(brokenRules(row)).toEqual([]);
  return row;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");
/** A high surrogate without its low half, or a low one without its high half: a code point cut in two. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** What a case installs: the package engine's declaration, its register row, and each record's grants. */
interface EnginesCase {
  /** Changes the declaration of `acmeevents`, the engine the one admitted package serves. */
  readonly declare?: (engine: EditableEngine) => void;
  /**
   * The package's register row for `acmeevents`: these grants, `grammarSha256` the digest of the grammar the engine
   * declares, or null where it declares no SQL text, unless they name another, every other member at its restrictive
   * value. No row where it is absent.
   */
  readonly row?: Partial<RegisterGrants>;
  /** Each record's grants, changed by the edit named for its engine after the composition. */
  readonly grants?: Readonly<Record<string, Partial<EngineGrants>>>;
  /** Each record's statement grammar, replaced by the value named for its engine after the composition. */
  readonly statementGrammar?: Readonly<Record<string, EngineRecord["statementGrammar"]>>;
}

/**
 * Installs the catalog composed of the legacy records and one admitted package serving `acmeevents`, against a register
 * holding the package's row where the case gives one, reviewing the grammar and the statement language data, if any,
 * the package declares, each record's grants then changed by the case's edit: what the builder reads an event's engine
 * from.
 */
function installEngines({ declare, row, grants = {}, statementGrammar = {} }: EnginesCase = {}): void {
  const manifest = admittedManifest("acmeevents", declare);
  const pkg = admittedFor("acmeevents-package", manifest);
  const declared = (manifest.engines[0] as { sqlText: { grammar: unknown } | null }).sqlText;
  const register =
    row === undefined
      ? STUDIO_GRANT_REGISTER
      : parseGrantRegister(
          [
            packageRow(pkg, "acmeevents", {
              grammarSha256: declared === null ? null : grammarSha256(declared.grammar),
              languageSha256: manifest.engines[0]?.statementLanguageData ? declaredLanguageSha256(manifest) : null,
              ...row,
            }),
          ],
          LEGACY_ENGINE_IDS,
        );
  const composed = composeServerCatalog([pkg], [], register);
  const engines = new Map(composed.engines);
  for (const [id, edit] of Object.entries(grants)) {
    const engine = engines.get(id) as EngineRecord;
    engines.set(id, { ...engine, grants: { ...engine.grants, ...edit } });
  }
  for (const [id, grammar] of Object.entries(statementGrammar)) {
    engines.set(id, { ...(engines.get(id) as EngineRecord), statementGrammar: grammar });
  }
  installServerCatalog({ engines, unavailable: composed.unavailable });
}

/** A package engine's declaration that requests redaction `sql` with `"` and reads nested block comments. */
function declaresQuotedSql(engine: EditableEngine): void {
  engine.sqlText.redaction = { kind: "sql", nameQuote: '"' };
  (engine.sqlText.grammar as Record<string, unknown>).blockComment = "nesting";
}

/** A statement whose nested comment holds a literal: read flat, the literal and the comment's tail are code. */
const NESTED_STATEMENT = `SELECT "Users".id /* a /* b */ 'gift' */ FROM "Users" WHERE id = 7`;

let savedSource: string | undefined;

beforeEach(() => {
  savedSource = process.env.GOVERNANCE_SOURCE;
  resetGovernanceState();
});

afterEach(() => {
  forgetServerCatalog();
  resetGovernanceState();
  if (savedSource === undefined) delete process.env.GOVERNANCE_SOURCE;
  else process.env.GOVERNANCE_SOURCE = savedSource;
});

describe("buildQueryEvent", () => {
  test("capture none gives null statement, fingerprint and error_message with statement_type from analyzeQuery", () => {
    const statements = [
      ["SELECT id FROM orders WHERE total > 100", "SELECT"],
      ["/* annotated */ select 1", "SELECT"],
      ["INSERT INTO orders (id) VALUES (7)", "INSERT"],
      ["WITH recent AS (SELECT id FROM orders) INSERT INTO archive SELECT id FROM recent", "INSERT"],
      ["WITH gone AS (DELETE FROM orders WHERE id = 7 RETURNING *) SELECT * FROM gone", "DELETE"],
      ["WITH seen AS (UPDATE orders SET total = 0 RETURNING id) SELECT * FROM seen", "UPDATE"],
      ["WITH kept AS (UPSERT INTO orders (id) VALUES (7) RETURNING *) SELECT * FROM kept", "OTHER"],
      ["UPDATE orders SET total = 0 WHERE id = 7", "UPDATE"],
      ["DELETE FROM orders WHERE id = 7", "DELETE"],
      ["CREATE TABLE audit_probe (id int)", "DDL"],
      ["VACUUM orders", "OTHER"],
    ] as const;

    for (const [statement, type] of statements) {
      const row = build(
        input({ statement, status: "error", errorCode: "42P01", errorMessage: `relation in ${statement} failed` }),
      );

      expect(row.statement_type).toBe(type);
      expect(row.statement_type).toBe(analyzeQuery(statement, "postgres").type);
      expect(row).toMatchObject({
        statement_capture: "none",
        statement: null,
        statement_truncated: false,
        statement_fingerprint: null,
        error_code: "42P01",
        error_message: null,
      });
    }
  });

  test("statement_type is OTHER for an engine whose statements are not SQL, and for a unit without text", () => {
    const redis = { ...ORDERS, id: "seed:cache", engine: "redis" } as const;
    const mongodb = { ...ORDERS, id: "seed:catalog", engine: "mongodb" } as const;

    expect(build(input({ connection: redis, statement: "SELECT 1" })).statement_type).toBe("OTHER");
    expect(
      build(input({ connection: mongodb, statement: '{"collection":"items","operation":"find"}' })).statement_type,
    ).toBe("OTHER");
    expect(build(input({ source: "maintenance", statement: null }), FULL)).toMatchObject({
      statement_type: "OTHER",
      statement: null,
      statement_fingerprint: null,
    });
  });

  test("an event of a package engine keeps no statement and no error text in any capture mode, and reads its statement as OTHER", () => {
    // An engine only a provider package serves, with no register row, a row for another grammar, or a row that reviews
    // none: no grant covers its text (S-7), so the restrictive reading keeps nothing of it, whatever the capture mode.
    const cases: readonly EnginesCase[] = [
      {},
      { row: { redaction: { kind: "none" }, grammarSha256: grammarSha256({ planted: randomUUID() }) } },
      { row: { redaction: { kind: "none" }, grammarSha256: null } },
    ];
    const kv = { ...ORDERS, id: "seed:kv", engine: "acmeevents" } as const;
    for (const engines of cases) {
      installEngines(engines);
      for (const capture of [NONE, REDACTED, FULL]) {
        const row = build(
          input({
            connection: kv,
            statement: "DELETE FROM orders WHERE id = 7",
            status: "error",
            errorCode: "INTERNAL_ERROR",
            errorMessage: "the package's own words",
          }),
          capture,
        );
        expect(row).toMatchObject({
          engine: "acmeevents",
          statement_type: "OTHER",
          statement: null,
          statement_truncated: false,
          statement_fingerprint: null,
          error_code: "INTERNAL_ERROR",
          error_message: null,
        });
      }
      forgetServerCatalog();
    }
  });

  test("an engine whose record holds no grammar keeps no statement and no error text and reads its kind as OTHER, and grants that say a row reviewed its grammar are a host defect", () => {
    const password = randomUUID();
    const kv = { ...ORDERS, id: "seed:kv", engine: "acmeevents" } as const;
    const event = {
      connection: kv,
      statement: `DELETE FROM orders WHERE note = 'redis://bob:${password}@cache'`,
      status: "error",
      errorCode: "INTERNAL_ERROR",
      errorMessage: "the package's own words",
    } as const;
    // The statement language data lets the row grant text-not-SQL under its digest.
    const statesNoSqlText = (engine: EditableEngine) => {
      withStatementLanguageData(engine);
      const members = engine as Record<string, unknown>;
      members.sqlText = null;
      members.sqlWriting = null;
      members.migrationDdl = null;
    };

    // Composed: a declaration with no SQL text, its row granting SQL text claims, which review no grammar of it. Under
    // the language digest the row reviewed, readsSqlText false and decidesAlone are granted, and still no grammar is
    // reviewed, so the event keeps nothing of the text.
    installEngines({
      declare: statesNoSqlText,
      row: { redaction: { kind: "sql", nameQuote: '"' }, readsSqlText: false, decidesAlone: true },
    });
    const { reviewedGrammar, readsSqlText, decidesAlone, redaction } = servedEngineRecord("acmeevents").grants;
    expect({ reviewedGrammar, readsSqlText, decidesAlone, redaction }).toEqual({
      reviewedGrammar: false,
      readsSqlText: false,
      decidesAlone: true,
      redaction: { kind: "none" },
    });
    for (const capture of [NONE, REDACTED, FULL]) {
      expect(build(input(event), capture)).toMatchObject({
        engine: "acmeevents",
        statement_type: "OTHER",
        statement: null,
        statement_truncated: false,
        statement_fingerprint: null,
        error_message: null,
      });
    }
    forgetServerCatalog();

    // Crafted: a record with no grammar whose grants say a row reviewed one, which no composition gives.
    const defect = `The engine "acmeevents"'s record grants a grammar its register row reviewed but holds no grammar: a host defect, since an engine that states no SQL text requests no grammar digest for a row to review.`;
    installEngines({ row: { redaction: { kind: "none" } }, statementGrammar: { acmeevents: null } });
    for (const capture of [NONE, REDACTED, FULL]) {
      expect(() => buildQueryEvent(input(event), capture, CONTEXT)).toThrow(defect);
    }
    forgetServerCatalog();

    // The control: the same record with its grammar keeps the masked text under full.
    installEngines({ row: { redaction: { kind: "none" } } });
    const kept = build(input(event), FULL);
    expect(kept.statement).toBe(maskCredentials(event.statement, "acmeevents"));
    expect(kept.statement).not.toContain(password);
  });

  test("a query event keeps the statement under the record's granted redaction, for a legacy engine and for a package engine its row grants sql", () => {
    const password = randomUUID();
    const errorMessage = `connection to postgres://alice:${password}@db/orders failed`;
    const event = { statement: NESTED_STATEMENT, status: "error", errorCode: "42501", errorMessage } as const;

    // A crafted postgres record granted redaction sql with no name quote: the quoted name postgres's row keeps goes.
    installEngines({ grants: { postgres: { redaction: { kind: "sql", nameQuote: null } } } });
    expect(build(input({ statement: `SELECT "Users".id FROM "Users" WHERE id = 7` }), REDACTED).statement).toBe(
      "SELECT ?.id FROM ? WHERE id = ?",
    );
    forgetServerCatalog();
    // The control: Studio's own postgres record keeps it.
    expect(build(input({ statement: `SELECT "Users".id FROM "Users" WHERE id = 7` }), REDACTED).statement).toBe(
      `SELECT "Users".id FROM "Users" WHERE id = ?`,
    );

    // A package engine whose row reviews its grammar and grants the sql redaction it requests: its statement is kept
    // under that redaction and its own grammar, which closes the nested comment where a flat reading would not.
    installEngines({ declare: declaresQuotedSql, row: { redaction: { kind: "sql", nameQuote: '"' } } });
    const kv = { ...ORDERS, id: "seed:kv", engine: "acmeevents" } as const;
    const redacted = build(input({ ...event, connection: kv }), REDACTED);
    expect(redacted).toMatchObject({
      engine: "acmeevents",
      statement: `SELECT "Users".id ? FROM "Users" WHERE id = ?`,
      statement_fingerprint: sha256(`SELECT "Users".id ? FROM "Users" WHERE id = ?`),
      error_message: null,
    });
    const full = build(input({ ...event, connection: kv }), FULL);
    expect(full).toMatchObject({
      statement: maskCredentials(NESTED_STATEMENT, "acmeevents"),
      statement_fingerprint: null,
      error_message: maskCredentials(errorMessage, "acmeevents"),
    });
    expect(full.statement).toBe(NESTED_STATEMENT);
    expect(full.error_message).not.toContain(password);
  });

  test("a package engine whose row reviews its grammar and grants none keeps ? when redacted and the masked text in full, as a legacy none engine does", () => {
    const password = randomUUID();
    const statement = `GET orders WHERE note = 'redis://bob:${password}@cache'`;
    const errorMessage = `connection to postgres://alice:${password}@db/orders failed`;
    const event = { statement, status: "error", errorCode: "42501", errorMessage } as const;
    const couchbase = { ...ORDERS, id: "seed:docs", engine: "couchbase" } as const;
    const kv = { ...ORDERS, id: "seed:kv", engine: "acmeevents" } as const;
    installEngines({ row: { redaction: { kind: "none" } } });

    const legacy = build(input({ ...event, connection: couchbase }), REDACTED);
    const redacted = build(input({ ...event, connection: kv }), REDACTED);
    expect(legacy).toMatchObject({ statement: "?", statement_fingerprint: sha256("?") });
    expect(redacted).toMatchObject({ statement: "?", statement_fingerprint: sha256("?"), error_message: null });

    const full = build(input({ ...event, connection: kv }), FULL);
    expect(full).toMatchObject({
      statement: maskCredentials(statement, "acmeevents"),
      statement_fingerprint: null,
      error_message: maskCredentials(errorMessage, "acmeevents"),
    });
    for (const text of [full.statement, full.error_message]) {
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain(password);
    }
  });

  test("a package engine's statement type is read under its own grammar where its granted readsSqlText is true, and is OTHER where it is false", () => {
    const kv = { ...ORDERS, id: "seed:kv", engine: "acmeevents" } as const;
    const statement = "/* a /* b */ DELETE FROM orders */ SELECT 1";
    // The control: read flat, under the compatibility grammar, the statement is a DELETE.
    expect(analyzeQuery(statement).type).toBe("DELETE");

    installEngines({ declare: declaresQuotedSql, row: { redaction: { kind: "sql", nameQuote: '"' } } });
    expect(build(input({ connection: kv, statement })).statement_type).toBe("SELECT");
    forgetServerCatalog();

    installEngines({
      declare: (engine) => {
        declaresQuotedSql(engine);
        engine.sqlText.readsSqlText = false;
        // The statement language data its row reviews, without which no package row grants text-not-SQL.
        withStatementLanguageData(engine);
      },
      row: { redaction: { kind: "sql", nameQuote: '"' }, readsSqlText: false },
    });
    expect(build(input({ connection: kv, statement })).statement_type).toBe("OTHER");
  });

  test("what an event keeps of its text is read from its engine's record's grants, a legacy engine's id included", () => {
    // A crafted catalog whose postgres record's grammar no register row reviewed: the builder reads the record's
    // grants, never whether the id is one Studio ships.
    installEngines({ grants: { postgres: { reviewedGrammar: false } } });
    const statement = "DELETE FROM orders WHERE id = 7 AND note = 'PASSWORD hunter'";
    const errorMessage = "permission denied for postgres://alice:hunter@db/orders";
    const mysql = { ...ORDERS, id: "seed:shop", engine: "mysql" } as const;
    for (const capture of [NONE, REDACTED, FULL]) {
      const event = { statement, status: "error", errorCode: "42501", errorMessage } as const;
      expect(build(input(event), capture)).toMatchObject({
        engine: "postgres",
        statement_type: "OTHER",
        statement: null,
        statement_truncated: false,
        statement_fingerprint: null,
        error_message: null,
      });

      const kept = build(input({ ...event, connection: mysql }), capture);
      const redacted = redactStatement(statement, "mysql");
      expect(kept.statement_type).toBe(analyzeQuery(statement, "mysql").type);
      if (capture === NONE) {
        expect(kept).toMatchObject({ statement: null, statement_fingerprint: null, error_message: null });
      } else if (capture === REDACTED) {
        expect(kept).toMatchObject({
          statement: redacted.statement,
          statement_fingerprint: redacted.statement_fingerprint,
          error_message: null,
        });
      } else {
        expect(kept).toMatchObject({
          statement: maskCredentials(statement, "mysql"),
          statement_fingerprint: null,
          error_message: maskCredentials(errorMessage, "mysql"),
        });
      }
    }
    forgetServerCatalog();

    // A crafted postgres record granted readsSqlText false: its statement reads as OTHER, and its text is masked as
    // text that is not SQL, so a password written as a literal is kept.
    const altered = `ALTER USER bob PASSWORD '${randomUUID()}'`;
    expect(build(input({ statement: altered }), FULL).statement).toBe("ALTER USER bob PASSWORD [REDACTED]");
    installEngines({ grants: { postgres: { readsSqlText: false } } });
    expect(build(input({ statement: altered }), FULL)).toMatchObject({ statement_type: "OTHER", statement: altered });
  });

  test("an event naming an engine the server serves no record of is the caller's defect, and no row is made", () => {
    const kv = { ...ORDERS, id: "seed:kv", engine: "acmeevents" } as const;

    expect(() => buildQueryEvent(input({ connection: kv }), FULL, CONTEXT)).toThrow(UnknownProviderError);
  });

  test("a statement type the route gives is kept whatever the text reads as, and the text is still captured", () => {
    const mongodb = { ...ORDERS, id: "seed:catalog", engine: "mongodb" } as const;

    expect(
      build(input({ source: "profile", statement: '"public"."orders"', statementType: "SELECT" }), FULL),
    ).toMatchObject({ statement_type: "SELECT", statement: '"public"."orders"' });
    expect(
      build(
        input({ connection: mongodb, source: "profile", statement: '{"collection":"items"}', statementType: "SELECT" }),
      ).statement_type,
    ).toBe("SELECT");
    expect(build(input({ source: "key-scan", statement: "SELECT 1", statementType: "OTHER" })).statement_type).toBe(
      "OTHER",
    );
  });

  test("capture redacted stores redactStatement() with its fingerprint and no error text", () => {
    const statement = "SELECT id, total FROM orders WHERE customer_id = 42 AND note = 'gift' -- vip";
    const redacted = redactStatement(statement, "postgres");

    const row = build(input({ statement, status: "error", errorCode: "57014", errorMessage: "canceled" }), REDACTED);

    expect(row).toMatchObject({
      statement_capture: "redacted",
      statement: redacted.statement,
      statement_fingerprint: redacted.statement_fingerprint,
      statement_truncated: false,
      error_code: "57014",
      error_message: null,
    });
    expect(row.statement).toBe("SELECT id, total FROM orders WHERE customer_id = ? AND note = ? ?");
  });

  test("capture redacted truncates at maxStatementBytes and fingerprints the whole redacted text", () => {
    const columns = Array.from({ length: 80 }, (_, index) => `column_${index}`).join(", ");
    const statement = `SELECT ${columns} FROM orders WHERE id = 7`;
    const whole = redactStatement(statement, "postgres");

    const row = build(input({ statement }), policy("redacted", 256));

    expect(utf8Bytes(whole.statement)).toBeGreaterThan(256);
    expect(row.statement_truncated).toBe(true);
    expect(utf8Bytes(row.statement as string)).toBe(256);
    expect(whole.statement.startsWith(row.statement as string)).toBe(true);
    expect(row.statement_fingerprint).toBe(whole.statement_fingerprint);
    expect(row.statement_fingerprint).toBe(sha256(whole.statement));
  });

  test("the statement column's 65536 bytes are the largest cap, and a cap it cannot hold is refused", () => {
    const statement = `SELECT '${"x".repeat(70_000)}'`;

    const row = build(input({ statement }), policy("full", 65_536));

    expect(row.statement_truncated).toBe(true);
    expect(utf8Bytes(row.statement as string)).toBe(65_536);
    for (const maxStatementBytes of [65_537, 4096.5, Number.NaN]) {
      expect(() => buildQueryEvent(input(), policy("full", maxStatementBytes), CONTEXT)).toThrow(/maxStatementBytes/);
    }
  });

  test("capture full truncates at maxStatementBytes on a character boundary and sets statement_truncated", () => {
    // Two, three and four UTF-8 bytes a character, none of which may be cut in two at the 256-byte cap.
    const cases = [
      { statement: `SELECT '${"é".repeat(200)}'`, keptBytes: 256 },
      { statement: `SELECT '${"€".repeat(100)}'`, keptBytes: 254 },
      { statement: `SELECT 'x${"𐍈".repeat(70)}'`, keptBytes: 253 },
    ];

    for (const { statement, keptBytes } of cases) {
      const row = build(input({ statement }), policy("full", 256));

      expect(row.statement_truncated).toBe(true);
      expect(utf8Bytes(row.statement as string)).toBe(keptBytes);
      expect(row.statement).not.toMatch(LONE_SURROGATE);
      expect(statement.startsWith(row.statement as string)).toBe(true);
      expect(row.statement_fingerprint).toBeNull();
    }
  });

  test("capture full stores the statement through maskCredentials() whole when it fits", () => {
    const statement = "ALTER USER app_writer PASSWORD 'example-only-swordfish'  -- rotated\nWITH LOGIN";

    const row = build(input({ statement }), FULL);

    expect(row.statement).toBe(maskCredentials(statement, "postgres"));
    expect(row.statement).toBe("ALTER USER app_writer PASSWORD [REDACTED]  -- rotated\nWITH LOGIN");
    expect(row.statement_truncated).toBe(false);
  });

  test("capture full stores the error text with its credentials masked, cut to 1000 characters", () => {
    const masked = build(
      input({
        status: "error",
        errorCode: "08001",
        errorMessage: "could not reach postgres://app:example-only-secret@orders.internal/db",
      }),
      FULL,
    );
    expect(masked.error_message).toBe("could not reach postgres://[REDACTED]@orders.internal/db");

    const long = build(input({ status: "error", errorMessage: `syntax error: ${"𐍈".repeat(1200)}` }), FULL);
    expect([...(long.error_message as string)]).toHaveLength(1000);
    expect(long.error_message).not.toMatch(LONE_SURROGATE);
  });

  test("started_at is wall-clock time and duration_ms comes from the monotonic timer", () => {
    const wallClock = 1_791_200_000_000;
    let wall = wallClock;
    let monotonic = 5_000.25;
    const wallSpy = spyOn(Date, "now").mockImplementation(() => wall);
    const monotonicSpy = spyOn(performance, "now").mockImplementation(() => monotonic);
    try {
      const started = queryEventStart();
      expect(started).toEqual({ wallClockMs: wallClock, monotonicMs: 5_000.25 });

      // NTP steps the wall clock an hour forward while the statement runs for 42 ms.
      wall += 3_600_000;
      monotonic += 41.6;
      const forward = build(input({ started }));
      expect(forward.started_at).toBe(new Date(wallClock).toISOString());
      expect(forward.finished_at).toBe(new Date(wallClock + 3_600_000).toISOString());
      expect(forward.duration_ms).toBe(42);

      // Stepped back below the start instead, the end is never dated before the start the table's CHECK holds it to.
      wall = wallClock - 30_000;
      monotonic += 8.2;
      const back = build(input({ started }));
      expect(back.started_at).toBe(new Date(wallClock).toISOString());
      expect(back.finished_at).toBe(back.started_at);
      expect(back.duration_ms).toBe(50);
    } finally {
      wallSpy.mockRestore();
      monotonicSpy.mockRestore();
    }
  });

  test("a start read on another clock is refused rather than recorded with a negative duration", () => {
    const started = { wallClockMs: Date.now(), monotonicMs: Date.now() };

    expect(() => buildQueryEvent(input({ started }), NONE, CONTEXT)).toThrow(RangeError);
    expect(() => buildQueryEvent(input({ started }), NONE, CONTEXT)).toThrow(/duration_ms/);
  });

  test("connection_id is the contract id without the seed: prefix, for a refused event too", () => {
    const granted = build(input());
    expect(granted).toMatchObject({
      connection_id: "orders-db",
      connection_name: "Orders",
      engine: "postgres",
      access_level: "read",
    });

    const notGranted = build(
      input({
        connection: { id: "seed:0b1e7c3d-9f2a-4e6b-8c5d-7a4f3e2d1c0b", name: null, engine: null, accessLevel: null },
        status: "refused",
        errorCode: "CONNECTION_NOT_FOUND",
      }),
    );
    expect(notGranted).toMatchObject({
      connection_id: "0b1e7c3d-9f2a-4e6b-8c5d-7a4f3e2d1c0b",
      connection_name: null,
      engine: null,
      access_level: null,
      status: "refused",
      error_code: "CONNECTION_NOT_FOUND",
    });

    const gateRefused = build(input({ connection: { ...ORDERS, accessLevel: "write" }, status: "refused" }));
    expect(gateRefused).toMatchObject({ connection_id: "orders-db", engine: "postgres", access_level: "write" });
  });

  test("an id that is not seed: and a contract id is refused, and contractConnectionId() answers null for it", () => {
    expect(contractConnectionId("seed:orders-db")).toBe("orders-db");
    expect(contractConnectionId(`seed:${"a".repeat(64)}`)).toBe("a".repeat(64));

    for (const id of ["orders-db", "seed:", "seed:Orders", "seed:orders_db", `seed:${"a".repeat(65)}`, "seed:seed:x"]) {
      expect(contractConnectionId(id)).toBeNull();
      const refused = input({ connection: { id, name: null, engine: null, accessLevel: null }, status: "refused" });
      expect(() => buildQueryEvent(refused, NONE, CONTEXT)).toThrow(/connection_id/);
    }
  });

  test("a refused request whose connection did not resolve keeps no statement or error text in any mode", () => {
    const unresolved = { id: "seed:billing", name: null, engine: null, accessLevel: null };
    for (const capture of [NONE, REDACTED, FULL]) {
      const row = build(
        input({
          connection: unresolved,
          statement: "SELECT * FROM invoices WHERE customer = 'acme'",
          status: "refused",
          errorCode: "CONNECTION_NOT_FOUND",
          errorMessage: "Connection not found: it does not exist or is not granted to you",
        }),
        capture,
      );

      expect(row).toMatchObject({
        statement_capture: capture.statementCapture,
        statement: null,
        statement_fingerprint: null,
        statement_truncated: false,
        error_message: null,
        statement_type: "SELECT",
      });
    }
  });

  test("a unit that ran needs the engine and access level of its connection", () => {
    for (const connection of [
      { ...ORDERS, engine: null },
      { ...ORDERS, accessLevel: null },
    ]) {
      expect(() => buildQueryEvent(input({ connection }), NONE, CONTEXT)).toThrow(/engine and access level/);
    }
  });

  test("a row has exactly the columns of query_events_v1, in the manifest's order, for contract version 1", () => {
    const row = build(input({ rowCount: 12, clientIp: "203.0.113.10" }), REDACTED);

    expect(Object.keys(row)).toEqual([...QUERY_EVENT_COLUMNS]);
    expect(VIEW_COLUMNS.map((column) => column.name)).toEqual([...QUERY_EVENT_COLUMNS]);
    expect(Object.keys(CONSTRAINTS).toSorted()).toEqual(TABLE_CONSTRAINTS.map(({ name }) => name).toSorted());
    expect(row).toMatchObject({
      contract_version: 1,
      studio_instance: "libredb-studio",
      subject: PRINCIPAL.subject,
      username: "alice@example.com",
      session_role: "user",
      source: "editor",
      explain: null,
      unit_index: null,
      row_count: 12,
      status: "success",
      error_code: null,
      correlation_id: null,
      transaction_id: null,
      transaction_outcome: null,
      client_ip: "203.0.113.10",
    });
    expect(row.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("every unit gets an event id of its own", () => {
    const event = input();

    expect(build(event).event_id).not.toBe(build(event).event_id);
  });

  test("explain maps the request mode estimate to plan and analyze to analyze", () => {
    expect(build(input({ explain: "estimate" })).explain).toBe("plan");
    expect(build(input({ explain: "analyze" })).explain).toBe("analyze");
  });

  test("the unit, correlation and transaction fields are kept as the route gives them", () => {
    const row = build(
      input({
        source: "transaction",
        principal: { ...PRINCIPAL, role: "admin" },
        connection: { ...ORDERS, accessLevel: "write" },
        statement: "COMMIT",
        unitIndex: 3,
        rowCount: 0,
        correlationId: "01a13a48-9e00-7a3c-8d4e-5f6a7b8c9d0e",
        transactionId: "2f9d6c1e-0b7a-4e3d-8c5f-1a2b3c4d5e6f",
        transactionOutcome: "committed",
        status: "cancelled",
      }),
    );

    expect(row).toMatchObject({
      source: "transaction",
      session_role: "admin",
      access_level: "write",
      statement_type: "OTHER",
      unit_index: 3,
      row_count: 0,
      correlation_id: "01a13a48-9e00-7a3c-8d4e-5f6a7b8c9d0e",
      transaction_id: "2f9d6c1e-0b7a-4e3d-8c5f-1a2b3c4d5e6f",
      transaction_outcome: "committed",
      status: "cancelled",
    });
  });

  test("a transaction event may end unknown", () => {
    const row = build(
      input({
        source: "transaction",
        statement: null,
        transactionId: "2f9d6c1e-0b7a-4e3d-8c5f-1a2b3c4d5e6f",
        transactionOutcome: "unknown",
        status: "cancelled",
      }),
    );

    expect(row.transaction_outcome).toBe("unknown");
    // The contract checks the column by format only, so an ending a newer Studio records fits contract v1.
    expect(row.transaction_outcome).toMatch(/^[a-z][a-z-]{0,31}$/);
  });

  test("bounded text columns are clamped to their manifest limits by character, so no execution is refused for length", () => {
    const row = build(
      input({
        principal: { ...PRINCIPAL, username: `${"ü".repeat(400)}@example.com` },
        connection: { ...ORDERS, name: "𐍈".repeat(200) },
        correlationId: "c".repeat(300),
        transactionId: "t".repeat(300),
        errorCode: "E".repeat(100),
        status: "error",
        errorMessage: "m".repeat(5000),
      }),
      FULL,
    );

    expect(row.username).toBe("ü".repeat(320));
    expect(row.connection_name).toBe("𐍈".repeat(128));
    expect(row.correlation_id).toBe("c".repeat(128));
    expect(row.transaction_id).toBe("t".repeat(128));
    expect(row.error_code).toBe("E".repeat(64));
    expect(row.error_message).toBe("m".repeat(1000));
  });

  test("a NUL, which a PostgreSQL text value cannot hold, is stored as U+FFFD so the row is not refused", () => {
    const statement = "SELECT note\u0000 FROM orders";

    const full = build(
      input({ statement, status: "error", errorCode: "22\u0000021", errorMessage: "bad\u0000byte" }),
      FULL,
    );
    expect(full.statement).toBe("SELECT note� FROM orders");
    expect(full.error_code).toBe("22�021");
    expect(full.error_message).toBe("bad�byte");

    const redacted = build(input({ statement }), REDACTED);
    expect(redacted.statement).toBe(redactStatement("SELECT note� FROM orders", "postgres").statement);
    expect(redacted.statement_fingerprint).toBe(sha256(redacted.statement as string));
    expect(JSON.stringify([full, redacted])).not.toContain("\\u0000");
  });

  test("client_ip is kept only when it parses as an IP address", () => {
    for (const address of ["203.0.113.10", "2001:db8::7", "::ffff:203.0.113.10"]) {
      expect(build(input({ clientIp: address })).client_ip).toBe(address);
    }
    for (const hint of ["unknown", "203.0.113.10:443", "[2001:db8::7]", "fe80::1%eth0", "", " 203.0.113.10"]) {
      expect(build(input({ clientIp: hint })).client_ip).toBeNull();
    }
    expect(build(input()).client_ip).toBeNull();
  });

  test("a unit index or a row count that is not a whole number from 0 is refused", () => {
    for (const unitIndex of [-1, 1.5, Number.NaN, 2_147_483_648]) {
      expect(() => buildQueryEvent(input({ unitIndex }), NONE, CONTEXT)).toThrow(/unit_index/);
    }
    for (const rowCount of [-1, 0.5, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => buildQueryEvent(input({ rowCount }), NONE, CONTEXT)).toThrow(/row_count/);
    }
    expect(build(input({ unitIndex: 2_147_483_647, rowCount: Number.MAX_SAFE_INTEGER }))).toMatchObject({
      unit_index: 2_147_483_647,
      row_count: Number.MAX_SAFE_INTEGER,
    });
  });

  test("a subject or an instance id outside its column's length is refused", () => {
    for (const subject of ["", "s".repeat(513)]) {
      const event = input({ principal: { ...PRINCIPAL, subject } });
      expect(() => buildQueryEvent(event, NONE, CONTEXT)).toThrow(/subject/);
    }
    for (const studioInstance of ["", "i".repeat(129)]) {
      expect(() => buildQueryEvent(input(), NONE, { studioInstance })).toThrow(/studio_instance/);
    }
    expect(build(input({ principal: { ...PRINCIPAL, subject: "𐍈".repeat(512) } })).subject).toBe("𐍈".repeat(512));
  });
});

describe("queryEventPolicy", () => {
  const registryDefault = (key: string) => SETTINGS_REGISTRY.find((definition) => definition.key === key)?.default;

  test("without governance, and with no runtime value, capture is none with the registry's byte cap", () => {
    delete process.env.GOVERNANCE_SOURCE;
    expect(queryEventPolicy()).toEqual({ statementCapture: "none", maxStatementBytes: 4096 });

    process.env.GOVERNANCE_SOURCE = "postgres";
    recordGovernanceSnapshot(grantedSnapshot([], []));
    const policy: Readonly<Record<string, unknown>> = { ...queryEventPolicy() };
    expect(policy).toEqual({
      statementCapture: registryDefault("queryLog.statementCapture"),
      maxStatementBytes: registryDefault("queryLog.maxStatementBytes"),
    });
  });

  test("valid runtime values of queryLog.statementCapture and queryLog.maxStatementBytes decide the policy", () => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    const rows = [
      { key: "queryLog.statementCapture", value: "full", updated_at: new Date() },
      { key: "queryLog.maxStatementBytes", value: 512, updated_at: new Date() },
    ];
    recordGovernanceSnapshot({ ...grantedSnapshot([], []), settings: validateSettings(rows, 1) });

    expect(queryEventPolicy()).toEqual({ statementCapture: "full", maxStatementBytes: 512 });
  });
});

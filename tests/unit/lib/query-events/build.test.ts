/**
 * The query event builder (spec 7.2, 7.9): `buildQueryEvent()` maps one executed unit, or one refused request, to a
 * row of `query_events_v1` with exactly the manifest's columns, keeping of the statement what the capture policy
 * allows.
 *
 * Every row built here is also checked against the published manifest (`tests/fixtures/governance/contract-v1.json`):
 * each value against its column's type, nullability and CHECK, and the row against the table's constraints, so a row
 * the builder makes is a row the governance source accepts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
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
import type {
  QueryEventConnection,
  QueryEventInput,
  QueryEventPolicy,
  QueryEventRow,
  StatementCapture,
} from "@/lib/query-events/types";
import { grantedSnapshot } from "../../../helpers/governance/granted-snapshot";

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

let savedSource: string | undefined;

beforeEach(() => {
  savedSource = process.env.GOVERNANCE_SOURCE;
  resetGovernanceState();
});

afterEach(() => {
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

/**
 * Threat: the query log becomes a second copy of the data and the secrets it was meant to account for. A query event
 * row is read by the control plane's administrators and kept for 90 days, so a bind parameter value, a row a statement
 * returned, a connection credential or a password typed into a statement must never land in one.
 *
 * `buildQueryEvent()` is the only maker of rows (spec 7.9). It copies the fields its input names and nothing else, so
 * a caller that hands it the request body, the result or the resolved connection with its credentials still produces
 * a row without them; and it keeps of the statement only what the capture mode allows: nothing under `none`, the
 * statement with every literal replaced by `?` under `redacted`, and under `full` the statement and the error text
 * with the value after PASSWORD or IDENTIFIED BY and the userinfo of every URI masked.
 */
import { describe, expect, test } from "bun:test";
import { QUERY_EVENT_COLUMNS } from "@/lib/governance/contract";
import { buildQueryEvent, queryEventStart } from "@/lib/query-events/build";
import type { QueryEventInput, QueryEventPolicy, StatementCapture } from "@/lib/query-events/types";
import type { DatabaseType } from "@/lib/types";

/** Recognisable on sight as test values; no row may carry one. */
const BIND_VALUE = "example-only-bind-value-4711";
const RESULT_VALUE = "example-only-result-cell-0815";
const CONNECTION_PASSWORD = "example-only-connection-password";
const PASSWORDS = [
  "example-only-pw-create-user",
  "exampleonlypworacle",
  "example-only-pw-mysql",
  "example-only-pw-login",
  "example-only-pw-uri",
];

/** Statements that write a password, each on the engine that reads it so. */
const STATEMENTS: readonly { readonly engine: DatabaseType; readonly statement: string }[] = [
  { engine: "postgres", statement: `CREATE USER audit_probe PASSWORD '${PASSWORDS[0]}'` },
  { engine: "oracle", statement: `ALTER USER audit_probe IDENTIFIED BY ${PASSWORDS[1]}` },
  { engine: "mysql", statement: `SET PASSWORD FOR 'ann'@'%' = '${PASSWORDS[2]}'` },
  { engine: "mssql", statement: `ALTER LOGIN audit_probe WITH PASSWORD = N'${PASSWORDS[3]}'` },
  { engine: "postgres", statement: `SELECT dblink_connect('postgresql://app:${PASSWORDS[4]}@orders.internal/db')` },
  { engine: "postgres", statement: "SELECT id, card FROM payments WHERE customer_id = $1" },
];

const CAPTURES: readonly StatementCapture[] = ["none", "redacted", "full"];

/**
 * What a careless route could hand the builder: the request body's bind parameters, the provider's result and the
 * resolved connection with its credentials, beside the fields the input names.
 */
function leakyInput(engine: DatabaseType, statement: string): QueryEventInput {
  return {
    source: "editor",
    principal: { subject: "8d0f6a4e-2b1c-4f3a-9e7d-5c6b4a3f2e1d", username: "alice@example.com", role: "user" },
    connection: {
      id: "seed:orders-db",
      name: "Orders",
      engine,
      accessLevel: "write",
      password: CONNECTION_PASSWORD,
      user: "orders_writer",
      connectionString: `postgres://orders_writer:${CONNECTION_PASSWORD}@orders.internal/db`,
    },
    statement,
    status: "error",
    errorCode: "42601",
    // A driver that quotes the statement it refused, as many do.
    errorMessage: `syntax error in statement: ${statement}`,
    started: queryEventStart(),
    params: [BIND_VALUE],
    rows: [{ card: RESULT_VALUE }],
    result: { rows: [{ card: RESULT_VALUE }], fields: ["card"], rowCount: 1 },
  } as QueryEventInput;
}

describe("query event capture", () => {
  test("no capture mode stores a bind parameter value, a result row or a password literal", () => {
    for (const statementCapture of CAPTURES) {
      const policy: QueryEventPolicy = { statementCapture, maxStatementBytes: 4096 };
      for (const { engine, statement } of STATEMENTS) {
        const row = buildQueryEvent(leakyInput(engine, statement), policy, { studioInstance: "libredb-studio" });
        const stored = JSON.stringify(row);

        expect(Object.keys(row)).toEqual([...QUERY_EVENT_COLUMNS]);
        // Non-vacuity: every mode but none stores the statement, and full stores the error text, around what it masks.
        expect(row.statement === null).toBe(statementCapture === "none");
        expect(row.error_message === null).toBe(statementCapture !== "full");
        for (const secret of [BIND_VALUE, RESULT_VALUE, CONNECTION_PASSWORD, ...PASSWORDS]) {
          expect(stored).not.toContain(secret);
        }
      }
    }
  });

  test("full capture still records the statement and the error text around the masked values", () => {
    const row = buildQueryEvent(
      leakyInput("postgres", STATEMENTS[0].statement),
      { statementCapture: "full", maxStatementBytes: 4096 },
      { studioInstance: "libredb-studio" },
    );

    expect(row.statement).toBe("CREATE USER audit_probe PASSWORD [REDACTED]");
    expect(row.error_message).toBe("syntax error in statement: CREATE USER audit_probe PASSWORD [REDACTED]");
  });

  test("no column of a row is named for a bind value, a result or a credential", () => {
    expect(
      QUERY_EVENT_COLUMNS.filter((column) => /param|bind|row(?!_count)|result|password|secret|credential/.test(column)),
    ).toEqual([]);
  });
});

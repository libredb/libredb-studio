import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { redactUriCredentials } from "@/lib/audit";
import { maskCredentials, redactStatement } from "@/lib/query-events/redact";
import type { DatabaseType } from "@/lib/types";

/**
 * What a query event keeps of a statement (spec 7.9): `redacted` capture stores `redactStatement()`, and `full`
 * capture stores the statement through `maskCredentials()`.
 *
 * The vectors in `tests/fixtures/governance/redaction-vectors.json` are the contract for `redacted`: each pins an
 * input, its engine, the stored statement and its fingerprint, and the expected statements were written by hand
 * rather than captured from this implementation.
 */

interface RedactionVector {
  readonly name: string;
  readonly engine: DatabaseType;
  readonly form: string;
  readonly input: string;
  readonly statement: string;
  readonly statement_fingerprint: string;
}

const VECTORS: readonly RedactionVector[] = (
  JSON.parse(
    readFileSync(path.join(import.meta.dir, "../../../fixtures/governance/redaction-vectors.json"), "utf8"),
  ) as { vectors: RedactionVector[] }
).vectors;

/** Every literal and comment form spec 7.9 masks, each of which the vectors exercise on every SQL engine of v1. */
const LITERAL_FORMS = [
  "single-quoted",
  "e-string",
  "n-string",
  "dollar-quoted",
  "q-quoted",
  "number",
  "line-comment",
  "block-comment",
  "hash-comment",
];
const SQL_ENGINES: readonly DatabaseType[] = ["postgres", "mysql", "mssql", "oracle"];

/** The cheapest of three runs, in milliseconds, so a scheduler stall on a loaded runner is not read as a regression. */
function cheapestOfThree(probe: () => void): number {
  let elapsed = Infinity;
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now();
    probe();
    elapsed = Math.min(elapsed, performance.now() - started);
  }
  return elapsed;
}

describe("redactStatement", () => {
  test("every redaction vector produces its redacted text and fingerprint", () => {
    const produced = VECTORS.map((vector) => ({ name: vector.name, ...redactStatement(vector.input, vector.engine) }));
    const pinned = VECTORS.map((vector) => ({
      name: vector.name,
      statement: vector.statement,
      statement_fingerprint: vector.statement_fingerprint,
    }));
    expect(produced).toEqual(pinned);
  });

  test("each pinned fingerprint is the lowercase hex SHA-256 of its statement", () => {
    for (const vector of VECTORS) {
      expect(vector.statement_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(vector.statement_fingerprint).toBe(createHash("sha256").update(vector.statement, "utf8").digest("hex"));
    }
  });

  test("the vectors hold every literal form for postgres, mysql, mssql and oracle, and MongoDB and Redis commands", () => {
    for (const engine of SQL_ENGINES) {
      const forms = new Set(VECTORS.filter((vector) => vector.engine === engine).map((vector) => vector.form));
      expect(LITERAL_FORMS.filter((form) => !forms.has(form))).toEqual([]);
    }
    expect(VECTORS.some((vector) => vector.engine === "mongodb")).toBe(true);
    expect(VECTORS.some((vector) => vector.engine === "redis")).toBe(true);
  });

  test("an engine id Studio does not know keeps nothing", () => {
    expect(redactStatement("SELECT 'secret'", "constructor" as DatabaseType).statement).toBe("?");
  });

  test("a number ends where the span reader opens a literal, so no text of the literal is kept", () => {
    expect(redactStatement("SELECT 1.q'[it's]' FROM dual", "oracle").statement).toBe("SELECT ?? FROM dual");
  });

  test("statements that differ only in whitespace and literal values share a fingerprint", () => {
    const one = redactStatement("SELECT *\n  FROM t\tWHERE id = 1", "postgres");
    const other = redactStatement("SELECT * FROM t WHERE id = 99", "postgres");
    expect(one).toEqual(other);
  });

  test("a MongoDB command nested 100000 levels deep is read without overflowing the stack", () => {
    const depth = 100_000;
    const input = `{"collection":"c","operation":"find","filter":${'{"a":'.repeat(depth)}1${"}".repeat(depth)}}`;
    const { statement } = redactStatement(input, "mongodb");
    expect(statement).toBe(
      `{"collection":"c","operation":"find","filter":${'{"a":'.repeat(depth)}?${"}".repeat(depth)}}`,
    );
  });

  test("reading stays linear on unclosed brackets, comments and quotes, and on password words", () => {
    const inputs: readonly [string, DatabaseType][] = [
      [`SELECT ${"[".repeat(100_000)}`, "postgres"],
      [`SELECT ${"/*".repeat(50_000)}`, "postgres"],
      [`SELECT ${"'".repeat(100_001)}`, "mysql"],
      [`SELECT ${"[a".repeat(50_000)}`, "mssql"],
      [`SELECT ${"q'[".repeat(30_000)}`, "oracle"],
      [`SET ${"PASSWORD FOR ".repeat(8_000)}`, "mysql"],
      [`ALTER USER x ${"IDENTIFIED WITH p BY ".repeat(5_000)}`, "mysql"],
    ];
    for (const [input, engine] of inputs) {
      expect(cheapestOfThree(() => redactStatement(input, engine))).toBeLessThan(500);
      expect(cheapestOfThree(() => maskCredentials(input, engine))).toBeLessThan(500);
    }
  });
});

describe("maskCredentials", () => {
  test("CREATE USER x PASSWORD 'p' and ALTER ROLE r IDENTIFIED BY p keep no secret under maskCredentials", () => {
    expect(maskCredentials("CREATE USER x PASSWORD 'p'", "postgres")).toBe("CREATE USER x PASSWORD [REDACTED]");
    expect(maskCredentials("ALTER ROLE r IDENTIFIED BY p", "oracle")).toBe("ALTER ROLE r IDENTIFIED BY [REDACTED]");
    expect(maskCredentials("CREATE USER x PASSWORD 'hunter2'", "postgres")).not.toContain("hunter2");
    expect(maskCredentials("ALTER ROLE r IDENTIFIED BY hunter2", "oracle")).not.toContain("hunter2");
  });

  test("postgres://u:p@h/db keeps no userinfo", () => {
    expect(maskCredentials("postgres://u:p@h/db", "postgres")).toBe("postgres://[REDACTED]@h/db");
    expect(maskCredentials("SELECT dblink_connect('postgres://u:p@h/db')", "postgres")).toBe(
      "SELECT dblink_connect('postgres://[REDACTED]@h/db')",
    );
    expect(redactUriCredentials("postgres://u:p@h/db")).toBe("postgres://[REDACTED]@h/db");
    expect(redactStatement("postgres://u:p@h/db", "postgres").statement).toBe("postgres://[REDACTED]@h/db");
  });

  test("everything that is not a credential is kept byte for byte", () => {
    const statement = "SELECT  'a@b' ,\n \"https://example.com\"  -- keep me\n FROM t WHERE x = 1.5 /* note */ ;";
    expect(maskCredentials(statement, "postgres")).toBe(statement);
  });

  test("a URI and an address in two literals stay as written, because userinfo is read inside one literal", () => {
    const statement = "INSERT INTO hooks (url, owner) VALUES ('https://hooks.example.com/x', 'ops@example.com')";
    expect(maskCredentials(statement, "postgres")).toBe(statement);
  });

  test("the userinfo of a URI in a comment, a quoted run or a code run is masked", () => {
    expect(maskCredentials("SELECT 1 -- via mysql://root:pw@db\n", "mysql")).toBe(
      "SELECT 1 -- via mysql://[REDACTED]@db\n",
    );
    expect(maskCredentials('{"uri": "mongodb://u:p@h/db"}', "mongodb")).toBe('{"uri": "mongodb://[REDACTED]@h/db"}');
    expect(maskCredentials("SET k redis://u:p@h:6379", "redis")).toBe("SET k redis://[REDACTED]@h:6379");
    // ClickHouse reads the `//` as a line comment, which must not cut the URI in two.
    expect(maskCredentials("\\connect postgres://u:p@h/db", "clickhouse")).toBe("\\connect postgres://[REDACTED]@h/db");
  });

  test.each<[DatabaseType, string, string]>([
    [
      "mysql",
      "ALTER USER 'ann'@'%' IDENTIFIED BY 'new' REPLACE 'old'",
      "ALTER USER 'ann'@'%' IDENTIFIED BY [REDACTED] REPLACE [REDACTED]",
    ],
    [
      "mysql",
      "CREATE USER 'ann'@'%' IDENTIFIED WITH caching_sha2_password BY 'S3cret!'",
      "CREATE USER 'ann'@'%' IDENTIFIED WITH caching_sha2_password BY [REDACTED]",
    ],
    [
      "mysql",
      "ALTER USER 'ann'@'%' IDENTIFIED WITH mysql_native_password AS '*94BDCEBE19083CE2A1F959FD02F964C7AF4CFC29'",
      "ALTER USER 'ann'@'%' IDENTIFIED WITH mysql_native_password AS [REDACTED]",
    ],
    [
      "mysql",
      "GRANT ALL ON *.* TO 'ann'@'%' IDENTIFIED BY PASSWORD '*94BDCEBE19083CE2A1F959FD02F964C7AF4CFC29'",
      "GRANT ALL ON *.* TO 'ann'@'%' IDENTIFIED BY PASSWORD [REDACTED]",
    ],
    ["mysql", "SET PASSWORD = PASSWORD('x')", "SET PASSWORD = PASSWORD([REDACTED])"],
    [
      "mysql",
      "SET PASSWORD FOR 'ann'@'%' = 'new' REPLACE 'old'",
      "SET PASSWORD FOR 'ann'@'%' = [REDACTED] REPLACE [REDACTED]",
    ],
    [
      "mysql",
      "ALTER USER ann IDENTIFIED VIA mysql_native_password USING '*94BDCEBE19083CE2A1F959FD02F964C7AF4CFC29'",
      "ALTER USER ann IDENTIFIED VIA mysql_native_password USING [REDACTED]",
    ],
    [
      "mysql",
      "SELECT 'O\\'Brien'; ALTER USER ann IDENTIFIED BY 'S3cret!'",
      // The quote behind the backslash ends the literal in a session with NO_BACKSLASH_ESCAPES, where the ALTER USER
      // after it is code, so the run that cannot be closed is masked whole.
      "SELECT [REDACTED]",
    ],
    [
      "mssql",
      "ALTER LOGIN ann WITH PASSWORD = N'new' OLD_PASSWORD = 'old'",
      "ALTER LOGIN ann WITH PASSWORD = [REDACTED] OLD_PASSWORD = [REDACTED]",
    ],
    ["mssql", "CREATE LOGIN a WITH PASSWORD = 0x0200AB HASHED", "CREATE LOGIN a WITH PASSWORD = [REDACTED] HASHED"],
    [
      "mssql",
      "CREATE MASTER KEY ENCRYPTION BY PASSWORD = 'p@ss'",
      "CREATE MASTER KEY ENCRYPTION BY PASSWORD = [REDACTED]",
    ],
    [
      "mssql",
      "SELECT * INTO #recent FROM Orders; ALTER LOGIN sa WITH PASSWORD = 'x'",
      "SELECT * INTO #recent FROM Orders; ALTER LOGIN sa WITH PASSWORD = [REDACTED]",
    ],
    [
      "oracle",
      'CREATE USER app IDENTIFIED BY "p@ss word" DEFAULT TABLESPACE users',
      "CREATE USER app IDENTIFIED BY [REDACTED] DEFAULT TABLESPACE users",
    ],
    [
      "oracle",
      "ALTER USER scott IDENTIFIED BY VALUES 'S:8F2D65FB5547B71C8DA3760F10960428CD307B1C6271691FC55C1F56554A'",
      "ALTER USER scott IDENTIFIED BY VALUES [REDACTED]",
    ],
    ["postgres", "ALTER ROLE r PASSWORD /* new */ 'x'", "ALTER ROLE r PASSWORD /* new */ [REDACTED]"],
    ["postgres", "SELECT 5 # 3; ALTER ROLE r PASSWORD 'x'", "SELECT 5 # 3; ALTER ROLE r PASSWORD [REDACTED]"],
    [
      "postgres",
      "UPDATE users SET password = 'hash' WHERE id = 1",
      "UPDATE users SET password = [REDACTED] WHERE id = 1",
    ],
  ])("%s: %s keeps no secret", (engine, statement, masked) => {
    expect(maskCredentials(statement, engine)).toBe(masked);
  });

  test.each<[DatabaseType, string]>([
    ["mysql", "CREATE USER 'ann'@'%' IDENTIFIED BY RANDOM PASSWORD"],
    ["postgres", "CREATE ROLE r PASSWORD NULL"],
    ["postgres", "SELECT password FROM users"],
    ["oracle", "ALTER USER x IDENTIFIED BY"],
    ["oracle", "ALTER USER x IDENTIFIED BY ;"],
    ["mysql", "CREATE USER x IDENTIFIED WITH auth_socket"],
    ["oracle", "CREATE USER x IDENTIFIED EXTERNALLY"],
    ["mysql", "SET PASSWORD FOR 'ann'@'%'"],
    // MySQL's own escape for an apostrophe: the run cannot be closed, and it names no password, so it is kept.
    ["mysql", "SELECT * FROM users WHERE name = 'O\\'Brien' AND age > 30"],
    // Password words are SQL syntax: a Redis or MongoDB statement is read for its URIs alone.
    ["redis", 'SET password "hunter2"'],
    ["mongodb", '{"collection": "users", "operation": "updateOne", "update": {"$set": {"password": "hunter2"}}}'],
  ])("%s: %s names no secret and stays as written", (engine, statement) => {
    expect(maskCredentials(statement, engine)).toBe(statement);
  });
});

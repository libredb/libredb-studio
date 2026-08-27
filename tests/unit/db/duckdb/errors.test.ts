/**
 * Unit tests for the DuckDB error vocabulary (issue #424).
 *
 * Every message string below is VERBATIM from a live DuckDB v1.5.5 through
 * @duckdb/node-api 1.5.5-r.4 on 2026-08-27, recorded in `.duckdb-measured.md`. That
 * matters more here than anywhere else in the provider: the classification is read off
 * the engine's own prefix, so a fabricated message would test a mapping against text
 * the engine never produces.
 *
 * The cross-process lock message in particular is a real measurement rather than an
 * invention - a second operating-system process opening the same file is refused, in
 * read-only mode too, which is the reason `singleWriterFile` is declared at all.
 */

import { describe, expect, test } from "bun:test";
import { describeOpenFailure, readLockHolderPid } from "@/lib/db/providers/sql/duckdb/client";
import { mapDuckDBError } from "@/lib/db/providers/sql/duckdb";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseError,
  ExecutionProfileError,
  QueryCancelledError,
  QueryError,
} from "@/lib/db/errors";

/** Measured against a writer holding /tmp/libredb-duckdb/lock-test.duckdb. */
const LOCK_MESSAGE =
  'IO Error: Could not set lock on file "/tmp/libredb-duckdb/lock-test.duckdb": Conflicting lock is held in ' +
  "/home/user/.bun/bin/bun (PID 274831). See also https://duckdb.org/docs/stable/connect/concurrency";

const MISSING_READ_ONLY_MESSAGE =
  'IO Error: Cannot open database "/tmp/duckdb-probe/missing.duckdb" in read-only mode: database does not exist';

describe("readLockHolderPid", () => {
  test("reads the PID DuckDB named", () => {
    expect(readLockHolderPid(LOCK_MESSAGE)).toBe(274831);
  });

  test("answers null when the message names none", () => {
    expect(readLockHolderPid("IO Error: something else")).toBeNull();
  });
});

describe("describeOpenFailure", () => {
  test("a lock conflict names the holding process and says a read-only handle will not help", () => {
    const error = describeOpenFailure(new Error(LOCK_MESSAGE), "/tmp/warehouse.duckdb", false);

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toContain("locked by process 274831");
    expect(error.message).toContain("in read-only mode too");
    // The engine's own sentence travels with it: it carries the path and the doc link.
    expect(error.message).toContain(LOCK_MESSAGE);
  });

  test("a lock conflict with no PID still says another process holds it", () => {
    const error = describeOpenFailure(new Error("IO Error: Conflicting lock is held elsewhere"), "/tmp/x.duckdb", true);

    expect(error.message).toContain("locked by another process");
  });

  test("a read-only open of a missing file explains that it will not be created", () => {
    const error = describeOpenFailure(new Error(MISSING_READ_ONLY_MESSAGE), "/tmp/missing.duckdb", true);

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toContain("does not exist and a read-only handle will not create one");
  });

  test("the same message from a WRITABLE open is not given the read-only sentence", () => {
    // A writable open creates the file, so "does not exist" there is a different
    // problem - a missing directory, a permission - and claiming otherwise misleads.
    const error = describeOpenFailure(new Error("IO Error: database does not exist"), "/tmp/x.duckdb", false);

    expect(error.message).toContain("Failed to open DuckDB database /tmp/x.duckdb");
  });

  test("a non-Error rejection is still reported with its text", () => {
    expect(describeOpenFailure("something threw a string", "/tmp/x.duckdb", false).message).toContain(
      "something threw a string",
    );
  });
});

describe("mapDuckDBError", () => {
  test("an interrupt is a cancellation, not a failure", () => {
    // Measured: `connection.interrupt()` stops a running scan with exactly this text.
    const error = mapDuckDBError(new Error("INTERRUPT Error: Interrupted!"), "SELECT count(*) FROM range(1e11)");

    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error.message).toBe("Query was cancelled");
  });

  test("a lock conflict raised mid-session gets the same actionable sentence as at open", () => {
    const error = mapDuckDBError(new Error(LOCK_MESSAGE), "CHECKPOINT");

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toContain("locked by process 274831");
  });

  test.each([
    ['Parser Error: syntax error at or near "SELCT"', "SELCT 1"],
    ["Catalog Error: Table with name nope does not exist!", "SELECT * FROM nope"],
    ['Binder Error: Referenced column "nocol" not found in FROM clause!', "SELECT nocol FROM customers"],
    ["Conversion Error: Could not convert string 'x' to INT32", "SELECT 'x'::INTEGER"],
    [
      'Invalid Input Error: Cannot execute statement of type "INSERT" on database "src" which is attached in read-only mode!',
      "INSERT INTO users VALUES (2)",
    ],
    ['Constraint Error: Duplicate key "id: 1" violates primary key constraint', "INSERT INTO t VALUES (1)"],
  ])("%s is a QueryError carrying the engine's own words", (message, sql) => {
    const error = mapDuckDBError(new Error(message), sql);

    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(message);
    expect((error as QueryError).query).toBe(sql);
  });

  test("a mistyped column named `password` is a QUERY error, not an authentication failure", () => {
    // This is why the prefix is read before the shared mapper: `mapDatabaseError`
    // classifies on substrings, and "password" in the sentence would otherwise report
    // a typo to the operator as a credential problem.
    const error = mapDuckDBError(
      new Error('Binder Error: Referenced column "password" not found in FROM clause!'),
      "SELECT password FROM users",
    );

    expect(error).toBeInstanceOf(QueryError);
    expect(error).not.toBeInstanceOf(AuthenticationError);
  });

  test("an already-mapped provider error is returned untouched", () => {
    const original = new QueryError("already mapped", "duckdb", "SELECT 1");

    expect(mapDuckDBError(original)).toBe(original);
  });

  test("an execution-profile refusal keeps its reason code", () => {
    // Wrapping it would strip the code the acquisition path fails closed on.
    const original = new ExecutionProfileError("no in-memory target", "PROFILE_UNSUPPORTED_TARGET");

    expect(mapDuckDBError(original)).toBe(original);
  });

  test("anything without a recognised prefix falls through to the shared mapper", () => {
    const error = mapDuckDBError(new Error("something entirely unexpected"), "SELECT 1");

    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).not.toBeInstanceOf(QueryError);
    expect(error.message).toBe("something entirely unexpected");
  });

  test("a non-Error rejection is still classified", () => {
    expect(mapDuckDBError("a bare string").message).toBe("a bare string");
  });
});

/**
 * ClickHouse transport seam (issue #264, design spec section 3.3)
 *
 * Almost all of transport.ts is type declarations, which erase at build time.
 * What survives is the vocabulary every other file in the provider switches on:
 * the frozen exception-code table and the normalized error. Those are pinned
 * here, ahead of the transport and the provider, because a wrong code silently
 * turns a degradation path into a thrown error (or the reverse).
 *
 * The numbering is not transcribed from documentation. It was read back from the
 * live server (ClickHouse 26.7.1.1315) with
 *   SELECT number, errorCodeToName(toUInt32(number)) FROM numbers(1500)
 * which is why ACCESS_DENIED is 497 and not one of the neighbouring codes.
 */
import { describe, expect, test } from "bun:test";
import {
  CLICKHOUSE_ERROR_CODES,
  CLICKHOUSE_UNKNOWN_ERROR_NAME,
  type ClickHouseErrorName,
  type ClickHouseQueryOptions,
  type ClickHouseQueryResult,
  type ClickHouseRow,
  ClickHouseTransportError,
  type ClickHouseTransport,
} from "@/lib/db/providers/sql/clickhouse/transport";

/** Every name in the frozen table, so a new code cannot escape the matrix below. */
const ERROR_NAMES = Object.keys(CLICKHOUSE_ERROR_CODES) as ClickHouseErrorName[];

function errorWithCode(code: number, name = "IRRELEVANT"): ClickHouseTransportError {
  return new ClickHouseTransportError(`Code: ${code}. DB::Exception: probe`, code, name);
}

// ============================================================================
// The shared code table
// ============================================================================

describe("CLICKHOUSE_ERROR_CODES", () => {
  test("carries exactly the codes read back from the live server", () => {
    expect(CLICKHOUSE_ERROR_CODES).toEqual({
      NOT_IMPLEMENTED: 48,
      UNKNOWN_TABLE: 60,
      SYNTAX_ERROR: 62,
      UNKNOWN_DATABASE: 81,
      ACCESS_DENIED: 497,
      AUTHENTICATION_FAILED: 516,
    });
  });

  test("maps every name to a distinct code", () => {
    const codes = Object.values(CLICKHOUSE_ERROR_CODES);

    expect(new Set(codes).size).toBe(codes.length);
  });

  // A consumer that can retune a code at runtime makes the table advisory, and
  // the whole point of exporting it is that there is one definition.
  test("is frozen, so no consumer can retune a code", () => {
    const mutable = CLICKHOUSE_ERROR_CODES as unknown as Record<string, number>;

    expect(Object.isFrozen(CLICKHOUSE_ERROR_CODES)).toBe(true);
    expect(() => {
      mutable.UNKNOWN_TABLE = 1;
    }).toThrow(TypeError);
    expect(CLICKHOUSE_ERROR_CODES.UNKNOWN_TABLE).toBe(60);
  });
});

// ============================================================================
// The normalized error
// ============================================================================

describe("ClickHouseTransportError", () => {
  test("is a real Error carrying the code and the message the server reported", () => {
    const error = new ClickHouseTransportError("Unknown table expression identifier 'nope'", 60, "UNKNOWN_TABLE");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ClickHouseTransportError);
    expect(error.code).toBe(60);
    expect(error.message).toBe("Unknown table expression identifier 'nope'");
  });

  // `name` deliberately holds ClickHouse's own symbol instead of the class name.
  // It is the vocabulary a ClickHouse user already knows from clickhouse-client,
  // and the class is recoverable through instanceof, which nothing else is.
  test("uses the ClickHouse exception name as the error name", () => {
    expect(new ClickHouseTransportError("boom", 62, "SYNTAX_ERROR").name).toBe("SYNTAX_ERROR");
  });

  test("falls back to a generic name when there was no exception name to read", () => {
    const error = new ClickHouseTransportError("socket hang up", 0);

    expect(error.name).toBe(CLICKHOUSE_UNKNOWN_ERROR_NAME);
    expect(error.code).toBe(0);
  });

  // Subclassing a builtin loses the prototype under some downlevel emits, which
  // would make every `catch` in the provider fall through to the generic path.
  test("survives being thrown and caught", () => {
    try {
      throw new ClickHouseTransportError("nope", 81, "UNKNOWN_DATABASE");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ClickHouseTransportError);
      expect((caught as ClickHouseTransportError).code).toBe(81);
    }
  });

  // Verified live: a query that fails mid-result reports code 395
  // (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO), far outside the named table. The
  // named codes are the ones the provider branches on, not the only legal ones.
  test("accepts a code that is not in the named table", () => {
    const error = errorWithCode(395, "FUNCTION_THROW_IF_VALUE_IS_NON_ZERO");

    expect(error.code).toBe(395);
    expect(ERROR_NAMES.some((name) => error.is(name))).toBe(false);
    expect(error.isMonitoringUnavailable()).toBe(false);
  });
});

describe("ClickHouseTransportError.is", () => {
  test.each(ERROR_NAMES)("recognises %s and rejects every other name", (name) => {
    const error = errorWithCode(CLICKHOUSE_ERROR_CODES[name]);

    expect(error.is(name)).toBe(true);
    expect(ERROR_NAMES.filter((other) => other !== name).some((other) => error.is(other))).toBe(false);
  });

  // The numeric code is a discrete field the server reports; the symbolic name
  // has to be scraped out of the message prose and can therefore be missing or
  // wrong. Matching on the code is what keeps the provider's branches reliable.
  test("matches on the code even when the name says something else", () => {
    const error = new ClickHouseTransportError("Code: 60. DB::Exception: mislabelled", 60, "SOMETHING_ELSE");

    expect(error.is("UNKNOWN_TABLE")).toBe(true);
    expect(error.name).toBe("SOMETHING_ELSE");
  });
});

describe("ClickHouseTransportError.isMonitoringUnavailable", () => {
  // Spec 1.6 / 3.7: a restricted user is the normal case, and query_log is
  // absent on plenty of deployments. Both must degrade to an empty panel.
  test.each<[ClickHouseErrorName]>([
    ["ACCESS_DENIED"],
    ["UNKNOWN_TABLE"],
  ])("treats %s as an unavailable monitoring surface", (name) => {
    expect(errorWithCode(CLICKHOUSE_ERROR_CODES[name]).isMonitoringUnavailable()).toBe(true);
  });

  // These are the user's own mistakes. Swallowing them would hide a real failure
  // behind an empty panel, which is the opposite of the honesty rule.
  test.each<[ClickHouseErrorName]>([
    ["SYNTAX_ERROR"],
    ["UNKNOWN_DATABASE"],
    ["AUTHENTICATION_FAILED"],
    ["NOT_IMPLEMENTED"],
  ])("does not swallow %s", (name) => {
    expect(errorWithCode(CLICKHOUSE_ERROR_CODES[name]).isMonitoringUnavailable()).toBe(false);
  });
});

// ============================================================================
// The seam contract
// ============================================================================

describe("the ClickHouseTransport contract", () => {
  /** A transport built out of nothing but the neutral types, proving they suffice. */
  class RecordingTransport implements ClickHouseTransport {
    readonly kind = "http" as const;
    readonly calls: { sql: string; opts?: ClickHouseQueryOptions }[] = [];
    closed = false;

    constructor(private readonly result: ClickHouseQueryResult) {}

    async query(sql: string, opts?: ClickHouseQueryOptions): Promise<ClickHouseQueryResult> {
      this.calls.push({ sql, opts });
      return this.result;
    }

    async close(): Promise<void> {
      this.closed = true;
    }
  }

  const rows: ClickHouseRow[] = [{ id: 1, big: "18446744073709551615" }];

  const jsonResult: ClickHouseQueryResult = {
    rows,
    fieldNames: ["id", "big"],
    // Declared types are carried verbatim (spec 1.7), wrappers included.
    columnTypes: { id: "Int32", big: "UInt64" },
    executionTimeMs: 3,
    mutationCount: 0,
    rawText: null,
  };

  test("a result describes its rows, their order and their declared types", async () => {
    const transport = new RecordingTransport(jsonResult);

    const result = await transport.query("SELECT id, big FROM probe", { database: "demo" });

    expect(transport.kind).toBe("http");
    expect(result.rows).toEqual(rows);
    expect(result.fieldNames).toEqual(["id", "big"]);
    expect(result.columnTypes).toEqual({ id: "Int32", big: "UInt64" });
    expect(result.rawText).toBeNull();
  });

  test("options retarget the database and add per-statement settings", async () => {
    const transport = new RecordingTransport(jsonResult);

    await transport.query("SELECT 1", { database: "other", settings: { max_execution_time: 5, readonly: true } });

    expect(transport.calls).toEqual([
      { sql: "SELECT 1", opts: { database: "other", settings: { max_execution_time: 5, readonly: true } } },
    ]);
  });

  // Spec 1.2: an explicit FORMAT in the user's SQL wins, so a result is not
  // always tabular. The seam represents that without a wire-shaped field.
  test("a non-tabular result is carried as text with nothing described", async () => {
    const transport = new RecordingTransport({
      rows: [],
      fieldNames: null,
      columnTypes: null,
      executionTimeMs: 1,
      mutationCount: 0,
      rawText: "1\n",
    });

    const result = await transport.query("SELECT 1 FORMAT TSV");

    expect(result.rawText).toBe("1\n");
    expect(result.rows).toEqual([]);
    expect(result.fieldNames).toBeNull();
    expect(result.columnTypes).toBeNull();
  });

  test("close is part of the contract even when a transport holds nothing open", async () => {
    const transport = new RecordingTransport(jsonResult);

    await transport.close();

    expect(transport.closed).toBe(true);
  });
});

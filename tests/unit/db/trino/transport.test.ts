/**
 * Trino transport seam (issue #424, Phase 2)
 *
 * Almost all of transport.ts is type declarations, which erase at build time.
 * What survives is what every other file switches on: the dialect descriptor the
 * whole protocol is generated from, and the normalized error.
 *
 * The descriptor is pinned here rather than left to the implementation because
 * getting it wrong is silent in exactly one direction. Measured against a live
 * Trino 476 on 2026-08-20: a coordinator sent headers under the wrong product
 * prefix sees NO user header at all and answers HTTP 401 with a PLAIN-TEXT body -
 * `Basic authentication or X-Trino-Original-User or X-Trino-User must be sent` -
 * which looks like a credentials problem and is not. So the prefix is the one
 * value in this repo where a typo reports someone else's fault.
 */
import { describe, expect, test } from "bun:test";
import {
  TRINO_DIALECT,
  TRINO_DIALECTS,
  type TrinoDialectId,
  type TrinoErrorCategory,
  type TrinoExecutionStats,
  type TrinoQueryOptions,
  type TrinoQueryResult,
  type TrinoRow,
  type TrinoTransport,
  TrinoTransportError,
  type TrinoWarning,
} from "@/lib/db/providers/sql/trino/transport";

// ============================================================================
// The dialect descriptor
// ============================================================================

describe("TRINO_DIALECT", () => {
  test("describes the product the transport generates its protocol from", () => {
    expect(TRINO_DIALECT).toEqual({
      id: "trino",
      headerPrefix: "Trino",
      displayName: "Trino",
      defaultPort: 8080,
      versionQuery: "SELECT version()",
    });
  });

  // The server generates every header as "X-" + protocolName + "-" + headerName.
  // A prefix carrying its own punctuation would produce `X-Trino--User`, which is
  // not a header the coordinator recognises, and the failure would arrive as a
  // 401 about credentials.
  test("carries a bare product name, so a generated header cannot be malformed", () => {
    expect(TRINO_DIALECT.headerPrefix).not.toContain("-");
    expect(TRINO_DIALECT.headerPrefix).not.toContain("X");
    expect(`X-${TRINO_DIALECT.headerPrefix}-User`).toBe("X-Trino-User");
  });

  /**
   * Measured on 476: `SELECT version()` answers the bare string `"476"` - no
   * product name, no dots, not semver. The descriptor carries the STATEMENT for
   * that reason: PrestoDB answers a `0.2xx`-shaped string, so the two cannot share
   * one parse and must not share one hardcoded query.
   */
  test("asks for the version with a statement rather than a parsed shape", () => {
    expect(TRINO_DIALECT.versionQuery).toBe("SELECT version()");
  });

  // A consumer that can retune the prefix at runtime makes the descriptor
  // advisory, and the whole point of exporting it is that there is one definition.
  test("is frozen, so no consumer can retune the protocol", () => {
    const mutable = TRINO_DIALECT as unknown as Record<string, string>;

    expect(Object.isFrozen(TRINO_DIALECT)).toBe(true);
    expect(() => {
      mutable.headerPrefix = "Presto";
    }).toThrow(TypeError);
    expect(TRINO_DIALECT.headerPrefix).toBe("Trino");
  });
});

describe("TRINO_DIALECTS", () => {
  test("keys every descriptor by the type-id it is registered under", () => {
    expect(Object.keys(TRINO_DIALECTS)).toEqual(["trino"]);
    expect(TRINO_DIALECTS.trino).toBe(TRINO_DIALECT);
  });

  // Selecting by `config.type` only works while the key and the descriptor agree.
  test("every entry names itself", () => {
    for (const [id, dialect] of Object.entries(TRINO_DIALECTS)) {
      expect(dialect.id).toBe(id as TrinoDialectId);
    }
  });

  test("is frozen, so the table cannot gain an entry at runtime", () => {
    const mutable = TRINO_DIALECTS as unknown as Record<string, unknown>;

    expect(Object.isFrozen(TRINO_DIALECTS)).toBe(true);
    expect(() => {
      mutable.presto = TRINO_DIALECT;
    }).toThrow(TypeError);
  });
});

// ============================================================================
// The normalized error
// ============================================================================

describe("TrinoTransportError", () => {
  test("carries the category a caller branches on and the engine's own wording", () => {
    const error = new TrinoTransportError(
      "unknown-object",
      "line 1:15: Table 'tpch.sf1.no_such_table' does not exist",
      "TABLE_NOT_FOUND",
      { line: 1, column: 15 },
    );

    expect(error.category).toBe("unknown-object");
    expect(error.message).toBe("line 1:15: Table 'tpch.sf1.no_such_table' does not exist");
    expect(error.code).toBe("TABLE_NOT_FOUND");
    expect(error.location).toEqual({ line: 1, column: 15 });
  });

  /**
   * Measured: `NOT_SUPPORTED` on a `CREATE TABLE` reports `errorLocation: null`
   * and `USER_CANCELED` omits the member entirely, so "no location" is the
   * ordinary case and a caller must not have to distinguish absent from unparsed.
   */
  test("defaults the diagnostics away, because the engine legitimately sends none", () => {
    const error = new TrinoTransportError("cancelled", "Query was canceled");

    expect(error.code).toBeNull();
    expect(error.location).toBeNull();
  });

  test("is an Error, so an unaware catch still reports something readable", () => {
    const error = new TrinoTransportError("syntax", "line 1:1: mismatched input 'SELEKT'");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TrinoTransportError");
    expect(String(error)).toContain("line 1:1: mismatched input 'SELEKT'");
  });

  // Subclassing a builtin loses the prototype under a downlevel emit, which would
  // make every instanceof check in the provider quietly fall through - and a
  // provider that cannot recognise its own transport error maps every failure onto
  // the generic branch.
  test("survives an instanceof check, which the provider's error mapping depends on", () => {
    const caught: unknown = new TrinoTransportError("engine", "refused");

    expect(caught instanceof TrinoTransportError).toBe(true);
    expect(Object.getPrototypeOf(caught)).toBe(TrinoTransportError.prototype);
  });

  /**
   * The union is the contract between the transport and the provider's error
   * mapping: the implementation owes each category a faithful decision, and the
   * provider owes each one an error class. Enumerated here so that adding a
   * category cannot happen without a deliberate edit on both sides.
   */
  test("the category union is exactly the nine the provider must map", () => {
    const categories: TrinoErrorCategory[] = [
      "syntax",
      "unknown-object",
      "unsupported",
      "auth",
      "unreachable",
      "cancelled",
      "timeout",
      "resources",
      "engine",
    ];
    const carried = categories.map((category) => new TrinoTransportError(category, "probe").category);

    expect(carried).toEqual(categories);
    expect(new Set(categories).size).toBe(categories.length);
  });
});

// ============================================================================
// The shape of the seam
// ============================================================================

/**
 * A hand-built transport, which is the whole point of the seam: introspection
 * and the provider take one of these and never learn what is behind it. It
 * compiling is the assertion - if a field of the neutral result were wire-shaped,
 * this object could not be written without a wire document to copy from.
 */
const STUB_STATS: TrinoExecutionStats = {
  state: "FINISHED",
  elapsedMs: 576,
  cpuMs: 4,
  queuedMs: 9,
  processedRows: 1,
  processedBytes: 0,
  peakMemoryBytes: 148,
};

describe("TrinoTransport", () => {
  test("can be satisfied without any knowledge of the protocol", async () => {
    const seen: string[] = [];
    const stub: TrinoTransport = {
      dialect: TRINO_DIALECT,
      query: (sql: string, options: TrinoQueryOptions = {}): Promise<TrinoQueryResult> => {
        options.onQueryStarted?.("20260819_231125_00001_chvb7");
        const row: TrinoRow = { _col0: "476" };
        const warning: TrinoWarning = {
          code: "REDUNDANT_ORDER_BY",
          message: "ORDER BY in subquery may have no effect",
        };
        return Promise.resolve({
          rows: [row],
          fieldNames: ["_col0"],
          columnTypes: { _col0: "varchar" },
          queryId: "20260819_231125_00001_chvb7",
          operation: null,
          affectedRows: null,
          warnings: [warning],
          stats: STUB_STATS,
          // `sql` is read so the stub is a transport rather than a constant.
          ...(sql === "" ? { rows: [] } : {}),
        });
      },
      cancel: (queryId: string): Promise<void> => {
        seen.push(queryId);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };

    const result = await stub.query(TRINO_DIALECT.versionQuery, { onQueryStarted: (id) => seen.push(id) });
    await stub.cancel(result.queryId);
    await stub.close();

    expect(result.rows).toEqual([{ _col0: "476" }]);
    expect(result.stats.state).toBe("FINISHED");
    // Announced while the statement is running AND carried on the result: a caller
    // that wants to cancel from elsewhere needs the first, and one that wants to
    // link to the cluster UI needs the second.
    expect(seen).toEqual(["20260819_231125_00001_chvb7", "20260819_231125_00001_chvb7"]);
  });
});

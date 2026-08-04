/**
 * Druid transport seam (issue #265, design spec section 5)
 *
 * Almost all of transport.ts is type declarations, which erase at build time.
 * What survives is the vocabulary every other file in the provider switches on:
 * the frozen category table and the normalized error. Those are pinned here,
 * ahead of the transport and the provider, because a wrong category silently
 * turns a degradation path into a thrown error (or the reverse) - and on Druid
 * the category is the ONLY reliable classifier: live-verified on 37.0.0,
 * `SELECT 1/0` answers HTTP 500 with `persona: "ADMIN"` for what is a plain user
 * mistake, so neither the status code nor the persona may be branched on.
 *
 * The categories are not transcribed from documentation. Both envelope shapes in
 * spec section 5 were read back from the live cluster, e.g.
 *   {"error":"druidException","errorCode":"invalidInput","persona":"USER",
 *    "category":"INVALID_INPUT","errorMessage":"Object 'nope' not found ..."}
 */
import { describe, expect, test } from "bun:test";
import {
  DRUID_ERROR_CATEGORIES,
  DRUID_TRANSPORT_FAILURE,
  type DruidErrorCategory,
  type DruidQueryOptions,
  type DruidQueryResult,
  type DruidRow,
  type DruidTransport,
  DruidTransportError,
} from "@/lib/db/providers/sql/druid/transport";

/** Every category in the frozen table, so a new one cannot escape the matrices below. */
const CATEGORIES = Object.keys(DRUID_ERROR_CATEGORIES) as DruidErrorCategory[];

function errorIn(category: string): DruidTransportError {
  return new DruidTransportError("probe", category, "general", "USER");
}

// ============================================================================
// The shared category table
// ============================================================================

describe("DRUID_ERROR_CATEGORIES", () => {
  test("carries exactly the categories Druid classifies a failure into", () => {
    expect(DRUID_ERROR_CATEGORIES).toEqual({
      INVALID_INPUT: "INVALID_INPUT",
      UNAUTHORIZED: "UNAUTHORIZED",
      FORBIDDEN: "FORBIDDEN",
      CAPACITY_EXCEEDED: "CAPACITY_EXCEEDED",
      CANCELED: "CANCELED",
      RUNTIME_FAILURE: "RUNTIME_FAILURE",
      TIMEOUT: "TIMEOUT",
      UNSUPPORTED: "UNSUPPORTED",
      NOT_FOUND: "NOT_FOUND",
      UNCATEGORIZED: "UNCATEGORIZED",
      DEFENSIVE: "DEFENSIVE",
    });
  });

  test("maps every name to a distinct token", () => {
    const tokens = Object.values(DRUID_ERROR_CATEGORIES);

    expect(new Set(tokens).size).toBe(tokens.length);
  });

  // A consumer that can retune a category at runtime makes the table advisory,
  // and the whole point of exporting it is that there is one definition.
  test("is frozen, so no consumer can retune a category", () => {
    const mutable = DRUID_ERROR_CATEGORIES as unknown as Record<string, string>;

    expect(Object.isFrozen(DRUID_ERROR_CATEGORIES)).toBe(true);
    expect(() => {
      mutable.TIMEOUT = "NOPE";
    }).toThrow(TypeError);
    expect(DRUID_ERROR_CATEGORIES.TIMEOUT).toBe("TIMEOUT");
  });

  // The stand-in is ours, not Druid's. Were it a member of the table, `is()`
  // would accept it and a caller could believe the server had classified the
  // failure when nothing ever answered.
  test("does not contain the stand-in used when the server said nothing", () => {
    expect(Object.values(DRUID_ERROR_CATEGORIES)).not.toContain(DRUID_TRANSPORT_FAILURE);
  });
});

// ============================================================================
// The normalized error
// ============================================================================

describe("DruidTransportError", () => {
  test("is a real Error carrying everything the envelope classified", () => {
    const error = new DruidTransportError(
      "Object 'nope' not found (line [1], column [15])",
      DRUID_ERROR_CATEGORIES.INVALID_INPUT,
      "invalidInput",
      "USER",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DruidTransportError);
    expect(error.category).toBe("INVALID_INPUT");
    expect(error.errorCode).toBe("invalidInput");
    expect(error.persona).toBe("USER");
    expect(error.message).toBe("Object 'nope' not found (line [1], column [15])");
    expect(error.name).toBe("DruidTransportError");
  });

  // Spec section 5, point 4 and the abort case: a refused socket, an aborted
  // request and a proxy's HTML error page all arrive with nothing to scrape.
  test("falls back to the stand-in when nothing was reported to classify", () => {
    const error = new DruidTransportError("Druid request failed: connect ECONNREFUSED 127.0.0.1:8888");

    expect(error.category).toBe(DRUID_TRANSPORT_FAILURE);
    expect(error.errorCode).toBe(DRUID_TRANSPORT_FAILURE);
    expect(error.persona).toBeNull();
    expect(CATEGORIES.some((category) => error.is(category))).toBe(false);
  });

  // Subclassing a builtin loses the prototype under some downlevel emits, which
  // would make every `catch` in the provider fall through to the generic path.
  test("survives being thrown and caught", () => {
    try {
      throw new DruidTransportError("url[...] timed out", DRUID_ERROR_CATEGORIES.TIMEOUT, "legacyQueryException");
    } catch (caught) {
      expect(caught).toBeInstanceOf(DruidTransportError);
      expect((caught as DruidTransportError).category).toBe("TIMEOUT");
      expect((caught as DruidTransportError).errorCode).toBe("legacyQueryException");
      expect((caught as DruidTransportError).persona).toBeNull();
    }
  });

  // The table holds the categories the provider branches on, not the only legal
  // ones: a later Druid may add one, and it must arrive verbatim rather than be
  // flattened onto UNCATEGORIZED, which is itself a category Druid really sends.
  test("carries a category that is not in the named table", () => {
    const error = errorIn("SOME_FUTURE_CATEGORY");

    expect(error.category).toBe("SOME_FUTURE_CATEGORY");
    expect(CATEGORIES.some((category) => error.is(category))).toBe(false);
    expect(error.isMonitoringUnavailable()).toBe(false);
  });
});

describe("DruidTransportError.is", () => {
  test.each(CATEGORIES)("recognises %s and rejects every other category", (category) => {
    const error = errorIn(DRUID_ERROR_CATEGORIES[category]);

    expect(error.is(category)).toBe(true);
    expect(CATEGORIES.filter((other) => other !== category).some((other) => error.is(other))).toBe(false);
  });

  // Spec section 5, point 2: `category` is the classifier and `errorCode` is
  // secondary. The same errorCode (`general`) arrives with UNCATEGORIZED,
  // and `legacyQueryException` with TIMEOUT as well as RUNTIME_FAILURE, so a
  // branch keyed on the code would be wrong for one of them.
  test("matches on the category even when the errorCode is the generic one", () => {
    const error = new DruidTransportError("/ by zero", DRUID_ERROR_CATEGORIES.UNCATEGORIZED, "general", "ADMIN");

    expect(error.is("UNCATEGORIZED")).toBe(true);
    expect(error.is("RUNTIME_FAILURE")).toBe(false);
    expect(error.errorCode).toBe("general");
  });
});

describe("DruidTransportError.isMonitoringUnavailable", () => {
  // Spec section 5: these three are the ordinary configurations of a locked-down
  // cluster - basic security refusing the credentials, a role without the
  // STATE/EXTERNAL permission `sys` needs, and a build where the table is absent.
  test.each<[DruidErrorCategory]>([
    ["UNAUTHORIZED"],
    ["FORBIDDEN"],
    ["NOT_FOUND"],
  ])("treats %s as an unavailable monitoring surface", (category) => {
    expect(errorIn(DRUID_ERROR_CATEGORIES[category]).isMonitoringUnavailable()).toBe(true);
  });

  // Everything else must keep propagating: swallowing it would hide the user's
  // own mistake behind an empty panel, which is what this list exists to prevent.
  // UNCATEGORIZED is the sharpest case - live-verified, `SELECT 1/0` lands there
  // with an ADMIN persona and an HTTP 500 while being an ordinary user error.
  test.each<[DruidErrorCategory]>([
    ["INVALID_INPUT"],
    ["CAPACITY_EXCEEDED"],
    ["CANCELED"],
    ["RUNTIME_FAILURE"],
    ["TIMEOUT"],
    ["UNSUPPORTED"],
    ["UNCATEGORIZED"],
    ["DEFENSIVE"],
  ])("does not swallow %s", (category) => {
    expect(errorIn(DRUID_ERROR_CATEGORIES[category]).isMonitoringUnavailable()).toBe(false);
  });

  // A cluster that never answered has told us nothing about the surface, so a
  // monitoring read must surface the outage rather than render an empty panel.
  test("does not swallow a failure that never reached the server", () => {
    expect(new DruidTransportError("The operation was aborted").isMonitoringUnavailable()).toBe(false);
  });
});

// ============================================================================
// The seam contract
// ============================================================================

describe("the DruidTransport contract", () => {
  /** A transport built out of nothing but the neutral types, proving they suffice. */
  class RecordingTransport implements DruidTransport {
    readonly kind = "http" as const;
    readonly calls: { sql: string; opts?: DruidQueryOptions }[] = [];
    closed = false;

    constructor(private readonly result: DruidQueryResult) {}

    async query(sql: string, opts?: DruidQueryOptions): Promise<DruidQueryResult> {
      this.calls.push({ sql, opts });
      return this.result;
    }

    async close(): Promise<void> {
      this.closed = true;
    }
  }

  const rows: DruidRow[] = [{ __time: "2026-08-03T14:36:44.356Z", id: "9007199254740993", ok: true }];

  const result: DruidQueryResult = {
    rows,
    fieldNames: ["__time", "id", "ok"],
    // Spec section 2: the SQL type is what the grid labels a column with, and it
    // is the only one of the two that is right here.
    sqlTypes: { __time: "TIMESTAMP", id: "BIGINT", ok: "BOOLEAN" },
    nativeTypes: { __time: "LONG", id: "LONG", ok: "LONG" },
    executionTimeMs: 7,
    // A whole answer: the source reported that no segment was out of reach.
    unavailableSegments: 0,
  };

  test("a result describes its rows, their order and both type vocabularies", async () => {
    const transport = new RecordingTransport(result);

    const received = await transport.query('SELECT __time, id, ok FROM "libredb_demo"');

    expect(transport.kind).toBe("http");
    expect(received.rows).toEqual(rows);
    expect(received.fieldNames).toEqual(["__time", "id", "ok"]);
    expect(received.executionTimeMs).toBe(7);
  });

  // Spec section 2, live-verified: the native type LIES for exactly these two
  // cases, which is why both maps exist rather than one.
  test("keeps the native type even where it disagrees with the SQL type", () => {
    expect(result.sqlTypes?.__time).toBe("TIMESTAMP");
    expect(result.nativeTypes?.__time).toBe("LONG");
    expect(result.sqlTypes?.ok).toBe("BOOLEAN");
    expect(result.nativeTypes?.ok).toBe("LONG");
  });

  /**
   * Spec section 2, live-verified on 37.0.0:
   *   SELECT 1 AS c, 2 AS c  ->  [["c","c"],["LONG","LONG"],["INTEGER","INTEGER"],[1,2]]
   * Rows are records, so the seam requires the implementation to disambiguate
   * before it builds them - the second column would otherwise be gone before the
   * seam, not after it. The spelling below is illustrative; the invariant the
   * seam states is that `fieldNames` is unique and is the key set of every row,
   * which is also what keeps the two type maps lossless.
   */
  test("a duplicated output name survives as two distinct columns", async () => {
    const names = ["c", "c (2)"];
    const duplicated: DruidQueryResult = {
      rows: [{ c: 1, "c (2)": 2 }],
      fieldNames: names,
      sqlTypes: { c: "INTEGER", "c (2)": "INTEGER" },
      nativeTypes: { c: "LONG", "c (2)": "LONG" },
      executionTimeMs: 2,
      unavailableSegments: 0,
    };
    const transport = new RecordingTransport(duplicated);

    const received = await transport.query("SELECT 1 AS c, 2 AS c");

    expect(received.fieldNames).toEqual(names);
    expect(new Set(names).size).toBe(2);
    // Both columns are reachable, and each type map still describes both.
    expect(names.map((name) => received.rows[0][name])).toEqual([1, 2]);
    expect(Object.keys(received.sqlTypes ?? {})).toEqual(names);
    expect(Object.keys(received.nativeTypes ?? {})).toEqual(names);
  });

  // Nothing in the endpoint's answer describes the columns of an EXPLAIN-free
  // failure-adjacent shape, and a proxy may rewrite the body, so both maps and
  // the order are nullable together rather than degrading to fabricated names.
  test("a result the source could not describe carries nulls, not guesses", async () => {
    const transport = new RecordingTransport({
      rows: [],
      fieldNames: null,
      sqlTypes: null,
      nativeTypes: null,
      executionTimeMs: 1,
      unavailableSegments: null,
    });

    const received = await transport.query("SELECT 1");

    expect(received.rows).toEqual([]);
    expect(received.fieldNames).toBeNull();
    expect(received.sqlTypes).toBeNull();
    expect(received.nativeTypes).toBeNull();
  });

  /**
   * Issue #273: Druid answers a query it could only partly serve with an ordinary
   * success, so the count is the only evidence the rows are incomplete. Zero and
   * null are different claims - "the source confirmed a whole answer" against "the
   * source said nothing" - and only the first one licenses trusting the row set.
   */
  test("a partial answer counts the unreachable segments, and a silent source stays null", async () => {
    const partial = new RecordingTransport({ ...result, unavailableSegments: 2 });
    const silent = new RecordingTransport({ ...result, unavailableSegments: null });

    expect((await partial.query("SELECT 1")).unavailableSegments).toBe(2);
    expect((await silent.query("SELECT 1")).unavailableSegments).toBeNull();
    expect(result.unavailableSegments).toBe(0);
  });

  // Spec sections 6 and 13: the two deadlines are independent halves, and
  // positional parameters really execute on Druid, so unlike ClickHouse the seam
  // carries them instead of rejecting them.
  test("options carry both deadlines and positional parameters", async () => {
    const transport = new RecordingTransport(result);

    await transport.query('SELECT id FROM "libredb_demo" WHERE region = ?', {
      timeoutMs: 30_000,
      clientDeadlineMs: 35_000,
      parameters: ["emea", 5, 1.5, true, null, new Date(0)],
    });

    expect(transport.calls).toEqual([
      {
        sql: 'SELECT id FROM "libredb_demo" WHERE region = ?',
        opts: {
          timeoutMs: 30_000,
          clientDeadlineMs: 35_000,
          parameters: ["emea", 5, 1.5, true, null, new Date(0)],
        },
      },
    ]);
  });

  test("close is part of the contract even when a transport holds nothing open", async () => {
    const transport = new RecordingTransport(result);

    await transport.close();

    expect(transport.closed).toBe(true);
  });
});

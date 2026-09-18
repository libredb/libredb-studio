import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  createBunSQLiteDriver,
  createNodeSQLiteDriver,
  loadNodeSQLiteDriver,
  loadSQLiteDriver,
  normalizeSQLiteBigInt,
  resolveSQLiteDriverName,
  toSQLiteBindValue,
  type BunSQLiteOpenOptions,
  type NodeDatabaseSyncLike,
  type NodeSQLiteModule,
  type SQLiteDatabase,
  type SQLiteStatement,
} from "@/lib/db/providers/sql/sqlite-driver";

/** In-memory stand-in for node:sqlite's DatabaseSync (Bun cannot import the real one). */
class StubDatabaseSync implements NodeDatabaseSyncLike {
  static lastInstance: StubDatabaseSync | undefined;
  readonly path: string;
  readonly options: { readOnly?: boolean; readBigInts?: boolean } | undefined;
  readonly calls: string[] = [];
  /** node:sqlite's own transaction flag; the adapter republishes it as `inTransaction`. */
  isTransaction = false;

  constructor(path: string, options?: { readOnly?: boolean; readBigInts?: boolean }) {
    this.path = path;
    this.options = options;
    StubDatabaseSync.lastInstance = this;
  }

  exec(sql: string): void {
    this.calls.push(`exec:${sql}`);
  }

  prepare(sql: string) {
    this.calls.push(`prepare:${sql}`);
    if (sql === "SELECT bigints") {
      return bigIntStatement();
    }
    return {
      all: (...params: unknown[]) => [{ sql, params }],
      get: (...params: unknown[]) => (params[0] === "miss" ? undefined : { sql, first: params[0] }),
      run: (...params: unknown[]) => ({ changes: params[0] === "bigint" ? BigInt(3) : 1 }),
    };
  }

  close(): void {
    this.calls.push("close");
  }
}

/**
 * What a driver hands back once its big-integer flag is on: every integer is a BigInt,
 * the huge id and the `1` alike. Shared by both adapters' stand-ins so the two are held
 * to the same answer.
 *
 * Written `BigInt("...")` rather than as `123n` literals because this repo's tsconfig
 * target is below ES2020, which rejects the literal form outright.
 */
function bigIntStatement() {
  const row = () => ({ small: BigInt("1"), huge: BigInt("9007199254740993"), text: "x", nothing: null });
  return {
    all: () => [row()],
    get: () => row(),
    run: () => ({ changes: BigInt("2"), lastInsertRowid: BigInt("9007199254740993") }),
  };
}

/** In-memory stand-in for bun:sqlite's Database. */
class StubBunDatabase implements SQLiteDatabase {
  static lastInstance: StubBunDatabase | undefined;
  readonly path: string;
  readonly options: BunSQLiteOpenOptions | undefined;
  readonly calls: string[] = [];
  inTransaction = false;

  constructor(path: string, options?: BunSQLiteOpenOptions) {
    this.path = path;
    this.options = options;
    StubBunDatabase.lastInstance = this;
  }

  exec(sql: string): void {
    this.calls.push(`exec:${sql}`);
  }

  prepare(sql: string): SQLiteStatement {
    this.calls.push(`prepare:${sql}`);
    return bigIntStatement() as unknown as SQLiteStatement;
  }

  close(throwOnError?: boolean): void {
    this.calls.push(`close:${throwOnError === true}`);
  }
}

const stubModule: NodeSQLiteModule = { DatabaseSync: StubDatabaseSync };

describe("sqlite-driver", () => {
  let origDriver: string | undefined;

  beforeEach(() => {
    origDriver = process.env.LIBREDB_SQLITE_DRIVER;
  });

  afterEach(() => {
    if (origDriver === undefined) delete process.env.LIBREDB_SQLITE_DRIVER;
    else process.env.LIBREDB_SQLITE_DRIVER = origDriver;
  });

  describe("resolveSQLiteDriverName()", () => {
    test.each(["bun", "node"] as const)("honors the %s override", (name) => {
      process.env.LIBREDB_SQLITE_DRIVER = name;
      expect(resolveSQLiteDriverName()).toBe(name);
    });

    test.each([undefined, "sqlite3", ""])("falls back to the runtime for %j", (value) => {
      if (value === undefined) delete process.env.LIBREDB_SQLITE_DRIVER;
      else process.env.LIBREDB_SQLITE_DRIVER = value;
      // Tests run under Bun, so the runtime pick is always "bun" here.
      expect(resolveSQLiteDriverName()).toBe("bun");
    });
  });

  describe("createNodeSQLiteDriver() adapter semantics", () => {
    test("bridges exec/prepare/close", () => {
      const Driver = createNodeSQLiteDriver(StubDatabaseSync);
      const db = new Driver("/tmp/adapter.db", { create: true, readwrite: true });
      const stub = StubDatabaseSync.lastInstance!;

      expect(stub.path).toBe("/tmp/adapter.db");

      db.exec("CREATE TABLE t (id)");
      expect(stub.calls).toContain("exec:CREATE TABLE t (id)");

      const stmt = db.prepare("SELECT * FROM t WHERE id = ?");
      expect(stmt.all(7)).toEqual([{ sql: "SELECT * FROM t WHERE id = ?", params: [7] }]);

      db.close();
      expect(stub.calls).toContain("close");
    });

    // #42: the digits the read prints go back in as the integer they came from, on all
    // three methods. The stub echoes its params, which is what makes the bind observable
    // without a database.
    test("sends the digits of a 64-bit integer back as that integer, and leaves other strings alone", () => {
      const Driver = createNodeSQLiteDriver(StubDatabaseSync);
      const stmt = new Driver("/tmp/adapter.db").prepare("SELECT * FROM t WHERE id = ?");

      expect(stmt.all("9007199254740993", "007", 7, null)).toEqual([
        { sql: "SELECT * FROM t WHERE id = ?", params: [BigInt("9007199254740993"), "007", 7, null] },
      ]);
      // get() takes the same route, and the stub echoes its parameter into a top-level
      // cell - where the OUTBOUND conversion prints it straight back. The digits in and
      // the digits out are the round trip itself, closed at one seam; that the value
      // was an integer while SQLite compared it is asserted against the real drivers
      // below, on a column with no affinity, where nothing else could match.
      expect(stmt.get("9007199254740993")).toEqual({
        sql: "SELECT * FROM t WHERE id = ?",
        first: "9007199254740993",
      });
      // run() takes the same route: "bigint" is the stub's own sentinel, not a conversion.
      expect(stmt.run("bigint")).toEqual({ changes: 3 });
    });

    test("get() maps node:sqlite's undefined miss to bun:sqlite's null", () => {
      const Driver = createNodeSQLiteDriver(StubDatabaseSync);
      const stmt = new Driver("/tmp/adapter.db").prepare("SELECT 1");

      expect(stmt.get("hit")).toEqual({ sql: "SELECT 1", first: "hit" });
      expect(stmt.get("miss")).toBeNull();
    });

    test("run() normalizes bigint change counts to number", () => {
      const Driver = createNodeSQLiteDriver(StubDatabaseSync);
      const stmt = new Driver("/tmp/adapter.db").prepare("DELETE FROM t");

      expect(stmt.run("bigint")).toEqual({ changes: 3 });
      expect(stmt.run("number")).toEqual({ changes: 1 });
    });

    // The read-only open flag is the SQLite half of the agent execution
    // profile's security boundary (#328). The two runtimes spell it
    // differently — bun `readonly`, node `readOnly` — so an adapter that
    // forwards nothing (or forwards the bun spelling verbatim) would hand the
    // agent a fully writable handle. These pin the mapping at the seam; the
    // node harness in tests/integration/db proves the real driver honors it.
    test("maps the read-only open flag onto node:sqlite's readOnly option", () => {
      const Driver = createNodeSQLiteDriver(StubDatabaseSync);
      new Driver("/tmp/agent.db", { readonly: true });

      expect(StubDatabaseSync.lastInstance!.options).toEqual({ readOnly: true, readBigInts: true });
    });

    test("opens read-write when no read-only flag is given (the shared editor path)", () => {
      const Driver = createNodeSQLiteDriver(StubDatabaseSync);
      new Driver("/tmp/editor.db", { create: true, readwrite: true });

      expect(StubDatabaseSync.lastInstance!.options).toEqual({ readOnly: false, readBigInts: true });
    });

    // node:sqlite spells it `isTransaction` and bun:sqlite spells it `inTransaction`,
    // and the provider reads only the bun spelling. An adapter that forwarded nothing
    // here would report every handle as clean, so a transaction a statement left open
    // would never be found and would reach the next request (D71).
    test("republishes node:sqlite's isTransaction under bun:sqlite's inTransaction", () => {
      const Driver = createNodeSQLiteDriver(StubDatabaseSync);
      const db = new Driver("/tmp/tx.db");
      const stub = StubDatabaseSync.lastInstance!;

      expect(db.inTransaction).toBe(false);
      stub.isTransaction = true;
      expect(db.inTransaction).toBe(true);
    });
  });

  test("loadNodeSQLiteDriver() builds the adapter from an injected module", async () => {
    const Driver = await loadNodeSQLiteDriver(async () => stubModule);
    const db = new Driver("/tmp/injected.db");

    expect(StubDatabaseSync.lastInstance!.path).toBe("/tmp/injected.db");
    db.close();
  });

  test("loadNodeSQLiteDriver() falls back to the real node:sqlite import", async () => {
    // Bun implements node:sqlite from 1.4.0, at or below the 1.4.2 this repo pins, so the default
    // importer resolves in-process instead of throwing, and this is the first time the
    // adapter can be driven against the REAL DatabaseSync rather than a stand-in. On Bun
    // 1.3.14 only the injected path above was reachable here.
    const Driver = await loadNodeSQLiteDriver();
    const db = new Driver(":memory:");

    db.exec("CREATE TABLE t (a INTEGER)");
    db.prepare("INSERT INTO t VALUES (?)").run(7);

    // The three bridges the adapter promises, against the real module: get() maps a miss
    // to null (node returns undefined), run() narrows bigint changes to number, and all()
    // hands back plain rows.
    expect(db.prepare("SELECT a FROM t").all()).toEqual([{ a: 7 }]);
    expect(db.prepare("SELECT a FROM t WHERE a = ?").get(999)).toBeNull();
    expect(db.prepare("DELETE FROM t").run()).toEqual({ changes: 1 });

    db.close();
  });

  // ==========================================================================
  // 64-bit integers (#39)
  // ==========================================================================

  describe("64-bit integers", () => {
    test("normalizeSQLiteBigInt() keeps numbers where that is lossless and digits where it is not", () => {
      expect(normalizeSQLiteBigInt(BigInt("0"))).toBe(0);
      expect(normalizeSQLiteBigInt(BigInt("1"))).toBe(1);
      expect(normalizeSQLiteBigInt(BigInt("-1"))).toBe(-1);
      // The exact edges of the safe range are still numbers.
      expect(normalizeSQLiteBigInt(BigInt("9007199254740991"))).toBe(9007199254740991);
      expect(normalizeSQLiteBigInt(BigInt("-9007199254740991"))).toBe(-9007199254740991);
      // One past them has no exact number, so it keeps its digits instead.
      expect(normalizeSQLiteBigInt(BigInt("9007199254740992"))).toBe("9007199254740992");
      expect(normalizeSQLiteBigInt(BigInt("9007199254740993"))).toBe("9007199254740993");
      expect(normalizeSQLiteBigInt(BigInt("-9007199254740993"))).toBe("-9007199254740993");
      expect(normalizeSQLiteBigInt(BigInt("9223372036854775807"))).toBe("9223372036854775807");
    });

    // The flag is the half of the fix the drivers provide; each spells it its own way,
    // and an adapter that forwarded neither would leave the rounding in place.
    test("opens bun:sqlite with safeIntegers and node:sqlite with readBigInts", () => {
      const BunDriver = createBunSQLiteDriver(StubBunDatabase);
      new BunDriver("/tmp/bigint.db", { create: true, readwrite: true });
      expect(StubBunDatabase.lastInstance!.options).toEqual({
        create: true,
        readwrite: true,
        safeIntegers: true,
      });

      const NodeDriver = createNodeSQLiteDriver(StubDatabaseSync);
      new NodeDriver("/tmp/bigint.db");
      expect(StubDatabaseSync.lastInstance!.options).toEqual({ readOnly: false, readBigInts: true });
    });

    test.each([
      // bun:sqlite publishes `lastInsertRowid` and it is a rowid, so it can be 64-bit too;
      // the node adapter narrows its result to `changes` before this seam sees it.
      ["bun", () => createBunSQLiteDriver(StubBunDatabase), { changes: 2, lastInsertRowid: "9007199254740993" }],
      ["node", () => createNodeSQLiteDriver(StubDatabaseSync), { changes: 2 }],
    ] as const)("the %s adapter converts every BigInt a statement returns", (_name, makeDriver, expectedRun) => {
      const stmt = new (makeDriver())("/tmp/bigint.db").prepare("SELECT bigints");

      // all(): rows out of a plain query.
      expect(stmt.all()).toEqual([{ small: 1, huge: "9007199254740993", text: "x", nothing: null }]);
      // get(): the single-row reads the schema, PRAGMA and monitoring paths use.
      expect(stmt.get()).toEqual({ small: 1, huge: "9007199254740993", text: "x", nothing: null });
      // run(): the write path's own result object.
      expect(stmt.run()).toEqual(expectedRun);
    });

    test.each([
      ["bun", () => createBunSQLiteDriver(StubBunDatabase)],
      ["node", () => createNodeSQLiteDriver(StubDatabaseSync)],
    ] as const)("the %s adapter lets no BigInt reach JSON.stringify", (_name, makeDriver) => {
      const stmt = new (makeDriver())("/tmp/bigint.db").prepare("SELECT bigints");

      for (const row of stmt.all() as Record<string, unknown>[]) {
        for (const value of Object.values(row)) {
          expect(typeof value).not.toBe("bigint");
        }
      }
      expect(() => JSON.stringify(stmt.all())).not.toThrow();
    });

    /**
     * The same reading, against whichever REAL driver is handed in. Before the fix
     * bun:sqlite answered 9007199254740992 for both rows and node:sqlite threw
     * ERR_OUT_OF_RANGE on the first of them.
     */
    function assertReadsSixtyFourBitIds(Driver: Awaited<ReturnType<typeof loadSQLiteDriver>>): void {
      const db = new Driver(":memory:", { create: true, readwrite: true });
      try {
        db.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, label TEXT)");
        db.exec("INSERT INTO big VALUES (9007199254740992, 'neighbour'), (9007199254740993, 'target')");

        expect(db.prepare("SELECT id, label FROM big ORDER BY id").all()).toEqual([
          { id: "9007199254740992", label: "neighbour" },
          { id: "9007199254740993", label: "target" },
        ]);
        // and the ordinary integers the all-or-nothing flag would otherwise have taken with it
        expect(db.prepare("SELECT COUNT(*) AS count FROM big").get()).toEqual({ count: 2 });
        expect(db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
      } finally {
        db.close(true);
      }
    }

    /**
     * #42, against whichever REAL driver is handed in: the column has NO affinity, so
     * SQLite compares the operands as they stand and the digits the read printed used to
     * match nothing at all. Run on both drivers because the bind is the driver's own call.
     */
    function assertEditsSixtyFourBitIdOnANoAffinityColumn(Driver: Awaited<ReturnType<typeof loadSQLiteDriver>>): void {
      const db = new Driver(":memory:", { create: true, readwrite: true });
      try {
        db.exec("CREATE TABLE k (id, label TEXT)");
        db.exec("INSERT INTO k VALUES (9007199254740992, 'neighbour'), (9007199254740993, 'target')");

        const target = db.prepare("SELECT id FROM k WHERE label = 'target'").get() as { id: unknown };
        expect(target.id).toBe("9007199254740993");

        // get() and all() bind it too, so the row can be READ back by its own key.
        expect(db.prepare("SELECT label FROM k WHERE id = ?").get(target.id)).toEqual({ label: "target" });
        expect(db.prepare("SELECT label FROM k WHERE id = ?").all(target.id)).toEqual([{ label: "target" }]);

        expect(db.prepare("UPDATE k SET label = 'edited' WHERE id = ?").run(target.id)).toMatchObject({ changes: 1 });
        expect(db.prepare("SELECT id, label FROM k ORDER BY id").all()).toEqual([
          { id: "9007199254740992", label: "neighbour" },
          { id: "9007199254740993", label: "edited" },
        ]);
      } finally {
        db.close(true);
      }
    }

    test("the real bun:sqlite driver edits a 64-bit id on a column with no affinity", async () => {
      process.env.LIBREDB_SQLITE_DRIVER = "bun";
      assertEditsSixtyFourBitIdOnANoAffinityColumn(await loadSQLiteDriver());
    });

    test("the real node:sqlite driver edits a 64-bit id on a column with no affinity", async () => {
      assertEditsSixtyFourBitIdOnANoAffinityColumn(await loadNodeSQLiteDriver());
    });

    test("the real bun:sqlite driver reads a 64-bit id back whole", async () => {
      process.env.LIBREDB_SQLITE_DRIVER = "bun";
      assertReadsSixtyFourBitIds(await loadSQLiteDriver());
    });

    // Built through loadNodeSQLiteDriver rather than loadSQLiteDriver on purpose:
    // loadSQLiteDriver caches per driver NAME, and the failure test below needs "node"
    // uncached. This still drives the real node:sqlite module (Bun implements it from
    // 1.4.0), which is the driver that used to throw ERR_OUT_OF_RANGE here.
    test("the real node:sqlite driver reads a 64-bit id back whole", async () => {
      assertReadsSixtyFourBitIds(await loadNodeSQLiteDriver());
    });
  });

  describe("loadSQLiteDriver()", () => {
    test("returns the cached constructor on repeat loads", async () => {
      process.env.LIBREDB_SQLITE_DRIVER = "bun";
      const first = await loadSQLiteDriver();
      const second = await loadSQLiteDriver();
      expect(second).toBe(first);
    });

    // This asserted the failure path by relying on the runtime NOT implementing
    // node:sqlite, and skipped itself when the import resolved. Bun 1.4.0 implements it,
    // so on the pinned runtime the test passed while the whole catch below went
    // unexercised - a green test and an eight-line hole in a 100% gate. The loader is
    // injected instead, the way `loadNodeSQLiteDriver` already injects its importer, so
    // the arm is a property of this test rather than of whichever Bun is installed.
    test("wraps a driver that cannot load in DatabaseConfigError and caches the failure", async () => {
      process.env.LIBREDB_SQLITE_DRIVER = "node";

      const firstError = await loadSQLiteDriver(() => Promise.reject(new Error("node:sqlite is not available"))).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(firstError).toBeInstanceOf(DatabaseConfigError);
      expect((firstError as Error).message).toContain('SQLite driver "node" is not available');
      // The underlying reason is carried, not swallowed.
      expect((firstError as Error).message).toContain("node:sqlite is not available");

      // The cached failure is rethrown without consulting the loader a second time.
      let secondAttempts = 0;
      const secondError = await loadSQLiteDriver(() => {
        secondAttempts += 1;
        return Promise.reject(new Error("must not be reached"));
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(secondError).toBe(firstError);
      expect(secondAttempts).toBe(0);
    });
  });
});

// ============================================================================
// Independent verification of the #39 boundary (added by the verifying pass)
//
// The two mutations the fix is most likely to suffer are "always Number()" (which
// silently reintroduces the rounding) and "always toString()" (which turns `1` and
// COUNT(*) into text). Neither is caught by an example-based assertion alone, so the
// two properties are asserted directly over the whole 64-bit range.
// ============================================================================

describe("normalizeSQLiteBigInt() boundary, independently", () => {
  /** Where the switch is: MAX_SAFE_INTEGER inclusive, one past it exclusive. */
  const EDGES: [string, number | string][] = [
    ["9007199254740990", 9007199254740990],
    ["9007199254740991", 9007199254740991], // 2^53 - 1 = Number.MAX_SAFE_INTEGER
    ["9007199254740992", "9007199254740992"], // 2^53 exactly - representable, still stringified
    ["9007199254740993", "9007199254740993"], // 2^53 + 1 - no exact number exists
    ["-9007199254740991", -9007199254740991], // Number.MIN_SAFE_INTEGER
    ["-9007199254740992", "-9007199254740992"], // -2^53 exactly
    ["-9007199254740993", "-9007199254740993"],
    ["9223372036854775807", "9223372036854775807"], // INT64 max
    ["-9223372036854775808", "-9223372036854775808"], // INT64 min
  ];

  test.each(EDGES)("%s converts to the expected shape", (digits, expected) => {
    expect(normalizeSQLiteBigInt(BigInt(digits))).toEqual(expected);
  });

  // Kills "always toString()": everything inside the safe range must stay a number.
  test("never stringifies a value the safe range holds", () => {
    for (const value of [0, 1, -1, 2, 1000, 2 ** 31, -(2 ** 31), 9007199254740990, 9007199254740991]) {
      const converted = normalizeSQLiteBigInt(BigInt(String(value)));
      expect(typeof converted).toBe("number");
      expect(converted).toBe(value);
    }
  });

  // Kills "always Number()": no conversion may lose a digit. Every answer, number or
  // string, must read back as the exact BigInt it came from.
  test("never loses a digit, whichever shape it picks", () => {
    const samples = [
      "0",
      "1",
      "-1",
      "9007199254740991",
      "9007199254740992",
      "9007199254740993",
      "9007199254740994",
      "-9007199254740993",
      "1234567890123456789",
      "9223372036854775807",
      "-9223372036854775808",
    ];
    for (const digits of samples) {
      const converted = normalizeSQLiteBigInt(BigInt(digits));
      expect(BigInt(converted)).toBe(BigInt(digits));
      expect(typeof converted === "number" || typeof converted === "string").toBe(true);
    }
  });
});

// ============================================================================
// The bind boundary (#42)
//
// `toSQLiteBindValue` is the inverse of `normalizeSQLiteBigInt`, so the property that
// matters is not an example: it is that the two compose to the identity over every
// 64-bit integer, and that NOTHING ELSE is converted. The two mutations it is most
// likely to suffer are "any digit string becomes a number" (which turns '007' into 7
// and breaks textual keys) and "convert nothing" (which reopens the defect), and both
// are asserted against directly below.
// ============================================================================

describe("toSQLiteBindValue()", () => {
  const CONVERTED: string[] = [
    "9007199254740992", // 2^53 exactly - the first value the read prints as digits
    "9007199254740993",
    "-9007199254740992",
    "-9007199254740993",
    "1234567890123456789",
    "9223372036854775807", // INT64 max
    "-9223372036854775808", // INT64 min
  ];

  const LEFT_ALONE: [string, string][] = [
    ["inside the safe range, where the read prints a number", "9007199254740991"],
    ["the safe range's negative edge", "-9007199254740991"],
    ["a small integer's digits", "7"],
    ["zero", "0"],
    ["a single leading zero", "007"],
    ["many leading zeros", "0009007199254740993"],
    ["a leading plus", "+9007199254740993"],
    ["a signed value with leading zeros", "-0009007199254740993"],
    ["leading space", " 9007199254740993"],
    ["trailing space", "9007199254740993 "],
    ["the empty string", ""],
    ["a lone minus", "-"],
    ["a decimal point", "9007199254740993.0"],
    ["exponent notation", "9.007199254740993e15"],
    ["hexadecimal", "0x1fffffffffffff1"],
    ["digits with a tail", "9007199254740993x"],
    ["one past INT64's maximum", "9223372036854775808"],
    ["one past INT64's minimum", "-9223372036854775809"],
    ["far wider than 64 bits", "99999999999999999999999999"],
    ["twenty digits", "12345678901234567890"],
  ];

  test.each(CONVERTED)("%s is sent back as the integer it came from", (digits) => {
    expect(toSQLiteBindValue(digits)).toBe(BigInt(digits));
  });

  test.each(LEFT_ALONE)("%s stays the string it is (%s)", (_label, value) => {
    expect(toSQLiteBindValue(value)).toBe(value);
  });

  // Kills "any digit string becomes a number": a textual key must survive untouched.
  test("converts nothing the read could not have printed", () => {
    for (const [, value] of LEFT_ALONE) {
      expect(typeof toSQLiteBindValue(value)).toBe("string");
    }
  });

  // Kills "convert nothing": everything the read prints as digits must come back.
  test("round-trips every shape normalizeSQLiteBigInt prints as digits", () => {
    const samples = [
      "9007199254740992",
      "9007199254740993",
      "-9007199254740992",
      "-9007199254740993",
      "9223372036854775807",
      "-9223372036854775808",
    ];
    for (const digits of samples) {
      const printed = normalizeSQLiteBigInt(BigInt(digits));
      expect(typeof printed).toBe("string");
      expect(toSQLiteBindValue(printed)).toBe(BigInt(digits));
    }
    // and the other direction: whatever the read prints as a NUMBER is never a string
    // this function has to answer for.
    for (const digits of ["0", "1", "-1", "9007199254740991", "-9007199254740991"]) {
      expect(typeof normalizeSQLiteBigInt(BigInt(digits))).toBe("number");
      expect(toSQLiteBindValue(digits)).toBe(digits);
    }
  });

  // Nothing that is not a string is touched, so a Uint8Array blob, a Date and a number
  // reach the driver exactly as the provider passed them.
  test("passes every non-string parameter through by identity", () => {
    const blob = new Uint8Array([1, 2, 3]);
    const date = new Date(0);
    const named = { $id: "9007199254740993" };
    for (const value of [7, -7, 1.5, true, false, null, undefined, blob, date, named, BigInt("1")]) {
      expect(toSQLiteBindValue(value)).toBe(value);
    }
  });
});

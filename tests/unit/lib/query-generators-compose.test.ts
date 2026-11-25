/**
 * Studio's SQL engine generator forms are composed when their module loads (docs/providers/CONTRACT.md, clause M-81):
 * each SQL engine's row from the generator forms its declaration authors, projected into
 * src/lib/db/engine-catalog/sql-generators.generated.ts, and Studio's SQL generator function table,
 * `SQL_GENERATOR_FUNCTIONS`, which binds each function name the declaration gives.
 *
 * tests/isolated/query-generator-parity.test.ts holds what every reader answers from the rows; this file holds the
 * composition itself: no row for an engine whose declaration states no forms, a form stated null left out, the count
 * expression as declared, each name bound at its own slot or refused by name, and every row frozen.
 */
import { describe, expect, test } from "bun:test";
import { BUNDLED_SQL_GENERATORS } from "@/lib/db/engine-catalog/sql-generators.generated";
import type { SqlGeneratorsEntry } from "@/lib/db/engine-catalog/projection";
import {
  COUCHBASE_GENERATOR_QUOTE,
  COUCHBASE_GENERATOR_SELECT,
  COUCHBASE_GENERATOR_TABLE,
} from "@/lib/db/providers/document/couchbase/generators";
import { DRUID_GENERATOR_QUOTE } from "@/lib/db/providers/sql/druid/generators";
import { MSSQL_GENERATOR_QUOTE, MSSQL_GENERATOR_SELECT_LIST } from "@/lib/db/providers/sql/mssql-generators";
import { MYSQL_GENERATOR_QUOTE } from "@/lib/db/providers/sql/mysql-generators";
import { ORACLE_GENERATOR_QUOTE, ORACLE_GENERATOR_SELECT_LIST } from "@/lib/db/providers/sql/oracle-generators";
import {
  composeSqlEngineGenerators,
  SQL_ENGINE_GENERATORS,
  SQL_GENERATOR_FUNCTIONS,
  type SqlGeneratorFunctions,
  sqlEngineGenerators,
} from "@/lib/db/query-generators";
import type { DatabaseType } from "@/lib/types";

const IDS = Object.keys(BUNDLED_SQL_GENERATORS) as DatabaseType[];

/** The engines whose declaration states generator forms of their own, in id order. */
const STATED = IDS.filter((id) => BUNDLED_SQL_GENERATORS[id] !== null);

/** Whether `value` is frozen with every object under it, a function left as it is. */
function frozenThrough(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(frozenThrough);
}

/** The stated entry of `id`, or a thrown error where its declaration states no forms. */
function stated(id: DatabaseType): NonNullable<SqlGeneratorsEntry> {
  const entry = BUNDLED_SQL_GENERATORS[id];
  if (entry === null) throw new Error(`${id}'s declaration states no SQL generator forms`);
  return entry;
}

/** Each slot kind of the table, with the name an entry gives at that slot, or null where it fills none. */
const SLOT_NAMES: Readonly<Record<keyof SqlGeneratorFunctions, (entry: SqlGeneratorsEntry) => string | null>> = {
  quotes: (entry) => entry?.quote ?? null,
  tables: (entry) => entry?.table ?? null,
  selects: (entry) => entry?.select ?? null,
  selectLists: (entry) => entry?.selectList ?? null,
};

/** Each slot kind of the table, with the function a composed row holds at that slot. */
const ROW_FUNCTIONS: Readonly<Record<keyof SqlGeneratorFunctions, (id: DatabaseType) => unknown>> = {
  quotes: (id) => SQL_ENGINE_GENERATORS[id]?.quote,
  tables: (id) => SQL_ENGINE_GENERATORS[id]?.table,
  selects: (id) => SQL_ENGINE_GENERATORS[id]?.select,
  selectLists: (id) => SQL_ENGINE_GENERATORS[id]?.selectList,
};

describe("Studio's SQL engine generator forms, composed from the declarations", () => {
  test("each SQL engine's generator row is its declaration's forms composed with Studio's SQL generator function table", () => {
    expect(Object.keys(SQL_ENGINE_GENERATORS)).toEqual(STATED);
    expect(STATED).toEqual(["couchbase", "druid", "mssql", "mysql", "oracle"]);
    for (const id of STATED) {
      const row = SQL_ENGINE_GENERATORS[id];
      expect({ id, row }).toEqual({ id, row: composeSqlEngineGenerators(id, stated(id), SQL_GENERATOR_FUNCTIONS) });
      expect(sqlEngineGenerators(id)).toBe(row);
    }
    expect(SQL_ENGINE_GENERATORS.couchbase).toEqual({
      quote: COUCHBASE_GENERATOR_QUOTE,
      table: COUCHBASE_GENERATOR_TABLE,
      select: COUCHBASE_GENERATOR_SELECT,
      countExpression: "COUNT(*)",
    });
    expect(SQL_ENGINE_GENERATORS.mssql).toEqual({
      quote: MSSQL_GENERATOR_QUOTE,
      selectList: MSSQL_GENERATOR_SELECT_LIST,
      countExpression: "COUNT_BIG(*)",
    });
  });

  test("an engine whose declaration states no generator forms has no row", () => {
    const none = IDS.filter((id) => BUNDLED_SQL_GENERATORS[id] === null);
    expect(none.length).toBeGreaterThan(30);
    expect(none.filter((id) => Object.hasOwn(SQL_ENGINE_GENERATORS, id))).toEqual([]);
    expect(sqlEngineGenerators("postgres")).toBeUndefined();
    expect(sqlEngineGenerators(undefined)).toBeUndefined();
  });

  test("a form the declaration states as null is left out, and the count expression is the declared one", () => {
    expect(Object.keys(SQL_ENGINE_GENERATORS.mysql ?? {})).toEqual(["quote", "countExpression"]);
    expect(SQL_ENGINE_GENERATORS.mysql?.countExpression).toBe("COUNT(*)");
    expect(Object.keys(SQL_ENGINE_GENERATORS.oracle ?? {})).toEqual(["quote", "selectList", "countExpression"]);
    expect(Object.keys(SQL_ENGINE_GENERATORS.couchbase ?? {})).toEqual(["quote", "table", "select", "countExpression"]);
    for (const id of STATED) {
      expect({ id, count: SQL_ENGINE_GENERATORS[id]?.countExpression }).toEqual({
        id,
        count: stated(id).countExpression,
      });
    }
    // A composition of an entry stating every form null leaves every form out, and takes its count as stated.
    const bare = composeSqlEngineGenerators(
      "couchbase",
      { ...stated("couchbase"), table: null, select: null, countExpression: "COUNT_BIG(*)" },
      SQL_GENERATOR_FUNCTIONS,
    );
    expect(Object.keys(bare)).toEqual(["quote", "countExpression"]);
    expect(bare.countExpression).toBe("COUNT_BIG(*)");
  });

  test("the rows are frozen", () => {
    expect(Object.isFrozen(SQL_ENGINE_GENERATORS)).toBe(true);
    for (const id of STATED) {
      expect({ id, frozen: frozenThrough(SQL_ENGINE_GENERATORS[id]) }).toEqual({ id, frozen: true });
    }
  });

  test("a function name Studio holds none for is refused by name at its slot, a name it holds only at another slot included", () => {
    expect(() =>
      composeSqlEngineGenerators(
        "mssql",
        { ...stated("mssql"), selectList: "generatorQuote" },
        SQL_GENERATOR_FUNCTIONS,
      ),
    ).toThrow('mssql names the function "generatorQuote", which Studio holds no function for.');
    expect(() =>
      composeSqlEngineGenerators("mysql", { ...stated("mysql"), table: "generatorTable" }, SQL_GENERATOR_FUNCTIONS),
    ).toThrow('mysql names the function "generatorTable", which Studio holds no function for.');
    expect(() =>
      composeSqlEngineGenerators("mysql", { ...stated("mysql"), quote: "toString" }, SQL_GENERATOR_FUNCTIONS),
    ).toThrow('mysql names the function "toString", which Studio holds no function for.');
    // An engine whose declaration states no forms holds no function at any slot.
    expect(() =>
      composeSqlEngineGenerators(
        "postgres",
        { quote: "generatorQuote", table: null, select: null, selectList: null, countExpression: "COUNT(*)" },
        SQL_GENERATOR_FUNCTIONS,
      ),
    ).toThrow('postgres names the function "generatorQuote", which Studio holds no function for.');
  });

  test("Studio's SQL generator function table holds exactly the functions the committed declarations name, each at its own slot", () => {
    const tableNames = (table: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>) =>
      Object.fromEntries(Object.entries(table).map(([id, slots]) => [id, Object.keys(slots ?? {})]));
    expect(Object.keys(SQL_GENERATOR_FUNCTIONS)).toEqual(Object.keys(SLOT_NAMES));
    for (const kind of Object.keys(SLOT_NAMES) as (keyof SqlGeneratorFunctions)[]) {
      const named = Object.fromEntries(
        IDS.flatMap((id) => {
          const name = SLOT_NAMES[kind](BUNDLED_SQL_GENERATORS[id]);
          return name === null ? [] : [[id, [name]]];
        }),
      );
      expect({ kind, names: tableNames(SQL_GENERATOR_FUNCTIONS[kind]) }).toEqual({ kind, names: named });
      // Each row runs, at the slot, the very function the table binds there.
      for (const [id, slots] of Object.entries(SQL_GENERATOR_FUNCTIONS[kind]) as [DatabaseType, object][]) {
        expect({ kind, id, bound: ROW_FUNCTIONS[kind](id) === Object.values(slots)[0] }).toEqual({
          kind,
          id,
          bound: true,
        });
      }
    }
    // 9 bindings, every one an engine's own function.
    const bindings = Object.values(SQL_GENERATOR_FUNCTIONS).flatMap((table) => Object.keys(table));
    expect(bindings.length).toBe(9);
    expect(SQL_GENERATOR_FUNCTIONS.quotes.druid?.generatorQuote).toBe(DRUID_GENERATOR_QUOTE);
    expect(SQL_GENERATOR_FUNCTIONS.quotes.mysql?.generatorQuote).toBe(MYSQL_GENERATOR_QUOTE);
    expect(SQL_GENERATOR_FUNCTIONS.quotes.oracle?.generatorQuote).toBe(ORACLE_GENERATOR_QUOTE);
    expect(SQL_GENERATOR_FUNCTIONS.selectLists.oracle?.generatorSelectList).toBe(ORACLE_GENERATOR_SELECT_LIST);
    expect(frozenThrough(SQL_GENERATOR_FUNCTIONS)).toBe(true);
  });
});

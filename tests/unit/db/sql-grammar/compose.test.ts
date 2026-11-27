/**
 * Studio's SQL grammar is composed when its module loads (docs/providers/CONTRACT.md, clause M-78): each engine's row
 * from the SQL text its declaration authors, projected into src/lib/db/engine-catalog/sql-text.generated.ts, and
 * Studio's grammar function table, `SQL_GRAMMAR_FUNCTIONS`, which binds each name a declaration gives. A row holds no
 * redaction: the query event log reads the engine record's grant of it, composed by
 * src/lib/db/sql-grammar/statement-redaction.ts with the same table.
 *
 * The census (tests/unit/db/engine-declarations.test.ts) reads every row back to its declaration fact by fact, and the
 * golden files hold what every reader answers from the rows; this file holds the composition itself: the absent
 * readings left out, each clause compiled once, every level frozen, and each name bound at its own slot or refused by
 * name.
 */
import { describe, expect, test } from "bun:test";
import type { GrammarFacts } from "@libredb/provider-sdk/manifest";
import { BUNDLED_SQL_TEXT } from "@/lib/db/engine-catalog/sql-text.generated";
import type { SqlTextEntry } from "@/lib/db/engine-catalog/projection";
import { MONGODB_REDACTION_READER } from "@/lib/db/providers/document/mongodb/sql-grammar";
import { REDIS_REDACTION_READER } from "@/lib/db/providers/keyvalue/redis-sql-grammar";
import { POSTGRES_FORMAT_SEGMENT, POSTGRES_READ_QUOTED_QUALIFIER } from "@/lib/db/providers/sql/postgres-sql-grammar";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import {
  byCodeUnit,
  composeSqlGrammar,
  FORMATTER_LANGUAGES,
  SQL_GRAMMAR,
  SQL_GRAMMAR_FUNCTIONS,
} from "@/lib/db/sql-grammar";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import type { DatabaseType } from "@/lib/types";

const IDS = Object.keys(BUNDLED_SQL_TEXT) as DatabaseType[];

/** The facts every grammar states, which the composition never leaves out. */
const REQUIRED_FACTS = [
  "hash",
  "bracket",
  "blockComment",
  "alternateQuoting",
  "doubleSlashComment",
  "backslashAlwaysEscapes",
  "script",
  "trailingLimitClauses",
];

/** Postgres's entry with its grammar replaced by `grammar` over postgres's own. */
function postgresWith(grammar: Partial<GrammarFacts>): SqlTextEntry {
  const postgres = BUNDLED_SQL_TEXT.postgres;
  return { ...postgres, grammar: { ...postgres.grammar, ...grammar } };
}

/** Whether `value` is frozen with every object under it, a RegExp left as it is. */
function frozenThrough(value: unknown): boolean {
  if (typeof value !== "object" || value === null || value instanceof RegExp) return true;
  if (value instanceof Set) return Object.isFrozen(value);
  return Object.isFrozen(value) && Object.values(value).every(frozenThrough);
}

describe("Studio's SQL grammar, composed from the declarations", () => {
  test("each row is its declaration's SQL text composed with Studio's grammar function table, and holds no redaction", () => {
    expect(Object.keys(SQL_GRAMMAR)).toEqual(IDS);
    for (const id of IDS) {
      expect({ id, members: Object.keys(SQL_GRAMMAR[id]) }).toEqual({
        id,
        members: ["grammar", "readsSqlText", "updateTarget", "completion"],
      });
      expect({ id, row: SQL_GRAMMAR[id] }).toEqual({
        id,
        row: composeSqlGrammar(id, BUNDLED_SQL_TEXT[id], SQL_GRAMMAR_FUNCTIONS),
      });
      expect(SQL_GRAMMAR[id].readsSqlText).toBe(BUNDLED_SQL_TEXT[id].readsSqlText);
      expect([...SQL_GRAMMAR[id].updateTarget.extraQueryOpeners]).toEqual([
        ...BUNDLED_SQL_TEXT[id].updateTarget.extraQueryOpeners,
      ]);
      expect([...SQL_GRAMMAR[id].updateTarget.extraSetOperators]).toEqual([
        ...BUNDLED_SQL_TEXT[id].updateTarget.extraSetOperators,
      ]);
      expect(SQL_GRAMMAR[id].updateTarget.dashCommentNeedsSeparator).toBe(
        BUNDLED_SQL_TEXT[id].updateTarget.dashCommentNeedsSeparator,
      );
    }
  });

  test("a grammar fact at the reading its absence has is left out, and every other fact is the declaration's", () => {
    const absent = composeSqlGrammar(
      "postgres",
      postgresWith({
        tripleQuotedStrings: false,
        backtickBackslashEscapes: false,
        dollarTags: true,
        doubleQuoteBackslashEscapes: null,
        singleQuoteBackslashEscapes: null,
        rawStrings: false,
        hintsAreCode: false,
        lineCommentBackslashContinues: false,
        lineCommentEndsAtCarriageReturn: false,
        script: { blocks: "none", separatorLine: null, unit: "statement", terminatedStatements: [] },
        trailingLimitClauses: [],
        nonNumericRowBounds: [],
        confirmForms: [],
        confirmCodeForms: [],
        confirmFormsWhen: [],
        confirmExemptForms: [],
        formatterLanguage: "postgresql",
        completionWords: { keywords: [], functions: [] },
        confirmConfigKeys: null,
        explainExecutesWithAnalyze: false,
      }),
      SQL_GRAMMAR_FUNCTIONS,
    );
    expect(Object.keys(absent.grammar)).toEqual(REQUIRED_FACTS);
    expect(absent.grammar.script).toEqual({ blocks: "none", separatorLine: null, unit: "statement" });
    expect(absent.grammar.trailingLimitClauses).toEqual([]);

    const stated: Partial<GrammarFacts> = {
      tripleQuotedStrings: true,
      backtickBackslashEscapes: true,
      dollarTags: false,
      doubleQuoteBackslashEscapes: false,
      singleQuoteBackslashEscapes: true,
      rawStrings: true,
      hintsAreCode: true,
      lineCommentBackslashContinues: true,
      lineCommentEndsAtCarriageReturn: true,
      script: { blocks: "pl-sql", separatorLine: "/", unit: "batch", terminatedStatements: ["BEGIN"] },
      nonNumericRowBounds: ["ALL"],
      confirmForms: [["REPLACE", "INTO"]],
      confirmCodeForms: [{ prefix: "SYS" }],
      confirmFormsWhen: [{ form: ["ALTER", "TABLE"], when: "DROP" }],
      confirmExemptForms: [["DELETE", "FROM"]],
      formatterLanguage: "snowflake",
      completionWords: { keywords: ["QUALIFY"], functions: [] },
      confirmConfigKeys: [],
      explainExecutesWithAnalyze: true,
    };
    const composed = composeSqlGrammar("postgres", postgresWith(stated), SQL_GRAMMAR_FUNCTIONS);
    const facts = Object.fromEntries(
      Object.entries(composed.grammar).filter(([fact]) => fact !== "trailingLimitClauses"),
    );
    expect<unknown>(facts).toEqual({
      hash: "code",
      bracket: "subscript",
      blockComment: "nesting",
      alternateQuoting: false,
      doubleSlashComment: false,
      backslashAlwaysEscapes: false,
      ...stated,
    });
    // The facts in the declaration's member order: a declaration stating them in another order composes in that order.
    const reordered = Object.fromEntries(Object.entries(BUNDLED_SQL_TEXT.snowflake.grammar).reverse()) as GrammarFacts;
    const snowflake = composeSqlGrammar(
      "snowflake",
      { ...BUNDLED_SQL_TEXT.snowflake, grammar: reordered },
      SQL_GRAMMAR_FUNCTIONS,
    );
    expect(Object.keys(snowflake.grammar)).toEqual([...Object.keys(SQL_GRAMMAR.snowflake.grammar)].reverse());
  });

  test("each trailing limit clause is compiled once, when its row is composed", () => {
    const declared = BUNDLED_SQL_TEXT.postgres.grammar.trailingLimitClauses;
    const clauses = SQL_GRAMMAR.postgres.grammar.trailingLimitClauses;
    expect(clauses.map((clause) => ({ source: clause.source, flags: clause.flags }))).toEqual([...declared]);
    expect(clauses.every((clause) => clause instanceof RegExp)).toBe(true);
    // The same objects on every read, so the limiter's cache of anchored patterns compiles each once.
    expect(resolveSqlGrammar("postgres").trailingLimitClauses[0]).toBe(clauses[0]);
    expect(SQL_GRAMMAR.postgres.grammar.trailingLimitClauses).toBe(clauses);
    // A composition compiles its own.
    const again = composeSqlGrammar("postgres", BUNDLED_SQL_TEXT.postgres, SQL_GRAMMAR_FUNCTIONS);
    expect(again.grammar.trailingLimitClauses[0]).not.toBe(clauses[0]);
    expect(again.grammar.trailingLimitClauses[0]).toEqual(clauses[0]);
  });

  test("the rows, their grammars and their lists are frozen", () => {
    expect(Object.isFrozen(SQL_GRAMMAR)).toBe(true);
    for (const id of IDS) {
      const row = SQL_GRAMMAR[id];
      expect({ id, frozen: frozenThrough(row) }).toEqual({ id, frozen: true });
      expect(Object.isFrozen(row.grammar.trailingLimitClauses)).toBe(true);
    }
    // A clause is a RegExp, left unfrozen: its lastIndex is the engine's to write.
    expect(Object.isFrozen(SQL_GRAMMAR.postgres.grammar.trailingLimitClauses[0])).toBe(false);
  });

  test("a function name Studio holds none for is refused by name at its slot, a name it holds only at another slot included", () => {
    const mysql = BUNDLED_SQL_TEXT.mysql;
    expect(() =>
      composeSqlGrammar(
        "mysql",
        { ...mysql, completion: { ...mysql.completion, formatSegment: "formatSegment" } },
        SQL_GRAMMAR_FUNCTIONS,
      ),
    ).toThrow('mysql names the function "formatSegment", which Studio holds no function for.');
    const postgres = BUNDLED_SQL_TEXT.postgres;
    expect(() =>
      composeSqlGrammar(
        "postgres",
        { ...postgres, completion: { formatSegment: "readQuotedQualifier", readQuotedQualifier: null } },
        SQL_GRAMMAR_FUNCTIONS,
      ),
    ).toThrow('postgres names the function "readQuotedQualifier", which Studio holds no function for.');
  });

  test("Studio's grammar function table holds exactly the functions the committed declarations and the legacy records' granted redactions name, each at its own slot", () => {
    const named = (read: (id: DatabaseType) => string | null) =>
      Object.fromEntries(
        IDS.flatMap((id) => {
          const name = read(id);
          return name === null ? [] : [[id, [name]]];
        }),
      );
    const tableNames = (table: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>) =>
      Object.fromEntries(Object.entries(table).map(([id, slots]) => [id, Object.keys(slots ?? {})]));

    expect(Object.keys(SQL_GRAMMAR_FUNCTIONS)).toEqual([
      "redactionReaders",
      "segmentFormatters",
      "quotedQualifierReaders",
    ]);
    expect(tableNames(SQL_GRAMMAR_FUNCTIONS.redactionReaders)).toEqual(
      named((id) => {
        const redaction = servedEngineRecord(id).grants.redaction;
        return redaction.kind === "command" ? redaction.reader : null;
      }),
    );
    expect(tableNames(SQL_GRAMMAR_FUNCTIONS.segmentFormatters)).toEqual(
      named((id) => BUNDLED_SQL_TEXT[id].completion.formatSegment),
    );
    expect(tableNames(SQL_GRAMMAR_FUNCTIONS.quotedQualifierReaders)).toEqual(
      named((id) => BUNDLED_SQL_TEXT[id].completion.readQuotedQualifier),
    );
    // Each name bound to the function its module exports for that engine and slot.
    expect(SQL_GRAMMAR_FUNCTIONS.redactionReaders.mongodb?.redactionReader).toBe(MONGODB_REDACTION_READER);
    expect(SQL_GRAMMAR_FUNCTIONS.redactionReaders.redis?.redactionReader).toBe(REDIS_REDACTION_READER);
    expect(SQL_GRAMMAR_FUNCTIONS.segmentFormatters.postgres?.formatSegment).toBe(POSTGRES_FORMAT_SEGMENT);
    expect(SQL_GRAMMAR_FUNCTIONS.quotedQualifierReaders.postgres?.readQuotedQualifier).toBe(
      POSTGRES_READ_QUOTED_QUALIFIER,
    );
    expect(SQL_GRAMMAR.postgres.completion.formatSegment).toBe(POSTGRES_FORMAT_SEGMENT);
    expect(SQL_GRAMMAR.postgres.completion.readQuotedQualifier).toBe(POSTGRES_READ_QUOTED_QUALIFIER);
    expect(frozenThrough(SQL_GRAMMAR_FUNCTIONS)).toBe(true);
  });
});

describe("FORMATTER_LANGUAGES", () => {
  test("byCodeUnit orders by UTF-16 code unit, not by locale, and holds equal names equal", () => {
    expect(byCodeUnit("Z", "a")).toBe(-1);
    expect(byCodeUnit("a", "Z")).toBe(1);
    expect(byCodeUnit("mysql", "mysql")).toBe(0);
  });

  test("the formatter languages are the distinct names the rows state, in code-unit order and frozen", () => {
    const stated = new Set(IDS.map((id) => BUNDLED_SQL_TEXT[id].grammar.formatterLanguage));

    expect(new Set(FORMATTER_LANGUAGES)).toEqual(stated);
    expect(FORMATTER_LANGUAGES.length).toBe(stated.size);
    expect(FORMATTER_LANGUAGES.every((name, index) => index === 0 || FORMATTER_LANGUAGES[index - 1] < name)).toBe(true);
    expect(Object.isFrozen(FORMATTER_LANGUAGES)).toBe(true);
  });
});

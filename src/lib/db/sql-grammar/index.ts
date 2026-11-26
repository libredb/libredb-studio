/**
 * Every engine's SQL grammar row, one per type id, composed when this module loads (docs/providers/CONTRACT.md, clause
 * M-78) from two sources:
 *
 * - the SQL text each engine's declaration authors, `sqlText.readsSqlText`, `grammar`, `updateTarget` and
 *   `completion`, projected into src/lib/db/engine-catalog/sql-text.generated.ts as `BUNDLED_SQL_TEXT`;
 * - Studio's grammar function table, `SQL_GRAMMAR_FUNCTIONS`, which binds each function name a declaration gives to the
 *   function Studio's own source holds for that engine at that slot.
 *
 * A row holds no redaction: the redaction reaches the query event log only as the engine record's grant of it, from the
 * engine's register row, composed per event by ./statement-redaction.ts with this module's function table. That module
 * stays out of this one because the VS Code webview and the browser bundle this module, and the grant reader's
 * closure is one the webview's boundary refuses.
 *
 * The grammar is the declaration's facts in its member order, each fact a declaration states at the reading its absence
 * has left out (clause S-4), so a reader that reads an absent fact through `=== undefined` reads it as it always has,
 * and each trailing limit clause is compiled once, here. A declaration's grammar facts, its update target words and its
 * completion readers' names are therefore edited in its file under src/lib/db/engine-declarations and regenerated with
 * `bun run engines:generate`.
 */
import type { SqlGrammar } from "@libredb/provider-sdk/sql";
import { BUNDLED_SQL_TEXT } from "@/lib/db/engine-catalog/sql-text.generated";
import type { SqlTextEntry } from "@/lib/db/engine-catalog/projection";
import { boundFunction, type FunctionTable } from "@/lib/db/function-table";
import { MONGODB_REDACTION_READER } from "@/lib/db/providers/document/mongodb/sql-grammar";
import { REDIS_REDACTION_READER } from "@/lib/db/providers/keyvalue/redis-sql-grammar";
import { POSTGRES_FORMAT_SEGMENT, POSTGRES_READ_QUOTED_QUALIFIER } from "@/lib/db/providers/sql/postgres-sql-grammar";
import { typeIdRow } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";
import { NO_CONNECTION_SQL_GRAMMAR } from "./no-connection";
import type { CommandRedactionReader, QuotedQualifierReader, SegmentFormatter, SqlGrammarSpec } from "./types";

/**
 * Studio's grammar function table: for each slot kind a declaration or an engine's granted redaction names a function
 * at, the functions Studio's own source holds, per engine and name. A name is bound only at its own kind, so a segment
 * formatter is never run as a redaction reader.
 */
export interface SqlGrammarFunctions {
  /** A command redaction's `reader`: from a statement's text, the text the query event log keeps. */
  readonly redactionReaders: FunctionTable<CommandRedactionReader>;
  /** `completion.formatSegment`: one name segment quoted as the engine quotes it. */
  readonly segmentFormatters: FunctionTable<SegmentFormatter>;
  /** `completion.readQuotedQualifier`: the quoted qualifier a text up to a dot ends in. */
  readonly quotedQualifierReaders: FunctionTable<QuotedQualifierReader>;
}

/**
 * The functions the committed declarations and the legacy engines' granted redactions name, each the one Studio's
 * source holds for that engine at that slot: MongoDB's and Redis's command redaction readers, bound per event by
 * ./statement-redaction.ts, and PostgreSQL's completion quoting. The completion readers run in the browser, so only
 * Studio's own functions are bound here: a name this table does not hold, a package's included, is refused when the
 * grammar is composed, and where a package's completion reader runs is decided with the first package that names one
 * (docs/providers/CONTRACT.md, clause S-10). tests/unit/db/sql-grammar/compose.test.ts holds the table to exactly the
 * names the committed declarations and the legacy records' grants give.
 */
export const SQL_GRAMMAR_FUNCTIONS: SqlGrammarFunctions = Object.freeze({
  redactionReaders: Object.freeze({
    mongodb: Object.freeze({ redactionReader: MONGODB_REDACTION_READER }),
    redis: Object.freeze({ redactionReader: REDIS_REDACTION_READER }),
  }),
  segmentFormatters: Object.freeze({ postgres: Object.freeze({ formatSegment: POSTGRES_FORMAT_SEGMENT }) }),
  quotedQualifierReaders: Object.freeze({
    postgres: Object.freeze({ readQuotedQualifier: POSTGRES_READ_QUOTED_QUALIFIER }),
  }),
});

/**
 * The reading each grammar fact a declaration must state has where the SDK's `SqlGrammar` may leave it out (clause
 * S-4): a declaration states the fact at this reading, and the composition leaves it out, as the readers default it.
 * The three facts whose absence is a reading no value of their type gives are null here. The script's
 * `terminatedStatements` is left out where it is empty, beside these.
 */
const ABSENT_READINGS: Readonly<Record<string, unknown>> = Object.freeze({
  tripleQuotedStrings: false,
  backtickBackslashEscapes: false,
  dollarTags: true,
  doubleQuoteBackslashEscapes: null,
  singleQuoteBackslashEscapes: null,
  rawStrings: false,
  hintsAreCode: false,
  lineCommentBackslashContinues: false,
  lineCommentEndsAtCarriageReturn: false,
  nonNumericRowBounds: Object.freeze([]),
  confirmForms: Object.freeze([]),
  confirmCodeForms: Object.freeze([]),
  confirmFormsWhen: Object.freeze([]),
  confirmExemptForms: Object.freeze([]),
  formatterLanguage: "postgresql",
  completionWords: Object.freeze({ keywords: Object.freeze([]), functions: Object.freeze([]) }),
  confirmConfigKeys: null,
  explainExecutesWithAnalyze: false,
});

/**
 * Whether `value`, the fact `fact` as a declaration states it, is the reading its absence has. Both are data the JSON
 * of a declaration holds, so their JSON text is compared: a list in its order, a record in its member order.
 */
function atAbsentReading(fact: string, value: unknown): boolean {
  return Object.hasOwn(ABSENT_READINGS, fact) && JSON.stringify(value) === JSON.stringify(ABSENT_READINGS[fact]);
}

/** A declared script as the grammar reads it: its `terminatedStatements` left out where it is empty, frozen. */
function scriptOf(script: SqlTextEntry["grammar"]["script"]): SqlGrammar["script"] {
  const { blocks, separatorLine, unit, terminatedStatements } = script;
  return Object.freeze({
    blocks,
    separatorLine,
    unit,
    ...(terminatedStatements.length === 0 ? {} : { terminatedStatements }),
  });
}

/** The declared trailing limit clauses, each compiled from its source and flags, in a frozen list. */
function clausesOf(clauses: SqlTextEntry["grammar"]["trailingLimitClauses"]): SqlGrammar["trailingLimitClauses"] {
  return Object.freeze(clauses.map(({ source, flags }) => new RegExp(source, flags)));
}

/**
 * The grammar `facts` declare, in their member order: each fact at the reading its absence has left out, the script
 * and the clauses read by `scriptOf` and `clausesOf`, and every other fact as declared. The facts are the SDK's
 * `GrammarFacts`, one member per member of `SqlGrammar`, so the record built here is a `SqlGrammar`. It reads no row
 * keyed by an engine, so the server catalog composes an admitted package's engine's grammar with it too
 * (src/lib/db/server-catalog-compose.ts).
 */
export function grammarFromFacts(facts: SqlTextEntry["grammar"]): SqlGrammar {
  const grammar: Record<string, unknown> = {};
  for (const [fact, value] of Object.entries(facts)) {
    if (fact === "script") grammar.script = scriptOf(facts.script);
    else if (fact === "trailingLimitClauses") grammar.trailingLimitClauses = clausesOf(facts.trailingLimitClauses);
    else if (!atAbsentReading(fact, value)) grammar[fact] = value;
  }
  return Object.freeze(grammar) as unknown as SqlGrammar;
}

/**
 * Engine `id`'s grammar row, composed from `entry`, its projected SQL text, and `functions`: the grammar by
 * `grammarFromFacts`; `readsSqlText` as declared; the update target's flag and its two word lists as sets in the
 * declared order; and each completion reader bound through `functions` or null. The row holds no redaction. The row and
 * every record in it are frozen, a trailing limit clause apart, whose `lastIndex` is the engine's to write.
 *
 * @throws {Error} Naming the engine and the name, for a function name `functions` holds none for at its slot, a name it
 * holds only at another slot included.
 */
export function composeSqlGrammar(
  id: DatabaseType,
  entry: SqlTextEntry,
  functions: SqlGrammarFunctions,
): SqlGrammarSpec {
  const { updateTarget, completion } = entry;
  return Object.freeze({
    grammar: grammarFromFacts(entry.grammar),
    readsSqlText: entry.readsSqlText,
    updateTarget: Object.freeze({
      dashCommentNeedsSeparator: updateTarget.dashCommentNeedsSeparator,
      extraQueryOpeners: Object.freeze(new Set(updateTarget.extraQueryOpeners)),
      extraSetOperators: Object.freeze(new Set(updateTarget.extraSetOperators)),
    }),
    completion: Object.freeze({
      formatSegment:
        completion.formatSegment === null
          ? null
          : boundFunction(id, functions.segmentFormatters, completion.formatSegment),
      readQuotedQualifier:
        completion.readQuotedQualifier === null
          ? null
          : boundFunction(id, functions.quotedQualifierReaders, completion.readQuotedQualifier),
    }),
  });
}

/**
 * Every engine's grammar row, composed when this module loads from `BUNDLED_SQL_TEXT` and Studio's grammar function
 * table, so a committed module naming a function Studio holds none for fails every importer by that sentence. Keyed
 * in the projection's ascending id order, and total over `DatabaseType`, since the generated record is typed over it.
 */
export const SQL_GRAMMAR: Readonly<Record<DatabaseType, SqlGrammarSpec>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(BUNDLED_SQL_TEXT) as DatabaseType[]).map((id) => [
      id,
      composeSqlGrammar(id, BUNDLED_SQL_TEXT[id], SQL_GRAMMAR_FUNCTIONS),
    ]),
  ) as Record<DatabaseType, SqlGrammarSpec>,
);

/**
 * The grammar facts of a type: `NO_CONNECTION_SQL_GRAMMAR` for `undefined`, and its row for a type id, read through
 * `typeIdRow`, so any other value, a `String` object such as `new String("mysql")` from a host calling in plain
 * JavaScript included, is refused by name and a prototype key never reaches an `Object.prototype` member.
 *
 * @throws {UnknownProviderError} When `type` is defined and not a type id: a string that names no provider, `""`,
 * `null`, or a value that is not text.
 */
export function sqlGrammarFor(type: string | undefined): SqlGrammarSpec {
  if (type === undefined) return NO_CONNECTION_SQL_GRAMMAR;
  return typeIdRow(SQL_GRAMMAR, type);
}

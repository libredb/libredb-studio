import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * Apache Spark SQL, 4.1 and later. The lexical facts are read off Spark's lexer and parser at tag v4.2.0
 * (`SqlBaseLexer.g4`, `SqlBaseParser.g4`); the comment facts were measured on Spark 4.2.0.
 *
 * Three readings the shared reader does not follow: a backslash before a line feed continues a Spark literal, which the
 * reader leaves unterminated (the fail-safe direction: the statement loses its bound and the gate asks); Spark counts
 * Unicode spaces as white space where the reader counts ASCII only; and Spark reads an address written without quotes
 * (`a://b`, the URI form of IDENTIFIER) as one token where the reader can start a comment or a raw string inside it.
 * The provider refuses the last two before any call. The same backslash before a line feed continues a `--` comment,
 * and that reading the reader follows (`lineCommentBackslashContinues`): a comment ended early would leave text Spark
 * skips as code to the gate and the limiter. A lone carriage return ends a `--` comment as a line feed does, and the
 * reader follows that reading too (`lineCommentEndsAtCarriageReturn`): a comment run on to the next line feed would
 * leave code Spark runs as comment text to the gate and the limiter.
 */
const SPARK_GRAMMAR: SqlGrammar = {
  // CODE: `#` is no token outside a literal, so text after it fails to parse and hides nothing.
  hash: "code",
  // A SUBSCRIPT: `arr[0]` and `m['k']` read a value, and names are quoted with backticks.
  bracket: "subscript",
  // NESTING: `/* */` nests at every level (measured on 4.2.0).
  blockComment: "nesting",
  alternateQuoting: false,
  // `/` is division; there is no `//` comment.
  doubleSlashComment: false,
  // The lexer pairs a backslash with the next character inside `'...'` and `"..."` under every setting, and
  // `doubleQuoteBackslashEscapes` stays absent so `"..."` takes the same reading. `dollarTags` stays absent: 4.2 lexes
  // `$$...$$` and `$tag$...$tag$` as one string, and 4.1 refuses a `$` outside a literal.
  backslashAlwaysEscapes: true,
  // `r'C:\'` is a closed literal that takes no escapes.
  rawStrings: true,
  // `/*+` opens a hint Spark lexes as code; inside a comment it opens no level (measured on 4.2.0).
  hintsAreCode: true,
  // A backslash right before a line feed continues a `--` comment onto the next line; before CR LF it does not.
  lineCommentBackslashContinues: true,
  // A carriage return ends a `--` comment as a line feed does, taking the line feed right after it.
  lineCommentEndsAtCarriageReturn: true,
  // One parse is one statement or one block, and blocks are refused in this version.
  script: DEFAULT_SQL_GRAMMAR.script,
  // LIMIT must precede OFFSET, so a trailing OFFSET takes the bound before it.
  trailingLimitClauses: [/\s+OFFSET\s+\d+\s*$/i],
  // Replace a table, view or function; load files into a table; run a catalog procedure or text the gate cannot read;
  // load code or make the driver fetch a URL (ADD JAR, FILE, ARCHIVE and their plurals). MERGE is shared vocabulary.
  confirmForms: [
    ["CREATE", "OR", "REPLACE"],
    ["REPLACE", "TABLE"],
    ["LOAD", "DATA"],
    ["CALL"],
    ["EXECUTE", "IMMEDIATE"],
    ["ADD"],
  ],
  // Anywhere in the code: overwrite or replace rows (4.2 also writes `INSERT WITH SCHEMA EVOLUTION OVERWRITE` and
  // `REPLACE ON <condition>`), load a function's code, remove partitions from the catalog, start an external process
  // (`TRANSFORM`, `MAP` or `REDUCE` ... `USING '<command>'`) or call a Java method by reflection. `reflect`,
  // `java_method` and `try_reflect` are whole code words, so a name such as `reflection` does not ask, and a quoted
  // name of one asks where a `(` follows it, since Spark resolves a function name without case, quoted or not. A
  // function `IDENTIFIER(<expr>)` names asks wherever it is called, since the gate cannot read the computed name, and so
  // does a dollar-quoted body, which 4.2 reads as a metric view's YAML definition and the gate does not read.
  confirmCodeForms: [
    ["INSERT", "OVERWRITE"],
    ["EVOLUTION", "OVERWRITE"],
    ["REPLACE", "WHERE"],
    ["REPLACE", "ON"],
    ["REPLACE", "USING"],
    ["USING", "JAR"],
    ["USING", "FILE"],
    ["USING", "ARCHIVE"],
    ["DROP", "PARTITIONS"],
    ["SYNC", "PARTITIONS"],
    { wordThenLiteral: "USING" },
    ["REFLECT"],
    ["JAVA_METHOD"],
    ["TRY_REFLECT"],
    { quotedCall: "REFLECT" },
    { quotedCall: "JAVA_METHOD" },
    { quotedCall: "TRY_REFLECT" },
    { computedCall: "IDENTIFIER" },
    { dollarQuoted: true },
  ],
  // Variable substitution is off in every session Studio opens; a SET or RESET that turns it back on, or rebinds a
  // catalog, asks.
  confirmConfigKeys: ["spark.sql.variable.substitute", "spark.sql.defaultCatalog", "spark.sql.catalog."],
};

/** How Spark statement text is read: grammar, SQL text, redaction, update target and completion. */
export const SPARK_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: SPARK_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: null },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};

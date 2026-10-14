/**
 * SQL Completion Provider for Monaco Editor
 *
 * Pure utility module (no React) that registers SQL keyword, function, snippet,
 * and schema-aware column/table completions.
 */

import type * as Monaco from "monaco-editor";
import { extractAliases, resolveAlias } from "@/lib/sql";
import { resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan, type SqlSpanKind } from "@/lib/sql/spans";
import { statementScope, type DerivedSource, type ScopeSource } from "./sql-scope";
import { formatPostgresIdentifier } from "./postgres-identifiers";
import type { ContainerSpelling } from "@/lib/query-generators";
import type { DatabaseType } from "@/lib/types";

// ---------------------------------------------------------------------------
// Static constants
// ---------------------------------------------------------------------------

export const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "BETWEEN",
  "LIKE",
  "IS NULL",
  "IS NOT NULL",
  "GROUP BY",
  "HAVING",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "UNION",
  "ALL",
  "EXISTS",
  "DISTINCT",
  "INNER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "FULL JOIN",
  "CROSS JOIN",
  "NATURAL JOIN",
  "ON",
  "USING",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "TRUNCATE",
  "CREATE",
  "ALTER",
  "DROP",
  "TABLE",
  "VIEW",
  "INDEX",
  "SCHEMA",
  "DATABASE",
  "FUNCTION",
  "TRIGGER",
  "PROCEDURE",
  "AS",
  "WITH",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "CAST",
  "COALESCE",
  "NULLIF",
  "WINDOW",
  "OVER",
  "PARTITION BY",
  "ROWS",
  "RANGE",
  "PRECEDING",
  "FOLLOWING",
  "UNBOUNDED",
];

export const SQL_FUNCTIONS = [
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "FIRST_VALUE",
  "LAST_VALUE",
  "LEAD",
  "LAG",
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "NTILE",
  "CONCAT",
  "SUBSTR",
  "LENGTH",
  "LOWER",
  "UPPER",
  "TRIM",
  "LTRIM",
  "RTRIM",
  "REPLACE",
  "ROUND",
  "TRUNC",
  "ABS",
  "NOW",
  "CURRENT_TIMESTAMP",
  "DATE_PART",
  "DATE_TRUNC",
  "EXTRACT",
  "AGE",
  "TO_CHAR",
  "TO_DATE",
  "TO_NUMBER",
  "JSON_AGG",
  "JSON_BUILD_OBJECT",
];

export const SQL_SNIPPETS = [
  { label: "SELECT", value: "SELECT * FROM ${1:table_name} LIMIT 10;" },
  { label: "INSERT", value: "INSERT INTO ${1:table_name} (${2:columns})\nVALUES (${3:values});" },
  { label: "UPDATE", value: "UPDATE ${1:table_name}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};" },
  { label: "DELETE", value: "DELETE FROM ${1:table_name}\nWHERE ${2:condition};" },
  { label: "JOIN", value: "SELECT ${1:*}\nFROM ${2:table1} t1\nJOIN ${3:table2} t2 ON t1.${4:id} = t2.${5:t1_id};" },
  {
    label: "WITH",
    value: "WITH ${1:cte_name} AS (\n  SELECT ${2:*}\n  FROM ${3:table_name}\n)\nSELECT * FROM ${1:cte_name};",
  },
];

// ---------------------------------------------------------------------------
// Pre-computed completion items
// ---------------------------------------------------------------------------

export interface PrecomputedItem {
  label: string;
  labelLower: string;
  kind: number;
  insertText: string;
  insertTextRules?: number;
  detail: string;
}

export const KEYWORD_ITEMS: PrecomputedItem[] = SQL_KEYWORDS.map((kw) => ({
  label: kw,
  labelLower: kw.toLowerCase(),
  kind: 17, // CompletionItemKind.Keyword
  insertText: kw,
  detail: "SQL Keyword",
}));

export const FUNCTION_ITEMS: PrecomputedItem[] = SQL_FUNCTIONS.map((f) => ({
  label: f,
  labelLower: f.toLowerCase(),
  kind: 1, // CompletionItemKind.Function
  insertText: f + "($1)",
  insertTextRules: 4, // InsertAsSnippet
  detail: "SQL Function",
}));

export const SNIPPET_ITEMS: PrecomputedItem[] = SQL_SNIPPETS.map((s) => ({
  label: s.label,
  labelLower: s.label.toLowerCase(),
  kind: 27, // CompletionItemKind.Snippet
  insertText: s.value,
  insertTextRules: 4, // InsertAsSnippet
  detail: "SQL Snippet",
}));

// ---------------------------------------------------------------------------
// Schema completion cache type (shared with MongoDB completions)
// ---------------------------------------------------------------------------

export interface SchemaTableItem {
  label: string;
  labelLower: string;
  /** Only where the engine counted: an unmeasured count is absent, never 0 (#1397). */
  rowCount?: number;
  columnNames: string;
  /** The container path the object sits in, where the schema carried its address. */
  container?: readonly string[];
  /** The object's own segment of that address. */
  segment?: string;
  /**
   * Whether accepting the table inserts its container too: true when the container is known
   * and is not the session's default one. A bare name outside it is a name the engine does not
   * resolve, measured on PostgreSQL 18.6 as `relation "regions" does not exist` for a table of
   * a schema off the search path (#1397).
   */
  qualify?: boolean;
  /**
   * Whether a qualified insert is labelled with its address (`dataset.table`) rather than the bare name, so one name
   * held by many containers reads as many tables. Set where tables need a container (BigQuery).
   */
  labelQualified?: boolean;
}

export interface SchemaColumnItem {
  label: string;
  labelLower: string;
  type: string;
  isPrimary: boolean;
  tableName: string;
}

export interface SchemaCompletionCache {
  tableItems: SchemaTableItem[];
  columnMap: Map<string, SchemaColumnItem[]>;
  allColumns: Map<string, SchemaColumnItem>;
  /**
   * The connection's own identifier quoting, for the segments of an address this module
   * writes. Absent before capabilities load, and then a segment is written as it is.
   */
  quoteSegment?: (segment: string) => string;
  /**
   * How a qualified name is written and read where the engine spells a container segment
   * itself (`containerNameSpelling`, Apache Spark): `containerSpellingOf`. Absent on every
   * other engine, where a qualified insert is its segments each written by `quoteSegment`, and
   * a typed qualifier is bare names, one per segment.
   */
  containerSpelling?: ContainerSpelling;
}

/** The qualifier the text before a word ends with, each part followed by a dot, and the names it holds. */
interface TypedQualifier {
  text: string;
  names: string[];
}

/** A qualifier of bare names, read as completion always has: a run of words, split at each dot. */
function readBareQualifier(text: string): TypedQualifier {
  const qualifier = text.match(/((?:[\w$]+\.)+)$/)?.[1] ?? "";
  return { text: qualifier, names: qualifier.split(".").slice(0, -1) };
}

/**
 * A qualifier where the engine spells a container name itself, by its quote character: a part
 * is a bare word as above or quoted, the quote doubled inside, and a quoted part keeps its dots.
 */
const SPELLED_QUALIFIER: Record<ContainerSpelling["quote"], { run: RegExp; part: RegExp }> = {
  "`": { run: /(?:(?:[\w$]+|`(?:[^`]|``)+`)\.)+$/, part: /([\w$]+)\.|`((?:[^`]|``)+)`\./g },
  '"': { run: /(?:(?:[\w$]+|"(?:[^"]|"")+")\.)+$/, part: /([\w$]+)\.|"((?:[^"]|"")+)"\./g },
};

/** A spelled qualifier: `` `a`.`b`. `` holds the names `a` and `b`, and `` `x.y`. `` the one name `x.y`. */
function readSpelledQualifier(text: string, quote: ContainerSpelling["quote"]): TypedQualifier {
  const { run, part } = SPELLED_QUALIFIER[quote];
  const qualifier = text.match(run)?.[0] ?? "";
  return {
    text: qualifier,
    names: [...qualifier.matchAll(part)].map(([, bare, quoted]) => bare ?? quoted.replaceAll(quote + quote, quote)),
  };
}

/**
 * Columns of a referenced table: by `container.table` first, since sharded datasets repeat table names.
 * A qualified reference never falls back to its bare name, which may be another container's table.
 */
function columnsOfReference(cache: SchemaCompletionCache, segments: readonly string[]): SchemaColumnItem[] | undefined {
  const lower = segments.map((segment) => segment.toLowerCase());
  for (let start = 0; start < Math.max(1, lower.length - 1); start++) {
    const hit = cache.columnMap.get(lower.slice(start).join("."));
    if (hit) return hit;
  }
  return undefined;
}

/** The name a source is qualified by in the statement: its alias, else its own last segment. */
function qualifierOf(source: ScopeSource): string | undefined {
  return source.alias ?? source.name?.at(-1);
}

/**
 * Columns of a FROM/JOIN source: a table's from the schema, a subquery's or CTE's from its select list,
 * typed where the name matches a column of its own sources. Undefined when the shape is unknown.
 */
function columnsOfSource(cache: SchemaCompletionCache, source: ScopeSource): SchemaColumnItem[] | undefined {
  if (source.opaque) return undefined;
  if (!source.derived) return source.name && columnsOfReference(cache, source.name);
  const { known, complete } = innerColumns(cache, source.derived);
  const tableName = source.name?.join(".") ?? source.alias ?? "subquery";
  const named = source.derived.columns.map((label) => {
    const labelLower = label.toLowerCase();
    const type = known.find((col) => col.labelLower === labelLower)?.type ?? "expression";
    return { label, labelLower, type, isPrimary: false, tableName };
  });
  // A select list that names nothing (`SELECT a * 2`) still has columns, just none this reader can name.
  if (!source.derived.star) return named.length > 0 ? named : undefined;
  const names = new Set(named.map((col) => col.labelLower));
  return complete ? [...named, ...known.filter((col) => !names.has(col.labelLower))] : undefined;
}

// Per derived source, since every reference to a CTE shares one: a chain of self-joining CTEs would
// otherwise resolve each link once per path to it, doubling with every link.
const innerMemo = new WeakMap<DerivedSource, { known: SchemaColumnItem[]; complete: boolean }>();

/** The columns of a derived source's own sources, and whether every one of them is known. */
function innerColumns(cache: SchemaCompletionCache, derived: DerivedSource) {
  let memo = innerMemo.get(derived);
  if (!memo) {
    const inner = derived.sources.map((s) => columnsOfSource(cache, s));
    // One entry per name: `SELECT *` over a self-join holds each name twice, and doubles again per link.
    const known = [...new Map(inner.flatMap((columns) => columns ?? []).map((col) => [col.labelLower, col])).values()];
    memo = { known, complete: inner.every((columns) => columns !== undefined) };
    innerMemo.set(derived, memo);
  }
  return memo;
}

const TABLE_CLAUSES: ReadonlySet<string> = new Set(["FROM", "JOIN", "INTO", "UPDATE", "TABLE"]);
const COLUMN_CLAUSES: ReadonlySet<string> = new Set(["SELECT", "WHERE", "ON", "SET", "HAVING", "ORDER BY", "GROUP BY"]);

/** Whether `text` closes a paren it did not open: the group the text started in ended before its end. */
function leavesGroup(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return true;
  }
  return false;
}

/** Offset just after the innermost `(` still open at `end`, or 0 at statement level. */
function openGroupStart(text: string, end: number): number {
  let depth = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (text[i] === ")") depth++;
    else if (text[i] === "(" && depth-- === 0) return i + 1;
  }
  return 0;
}

/**
 * The last clause keyword before the cursor that still governs it, uppercased with single spaces,
 * and the text after it. A keyword inside a group that closed before the cursor (a finished
 * subquery) governs nothing there, so the scan keeps going back.
 */
function lastClause(textBeforeCursor: string): { name: string; rest: string } | undefined {
  const matches = [
    ...textBeforeCursor.matchAll(
      // Not a qualified name's segment (`t.table`), and `DISTINCT ON` is an expression list.
      /(?<![\w$.])(SELECT|FROM|JOIN|WHERE|(?<!\bDISTINCT\s+)ON|SET|HAVING|ORDER\s+BY|GROUP\s+BY|INTO|(?<!\b(?:ON|FOR|KEY)\s+)UPDATE|TABLE|LIMIT|USING)\b/gi,
    ),
  ];
  // A clause keyword that governs the text from it to `end`: not inside a group that closed before.
  const governs = (match: RegExpMatchArray, end: number) =>
    !leavesGroup(textBeforeCursor.slice(match.index! + match[0].length, end));
  matches.reverse();
  for (const [i, match] of matches.entries()) {
    // A FROM inside a call (`EXTRACT(YEAR FROM`, `TRIM(BOTH FROM`) is an argument, unless its group opens a query.
    if (/^FROM$/i.test(match[1])) {
      const group = openGroupStart(textBeforeCursor, match.index);
      if (group > 0 && !/\b(?:SELECT|DELETE)\b/i.test(textBeforeCursor.slice(group, match.index))) continue;
    }
    const rest = textBeforeCursor.slice(match.index + match[0].length);
    if (leavesGroup(rest)) continue;
    // A statement-level ON after no clause, SELECT or UPDATE names an object (`CREATE INDEX i ON`,
    // `GRANT SELECT ON`, `AFTER UPDATE ON`): a table position. A join's, an `ON CONFLICT`'s or a key's is not.
    if (/^ON$/i.test(match[1]) && /^\s*[\w$.]*$/.test(rest) && openGroupStart(textBeforeCursor, match.index) === 0) {
      const previous = matches.slice(i + 1).find((m) => governs(m, match.index!));
      if (!previous || /^(?:SELECT|UPDATE)$/i.test(previous[1])) return { name: "TABLE", rest };
    }
    return { name: match[1].toUpperCase().replace(/\s+/g, " "), rest };
  }
  return undefined;
}

const COMMENT_KINDS: ReadonlySet<SqlSpanKind> = new Set(["line-comment", "block-comment", "string", "dollar-string"]);
const LITERAL_KINDS: ReadonlySet<SqlSpanKind> = new Set([...COMMENT_KINDS, "quoted-identifier"]);

/** `sql` with the spans of these kinds overwritten by spaces, so offsets still line up with the original. */
function blankSpans(sql: string, grammar: SqlGrammar, kinds: ReadonlySet<SqlSpanKind>): string {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
    const end = span?.end ?? i + 1;
    out.push(span && kinds.has(span.kind) ? " ".repeat(end - i) : sql.slice(i, end));
    i = end;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

/**
 * Registers the SQL completion item provider with Monaco.
 *
 * @param monaco  - The Monaco namespace (from `useMonaco()` or `beforeMount`)
 * @param schemaCompletionCache - Pre-computed schema data for table/column completions
 * @returns An `IDisposable` that should be called on cleanup.
 */
export function registerSQLCompletionProvider(
  monaco: typeof Monaco,
  schemaCompletionCache: SchemaCompletionCache,
  databaseType?: DatabaseType,
): Monaco.IDisposable {
  const grammar = resolveSqlGrammar(databaseType);
  const blanked = new WeakMap<Monaco.editor.ITextModel, { version: number; code: string }>();
  const spelling = schemaCompletionCache.containerSpelling;
  const readQualifier =
    spelling === undefined ? readBareQualifier : (text: string) => readSpelledQualifier(text, spelling.quote);
  return monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", " "],
    provideCompletionItems: (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const line = model.getLineContent(position.lineNumber);
      const lastChar = line[position.column - 2];
      const prefix = word.word.toLowerCase();

      const suggestions: Monaco.languages.CompletionItem[] = [];

      // Monaco replaces only the current word. A qualified table suggestion must
      // match and replace the already typed qualifier as well as that word.
      const typed = readQualifier(line.substring(0, word.startColumn - 1));
      const typedQualifier = typed.text;
      // Preserve ordinary identifiers; quote catalog names only when needed
      // to preserve case, escape special characters, or avoid keywords.
      // PostgreSQL keeps its keyword-aware quoting; every other dialect quotes through the
      // connection's capabilities, so a MySQL `e2e-other` or a SQL Server segment with a space
      // is written in a form the engine parses.
      const quoteSegment = schemaCompletionCache.quoteSegment;
      const formatSegment = (segment: string) =>
        databaseType === "postgres"
          ? formatPostgresIdentifier(segment)
          : quoteSegment === undefined
            ? segment
            : quoteSegment(segment);
      // An address is written whole where the engine spells a container segment itself: Spark's
      // namespace `a.b` is `a`.`b` there, and one quoted segment would name a namespace `a.b`.
      const formatPath = (path: readonly string[]) =>
        spelling === undefined ? path.map(formatSegment).join(".") : spelling.quotePath(path);
      // A statement's own name is read unquoted; one that needed quotes gets them back.
      const asWritten = (name: string) => (/^[A-Za-z_][\w$]*$/.test(name) ? name : formatSegment(name));
      const tableItem = (table: SchemaTableItem, insertText: string, tableRange: Monaco.IRange) => ({
        // It still filters on the table's own name.
        ...(table.labelQualified && insertText.includes(".") && insertText !== table.label
          ? { label: [...(table.container ?? []), table.segment ?? table.label].join("."), filterText: table.label }
          : { label: table.label }),
        kind: monaco.languages.CompletionItemKind.Class,
        insertText,
        range: tableRange,
        // The count only where the engine measured one: "(0 rows)" for a count nobody
        // took read as an empty table (#1397).
        detail: table.rowCount === undefined ? "Table" : `Table (${table.rowCount} rows)`,
        documentation: table.columnNames,
        sortText: "2" + table.label,
      });

      // A typed qualifier that names a CONTAINER (`sales.`, `e2e_other.`, `demo.`) offers that
      // container's tables, which are inserted by their own segment because the qualifier is
      // already in the text. It is matched against the trailing segments of each table's
      // container path, so `db.sales.` and `sales.` both reach a SQL Server `[db, sales]`. A
      // segment the engine spells itself holds its parts, and the qualifier names whole segments:
      // `a.b.` reaches a Spark namespace `a.b`, while `b.` does not, nor `x.y.` a namespace `` `x.y` ``.
      const qualifierSegments = typed.names.map((name) => name.toLowerCase());
      const inTypedContainer = (table: SchemaTableItem) => {
        const container = table.container;
        if (!container || table.segment === undefined) return false;
        const segments =
          spelling === undefined
            ? container.map((segment) => [segment])
            : spelling.pathNames([...container, table.segment]).slice(0, -1);
        const tail: string[] = [];
        for (let index = segments.length - 1; index >= 0 && tail.length < qualifierSegments.length; index--) {
          tail.unshift(...segments[index]);
        }
        return (
          tail.length === qualifierSegments.length &&
          tail.every((name, index) => name.toLowerCase() === qualifierSegments[index])
        );
      };
      const containerTables =
        qualifierSegments.length > 0 ? schemaCompletionCache.tableItems.filter(inTypedContainer) : [];

      const qualifiedMatch = schemaCompletionCache.tableItems.some((table) =>
        table.labelLower.startsWith(typedQualifier.toLowerCase() + prefix),
      );
      const qualifier = typedQualifier && qualifiedMatch ? typedQualifier : "";
      const tablePrefix = qualifier.toLowerCase() + prefix;
      const tableSuggestions =
        containerTables.length > 0
          ? containerTables
              .filter((table) => table.segment!.toLowerCase().startsWith(prefix))
              .map((table) => tableItem(table, formatSegment(table.segment!), range))
          : schemaCompletionCache.tableItems
              .filter((table) => (!qualifier && prefix.length < 2) || table.labelLower.startsWith(tablePrefix))
              .map((table) =>
                tableItem(
                  table,
                  // Outside the session's default container the address is the name the
                  // engine resolves; inside it the label is, as it always was.
                  table.qualify && table.container && table.segment !== undefined
                    ? formatPath([...table.container, table.segment])
                    : databaseType === "postgres"
                      ? table.label.split(".").map(formatPostgresIdentifier).join(".")
                      : table.label,
                  { ...range, startColumn: range.startColumn - qualifier.length },
                ),
              );

      // Read with literals and comments blanked: a `;`, a paren or a keyword written in one is no code.
      // Blanked once per model version: a trigger and the filtering requests after it share it.
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const version = model.getVersionId();
      let memo = blanked.get(model);
      if (memo?.version !== version) {
        memo = { version, code: blankSpans(text, grammar, LITERAL_KINDS) };
        blanked.set(model, memo);
      }
      const code = memo.code;
      const start = offset > 0 ? code.lastIndexOf(";", offset - 1) + 1 : 0;
      const terminator = code.indexOf(";", offset);
      const scope = statementScope(
        blankSpans(text.slice(start, terminator < 0 ? undefined : terminator), grammar, COMMENT_KINDS),
        offset - start,
      );

      // Dot-triggered: Show columns for specific table or alias
      if (lastChar === ".") {
        const textToDot = line.substring(0, position.column - 1);
        // Only PostgreSQL completions introduce quoted table names in this PR.
        // Other dialects retain their existing bare-identifier lookup.
        const quotedIdentifier =
          databaseType === "postgres" ? textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"') : undefined;
        const identifier = (quotedIdentifier ?? textToDot.match(/(\w+)\.$/)?.[1])?.toLowerCase();
        if (identifier) {
          // Helper to find columns by table name (handles schema.table format)
          const findColumns = (tableName: string) => {
            const tableNameLower = tableName.toLowerCase();
            // 1. Try exact match first
            const cols = schemaCompletionCache.columnMap.get(tableNameLower);
            if (cols) return cols;

            // 2. Try matching table name with any schema prefix
            for (const [key, value] of schemaCompletionCache.columnMap.entries()) {
              const parts = key.split(".");
              const justTableName = parts[parts.length - 1];
              if (justTableName === tableNameLower) {
                return value;
              }
            }
            return null;
          };

          // 1. First, the statement's own source of that name: an alias, a CTE or a subquery
          const source = scope.sources.find((s) => qualifierOf(s)?.toLowerCase() === identifier);
          let columns = (source && columnsOfSource(schemaCompletionCache, source)) || null;

          // 2. Then a direct table lookup
          columns ??= findColumns(identifier);

          // 3. If not found, try alias resolution
          if (!columns) {
            // The whole statement around the cursor, not only the text before it: in
            // `SELECT c. FROM e2e.customers c` the alias is defined AFTER the cursor, and a
            // read that stopped at the cursor offered nothing there (#1397). It runs from the
            // statement's start to its terminator, so another statement's aliases are not read.
            const after = text.slice(offset);
            const terminator = after.indexOf(";");
            const statement = `${text.slice(start, offset - 1)} ${terminator < 0 ? after : after.slice(0, terminator)}`;

            const { aliases } = extractAliases(statement);
            const resolvedTableName = resolveAlias(identifier, aliases);
            columns = findColumns(resolvedTableName);
          }

          // 4. Provide column suggestions
          if (columns) {
            columns.forEach((col) => {
              suggestions.push({
                label: col.label,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: col.label,
                range,
                detail: `${col.type}${col.isPrimary ? " (PK)" : ""}`,
                documentation: `Column of ${col.tableName}`,
              });
            });
          }
        }
        if ((qualifier || containerTables.length > 0) && suggestions.length === 0)
          suggestions.push(...tableSuggestions);
        return { suggestions };
      }

      // General completion with lazy filtering and context awareness
      const shouldFilter = prefix.length >= 2;

      // Detect context: Are we in a position where columns make sense? Read across lines, so a
      // column on the line below its SELECT counts too.
      const textBeforeCursor = code.slice(start, offset);
      // The clause the cursor sits in decides: a FROM/JOIN position names tables, a SELECT/WHERE/ON
      // position names columns, and each hides the other.
      const clause = lastClause(textBeforeCursor);
      // An unclosed `(` after INTO/TABLE/USING is a column or definition list: columns belong there.
      const inList =
        (clause?.name === "INTO" || clause?.name === "TABLE" || clause?.name === "USING") &&
        clause.rest.split("(").length > clause.rest.split(")").length;
      // Any other unclosed `(` after a table clause holds a table function's arguments or a subquery: no table position.
      const isTableContext =
        clause !== undefined &&
        TABLE_CLAUSES.has(clause.name) &&
        clause.rest.split("(").length === clause.rest.split(")").length;
      // Right after FROM/JOIN/INTO/UPDATE/TABLE only a name can stand. Read on the raw text, where a
      // quoted table name is still there.
      const atNameSlot = isTableContext && /^\s*[\w$]*$/.test(text.slice(offset - clause.rest.length, offset));
      const isColumnContext =
        !isTableContext &&
        (inList ||
          (clause !== undefined && COLUMN_CLAUSES.has(clause.name)) ||
          /\b(SELECT|WHERE|AND|OR|ON|SET|HAVING|ORDER\s+BY|GROUP\s+BY|,)\s*\w*$/i.test(textBeforeCursor));

      // Keywords, except where only a name can stand
      KEYWORD_ITEMS.forEach((item) => {
        if (!atNameSlot && (!shouldFilter || item.labelLower.startsWith(prefix))) {
          suggestions.push({
            label: item.label,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: item.insertText,
            range,
            detail: item.detail,
            sortText: "0" + item.label,
          });
        }
      });

      // Functions, except where a table goes
      FUNCTION_ITEMS.forEach((item) => {
        if (!isTableContext && (!shouldFilter || item.labelLower.startsWith(prefix))) {
          suggestions.push({
            label: item.label,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: item.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            detail: item.detail,
            sortText: "1" + item.label,
          });
        }
      });

      // Tables and the statement's CTEs, except where only a column can stand. A SELECT list that names
      // no source yet still offers them: typed left to right, nothing else reaches a table there.
      if (!isColumnContext || (clause?.name === "SELECT" && scope.sources.length === 0)) {
        suggestions.push(...tableSuggestions);
        for (const cte of scope.ctes) {
          if (!shouldFilter || cte.toLowerCase().startsWith(prefix)) {
            suggestions.push({
              label: cte,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: asWritten(cte),
              range,
              detail: "CTE",
              sortText: "2" + cte,
            });
          }
        }
      }

      // Columns - only show in appropriate context, and only the columns of the sources the cursor's
      // query and its enclosing ones name, when every one of them has a known shape. A source that has
      // none (a table the schema does not hold, a table function) may hold any column, so then every
      // known column.
      if (isColumnContext) {
        const resolved: { source: ScopeSource; columns: SchemaColumnItem[] }[] = [];
        for (const source of scope.sources) {
          const columns = columnsOfSource(schemaCompletionCache, source);
          if (!columns) {
            resolved.length = 0;
            break;
          }
          resolved.push({ source, columns });
        }
        const inScope = resolved.length > 0;
        // `JOIN b USING (`: only a column the joined source shares with an earlier one of its query.
        if (clause?.name === "USING" && inScope) {
          const level = resolved.filter(
            (r) => r.source.depth === resolved[0].source.depth && r.source.at < offset - start,
          );
          const joined = level.pop();
          const earlier = new Set(level.flatMap((r) => r.columns.map((col) => col.labelLower)));
          resolved.length = 0;
          if (joined) {
            resolved.push({ ...joined, columns: joined.columns.filter((col) => earlier.has(col.labelLower)) });
          }
        }

        const scoped = new Map<string, { col: SchemaColumnItem; owners: string[] }>();
        for (const { source, columns } of resolved) {
          const owner = source.name?.join(".") ?? source.alias ?? "subquery";
          for (const col of columns) {
            const entry = scoped.get(col.labelLower);
            if (!entry) scoped.set(col.labelLower, { col, owners: [owner] });
            else if (!entry.owners.includes(owner)) entry.owners.push(owner);
          }
        }
        const columnEntries = inScope
          ? [...scoped.values()]
          : [...schemaCompletionCache.allColumns.values()].map((col) => ({ col, owners: [] as string[] }));
        for (const { col, owners } of columnEntries) {
          if (!shouldFilter || col.labelLower.startsWith(prefix)) {
            suggestions.push({
              label: col.label,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: col.label,
              range,
              detail: owners.length > 1 ? `Column (${col.type}) · ${owners.join(", ")}` : `Column (${col.type})`,
              // In scope, columns rank above keywords; otherwise below everything else.
              sortText: (inScope ? "00" : "4") + col.label,
            });
          }
        }

        // The statement's qualifiers, so `u` then `.` reaches a column now that tables are not offered here
        const qualifiers = new Set<string>();
        for (const source of scope.sources) {
          const qualifier = qualifierOf(source);
          if (!qualifier || qualifiers.has(qualifier.toLowerCase())) continue;
          qualifiers.add(qualifier.toLowerCase());
          if (shouldFilter && !qualifier.toLowerCase().startsWith(prefix)) continue;
          suggestions.push({
            label: qualifier,
            kind: monaco.languages.CompletionItemKind.Variable,
            insertText: asWritten(qualifier),
            range,
            detail: source.alias
              ? `Alias of ${source.name?.join(".") ?? "subquery"}`
              : source.derived
                ? "CTE"
                : `Source ${source.name?.join(".")}`,
            sortText: "01" + qualifier,
          });
        }
      }

      // Snippets, except where only a name can stand
      SNIPPET_ITEMS.forEach((item) => {
        if (!atNameSlot && (!shouldFilter || item.labelLower.startsWith(prefix))) {
          suggestions.push({
            label: item.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: item.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            detail: item.detail,
            sortText: "3" + item.label,
          });
        }
      });

      return { suggestions };
    },
  });
}

import { declaredLevels } from "@/lib/db/object-kinds";
import { registeredDialect } from "@/lib/db/query-dialects";
import { DIALECT_GENERATORS, languageGenerators, sqlPortGenerators } from "@/lib/db/query-generators";
import { commentName, objectSegment } from "@/lib/db/query-generators/shared";
import type { DialectGenerators, GeneratorScope, SqlFormContext } from "@/lib/db/query-generators/types";
import type { QueryDialect } from "@/lib/db/query-dialects";
import { offersCountQuery, type PreviewTimeWindow, type ProviderCapabilities } from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";

export { escapeGlob, objectSegment } from "@/lib/db/query-generators/shared";
export type { DialectGenerators, GeneratorScope } from "@/lib/db/query-generators/types";

/**
 * The query generators, the engine-agnostic dispatcher: what a tree click runs, what Generate Query and Generate Count
 * Query write, what a declared row action runs, and how a name or an address is quoted. Every text one engine writes is
 * a row declared beside its provider and collected by the registry in `src/lib/db/query-generators/index.ts`, read
 * here by what the declaration says: its query dialect, its query language, or the default port an SQL engine's forms
 * have always been keyed by. Nothing here names an engine; `tests/unit/lib/query-generators-isolation.test.ts` holds
 * that.
 */

/** Backtick-quote an identifier, doubling any backtick it contains. */
function backtickQuote(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

/**
 * Quote only when the name would not round-trip bare, in the two styles a provider
 * may DECLARE (`ProviderCapabilities.identifierQuoting`), or always, in the other two.
 *
 * One object rather than two functions, and looked up rather than branched on: bun's
 * lcov attributes a freshly added function's declaration line to nothing, so two new
 * `function` declarations here read as uncovered while their bodies run - the phantom
 * this repo's coverage notes describe. A table has one executable line per entry and
 * no declaration line to lose.
 */
const DECLARED_QUOTING: Record<
  NonNullable<ProviderCapabilities["identifierQuoting"]>,
  (name: string, always: boolean) => string
> = {
  backtick: (name, always) => (!always && /^[A-Za-z_][\w$]*$/.test(name) ? name : backtickQuote(name)),
  double: (name, always) => (!always && /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`),
  "double-always": (name) => `"${name.replaceAll('"', '""')}"`,
  "backtick-always": (name) => backtickQuote(name),
};

/**
 * Quote a SQL identifier (table/column) for the target dialect, but ONLY when
 * needed. Plain identifiers that round-trip unquoted are left as-is so generated
 * SQL stays readable and existing behavior is preserved; mixed-case / special /
 * fold-sensitive names get the dialect's quoting.
 *
 * The rule is read from the provider capabilities, in order: a language that spells names its own way quotes with
 * its row in `LANGUAGE_GENERATORS`; a declared `identifierQuoting` comes next; then the SQL engine whose default port
 * the declaration names, with its row in `SQL_PORT_GENERATORS`; and every other engine gets the default below, where
 * an unquoted name folds to lowercase, so a name is quoted unless it is plain lower case.
 *
 * An engine that never folds case and quotes with the double quote needs no row of its own: the default is already
 * exactly right for it, as both `SELECT "id" FROM "probe"` and the bare form parse (issue #264).
 *
 * `always` quotes a name that would round-trip bare as well. The bare test is about case and
 * characters only, so a lowercase reserved word passes it: `when`, `order`, `user` and `group`
 * come back bare and the engine reads them as keywords (#1396). Quoting such a name never
 * changes which object it means, because a name passes the bare test only in the case the
 * engine folds a bare name to. A statement that names columns it is about to create, as an
 * import into a new table does, asks for this.
 */

export function quoteIdentifier(
  name: string,
  capabilities: ProviderCapabilities,
  { always = false }: { always?: boolean } = {},
): string {
  // A language that spells names its own way quotes them with its own rule, the JSON language's engines included:
  // they don't use SQL identifier quoting (#1088, #1089).
  const language = languageGenerators(capabilities);
  if (language?.quote !== undefined) return language.quote(name);

  // An explicit declaration wins over the port, because the port stopped being a faithful proxy for the dialect:
  // two search engines ship on one port and disagree about the quote character, and where a double-quoted
  // identifier is a STRING LITERAL the generated query answers 200 with zero rows instead of failing, so the
  // default would produce silently wrong results there, not an error. See `ProviderCapabilities.identifierQuoting`.
  const declared = capabilities.identifierQuoting;
  if (declared !== undefined) return DECLARED_QUOTING[declared](name, always);

  const engine = sqlPortGenerators(capabilities);
  if (engine !== undefined) return engine.quote(name, always);
  // The default: an unquoted name folds to lowercase.
  return !always && /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/** A regular identifier in the subset every SQL dialect reads bare: ASCII letters, digits and `_`, no leading digit. */
const PORTABLE_BARE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Write a name the USER TYPED, as opposed to a catalog name read back from the engine, the way
 * the SQL editor would read the same text (#1435).
 *
 * A name in the portable bare subset is written bare, so the engine folds it exactly as it
 * folds that text typed in the editor: on Oracle `orders` becomes `ORDERS`, and a later
 * `SELECT * FROM orders` finds it. `quoteIdentifier` would quote it there, because it keeps a
 * catalog name exact, and the result would be a lowercase table that query cannot see. Any
 * other name, `Ürün Tablo` or `a-b`, has no bare spelling at all, so it is quoted in the
 * connection's own dialect and kept exactly as typed.
 *
 * A reserved word passes the bare test and reaches the engine bare, where it is refused with
 * the engine's own error, as it would be from the editor. There is no per-engine reserved-word
 * list to consult: the one reserved-word list in the repo is PostgreSQL's alone
 * (`src/lib/db/providers/sql/postgres-sql-grammar.ts`).
 */
export function quoteTypedName(name: string, capabilities: ProviderCapabilities): string {
  return PORTABLE_BARE_NAME.test(name) ? name : quoteIdentifier(name, capabilities, { always: true });
}

/** The quote character of each declared quoting, which an engine-spelled segment is read with. */
const DECLARED_QUOTE_CHARACTER: Record<NonNullable<ProviderCapabilities["identifierQuoting"]>, '"' | "`"> = {
  double: '"',
  "double-always": '"',
  backtick: "`",
  "backtick-always": "`",
};

const BARE_SPELLED_PART = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * The parts of an engine-spelled name: bare parts and parts quoted with `quote` (that character doubled inside), joined
 * by dots; `undefined` when the text does not read completely as such a spelling, so the caller quotes it as one name.
 */
function readSpelledParts(text: string, quote: string): string[] | undefined {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    if (text[i] === quote) {
      let part = "";
      let j = i + 1;
      while (j < text.length && !(text[j] === quote && text[j + 1] !== quote)) {
        part += text[j];
        j += text[j] === quote ? 2 : 1;
      }
      if (j >= text.length || part === "") return undefined;
      parts.push(part);
      i = j + 1;
    } else {
      const bare = BARE_SPELLED_PART.exec(text.slice(i));
      if (bare === null) return undefined;
      parts.push(bare[0]);
      i += bare[0].length;
    }
    if (i === text.length) return parts;
    if (text[i] !== ".") return undefined;
    i++;
  }
}

/** The index of the segment `containerNameSpelling: "engine"` covers: the schema level's, when a segment follows it. */
function spelledSegmentIndex(path: readonly string[], capabilities: ProviderCapabilities): number {
  if (capabilities.containerNameSpelling !== "engine") return -1;
  const index = declaredLevels(capabilities).findIndex((level) => level.id === "schema");
  return index !== -1 && index < path.length - 1 ? index : -1;
}

/** The character an engine-spelled segment is read with: the declared quoting's, which the declaration needs beside it. */
function spelledQuote(capabilities: ProviderCapabilities): '"' | "`" {
  const declared = capabilities.identifierQuoting;
  if (declared === undefined) {
    throw new RangeError('containerNameSpelling "engine" needs a declared identifierQuoting to read the spelling with');
  }
  return DECLARED_QUOTE_CHARACTER[declared];
}

/** Quote an engine-spelled segment part by part, or as one name where it does not read as a spelling. */
function quoteSpelledSegment(
  segment: string,
  capabilities: ProviderCapabilities,
  options: { always?: boolean },
): string {
  const parts = readSpelledParts(segment, spelledQuote(capabilities));
  if (parts === undefined) return quoteIdentifier(segment, capabilities, options);
  return parts.map((part) => quoteIdentifier(part, capabilities, options)).join(".");
}

/**
 * Quote an object ADDRESS: one segment per container level, then the object's own
 * segment, each quoted independently and joined with `.`.
 *
 * Segments in and never a string to split, which is the whole of the rule. A name is
 * what LABELS an object and a path is what ADDRESSES it (#789), and the string form
 * below could only guess where one segment ends: a ClickHouse table really named
 * `.inner_id.fake` in `demo` generated `SELECT * FROM "".inner_id.fake`, which the
 * server answers with a syntax error at position 15, because the dots in its NAME were
 * read as qualifiers. Reproduced in the browser on ClickHouse 25.8 before this changed.
 *
 * Quoting stays per segment and stays conditional, so `["employees", "department"]` is
 * still `employees.department` and `["public", "Order"]` is still `public."Order"`.
 *
 * Where the engine declares `containerNameSpelling: "engine"`, the schema-level segment is
 * its own spelling of a multi-part name and is quoted part by part; a segment that does not
 * read as such a spelling is quoted as one name. That reading applies only when a segment
 * follows the schema level, so the last segment is always the object's own name, and a
 * container path passed here alone keeps its schema segment as one name: Spark's
 * `["lake", "a.b"]` is `` `lake`.`a.b` ``, and a name appended to that text does not address
 * the namespace `a`.`b`.
 *
 * Full qualification is emitted unconditionally, including inside the session default
 * container. `demo.orders`, `[libredb_objects].[app].[customers]` and `APP.APP_CUSTOMERS`
 * are all valid wherever the bare name is, so nothing here has to know which container a
 * connection defaults to - and no capability declares that, which is why the flat spelling
 * could not be qualified at the call site.
 *
 * `options.always` is `quoteIdentifier`'s, applied to every segment.
 */

export function quoteObjectPath(
  path: readonly string[],
  capabilities: ProviderCapabilities,
  options: { always?: boolean } = {},
): string {
  // A language that addresses an object its own way writes the address with its own rule.
  const language = languageGenerators(capabilities);
  if (language?.quotePath !== undefined) return language.quotePath(path);
  const spelled = spelledSegmentIndex(path, capabilities);
  return path
    .map((segment, index) =>
      index === spelled
        ? quoteSpelledSegment(segment, capabilities, options)
        : quoteIdentifier(segment, capabilities, options),
    )
    .join(".");
}

/**
 * How editor completion writes and reads a qualified name on an engine that declares
 * `containerNameSpelling: "engine"`: there not every dot separates two segments, because the
 * spelled segment holds one name or several. Spark's namespace `a.b` is the names `a` and `b`,
 * and its namespace `` `x.y` `` the one name `x.y`.
 */
export interface ContainerSpelling {
  /** The character a part is quoted with, doubled inside: the declared quoting's. */
  quote: '"' | "`";
  /** An object's address as the engine writes it: `quoteObjectPath`. */
  quotePath: (path: readonly string[]) => string;
  /** The names each segment of an object's address holds: one, or the parts `quoteObjectPath` quotes it by. */
  pathNames: (path: readonly string[]) => string[][];
}

/** The engine's `ContainerSpelling`, or `undefined` where it does not declare `containerNameSpelling`. */
export function containerSpellingOf(capabilities: ProviderCapabilities): ContainerSpelling | undefined {
  if (capabilities.containerNameSpelling !== "engine") return undefined;
  const quote = spelledQuote(capabilities);
  return {
    quote,
    quotePath: (path) => quoteObjectPath(path, capabilities),
    pathNames: (path) => {
      const spelled = spelledSegmentIndex(path, capabilities);
      return path.map((segment, index) =>
        index === spelled ? (readSpelledParts(segment, quote) ?? [segment]) : [segment],
      );
    },
  };
}

/**
 * The terminator a generated statement ends with: `;` everywhere, and nothing on a
 * product whose grammar has none.
 *
 * Only the two shapes a user reaches by CLICKING are bounded here - the schema tree's
 * "Select Top N" and "Generate Query" - because those are the statements this file
 * writes on the user's behalf.
 *
 * The shared SQL forms below ask this, and an SQL row receives it as `SqlFormContext.terminator`.
 * A row may still write a literal `;` of its own where its engine accepts one; that choice is the
 * row's, and its docblock says why.
 *
 * Oracle is the measurement that moved: `SELECT * FROM app_customers FETCH FIRST 50
 * ROWS ONLY;` answers ORA-00933, so clicking a table on Oracle had never once worked.
 * See `ProviderCapabilities.statementTerminator` for both measurements.
 */
function terminator(capabilities: ProviderCapabilities): string {
  return capabilities.statementTerminator === "none" ? "" : ";";
}

/** What an SQL row reads of the declaration it writes for: its quoting and its terminator. */
function sqlFormContext(capabilities: ProviderCapabilities): SqlFormContext {
  return { quote: (name) => quoteIdentifier(name, capabilities), terminator: terminator(capabilities) };
}

/**
 * The statement behind "Select Top 50", the one a CLICK on a tree row runs (#789).
 *
 * It takes the object's PATH, because that is what addresses an object; `name` is what
 * labels it (standing ruling 2). Every row that addresses by qualification reads the whole
 * path, and each that addresses a single key, collection, topic or metric reads the object's
 * own segment.
 *
 * NO SQL RETURN HERE CARRIES A ROW BOUND (#816). It used to: `LIMIT 50`, `FETCH FIRST 50
 * ROWS ONLY`, `SELECT TOP 50`. Nothing downstream could then tell that preview cap from a
 * bound the user typed, because both are text in the same string — and the limiter
 * returns a self-bounded statement UNTOUCHED, discarding the offset with it, so the page
 * after the first was the first again. The cap travels as the `limit` EXECUTION OPTION
 * instead (`PREVIEW_PAGE_SIZE` in `use-tab-manager.ts`), which leaves a user-written
 * `LIMIT n` with exactly one meaning: a hard bound we do not page past.
 *
 * A dialect's or a language's row decides its own bound, and that is not an exception to the
 * rule: where an engine cannot be asked for page two at all (`supportsResultPagination: false`),
 * the bound its row writes is the only one there is, and where its language has no bound to
 * write, its row writes none. Each row's docblock says which, and why.
 *
 * `scope` is handed to the dialect rows only; each reads what of it the row needs.
 */

export function generateTableQuery(
  path: readonly string[],
  capabilities: ProviderCapabilities,
  columns?: readonly ColumnSchema[],
  scope?: GeneratorScope,
): string {
  // Refuses an empty address before any row spells it.
  objectSegment(path);
  // A query dialect's own command, from its `DIALECT_GENERATORS` record, BEFORE its language's row below.
  const dialect = registeredDialect(capabilities);
  if (dialect !== undefined) return DIALECT_GENERATORS[dialect].table(path, columns, scope);
  // A language an engine writes its own text in, from its `LANGUAGE_GENERATORS` record.
  const language = languageGenerators(capabilities);
  if (language !== undefined) return language.table(path, columns, capabilities);
  const table = quoteObjectPath(path, capabilities);
  // An SQL engine whose click reads a projection of its own, from its `SQL_PORT_GENERATORS` record.
  const engineTable = sqlPortGenerators(capabilities)?.table;
  if (engineTable !== undefined) return engineTable(table, sqlFormContext(capabilities));
  // An engine whose driver misreads some column types declares how its preview reads each one
  // (#786), so the preview names its columns rather than asking for `*`.
  const projection = capabilities.previewProjection;
  if (projection !== undefined) {
    return projectedPreview(table, projection, columns ?? [], capabilities);
  }
  // An engine whose preview reads a recent window, newest first (InfluxDB spec 6.6, I20).
  const window = capabilities.previewTimeWindow;
  if (window !== undefined) return windowedPreview(table, window, capabilities);
  // Every other SQL dialect. Some once had branches of their own only to spell their row bound, and with no bound to
  // spell, one statement serves all of them. Issue #264's rule, that a bound must sit after any `FORMAT` or
  // `SETTINGS` clause, is moot for the same reason: there is no generated bound to misplace.
  return `SELECT * FROM ${table}${terminator(capabilities)}`;
}

/**
 * The preview of an engine that declares `previewTimeWindow` (InfluxDB spec 6.6, I20): the newest rows of the
 * window under the declaration's note, with no `LIMIT` in the text, so the limiter appends the preview cap after
 * `ORDER BY ... DESC` and Load More pages (finding F5).
 */
function windowedPreview(table: string, window: PreviewTimeWindow, capabilities: ProviderCapabilities): string {
  const column = quoteIdentifier(window.column, capabilities);
  return `-- ${window.note}\nSELECT * FROM ${table} WHERE ${column} >= ${window.since} ORDER BY ${column} DESC${terminator(capabilities)}`;
}

/**
 * The declaration's example lines as comments, `{table}` and `{column}` filled: the first `float` or `integer`
 * column, else `"value"`, each quoted. Filled through a function, so a `$&` in a name is the name; a line break in a
 * name becomes a space, so no name can end a comment line and turn its rest into a statement.
 */
function windowExamples(
  table: string,
  window: PreviewTimeWindow,
  columns: readonly ColumnSchema[],
  capabilities: ProviderCapabilities,
): string[] {
  const numeric = columns.find((c) => c.type === "float" || c.type === "integer");
  const column = quoteIdentifier(numeric?.name ?? "value", capabilities);
  return window.examples.map(
    (example) =>
      `-- ${example
        .replaceAll("{table}", () => table)
        .replaceAll("{column}", () => column)
        .replace(/[\r\n]/g, " ")}`,
  );
}

/**
 * A preview that names its columns and reads each through the declared projection (#786).
 *
 * The first rule whose `type` matches a column's declared type decides how it is read: through
 * its expression, aliased back to the column's own name so the grid's header does not change, or
 * not at all, in which case the column is named in a comment above the statement. Names in the
 * comment are JSON-quoted, as `commentName` quotes them, so no name can end the comment.
 *
 * With no column list loaded, the preview reads `*` under the declaration's own note: there is
 * no list to project, and saying so beats a statement that pretends to have one. With a list
 * whose every column is left out, the comment naming them is the whole preview: `*` would read
 * exactly the columns the declaration says cannot be read.
 */
function projectedPreview(
  table: string,
  projection: NonNullable<ProviderCapabilities["previewProjection"]>,
  columns: readonly ColumnSchema[],
  capabilities: ProviderCapabilities,
): string {
  const rules = projection.rules.map((rule) => ({ pattern: new RegExp(rule.type), expression: rule.expression }));
  const read: string[] = [];
  const omitted: string[] = [];
  for (const column of columns) {
    const rule = rules.find((candidate) => candidate.pattern.test(column.type));
    const quoted = quoteIdentifier(column.name, capabilities);
    if (rule === undefined) {
      read.push(quoted);
    } else if (rule.expression === null) {
      omitted.push(`${commentName(column.name)} ${column.type.replace(/[\r\n]/g, " ")}`);
    } else {
      read.push(`${rule.expression.replaceAll("{column}", quoted)} AS ${quoted}`);
    }
  }
  if (columns.length === 0) {
    return `-- ${projection.unprojectedNote}\nSELECT * FROM ${table}${terminator(capabilities)}`;
  }
  const comment = `-- Not read by this preview: ${omitted.join(", ")}. ${projection.omittedNote}`;
  if (read.length === 0) return comment;
  const statement = `SELECT ${read.join(", ")} FROM ${table}${terminator(capabilities)}`;
  if (omitted.length === 0) return statement;
  return `${comment}\n${statement}`;
}

/**
 * The statement behind "Generate Query", which is written into a tab and NOT run.
 *
 * Takes the object's PATH for the same reason `generateTableQuery` does, and the two stay
 * in step: a user who clicks a row and a user who asks for the statement must be handed
 * the same address.
 *
 * IT KEEPS ITS `LIMIT 100`, and #816 left it there deliberately. The bound left
 * `generateTableQuery` because that statement is RUN on the user's behalf, so its cap was
 * the product's own and had to be distinguishable from one the user typed. This one is
 * written into the editor and run only if the user presses Run, at which point it is a
 * statement they chose to execute and its bound is theirs: a hard bound, honoured, and not
 * paged past. Removing it would instead hand them an unbounded scan they never asked for.
 *
 * A dialect's or a language's row writes its own text and decides its own bound, for the same
 * reasons and in the same row as its tree click; `scope` is handed to the dialect rows only.
 */

export function generateSelectQuery(
  path: readonly string[],
  columns: readonly ColumnSchema[],
  capabilities: ProviderCapabilities,
  scope?: GeneratorScope,
): string {
  // Refuses an empty address before any row spells it.
  objectSegment(path);
  // A query dialect's own text, from its `DIALECT_GENERATORS` record, BEFORE its language's row below.
  const dialect = registeredDialect(capabilities);
  if (dialect !== undefined) return DIALECT_GENERATORS[dialect].select(path, columns, scope);
  // A language an engine writes its own text in, from its `LANGUAGE_GENERATORS` record.
  const language = languageGenerators(capabilities);
  if (language !== undefined) return language.select(path, columns, capabilities);
  const table = quoteObjectPath(path, capabilities);
  const engine = sqlPortGenerators(capabilities);
  // An SQL engine whose starter statement is its own, from its `SQL_PORT_GENERATORS` record.
  if (engine?.select !== undefined) return engine.select(table, columns, sqlFormContext(capabilities));
  // The windowed preview with its example lines below it (InfluxDB spec 6.6, I20).
  const window = capabilities.previewTimeWindow;
  if (window !== undefined) {
    return [windowedPreview(table, window, capabilities), ...windowExamples(table, window, columns, capabilities)].join(
      "\n",
    );
  }
  // Columns the engine refuses to project in a SELECT list (e.g. search mapped types like `flattened`, #1459)
  // are omitted so the starter query runs; an index holding only unprojectable columns falls back to `*`.
  const projectable = columns.filter((c) => c.projectable !== false);
  const cols = projectable.map((c) => `  ${quoteIdentifier(c.name, capabilities)}`).join(",\n") || "  *";
  // An SQL engine that spells its row bound its own way, from its `SQL_PORT_GENERATORS` record.
  if (engine?.selectList !== undefined) return engine.selectList(table, cols, sqlFormContext(capabilities));
  // A grammar with no constant predicate (CQL, #1410) gets no WHERE clause rather than one it refuses.
  const where = capabilities.supportsConstantPredicate === false ? "" : "\nWHERE 1=1";
  return `SELECT\n${cols}\nFROM ${table}${where}\nLIMIT 100${terminator(capabilities)}`;
}

/**
 * The statement a declared row action runs on one object, from the dialect's `rowAction` generator.
 *
 * Raises when the declaration names no dialect or the dialect writes no row action: a provider that
 * declares `rowActions` without a generator behind them has a broken declaration, and a menu item that
 * opened an empty tab would hide it. `registry` is the dialect record this module holds; a test passes
 * its own, because no dialect shipped beside this function writes a row action yet.
 */
export function generateRowActionQuery(
  path: readonly string[],
  actionId: string,
  capabilities: ProviderCapabilities,
  scope: GeneratorScope,
  registry: Readonly<Partial<Record<QueryDialect, DialectGenerators>>> = DIALECT_GENERATORS,
): string {
  const dialect = registeredDialect(capabilities);
  const rowAction = dialect === undefined ? undefined : registry[dialect]?.rowAction;
  if (rowAction === undefined) {
    throw new Error(
      `the ${dialect ?? capabilities.queryLanguage} dialect writes no statement for the row action "${actionId}"`,
    );
  }
  return rowAction(path, actionId, scope);
}

/**
 * Prepare an editable count statement, without a row limit or any execution (#702). A dialect's own count statement,
 * from its `DIALECT_GENERATORS` record, comes before its language's, as the other two generators' do. `registry` is
 * the record this module holds; a test passes its own to reach the refusal no shipped record triggers.
 */
export function generateCountQuery(
  path: readonly string[],
  capabilities: ProviderCapabilities,
  registry: Readonly<Partial<Record<QueryDialect, DialectGenerators>>> = DIALECT_GENERATORS,
): string | null {
  if (!offersCountQuery(capabilities)) return null;
  // Refuses an empty address before any dialect or language spells it.
  objectSegment(path);
  const dialect = registeredDialect(capabilities);
  if (dialect !== undefined) {
    const count = registry[dialect]?.count;
    if (count === undefined) {
      throw new Error(`the ${dialect} dialect offers Generate Count Query and writes no count statement`);
    }
    return count(path);
  }
  // A language that writes its own count, from its `LANGUAGE_GENERATORS` record.
  const languageCount = languageGenerators(capabilities)?.count;
  if (languageCount !== undefined) return languageCount(path, capabilities);
  // An SQL engine whose count is not `COUNT(*)`, from its `SQL_PORT_GENERATORS` record.
  const countExpression = sqlPortGenerators(capabilities)?.countExpression ?? "COUNT(*)";
  return `SELECT ${countExpression} AS row_count\nFROM ${quoteObjectPath(path, capabilities)}${terminator(capabilities)}`;
}

/**
 * The address a request carries for the object at `path`, from the row of the language the declaration names: what a
 * request written outside the generators, such as Generate Test Data's document insert, puts beside its operation.
 * Raises for a language whose requests carry no address of their own, rather than writing a request to nowhere.
 */
export function requestAddress(
  path: readonly string[],
  capabilities: ProviderCapabilities,
): Readonly<Record<string, unknown>> {
  const address = languageGenerators(capabilities)?.address;
  if (address === undefined) {
    throw new Error(`the ${capabilities.queryLanguage} language writes no request address`);
  }
  return address(path, capabilities);
}

export function shouldRefreshSchema(query: string, schemaRefreshPattern: string): boolean {
  return new RegExp(schemaRefreshPattern, "i").test(query);
}

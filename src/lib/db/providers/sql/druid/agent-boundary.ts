/**
 * The agent read-only execution profile's boundary on Apache Druid: the proof that the SQL endpoint runs the native
 * engine, sent at the open of a connection that will send statements and again before every agent statement, and the
 * fence every agent statement passes before it is sent.
 *
 * The boundary is the engine. Measured on Apache Druid 37.0.0 (`tests/fixtures/druid/37.0.0/agent-boundary/`), every
 * write on the SQL endpoint under the request context `engine: native` is refused by the server, whoever asks:
 * INSERT and REPLACE in every spelling are refused as operations the native engine does not support, an INSERT into
 * EXTERN (an export) included; UPDATE, DELETE and MERGE are unsupported statements; CREATE, DROP, ALTER and TRUNCATE
 * are not in the grammar; and a SELECT that reads EXTERN cannot be planned on the native engine (captures 01 and 06).
 * Under druid-basic-security the refusals are the same for a user holding WRITE on every datasource and for the
 * administrator, while the same INSERT through the MSQ task endpoint, which the provider never calls, writes (capture
 * 06). No least-privilege principal can be proven: a user reads its own permissions only when it holds CONFIG READ,
 * which also shows it every user's credential hash (capture 05), so the boundary rests on the engine, never the user.
 *
 * What would move the engine is the statement or the request: `SET engine = 'msq-task'` before a statement, or the
 * request context's own engine, selects another engine, and a SET also replaces the request's query id and timeout
 * (capture 01). Druid 37 refuses msq-task on this endpoint, but the provider does not lean on that. The request
 * context is written by the transport and never by the caller, and the fence below sends only a statement whose first
 * keyword is SELECT or WITH, so no SET reaches the server.
 *
 * The proof (`verifyDruidAgentEngine`) sends one INSERT into a datasource whose name carries a fresh random suffix,
 * under the agent request's own context, and admits the server only when it answers the native engine's own refusal,
 * category INVALID_INPUT and those exact words. A server that ran the INSERT does not enforce the engine; any other
 * answer is one this check has not measured; both refuse the profile. A failure to reach the server leaves as it came.
 */
import { ExecutionProfileError } from "../../../errors";
import { hasLoneCarriageReturnInLineComment, readSqlSpan } from "@/lib/sql/spans";
import { DRUID_SQL_GRAMMAR } from "./sql-grammar";
import { type DruidQueryResult, type DruidRow, DruidTransportError } from "./transport";

/** Sends one statement under the agent request's context and answers its result, or throws the server's refusal. */
export type DruidAgentProbe = (sql: string) => Promise<DruidQueryResult>;

/** The native engine's refusal of an INSERT, word for word as Druid 37.0.0 answers it (captures 01 and 06). */
const NATIVE_INSERT_REFUSAL =
  "INSERT operations are not supported by requested SQL engine [native], consider using MSQ.";

/** What every refusal of the check starts with. */
const NEEDS_NATIVE =
  "The agent read-only execution profile needs the Druid SQL endpoint's native engine, which refuses every INSERT";

/** The probe: an INSERT into one datasource named with a fresh suffix, which no one holds. */
export function druidAgentProbeStatement(nonce: string): string {
  return `INSERT INTO "libredb_agent_probe_${nonce}" SELECT TIME_PARSE('2026-01-01') AS __time PARTITIONED BY ALL`;
}

/**
 * The proof that the endpoint runs the native engine: `probe` sends the INSERT, which the server must refuse with the
 * native engine's own refusal. Resolves when it does; refuses the profile on any other answer.
 */
export async function verifyDruidAgentEngine(probe: DruidAgentProbe, nonce: string): Promise<void> {
  try {
    await probe(druidAgentProbeStatement(nonce));
  } catch (error) {
    if (!(error instanceof DruidTransportError) || !error.isServerAnswer()) throw error;
    if (error.is("INVALID_INPUT") && error.message === NATIVE_INSERT_REFUSAL) return;
    throw new ExecutionProfileError(
      `${NEEDS_NATIVE}; this server answered the probe with ${JSON.stringify(error.message)}, which is not that refusal, so its enforcement is unmeasured, and the connection is refused.`,
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  throw new ExecutionProfileError(
    `${NEEDS_NATIVE}; this server ran one, so it does not enforce it, and the connection is refused.`,
    "PROFILE_SERVER_UNENFORCED",
  );
}

/** What every fence refusal starts with. */
const FENCE =
  "The agent read-only execution profile sends one Druid SQL statement, a SELECT (a WITH before it is fine), and nothing else";

/** The statement's first keyword, read from its first code character, case aside and not a longer word. */
const FIRST_KEYWORD = /^(?:select|with)(?![\w$])/i;

/**
 * The fence in front of every agent statement: `null` when `sql` is one statement whose first keyword is SELECT or
 * WITH, else the reason it is refused, before anything is sent. A SET before a statement selects another engine and
 * replaces the request's query id and timeout (capture 01), so only a SELECT is sent.
 *
 * The text is walked with the shared span reader under Druid's own grammar (`sql-grammar.ts`), so `--`, `//` and
 * block comments and whitespace are skipped, and string literals and double-quoted names are opaque. The first code
 * character must open SELECT or WITH; a code semicolon ends the statement, and only comments and whitespace may follow
 * it. A hint (`/*+ ... *\/`) and an array's brackets are read as code, a literal inside them still opaque, so a
 * semicolon there ends the statement too. Text that ends inside a comment, string or quoted name cannot be bounded and
 * is refused: that includes a plain literal ending in a backslash, which Druid closes and the reader cannot place
 * (capture 02), so it refuses rather than guesses.
 *
 * Two readings where the server and a reader can differ are refused before the walk. A carriage return inside a `--`
 * or `//` comment with more text after it ends the comment on the server (capture 02), as it does in the grammar the
 * walk reads, but a reader that runs the comment on to the line feed reads a different statement. And a `$$` run is a
 * string to the reader but part of a name to Druid, which reads `$` as a letter (capture 02), so a comment inside it is
 * code to one and text to the other. A form feed, U+2028 and U+0085 end no comment on the server.
 */
export function druidAgentStatementRefusal(sql: string): string | null {
  const grammar = DRUID_SQL_GRAMMAR.grammar;
  if (hasLoneCarriageReturnInLineComment(sql, grammar)) {
    return `${FENCE}; this text holds a carriage return inside a -- or // comment with more text after it, and the server ends the comment at that carriage return, so a reader that does not could read another statement, and it was not sent. End a comment with a line feed.`;
  }
  let opened = false;
  let ended = false;
  for (let at = 0; at < sql.length; ) {
    const span = readSqlSpan(sql, at, grammar);
    if (span !== null && span.kind !== "subscript") {
      if (!span.terminated) {
        return `${FENCE}; this text ends inside a comment, a string or a quoted name, so where it ends cannot be read, and it was not sent.`;
      }
      const trivia = span.kind === "whitespace" || span.kind === "line-comment" || span.kind === "block-comment";
      if (!trivia) {
        if (!opened) return notSelect();
        if (ended) return goesOn();
        if (span.kind === "dollar-string") {
          return `${FENCE}; this text holds a dollar-quoted run ($$ ... $$), which Druid reads as part of a name rather than as a string, so where its comments end cannot be read, and it was not sent.`;
        }
      }
      at = span.end;
      continue;
    }
    if (ended) return goesOn();
    if (!opened) {
      if (!FIRST_KEYWORD.test(sql.slice(at, at + 7))) return notSelect();
      opened = true;
    }
    if (sql[at] === ";") ended = true;
    at++;
  }
  if (!opened) return `${FENCE}; this text holds no statement, so nothing was sent.`;
  if (spellsEscapedName(sql)) return escapedName();
  return readsBeyondDatasources(sql) ? outsideDatasources() : null;
}

/**
 * Whether the text holds a quoted name spelled with Unicode escapes, `U&"..."` in any case: Druid reads
 * `U&"\0073ys".segments` as `sys.segments` (capture 08), so the fence, which compares names as written, refuses the
 * spelling rather than decode it. A `U&'...'` string literal is a value, not a name, and passes.
 */
function spellsEscapedName(sql: string): boolean {
  const grammar = DRUID_SQL_GRAMMAR.grammar;
  for (let at = 0; at < sql.length; ) {
    const span = readSqlSpan(sql, at, grammar);
    if (span !== null && span.kind !== "subscript") {
      if (span.kind === "quoted-identifier" && /u&$/i.test(sql.slice(Math.max(0, at - 2), at))) return true;
      at = span.end;
      continue;
    }
    at++;
  }
  return false;
}

function escapedName(): string {
  return `${FENCE}; this statement spells a quoted name with Unicode escapes (U&"..."), which the server reads as another name, so it was not sent. Write the name itself.`;
}

/** A name in code: a run of identifier characters, `$` among them, as `FIRST_KEYWORD` bounds a word. */
const NAME_CHARACTER = /[\w$]/;

/** The schemas whose tables answer the cluster's own state, lookups and views rather than a datasource's rows. */
const CLUSTER_SCHEMAS = new Set(["sys", "lookup", "view"]);

/**
 * Whether the text reads beyond the datasources: it names the `sys`, `lookup` or `view` schema, a name followed by a
 * dot, or calls `LOOKUP`, a name followed by an opening parenthesis; bare or double-quoted, in any case, and with
 * comments and whitespace around the dot or the parenthesis. Measured on Druid 37.0.0: the server filters
 * `sys.segments`, `sys.tasks` and `sys.supervisors` to the datasources a user may read but answers their segment, task
 * and supervisor payloads, `sys.servers` and its siblings to a user holding STATE READ and to every caller with
 * security off, and a lookup to anyone. Comments and string literals are skipped as the fence reads them, and a
 * datasource or column that is merely called `sys` or `lookup` is not followed by a dot. The planner's own list of
 * what a statement reads is checked before it is sent as well, so this reading is not the only layer.
 */
function readsBeyondDatasources(sql: string): boolean {
  const grammar = DRUID_SQL_GRAMMAR.grammar;
  // The last code token: a name (lowercased), or null for anything else.
  let last: string | null = null;
  for (let at = 0; at < sql.length; ) {
    const span = readSqlSpan(sql, at, grammar);
    if (span !== null && span.kind !== "subscript") {
      if (span.kind === "quoted-identifier") {
        last = sql
          .slice(at + 1, span.end - 1)
          .replaceAll('""', '"')
          .toLowerCase();
      } else if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") {
        last = null;
      }
      at = span.end;
      continue;
    }
    const character = sql[at] ?? "";
    if (NAME_CHARACTER.test(character)) {
      let end = at + 1;
      while (end < sql.length && NAME_CHARACTER.test(sql[end] ?? "")) end++;
      last = sql.slice(at, end).toLowerCase();
      at = end;
      continue;
    }
    if (character === "." && last !== null && CLUSTER_SCHEMAS.has(last)) return true;
    if (character === "(" && last === "lookup") return true;
    last = null;
    at++;
  }
  return false;
}

function outsideDatasources(): string {
  return `${FENCE}; this statement reads the sys, lookup or view schema or calls LOOKUP, which answer the cluster's own servers, segments, tasks, supervisors, lookups or views rather than a datasource's rows, so it was not sent. Read the datasources themselves.`;
}

function notSelect(): string {
  return `${FENCE}; this statement does not begin with SELECT or WITH, so it was not sent. A SET before a statement changes the request's own context, the engine and the query id among them, so only a SELECT reaches the server.`;
}

function goesOn(): string {
  return `${FENCE}; this text goes on after its first statement's semicolon, so it was not sent. Send one SELECT at a time.`;
}

/** The refusal of a statement whose plan, as the planner answered it, cannot be read. */
export const DRUID_UNREADABLE_PLAN_REFUSAL = `${FENCE}; the planner's account of what this statement reads could not be read, so it was not sent.`;

/**
 * The statement that asks the planner what `sql` reads: Druid's EXPLAIN never runs the statement it plans. The prefix
 * takes a line of its own, so a position the planner reports in the statement keeps its column, one line further down
 * (`druidAgentPlanMessage`).
 */
export function druidAgentExplainStatement(sql: string): string {
  return `EXPLAIN PLAN FOR\n${sql}`;
}

/**
 * The planner's refusal of `EXPLAIN PLAN FOR` the statement, each position in it moved back onto the statement's own
 * line, so the agent repairs the statement from where the statement itself would have been refused. Measured on 37.0.0:
 * Druid writes a position as `(line [L], column [C])`, counted over the whole text it received, and `SELECT nope`
 * answers line 1, column 8 sent raw and line 2, column 8 after the prefix's line. A position on the prefix's own line
 * is not one in the statement and stays as the server wrote it.
 */
export function druidAgentPlanMessage(message: string): string {
  return message.replace(/\(line \[(\d+)\], column \[(\d+)\]\)/g, (position, line: string, column: string) =>
    Number(line) > 1 ? `(line [${Number(line) - 1}], column [${column}])` : position,
  );
}

/** The dataSource types a statement over datasources plans into (capture 08); any other type is refused. */
const PLAN_DATA_SOURCES = new Set(["table", "inline", "query", "join", "union", "unnest"]);

/** Far past the deepest real plan (a join whose right side is a subquery over a table), so only a runaway stops it. */
const MAX_PLAN_DEPTH = 32;

/** The schema whose Calcite scans a statement may plan into: INFORMATION_SCHEMA, which the server filters per user. */
const CATALOG_SCHEMA = "INFORMATION_SCHEMA";

/** One line of a Calcite plan, as Druid answers a read of INFORMATION_SCHEMA or `sys` (capture 08). */
const CALCITE_LINE = /^ *Bindable[A-Za-z]+\(/;
/** A line that reads a table, in whatever shape: each must be a scan in the one shape Calcite writes it. */
const CALCITE_READS = /Scan\(/;
const CALCITE_SCAN = /^ *BindableTableScan\(table=\[\[([^,\]]+), ([^\]]+)\]\]/;

/** A refusal while the plan is walked: what the statement reads, or null when the plan cannot be read. */
class PlanRefusal extends Error {
  constructor(readonly reads: string | null) {
    super(reads ?? "unreadable");
  }
}

/**
 * The second layer in front of every agent statement, which does not read the statement's text: the planner's own
 * answer to `EXPLAIN PLAN FOR` the statement (`druidAgentExplainStatement`), sent as the same user just before the
 * statement, `null` when everything it reads is a datasource, else the reason it is refused.
 *
 * Measured on Druid 37.0.0 (capture 08): a statement over datasources plans into a native query whose dataSource tree
 * names each one (`table`), with inline rows (`inline`), subqueries (`query`), joins, unions and unnests between them,
 * and its RESOURCES list names each datasource as a DATASOURCE; a read of a lookup plans into a `lookup` dataSource,
 * and the lookup function over a column into a `lookup(...)` expression, neither of them in RESOURCES; a read of a
 * system table or of INFORMATION_SCHEMA plans into Calcite's own scan, a text plan whose `BindableTableScan` lines name
 * the schema and table, `sys` included, however the statement spelled them (`U&"\0073ys"` reads as `sys`).
 *
 * So the statement is admitted only when RESOURCES lists only DATASOURCE resources, and the plan is either a native
 * plan whose every dataSource is one of the types above, every `table` among them one RESOURCES lists, with no lookup
 * function anywhere in it, or a Calcite plan of `Bindable` lines whose every scan reads INFORMATION_SCHEMA, which the
 * server filters to the datasources the user may read. Anything else, a plan that cannot be read included, is refused.
 *
 * What it cannot see: the planner evaluates the lookup function on a literal key while it plans, and rewrites a filter
 * on the lookup function into one on the keys it maps from, so neither plan shows a lookup; the statement fence above
 * refuses every `LOOKUP` call by name.
 */
export function druidAgentReachRefusal(answer: DruidQueryResult): string | null {
  try {
    const row = onlyRow(answer.rows);
    const datasources = resourceDatasources(row.RESOURCES);
    const plan = row.PLAN;
    if (typeof plan !== "string") throw new PlanRefusal(null);
    const native = parseJson(plan);
    if (native === undefined) readCalcitePlan(plan);
    else readNativePlan(native, datasources);
    return null;
  } catch (error) {
    if (!(error instanceof PlanRefusal)) throw error;
    return error.reads === null
      ? DRUID_UNREADABLE_PLAN_REFUSAL
      : `${FENCE}; the planner says this statement reads ${error.reads}, which is not a datasource, so it was not sent. Read the datasources themselves.`;
  }
}

function onlyRow(rows: DruidRow[]): DruidRow {
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) throw new PlanRefusal(null);
  return row;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The datasources RESOURCES lists; any resource of another type refuses the statement. */
function resourceDatasources(cell: unknown): Set<string> {
  const resources = typeof cell === "string" ? parseJson(cell) : undefined;
  if (!Array.isArray(resources)) throw new PlanRefusal(null);
  const names = new Set<string>();
  for (const resource of resources) {
    if (!isRecord(resource) || typeof resource.name !== "string" || typeof resource.type !== "string") {
      throw new PlanRefusal(null);
    }
    if (resource.type !== "DATASOURCE") throw new PlanRefusal(`the ${resource.type} ${resource.name}`);
    names.add(resource.name);
  }
  return names;
}

/**
 * A Calcite plan: only `Bindable` lines, and every line that scans anything a `BindableTableScan` of
 * `table=[[schema, table]]` on INFORMATION_SCHEMA; a scan in any other shape is a plan this cannot read. A plan with no scan reads no table: the
 * planner answers a filter it proves empty, such as the agent's relation read (`WHERE 1 = 0`), with
 * `BindableValues(tuples=[[]])` (measured on 37.0.0).
 */
function readCalcitePlan(plan: string): void {
  const lines = plan.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0 || !lines.every((line) => CALCITE_LINE.test(line))) throw new PlanRefusal(null);
  for (const line of lines) {
    if (!CALCITE_READS.test(line)) continue;
    const scan = CALCITE_SCAN.exec(line);
    if (scan === null) throw new PlanRefusal(null);
    const [, schema, table] = scan;
    if (schema !== CATALOG_SCHEMA) throw new PlanRefusal(`the table ${schema}.${table}`);
  }
}

/** A native plan: a non-empty list of entries, each holding the native query it runs. */
function readNativePlan(plan: unknown, datasources: Set<string>): void {
  if (!Array.isArray(plan) || plan.length === 0) throw new PlanRefusal(null);
  for (const entry of plan) {
    if (!isRecord(entry)) throw new PlanRefusal(null);
    readQuery(entry.query, datasources, 0);
  }
}

function readQuery(query: unknown, datasources: Set<string>, depth: number): void {
  if (!isRecord(query)) throw new PlanRefusal(null);
  readDataSource(query.dataSource, datasources, depth + 1);
  if (callsLookup(query)) throw new PlanRefusal("a lookup, through the lookup function");
}

function readDataSource(dataSource: unknown, datasources: Set<string>, depth: number): void {
  if (depth > MAX_PLAN_DEPTH || !isRecord(dataSource) || typeof dataSource.type !== "string") {
    throw new PlanRefusal(null);
  }
  const { type } = dataSource;
  if (type === "lookup") {
    if (typeof dataSource.lookup !== "string") throw new PlanRefusal(null);
    throw new PlanRefusal(`the lookup ${dataSource.lookup}`);
  }
  if (!PLAN_DATA_SOURCES.has(type)) throw new PlanRefusal(`a dataSource of type ${type}`);
  if (type === "table") {
    if (typeof dataSource.name !== "string") throw new PlanRefusal(null);
    if (!datasources.has(dataSource.name)) {
      throw new PlanRefusal(
        `the table ${dataSource.name}, which it does not list among the datasources the statement reads`,
      );
    }
  } else if (type === "query") {
    readQuery(dataSource.query, datasources, depth);
  } else if (type === "join") {
    readDataSource(dataSource.left, datasources, depth + 1);
    readDataSource(dataSource.right, datasources, depth + 1);
  } else if (type === "union") {
    if (!Array.isArray(dataSource.dataSources)) throw new PlanRefusal(null);
    for (const member of dataSource.dataSources) readDataSource(member, datasources, depth + 1);
  } else if (type === "unnest") {
    readDataSource(dataSource.base, datasources, depth + 1);
  }
}

/**
 * Whether a native query uses a lookup anywhere in it, its dataSources included: a `lookup(...)` call in any string, or
 * an object of type `registeredLookup` or `lookup`, an extraction as much as a dataSource. Measured on 37.0.0: the
 * lookup function over a column plans into an expression virtual column, `lookup("s",'name')`. A string value that
 * merely holds those words refuses the statement too.
 */
function callsLookup(value: unknown): boolean {
  if (typeof value === "string") return /\blookup\s*\(/i.test(value);
  if (Array.isArray(value)) return value.some(callsLookup);
  if (!isRecord(value)) return false;
  if (value.type === "registeredLookup" || value.type === "lookup") return true;
  return Object.values(value).some(callsLookup);
}

/**
 * MySQL Database Provider
 * Full MySQL support with connection pooling using mysql2
 */

import { randomUUID } from "node:crypto";
import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
  type FieldPacket,
  type QueryOptions,
  type ResultSetHeader,
} from "mysql2/promise";
import { SQLBaseProvider } from "./sql-base";
import { mysqlColumnTypes } from "./column-types";
import { uniqueFieldNames } from "../../utils/result-fields";
import { keyRowsByPosition } from "../../utils/positional-rows";
import {
  type ColumnSchema,
  type Container,
  type ContainerLevelSpec,
  type DatabaseConnection,
  type DatabaseObject,
  type ForeignKeySchema,
  type IndexSchema,
  type KindCount,
  type ObjectDetail,
  type DescribeObjectsOptions,
  type ObjectDetailBatch,
  type ObjectKindSpec,
  type ObjectSourceDocument,
  type ObjectSourceForm,
  type ObjectSourceOrigin,
  type ObjectSourcePart,
  type QueryResult,
  type HealthInfo,
  type MaintenanceDeclaration,
  type MaintenanceOperation,
  type MaintenanceType,
  type MaintenanceResult,
  type MeasuredMaintenancePlacements,
  narrowMaintenance,
  type ProviderOptions,
  type ProviderCapabilities,
  type ExplainFormat,
  type ProviderLabels,
  type SlowQuery,
  type ActiveSession,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
  type BeginTransactionOptions,
  type BeginTransactionResult,
} from "../../types";
import {
  DatabaseConfigError,
  ConnectionError,
  ExecutionProfileError,
  QueryError,
  mapDatabaseError,
  NO_TRANSACTION_OPENED,
  TRANSACTION_STATE_UNREPORTED,
  MYSQL_ACCOUNT_LIMIT_ERRNOS,
} from "../../errors";
import type { ProviderExecutionContext, ReadOnlyStatementBudget, ReadOnlyStatementMode } from "../../types";
import { assertReadOnlyBudget, measureResultBytes } from "./read-only-budget";
import {
  applySourceBound,
  assertContainerPathShape,
  assertObjectPathShape,
  type ObjectPathShapeEngine,
  callerBoundTruncationReason,
  containerDepth,
  type ContainerPathShapeEngine,
  declaredKinds,
  findKind,
  requireSourceKind,
} from "../../object-kinds";
import { comparePaths } from "../../object-path";
import { formatBytes } from "../../utils/pool-manager";
import { measuredNullableAggregate } from "../../utils/measured-aggregate";
import { CACHE_HIT_RATIO_UNAVAILABLE, formatCacheHitRatio, measuredNumber } from "@/lib/monitoring-cache-ratio";
import { unquoteLiteral } from "@/lib/sql/values";
import type { QueryResultSet } from "@/lib/types";
import { portableDefaultSql, showCreateColumnDefaults } from "./mysql-show-create";

/**
 * MySQL's identity for the shared container-path renderer.
 *
 * Which paths this engine accepts is not a field here: it is `containerPathShapes` in
 * `getCapabilities()`, which the object routes read too (#1147).
 */
const MYSQL_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: "mysql",
  label: "A MySQL",
  shapeNames: "label",
};

/**
 * mysql2 3.23 narrowed `execute`'s values parameter from `any` to a concrete
 * `ExecuteValues` union that excludes `undefined`. The provider interface every
 * driver implements passes `unknown[]` - it cannot be narrowed here without
 * narrowing it for MongoDB and Redis too - so the array is cast at this one
 * boundary.
 *
 * The cast changes nothing about what reaches the server: mysql2 validates
 * every bind value itself and REJECTS `undefined` outright ("Bind parameters
 * must not contain undefined. To pass SQL NULL specify JS null", thrown from
 * lib/base/connection.js). It is not coerced to NULL, before or after this
 * change - callers wanting SQL NULL must pass `null`. The new typing states
 * that rule; this cast keeps the runtime rule as the thing that enforces it.
 *
 * Derived from the method signature rather than importing `ExecuteValues` by
 * name, so a future rename in mysql2 surfaces as a type error here instead of
 * an unresolved import.
 */
type ExecuteParams = Parameters<PoolConnection["execute"]>[1];
const asExecuteParams = (params?: unknown[]): ExecuteParams => params as ExecuteParams;

/**
 * Anything this provider can issue a statement over: the pool, a pooled
 * connection, and the connection a transaction holds. All three are used.
 */
type MySQLQueryable = Pick<PoolConnection, "query" | "execute">;

/**
 * Every statement this provider issues goes through here, and the protocol is
 * chosen by one fact: whether the statement carries parameters.
 *
 * mysql2 offers two: `query` speaks MySQL's TEXT protocol, `execute` the BINARY
 * PREPARED one. Everything here used to call `execute`, parameterless statements
 * included, and three engines refuse whole statement classes on that protocol
 * with `This command is not supported in the prepared statement protocol yet`:
 *
 * - SingleStore 9.1.1 (`ghcr.io/singlestore-labs/singlestoredb-dev:0.2.82`),
 *   measured 2026-08-24 both ways over one connection: `SHOW STATUS`,
 *   `SHOW VARIABLES`, `EXPLAIN`, `EXPLAIN JSON`, `OPTIMIZE TABLE` and
 *   `CHECK TABLE` all fail prepared with `ER_UNSUPPORTED_PS` and all succeed as
 *   text. `EXPLAIN FORMAT=JSON` is NOT in that list: it is `ER_PARSE_ERROR` on
 *   both protocols there, because SingleStore's grammar is `EXPLAIN JSON`, so the
 *   Explain panel is not something this helper recovers. What recovers it is
 *   `probeExplainFormat()` below: the grammar is measured at connect and declared
 *   as a capability, so an engine that refuses `EXPLAIN FORMAT=JSON` gets the
 *   plain `EXPLAIN` of the `mysql-text` strategy instead of a failing panel.
 * - StarRocks 3.3, whose overview this recovers (measured through the provider,
 *   2026-08-24); its health still fails on a missing
 *   `information_schema.PROCESSLIST`, which is the engine's gap, not the protocol.
 * - MySQL 26.7.0 itself refuses `CHECK TABLE` prepared - measured 2026-08-24 on
 *   `mysql:latest` - so one maintenance action was unavailable on the engine this
 *   provider is named for.
 *
 * A parameterised statement keeps `execute`: the placeholders are what the
 * prepared protocol is for, and binding is what keeps a value out of the SQL text.
 * An empty array carries no parameter and is nothing to bind, so it takes the text
 * path with the parameterless statements.
 *
 * Moving the read path across is safe because the two protocols decode to the same
 * JS shapes. Measured 2026-08-24 on MySQL 26.7.0 over one connection, the same
 * SELECT both ways across TINYINT(1), INT, BIGINT past 2^53, BIGINT UNSIGNED,
 * DECIMAL, FLOAT, DOUBLE, DATE, DATETIME, TIMESTAMP, TIME, YEAR, CHAR, VARCHAR,
 * TEXT, BLOB, BIT(1), BIT(8), JSON, ENUM, SET and NULLs: every value identical by
 * `typeof` and by `JSON.stringify`, every `FieldPacket` identical in `columnType`,
 * `flags`, `characterSet`, `columnLength` and `decimals` - so `columnTypes` names
 * the same types - and a non-result-set statement answers the same
 * `ResultSetHeader`, which is what `buildQueryResult` reads. See
 * `docs/providers/mysql.md` section 3.4.
 *
 * The one exception is a server that refuses COM_STMT_PREPARE itself, which
 * `probeClientSideBinding()` measures at connect: there a parameterised statement is
 * written out by `bindClientSide()` and goes over the text protocol like any other.
 * A server that prepares some statements and refuses others is met per statement, by
 * `bindAfterRefusedPrepare()` (#1403).
 *
 * `arrayRows` asks for each row as its values in column order (`rowsAsArray`), on every one of
 * those paths. A user's statement is read that way, see `buildQueryResult`; the provider's own
 * reads keep object rows, because they read columns by the names they wrote themselves.
 */
const runStatement = <T extends RowDataPacket[] = RowDataPacket[]>(
  queryable: MySQLQueryable,
  sql: string,
  params?: unknown[],
  arrayRows = false,
): Promise<[T, FieldPacket[]]> => {
  const core = (queryable as { connection?: object }).connection;
  if (core !== undefined && BINDS_CLIENT_SIDE.has(core) && params !== undefined && params.length > 0) {
    return runBoundClientSide<T>(queryable, core as CoreConnection, sql, params, arrayRows);
  }
  const prepared = (answer: Promise<[T, FieldPacket[]]>, values: unknown[]): Promise<[T, FieldPacket[]]> =>
    core === undefined
      ? answer
      : answer.catch((error: unknown) =>
          bindAfterRefusedPrepare<T>(error, queryable, core as CoreConnection, sql, values, arrayRows),
        );
  if (core !== undefined && UTF8_UNDER_UTF8MB3.has(core)) {
    const answer = runReadingUtf8mb3AsUtf8<T>(core as CoreConnection, statementOf(sql, arrayRows), params);
    return params === undefined || params.length === 0 ? answer : prepared(answer, params);
  }
  // Two calls each rather than one over `statementOf()`: mysql2 types the text and the options
  // object as two overloads, and the provider's own reads keep sending the bare text.
  if (params === undefined || params.length === 0) {
    return arrayRows ? queryable.query<T>({ sql, rowsAsArray: true }) : queryable.query<T>(sql);
  }
  return prepared(
    arrayRows
      ? queryable.execute<T>({ sql, rowsAsArray: true }, asExecuteParams(params))
      : queryable.execute<T>(sql, asExecuteParams(params)),
    params,
  );
};

/** The statement as mysql2 takes it: the bare text, or with `rowsAsArray` when array rows are asked for. */
const statementOf = (sql: string, arrayRows: boolean): string | QueryOptions =>
  arrayRows ? { sql, rowsAsArray: true } : sql;

/**
 * The core (callback) connections of a pool whose server refuses COM_STMT_PREPARE, see
 * `probeClientSideBinding()`. Filled from that pool's `acquire` event, the same way and for
 * the same reason as `UTF8_UNDER_UTF8MB3`: only the pool that was measured is touched.
 */
const BINDS_CLIENT_SIDE = new WeakSet<object>();

/**
 * A string as a single-quoted literal that no value can close, whichever way the session
 * reads a backslash: a quote is DOUBLED (`''`), a backslash is written as `\\`, and every
 * other character is written as itself.
 *
 * Doubling is what makes it safe in both modes. A session can turn `NO_BACKSLASH_ESCAPES` on
 * after connect - one `SET SESSION sql_mode = ...` from the editor stays on its pooled
 * connection, and a `SET GLOBAL` reaches every connection opened after it - and there a
 * backslash is an ordinary character, so a `\'` escape would END the literal and the rest of
 * the value would run as SQL. `''` is a quote inside the literal in both modes. The cost in
 * that mode is that `\\` reads as two backslashes, which is corruption rather than injection,
 * and `runBoundClientSide()` refuses a value holding a backslash before it can happen.
 *
 * Not mysql2's own escaper, which also writes `\0`, `\b`, `\n`, `\r`, `\t`, `\Z` and `\"`, and
 * that is a measured choice. On Databend 1.2.881 and 1.2.925-patch-11 (2026-10-04), across a
 * SELECT, an INSERT, a WHERE match and an UPDATE, the escaper's literal came back changed for
 * three characters: `\Z` (0x1a) reads as a backslash and a `Z` everywhere, and `\b` and `\"`
 * read the same way in an INSERT, so an inline edit of a value holding a double quote would
 * have stored a backslash in front of it. This literal round-tripped all nine of those
 * characters, `''` and `\\` included, byte for byte in all four statements on both versions
 * and on MySQL 26.7.0, and `probeClientSideBinding()` requires it back unchanged before any
 * pool binds this way.
 */
function stringLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** A number as its literal. A negative one starts with a space, so `-?` never writes `--5`, a comment. */
function numberLiteral(value: number | bigint): unknown {
  return value < 0 ? { toSqlString: () => ` ${String(value)}` } : value;
}

/**
 * One bound value as what replaces its placeholder, or a refusal.
 *
 * The values a statement can carry here are the JSON scalars `readBoundParams` admits at the
 * API boundary plus the strings and numbers this provider binds itself. Anything else (an
 * object, a Buffer, a Date, `undefined`, a number that is not finite) has no literal this
 * provider has measured, so it is refused rather than handed to a formatter that would expand
 * an object into `key = value` pairs or write `NaN` as an identifier.
 */
function clientSideValue(value: unknown): unknown {
  if (typeof value === "string") return { toSqlString: () => stringLiteral(value) };
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "bigint" || (typeof value === "number" && Number.isFinite(value))) return numberLiteral(value);
  throw new QueryError(
    `This server cannot prepare statements, so values are written into the statement text, and a ${typeof value} value has no literal form here.`,
    "mysql",
  );
}

/** What the formatter writes for each `?` (a value) and each `??` (an identifier) while they are counted. */
const PLACEHOLDER_MARK = "\u0001";
const IDENTIFIER_MARK = "\u0002";
const PLACEHOLDER_MARKER = { toSqlString: () => PLACEHOLDER_MARK, toString: () => IDENTIFIER_MARK };

const occurrences = (text: string, mark: string): number => text.split(mark).length - 1;

/**
 * The statement with its values written in, for a pool whose server refuses to prepare.
 *
 * mysql2's formatter finds the placeholders, skipping single-quoted strings, backtick
 * identifiers and `--` and block comments. It does NOT skip a double-quoted string or a `#`
 * comment, where a server preparing the statement would not see a placeholder, so
 * `SELECT "a?", ?` would put the value inside the double-quoted text; and it reads `??` as an
 * identifier placeholder, which a server preparing the statement does not have. So the
 * statement is formatted with markers first, one more than there are values, and refused with
 * a sentence naming the cause when the formatter found a `??`, or a number of value
 * placeholders different from the number of values, instead of being sent with a value in the
 * wrong place.
 */
function bindClientSide(core: CoreConnection, sql: string, params: unknown[]): string {
  const marked = core.format(
    sql,
    Array.from({ length: params.length + 1 }, () => PLACEHOLDER_MARKER),
  );
  const identifiers = occurrences(marked, IDENTIFIER_MARK) - occurrences(sql, IDENTIFIER_MARK);
  const found = occurrences(marked, PLACEHOLDER_MARK) - occurrences(sql, PLACEHOLDER_MARK);
  if (identifiers > 0 || found !== params.length) {
    throw new QueryError(
      `This server cannot prepare statements, so values are written into the statement text, and the statement has ${found} value placeholders for ${params.length} values${identifiers > 0 ? " and a ?? identifier placeholder" : ""}. A ? inside a double-quoted string or after # counts as a placeholder there, and ?? cannot be bound; write the statement without them.`,
      "mysql",
    );
  }
  return core.format(sql, params.map(clientSideValue));
}

/** `'a\\b'`: one backslash in a session that reads backslash escapes, two in one that does not. */
const BACKSLASH_CHECK_SQL = "SELECT 'a\\\\b' AS backslash";

/**
 * Run a statement whose values `bindClientSide()` writes in.
 *
 * A value holding a backslash is written as `\\`, which reads back as itself only in a session
 * that reads backslash escapes. Whether this session does can change after connect, so for such
 * a value the session is asked first, on the same connection, and the statement is refused
 * rather than sent when it reads backslashes verbatim: the value would be stored with every
 * backslash doubled. No value can close its literal either way (`stringLiteral()`), so this is
 * about not corrupting a value, and the extra round trip is spent only on a value that has one.
 */
async function runBoundClientSide<T extends RowDataPacket[]>(
  queryable: MySQLQueryable,
  core: CoreConnection,
  sql: string,
  params: unknown[],
  arrayRows: boolean,
): Promise<[T, FieldPacket[]]> {
  const text = bindClientSide(core, sql, params);
  if (params.some((value) => typeof value === "string" && value.includes("\\"))) {
    const [rows] = await queryable.query<RowDataPacket[]>(BACKSLASH_CHECK_SQL);
    if (rows[0]?.backslash !== "a\\b") {
      throw new QueryError(
        "This server cannot prepare statements, so values are written into the statement text, and this session reads a backslash as an ordinary character (NO_BACKSLASH_ESCAPES), so a value holding a backslash would be stored changed. Turn NO_BACKSLASH_ESCAPES off for the session, or send the value without a backslash.",
        "mysql",
      );
    }
  }
  return runStatement<T>(queryable, text, undefined, arrayRows);
}

/**
 * The value the binding probe sends: the nine characters mysql2's escaper writes a backslash
 * in front of (NUL, backspace, tab, newline, carriage return, 0x1a, the double quote, the
 * quote and the backslash), so a server that reads it back unchanged reads `stringLiteral()`
 * the way it is written, the doubled quote and the escaped backslash included.
 */
const BINDING_PROBE_VALUE = "\0\b\t\n\r\x1a\"'\\ probe";

/** `max_prepared_stmt_count` reached: a MySQL server that prepares, out of slots for now. */
const ER_MAX_PREPARED_STMT_COUNT_REACHED = 1461;

/**
 * Whether this server refuses COM_STMT_PREPARE and reads `stringLiteral()` back exactly, in
 * which case a parameterised statement is sent as text with its values written in. Run once
 * per `connect()`, on the connection the pool check already holds.
 *
 * Databend's MySQL handler implements no prepared statement at all: measured 2026-10-04 on
 * `datafuselabs/databend:latest` (1.2.881) through mysql2 3.24.4, `execute("SELECT ? AS x", [1])`,
 * `prepare()` and even a parameterless `execute` all answer errno 1105 `Prepare is not support in
 * Databend.`, while the same values written into the text answer intact. So every read here that
 * carries a placeholder - the whole object browser and every statistics panel - failed there,
 * and the catalogs they read were there all along.
 *
 * Two questions, and both must answer:
 *
 * 1. Does the server refuse to prepare, for good? A server that prepares keeps the prepared
 *    path, because binding on the server is what keeps a value out of the SQL text. MySQL 26.7.0
 *    and StarRocks 4.1.6 prepare `SELECT ?` (measured the same day), and so does every relative
 *    whose parameterised reads already answered, because those reads prepare. The family shares
 *    no errno for a refusal, so the errno does not have to name one; but a decision that lasts
 *    the pool's lifetime is not taken on a passing failure. A `fatal` error (the connection
 *    itself failed) and errno 1461 (`max_prepared_stmt_count`, a server that prepares and is out
 *    of slots for now) keep the prepared path, and any other refusal has to repeat on a second
 *    attempt before it counts.
 * 2. Does the written literal come back unchanged? The probe sends `stringLiteral()` of a value
 *    holding every character an escaper touches. A server that reads anything else back keeps
 *    the prepared path and its refusal. A session that turns `NO_BACKSLASH_ESCAPES` on LATER is
 *    not caught here, and does not need to be: `stringLiteral()` cannot be closed by a value in
 *    either mode, and `runBoundClientSide()` refuses a value holding a backslash in such a session.
 *
 * The refusal that switched a pool over is logged with its errno. Nothing here rejects.
 */
const probeClientSideBinding = async (queryable: MySQLQueryable): Promise<boolean> => {
  const prepares = async (): Promise<unknown> => {
    try {
      await queryable.execute("SELECT ? AS bound", [1]);
      return undefined;
    } catch (error) {
      return error ?? new Error("refused");
    }
  };
  const refusal = await prepares();
  if (refusal === undefined) return false;
  const { errno, fatal, message } = refusal as { errno?: unknown; fatal?: unknown; message?: unknown };
  if (fatal === true || errno === ER_MAX_PREPARED_STMT_COUNT_REACHED) return false;
  if ((await prepares()) === undefined) return false;
  if ((await literalReadsBack(queryable)) !== true) return false;
  console.info(
    `[MySQL] The server refused to prepare a statement (errno ${String(errno)}: ${String(message)}); this pool writes parameter values into the statement text.`,
  );
  return true;
};

/**
 * Whether the server reads `stringLiteral()` of `BINDING_PROBE_VALUE` back unchanged, or
 * `undefined` when it did not answer the question.
 */
const literalReadsBack = async (queryable: MySQLQueryable): Promise<boolean | undefined> => {
  try {
    const [rows] = await queryable.query<RowDataPacket[]>(`SELECT ${stringLiteral(BINDING_PROBE_VALUE)} AS bound`);
    return rows[0]?.bound === BINDING_PROBE_VALUE;
  } catch {
    return undefined;
  }
};

/**
 * `This command is not supported in the prepared statement protocol yet`, MySQL's own code for a
 * statement class the server will not prepare.
 */
const ER_UNSUPPORTED_PS = 1295;

/** The core connections that answered `literalReadsBack()`, and what they answered. */
const LITERAL_READ_BACK = new WeakMap<object, boolean>();

/**
 * A parameterised statement the server refused to PREPARE, sent once more as text with its values
 * written in by `runBoundClientSide()` (#1403). Any other failure is rethrown unchanged.
 *
 * StarRocks prepares `SELECT ?` and refuses `UPDATE`, `INSERT` and `DELETE` with a placeholder:
 * measured 2026-10-09 through mysql2 on `starrocks/allin1-ubuntu:latest` and `:3.3.22`, each
 * answered errno 1295 `ER_UNSUPPORTED_PS`, a bare `prepare()` of the UPDATE did too, and after a
 * refused `UPDATE pk SET n = n + 1 WHERE id = ?` the row still read `n = 0`. So the refusal comes
 * at COM_STMT_PREPARE and nothing has run when the statement is sent again. Every inline row edit
 * there failed with that sentence while the same UPDATE typed in the editor saved.
 *
 * Only 1295 on a live connection is retried, because it is the one answer that says "this
 * statement, prepared" rather than "this statement". The written literal is the one
 * `probeClientSideBinding()` checks at connect, and it is checked the same way on this connection
 * before its first retry: a server that does not read it back unchanged keeps its refusal.
 * Measured on both StarRocks versions and MySQL 26.7.0, the literal read back byte for byte in a
 * text SELECT and in a text UPDATE.
 */
async function bindAfterRefusedPrepare<T extends RowDataPacket[]>(
  error: unknown,
  queryable: MySQLQueryable,
  core: CoreConnection,
  sql: string,
  params: unknown[],
  arrayRows: boolean,
): Promise<[T, FieldPacket[]]> {
  const { errno, fatal } = (error ?? {}) as { errno?: unknown; fatal?: unknown };
  if (errno !== ER_UNSUPPORTED_PS || fatal === true) throw error;
  let readsBack = LITERAL_READ_BACK.get(core);
  if (readsBack === undefined) {
    readsBack = await literalReadsBack(queryable);
    if (readsBack !== undefined) LITERAL_READ_BACK.set(core, readsBack);
  }
  if (readsBack !== true) throw error;
  return runBoundClientSide<T>(queryable, core, sql, params, arrayRows);
}

/**
 * One result set read as array rows: its columns named by `uniqueFieldNames`, and each row keyed by
 * those names by position (`keyRowsByPosition`, which raises a row whose value count is not the
 * column count).
 */
function mysqlResultSet(rows: readonly unknown[], declared: readonly FieldPacket[], sql: string): QueryResultSet {
  const fields = uniqueFieldNames(declared.map((field) => field.name));
  return {
    rows: keyRowsByPosition(fields, rows as readonly unknown[][], "mysql", sql),
    fields,
    ...mysqlColumnTypes(declared.map((field, index) => ({ ...field, name: fields[index] }))),
  };
}

/** What a statement that answered a result set, or a `CALL`'s list of them, is read as (`buildQueryResult`). */
function mysqlResults(
  rows: readonly unknown[],
  fields: FieldPacket[] | undefined,
  sql: string,
): Pick<QueryResult, "rows" | "fields" | "columnTypes" | "rowCount" | "resultSets"> {
  const perAnswer = (fields ?? []) as unknown as (FieldPacket[] | undefined)[];
  if (!perAnswer.some((declared) => declared === undefined || Array.isArray(declared))) {
    const set = mysqlResultSet(rows, fields ?? [], sql);
    return { ...set, rowCount: set.rows.length };
  }
  const sets = perAnswer.flatMap((declared, index) =>
    Array.isArray(declared) ? [mysqlResultSet(rows[index] as unknown[], declared, sql)] : [],
  );
  const [first] = sets;
  if (first === undefined) {
    return { rows: [], fields: [], rowCount: (rows[0] as { affectedRows?: number }).affectedRows ?? 0 };
  }
  return { ...first, rowCount: first.rows.length, ...(sets.length > 1 && { resultSets: sets }) };
}

/**
 * The core (callback) connections of a pool whose server sends UTF-8 under a utf8mb3
 * label, see `probeUtf8UnderUtf8mb3()`. Filled from that pool's `acquire` event, so
 * membership is per connection of the one pool that was measured, and nothing else in
 * the process (another provider's pool, a host application's own mysql2) is touched.
 */
const UTF8_UNDER_UTF8MB3 = new WeakSet<object>();

/** The slice of mysql2's callback API that `runReadingUtf8mb3AsUtf8` drives. */
type CoreCallback = (error: Error | null, rows: unknown, fields: FieldPacket[]) => void;
interface CoreCommand {
  on(event: "fields", listener: (fields?: FieldPacket[]) => void): unknown;
}
interface CoreConnection {
  query(sql: string | QueryOptions, callback: CoreCallback): CoreCommand;
  execute(sql: string | QueryOptions, values: unknown[], callback: CoreCallback): CoreCommand;
  format(sql: string, values: unknown[]): string;
}

/**
 * Decode this statement's utf8mb3 columns as UTF-8.
 *
 * mysql2 picks a column's decoder from its collation id and ships the whole utf8mb3
 * family (33, 76, 83, 192-215, 223 and MariaDB's utf8mb3 ids) as `cesu8`, which has no
 * 4-byte form. The command emits `fields` once the column definitions are read and
 * before the row parser is built, and both parsers read `field.encoding` when a row
 * arrives, so relabelling the definitions here changes how THIS statement's values
 * decode and nothing else: mysql2's shared `CharsetToEncoding` table is not touched.
 *
 * A `typeCast` cannot do this: mysql2 3.24 hands it the type and column name but not
 * the collation, so it cannot tell a utf8mb3 VARCHAR from a latin1 one or a VARBINARY.
 * A column NAME is decoded while its definition is parsed, before `fields` fires, so an
 * alias outside the BMP still reads as U+FFFD on these servers.
 */
const readUtf8mb3AsUtf8 = (fields?: FieldPacket[]): void => {
  // A statement that answers an OK packet (INSERT, UPDATE, DDL, SET, ...) emits `fields`
  // with nothing. A throw here would be fatal to the connection, after the server had
  // already run the statement.
  if (fields === undefined) return;
  for (const field of fields) {
    if (field.encoding === "cesu8") field.encoding = "utf8";
  }
};

/**
 * `runStatement` over the core connection, with `readUtf8mb3AsUtf8` on the command. The
 * protocol choice is the same as `runStatement`'s; the promise wrapper hides the
 * command object, which is the only thing the `fields` event is on.
 */
function runReadingUtf8mb3AsUtf8<T extends RowDataPacket[]>(
  core: CoreConnection,
  sql: string | QueryOptions,
  params?: unknown[],
): Promise<[T, FieldPacket[]]> {
  return new Promise((resolve, reject) => {
    const done: CoreCallback = (error, rows, fields) => (error ? reject(error) : resolve([rows as T, fields]));
    const command =
      params === undefined || params.length === 0 ? core.query(sql, done) : core.execute(sql, params, done);
    command.on("fields", readUtf8mb3AsUtf8);
  });
}

/**
 * The leading keywords of the statements MySQL commits implicitly inside a transaction,
 * from the manual's "Statements That Cause an Implicit Commit" (13.3.3). `SET` is left
 * out on purpose: only `SET autocommit = 1` and `SET PASSWORD` commit, and refusing every
 * `SET` would refuse session variables a SANDBOX run needs. Those two are caught after
 * the fact instead, by the `SERVER_STATUS_IN_TRANS` read in `queryInTransaction()`.
 * `LOAD` is left out for the same reason: `LOAD DATA` commits only on NDB tables.
 */
const MYSQL_IMPLICIT_COMMIT_STATEMENTS: readonly string[] = [
  "ALTER",
  "ANALYZE",
  "BEGIN",
  "CACHE",
  "CHANGE",
  "CHECK",
  "CREATE",
  "DROP",
  "FLUSH",
  "GRANT",
  "INSTALL",
  "LOCK",
  "OPTIMIZE",
  "RENAME",
  "REPAIR",
  "RESET",
  "REVOKE",
  "START",
  "STOP",
  "TRUNCATE",
  "UNINSTALL",
  "UNLOCK",
];

/**
 * What the list above would match and does not commit. `CREATE TEMPORARY TABLE` and `DROP
 * TEMPORARY TABLE` are named by the manual as the exceptions to its own CREATE/DROP rule (a
 * temporary table SANDBOX creates stays on the pooled connection after the rollback, which is
 * session state, not data). `ANALYZE SELECT` and `ANALYZE FORMAT` are MariaDB's statement
 * analyser, a read that shares its first word with `ANALYZE TABLE`.
 */
const MYSQL_IMPLICIT_COMMIT_EXCEPTIONS: readonly string[] = [
  "CREATE TEMPORARY",
  "DROP TEMPORARY",
  "ANALYZE SELECT",
  "ANALYZE FORMAT",
];

/** `SERVER_STATUS_IN_TRANS`, bit 0 of the status flags every OK packet carries. */
const SERVER_STATUS_IN_TRANS = 1;

/**
 * `SERVER_STATUS_AUTOCOMMIT`, bit 1. MySQL sets one of the two bits on every OK packet: bit 0
 * inside a transaction, bit 1 outside one while autocommit is on.
 */
const SERVER_STATUS_AUTOCOMMIT = 2;

/**
 * The status flags of the OK packet that answered `result`, or `undefined` when the answer
 * carries none to read.
 *
 * `mysql2` keeps no transaction flag on a connection; it surfaces the status flags only
 * as `ResultSetHeader.serverStatus`. A statement that returns rows answers an array with
 * no header, so a read is not something this can judge, and a read never ends a
 * transaction. A `CALL` that returns result sets answers an array of them whose LAST
 * element is the header of the call itself, which is the state after everything the
 * procedure ran. The two arrays are told apart by their first element, a row set (an
 * array) for the `CALL` and a row (an object) for a read, so a column that happens to be
 * named `serverStatus` is never read as the flags. A user's statement is read with array
 * rows (`rowsAsArray`), where a read's first element is an array too; its last element is
 * then a row, an array, which is no header either.
 */
function statusFlagsOf(result: unknown): number | undefined {
  const header = Array.isArray(result) ? (Array.isArray(result[0]) ? result[result.length - 1] : undefined) : result;
  if (typeof header !== "object" || header === null || Array.isArray(header)) return undefined;
  const status = (header as { serverStatus?: unknown }).serverStatus;
  return typeof status === "number" ? status : undefined;
}

/**
 * Whether the server says a transaction is open after the statement that answered
 * `result`, or `undefined` when the answer carries no OK packet to read.
 */
function serverReportsOpenTransaction(result: unknown): boolean | undefined {
  const status = statusFlagsOf(result);
  return status === undefined ? undefined : (status & SERVER_STATUS_IN_TRANS) !== 0;
}

/**
 * Open a transaction on `conn` and answer what the server said to it.
 *
 * `BEGIN` first, because it is the one form every MySQL-wire server measured opens a
 * transaction with. On 2026-10-04 Databend 1.2.881 and Apache Doris 4.1.3 accepted
 * `START TRANSACTION` and opened nothing (a second session saw the INSERT at once and it
 * survived the ROLLBACK), while `BEGIN` opened a real one there and on StarRocks 4.1.6; MySQL
 * documents `BEGIN` as an alias of `START TRANSACTION`, and MySQL 26.7.0 and MariaDB 13.0.2
 * answer the two with the same status. `START TRANSACTION` is
 * the fallback for a server that refuses a bare `BEGIN`: MariaDB under `sql_mode=ORACLE`
 * reads it as the start of a block and answers 1064.
 *
 * The fallback keys on that errno, unlike `probeExplainFormat()`, which reads only success
 * or failure. Here a wrong fallback is harmful: on Databend and Doris `START TRANSACTION`
 * opens nothing, so a BEGIN that failed for any other reason (a lost connection, a
 * permission, a transaction already open) would turn into a session that only looks open.
 * So only a parse error (1064, `ER_PARSE_ERROR`) on a live connection falls back, and if
 * the fallback fails too, the BEGIN's own error is the one raised.
 */
async function openTransaction(conn: PoolConnection): Promise<unknown> {
  try {
    const [answer] = await conn.query("BEGIN");
    return answer;
  } catch (error) {
    const { errno, fatal } = error as { errno?: unknown; fatal?: unknown };
    if (errno !== 1064 || fatal === true) throw error;
    try {
      const [answer] = await conn.query("START TRANSACTION");
      return answer;
    } catch {
      throw error;
    }
  }
}

/**
 * The EXPLAIN grammars this provider can ask for, most specific first, each paired
 * with the strategy id that reads what the statement answers.
 *
 * `EXPLAIN FORMAT=JSON` is MySQL's own grammar and the rest of the wire family does
 * not share it. Measured 2026-09-06 through mysql2 3.24.2 over the text protocol,
 * one connection per engine:
 *
 * - MySQL 26.7.0 (`mysql:latest`) and MariaDB 12.3.2 (`mariadb:latest`): both
 *   statements accepted.
 * - TiDB 8.5.1 (`pingcap/tidb:v8.5.1`): `EXPLAIN FORMAT=JSON SELECT 1` is errno 1105
 *   `explain format 'json' is not supported now`; `EXPLAIN SELECT 1` is accepted.
 * - Apache Doris 4.1.3 (`apache/doris:all-in-one-4.1.3`): errno 1105
 *   `mismatched input '=' expecting {<EOF>, ';'}(line 1, pos 14)`; `EXPLAIN SELECT 1`
 *   is accepted.
 * - StarRocks 3.3.22 (`starrocks/allin1-ubuntu:3.3.22`) and SingleStore
 *   (`ghcr.io/singlestore-labs/singlestoredb-dev:0.2.82`): errno 1064, a parse error;
 *   `EXPLAIN SELECT 1` is accepted on both.
 * - Databend 1.2.925 (`datafuselabs/databend:v1.2.925-patch-11`): errno 1105
 *   SyntaxException; `EXPLAIN SELECT 1` is accepted.
 * - Vitess 24.0.2 (`vitess/vttestserver:v24.0.2-mysql80`) and OceanBase CE 4.4.2
 *   (`oceanbase/oceanbase-ce:4.4.2-lts`): both statements accepted, so nothing about
 *   those two changes. Vitess refuses the QUOTED `EXPLAIN FORMAT='json'`, which is a
 *   reason to keep sending the unquoted form the probe and the strategy already use.
 */
const EXPLAIN_PROBES: readonly (readonly [prefix: string, format: ExplainFormat])[] = [
  ["EXPLAIN FORMAT=JSON", "mysql-json"],
  ["EXPLAIN", "mysql-text"],
];

/**
 * One base table of the session's database, for the probes to name when the server refuses
 * to explain a statement that names none (#1393).
 *
 * Vitess 25.0.0-SNAPSHOT (`vitess/vttestserver:mysql84`, built 2026-10-08) answers
 * `EXPLAIN FORMAT=JSON SELECT 1`, `EXPLAIN SELECT 1` and `... SELECT 1 FROM dual` with `1105
 * VT03031: EXPLAIN is only supported for single keyspace`, and answers both grammars for
 * `SELECT * FROM customers LIMIT 0`. Through vtgate this lookup answers `customers`: vtgate
 * rewrites the schema to the shard's `vt_e2e_0` and keeps the table's name (measured
 * 2026-10-09).
 */
const EXPLAIN_PROBE_TABLE_SQL =
  "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' LIMIT 1";

/** The first grammar that explains `statement`, or `undefined` when the server refuses both. */
const firstExplainFormat = async (queryable: MySQLQueryable, statement: string): Promise<ExplainFormat | undefined> => {
  for (const [prefix, format] of EXPLAIN_PROBES) {
    try {
      await runStatement(queryable, `${prefix} ${statement}`);
      return format;
    } catch {
      // Refused, so try the next grammar. The reason is the engine's own and there is
      // nothing to report: the capability this produces IS the report.
    }
  }
  return undefined;
};

/**
 * Which of those grammars this server accepts, or `undefined` when it accepts
 * neither. Run once per `connect()`, on the connection the pool check already holds.
 *
 * It reads SUCCESS OR FAILURE and never the errno, because the family does not share
 * one for a grammar refusal: Doris and TiDB answer 1105 where StarRocks and
 * SingleStore answer 1064 (measured 2026-09-06, see `EXPLAIN_PROBES`). Keying on a
 * code would have to enumerate engines, which is the branch `src/lib/db` does not
 * take; asking the server what its grammar accepts is the same answer without the
 * enumeration.
 *
 * `SELECT 1` is asked first, and a server that explains it is never asked anything else. Only
 * when both grammars refuse it are they asked again against a table the session's database
 * holds (`EXPLAIN_PROBE_TABLE_SQL`), because a refusal of `SELECT 1` can be about the statement
 * rather than the grammar (#1393). `LIMIT 0` keeps the statement a plan with nothing to read. A
 * database with no base table, or a lookup the server refuses, leaves the answer `undefined`.
 *
 * Nothing here rejects. A grammar the server does not have is a fact about the
 * Explain panel, not about the connection, and `connect()` must not fail for it.
 */
const probeExplainFormat = async (queryable: MySQLQueryable): Promise<ExplainFormat | undefined> => {
  const format = await firstExplainFormat(queryable, "SELECT 1");
  if (format !== undefined) return format;
  let table: unknown;
  try {
    const [rows] = await runStatement(queryable, EXPLAIN_PROBE_TABLE_SQL);
    table = rows[0]?.name;
  } catch {
    return undefined;
  }
  if (typeof table !== "string" || table === "") return undefined;
  return firstExplainFormat(queryable, `SELECT * FROM ${escapeMySQLIdentifier(table)} LIMIT 0`);
};

/**
 * MySQL's maintenance, as MySQL itself runs it.
 *
 * MySQL has no VACUUM, and every statement it does have names tables: `ANALYZE/OPTIMIZE/CHECK
 * TABLE <t>` with a target, the same verb over every table in the database without one
 * (`getAllTablesForMaintenance`). `kill` takes a connection id from the Sessions panel. This is the
 * declaration before a server is measured; what a connected server keeps of it is
 * `probeMaintenance`'s answer (#1387).
 */
const MYSQL_MAINTENANCE: Required<MaintenanceDeclaration> = {
  maintenanceOperations: ["analyze", "optimize", "check", "kill"],
  maintenanceOperationSpecs: {
    analyze: { label: "Analyze Table", perEntity: true, global: true },
    optimize: { label: "Optimize Table", perEntity: true, global: true },
    check: { label: "Check Table", perEntity: true, global: true },
    kill: { label: "Kill Connection", perEntity: false, global: false },
  },
};

/** The verbs `probeMaintenance` asks about; `kill` takes a connection id, not a table. */
const PROBED_MAINTENANCE = ["analyze", "optimize", "check"] as const;

/**
 * The name every probe table starts with. Each probe adds a random suffix (`probeTableName`), so a
 * table a user happens to own can never be the one the verbs reach: with a fixed name, a table of
 * that name would really be analyzed, optimized and checked on every connect.
 */
const MAINTENANCE_PROBE_TABLE_PREFIX = "libredb_maintenance_probe_";

/** A fresh probe table name: the prefix and a dashless UUID, 58 characters, inside MySQL's 64. */
const probeTableName = (): string => `${MAINTENANCE_PROBE_TABLE_PREFIX}${randomUUID().replace(/-/g, "")}`;

/**
 * Answers to the control statement, `SELECT 1 FROM` the missing probe table, that mean "the table is
 * not there" (or "you may not read it"): `1146` no such table, `1049` unknown database, `1051` and
 * `1109` unknown table, `1142` and `1044` the refusals a least-privilege account gets, and `1105`,
 * the generic code Apache Doris answers a missing table with. Any other answer, or a control that
 * resolves, is not a baseline the verbs can be read against, and the declaration stands.
 */
const MAINTENANCE_PROBE_CONTROL_ERRNOS = new Set([1146, 1049, 1051, 1109, 1142, 1044, 1105]);

/**
 * Answers to a verb that mean the server parsed it and went on to the table or to the caller's
 * rights, whatever the control answered: `1146`, `1049`, `1051` and `1109` for the missing table or
 * database, and `1142`, `1044` and `1227` for a least-privilege account. Measured 2026-10-04 on
 * mysql:latest and mariadb:latest with an account granted `ALL ON app.*`: MySQL 26.7.0's `OPTIMIZE`
 * asks it for `OPTIMIZE_LOCAL_TABLE` with `1227`. The verb exists there, and the run's own refusal
 * is the engine's answer, a 400 with its sentence.
 */
const MAINTENANCE_PROBE_ACCEPTED_ERRNOS = new Set([1146, 1049, 1051, 1109, 1142, 1044, 1227]);

/**
 * Answers that mean the server does not have the verb, when they differ from the control's answer:
 * `1064` a parse error (TiDB's `CHECK TABLE`), `1105` the generic error vtgate answers a parse error
 * with, `8200` TiDB's `OPTIMIZE TABLE is not supported` and `1235` not supported yet, plus any
 * other answer in SQLSTATE class `42` or `0A`.
 */
const MAINTENANCE_PROBE_REFUSED_ERRNOS = new Set([1064, 1105, 8200, 1235]);

/** `ER_PARSE_ERROR`, the one answer on which the probe retries without `NO_WRITE_TO_BINLOG`. */
const PARSE_ERROR_ERRNO = 1064;

/** A backtick-quoted identifier, the backtick doubled, as `SQLBaseProvider.escapeIdentifier` quotes one. */
const escapeMySQLIdentifier = (name: string): string => `\`${name.replace(/`/g, "``")}\``;

/** The database this session selected, or undefined when it selected none or the server would not say. */
const selectedDatabase = async (queryable: MySQLQueryable): Promise<string | undefined> => {
  try {
    const [rows] = await runStatement(queryable, "SELECT DATABASE() AS name");
    const name = rows[0]?.name;
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch {
    return undefined;
  }
};

/** What one statement answered: `"resolved"`, or the error's `errno` and `sqlState`. */
type ProbeAnswer = "resolved" | { readonly errno: unknown; readonly sqlState: unknown };

const probeAnswer = async (queryable: MySQLQueryable, sql: string): Promise<ProbeAnswer> => {
  try {
    await runStatement(queryable, sql);
    return "resolved";
  } catch (error) {
    const { errno, sqlState } = error as { errno?: unknown; sqlState?: unknown };
    return { errno, sqlState };
  }
};

type ProbeVerdict = "accepted" | "refused" | "unknown";

/**
 * One verb's answer read against the control's `errno`, never the message. The same answer the
 * control got is the verb reaching the same missing table, which is how an engine whose codes are
 * generic (Doris answers both a missing table and much else with `1105`) is read correctly.
 */
const verbVerdict = (answer: ProbeAnswer, controlErrno: number): ProbeVerdict => {
  if (answer === "resolved") return "accepted";
  const { errno, sqlState } = answer;
  if (typeof errno !== "number" || MYSQL_ACCOUNT_LIMIT_ERRNOS.has(errno)) return "unknown";
  if (errno === controlErrno || MAINTENANCE_PROBE_ACCEPTED_ERRNOS.has(errno)) return "accepted";
  if (MAINTENANCE_PROBE_REFUSED_ERRNOS.has(errno)) return "refused";
  return typeof sqlState === "string" && /^(42|0A)/.test(sqlState) ? "refused" : "unknown";
};

/**
 * Which of ANALYZE, OPTIMIZE and CHECK TABLE this server's grammar has (#1387), asked once per
 * `connect()` on the connection the pool check already holds.
 *
 * The MySQL type id serves wire-compatible engines that refuse part of MySQL's maintenance.
 * Measured 2026-10-04 against a missing table in the connection's own database: MySQL 26.7.0 and
 * MariaDB answer all three with a result set whose row says the table does not exist; TiDB v8.5.8
 * answers ANALYZE with `1146`, OPTIMIZE with `8200 OPTIMIZE TABLE is not supported` and CHECK with
 * `1064`; Vitess 24.0.4 answers ANALYZE and OPTIMIZE and refuses CHECK with `1105 syntax error at
 * position 6 near 'CHECK'`. The table is in the connection's OWN database because an account
 * granted only that database is refused (`1142`) for a table anywhere else, and its name carries a
 * random suffix so no real table is ever reached.
 *
 * A control statement goes first: `SELECT 1 FROM` the same missing table. Its answer is what "the
 * table is not there" sounds like on this server, so a verb that answers the same way reached the
 * table and has the verb, and one that answers differently with a refusal code does not. A control
 * that resolves, or fails some other way, leaves the declaration as it is.
 *
 * ANALYZE and OPTIMIZE carry `NO_WRITE_TO_BINLOG`. Without it MySQL writes both to the binary log
 * even for a table that does not exist, so every connect added two GTID transactions to a primary
 * and to every replica downstream; with it `gtid_executed` stayed unchanged on MySQL 26.7.0, as did
 * MariaDB's `gtid_binlog_pos` and Vitess's `gtid_executed` (measured). All four engines parse the
 * modifier; a server that answers it with a parse error the control did not get is asked once more
 * without it. CHECK TABLE is never written to the binary log and takes no modifier.
 *
 * Both placements follow the verb: the whole-database form is the same statement over every table.
 * Nothing here rejects, and only a server's refusal narrows anything: an answer that is neither an
 * acceptance nor a refusal (a reset connection, an account limit, an unknown code) leaves the
 * result undefined, and the declaration stands.
 */
const probeMaintenance = async (
  queryable: MySQLQueryable,
  database: string | undefined,
): Promise<Partial<Record<MaintenanceOperation, MeasuredMaintenancePlacements>> | undefined> => {
  // A connection string carries its database in the URL rather than in `config.database`, so the
  // server is asked which one the session selected. A session that selected none names a database
  // that does not exist, qualified because a bare name answers `1046 No database selected` before
  // the verb is read (measured on MySQL 26.7.0 and TiDB v8.5.8).
  const selected = database || (await selectedDatabase(queryable)) || probeTableName();
  const table = `${escapeMySQLIdentifier(selected)}.${escapeMySQLIdentifier(probeTableName())}`;
  const control = await probeAnswer(queryable, `SELECT 1 FROM ${table}`);
  if (control === "resolved" || typeof control.errno !== "number") return undefined;
  const controlErrno = control.errno;
  if (!MAINTENANCE_PROBE_CONTROL_ERRNOS.has(controlErrno)) return undefined;
  const measured: Partial<Record<MaintenanceOperation, MeasuredMaintenancePlacements>> = {};
  for (const verb of PROBED_MAINTENANCE) {
    const plain = `${verb.toUpperCase()} TABLE ${table}`;
    const quiet = verb === "check" ? plain : `${verb.toUpperCase()} NO_WRITE_TO_BINLOG TABLE ${table}`;
    let answer = await probeAnswer(queryable, quiet);
    const parseError =
      answer !== "resolved" && answer.errno === PARSE_ERROR_ERRNO && controlErrno !== PARSE_ERROR_ERRNO;
    if (parseError && quiet !== plain) answer = await probeAnswer(queryable, plain);
    const verdict = verbVerdict(answer, controlErrno);
    if (verdict === "unknown") return undefined;
    const accepted = verdict === "accepted";
    measured[verb] = { perEntity: accepted, global: accepted };
  }
  return measured;
};

/**
 * One row of MySQL's answer to `ANALYZE`/`OPTIMIZE`/`CHECK TABLE`. These statements
 * return a RESULT SET, not a header: the outcome is data, and reading it is the only
 * way to know what happened.
 */
interface MaintenanceReportRow extends RowDataPacket {
  Table: string;
  Op: string;
  Msg_type: string;
  Msg_text: string;
}

/**
 * MySQL's verdict on a table maintenance statement, taken from the statement's own
 * answer.
 *
 * The statement does NOT throw when the server refuses it: measured through this
 * provider against MySQL 26.7.0 (`libredb-mysql`) on 2026-08-25, `OPTIMIZE TABLE
 * \`missing\`` resolves normally and answers
 *
 *   [{ Table: 'u9t.missing', Op: 'optimize', Msg_type: 'Error',
 *      Msg_text: "Table 'u9t.missing' doesn't exist" },
 *    { Table: 'u9t.missing', Op: 'optimize', Msg_type: 'status',
 *      Msg_text: 'Operation failed' }]
 *
 * so `await runStatement(...); return { success: true }` reported a completed
 * operation for a statement the server had rejected - and discarded the `Msg_text`
 * that is the entire point of `CHECK TABLE`, whose OK-or-corruption-report is the only
 * thing the user asked for. `Msg_type` is the decision (`'Error'` from the server,
 * matched case-insensitively because the manual documents the set in lower case), and
 * the same read is what SQLite's `check` already does with `PRAGMA integrity_check`.
 *
 * The whole-database form names every table in one statement, so a failing table is
 * quoted WITH its name - it is the only place the failure appears - while a successful
 * run quotes the messages alone and deduplicates them: over forty tables the OK and
 * InnoDB's "doing recreate + analyze instead" note repeat once per table and say the
 * same thing forty times.
 *
 * Not every MySQL-wire server sends the report. Measured 2026-10-04 through mysql2
 * 3.24.2, TiDB v8.5.8 and Databend v1.2.925 answer `ANALYZE TABLE` with an OK packet,
 * and OceanBase CE 4.4.2.1 answers both `ANALYZE TABLE` and `OPTIMIZE TABLE` that way,
 * so mysql2 hands back a `ResultSetHeader` object instead of rows, and calling `.filter`
 * on it failed the action with "rows.filter is not a function". Each of them refuses a
 * missing table by throwing, so a header carries no failure to read: the statement ran,
 * and the honest message is that the server said nothing more than that. What the
 * header does carry is a warning count (TiDB's is 1, a sample-rate Note), and the
 * message names it so the user knows where the server's words went.
 */
function readMaintenanceReport(
  type: MaintenanceType,
  answer: MaintenanceReportRow[] | ResultSetHeader,
): { success: boolean; message: string } {
  const noReport = `${type.toUpperCase()} completed; the server returned no report`;
  if (!Array.isArray(answer)) {
    const warnings = answer.warningStatus;
    return {
      success: true,
      message:
        warnings > 0 ? `${noReport} (${warnings} warning${warnings === 1 ? "" : "s"}, see SHOW WARNINGS)` : noReport,
    };
  }
  // A result set with no row leaves nothing to quote either.
  if (answer.length === 0) {
    return { success: true, message: noReport };
  }

  const rows = answer;
  const failures = rows.filter((row) => String(row.Msg_type).toLowerCase() === "error");
  if (failures.length > 0) {
    return {
      success: false,
      message: `${type.toUpperCase()} failed: ${unique(failures.map((row) => `${row.Table}: ${row.Msg_text}`)).join("; ")}`,
    };
  }

  return { success: true, message: `${type.toUpperCase()}: ${unique(rows.map((row) => row.Msg_text)).join("; ")}` };
}

const unique = (values: string[]): string[] => [...new Set(values)];

/**
 * One status variable out of a bare `SHOW STATUS` result, or `undefined` when the
 * server does not publish it.
 *
 * The provider used to ask for each variable by name with `SHOW STATUS LIKE '<name>'`,
 * which is MySQL grammar that not every MySQL-wire server has. Measured 2026-09-06 over
 * mysql2 3.24.2's text protocol against `apache/doris:all-in-one-4.1.3`:
 *
 *   SHOW STATUS LIKE 'Uptime'  -> errno=1105 code=ER_UNKNOWN_ERROR sqlState=HY000
 *                                 "mismatched input 'LIKE' expecting {<EOF>, ';'}
 *                                  (line 1, pos 12)"
 *   SHOW STATUS                -> ok, columns Variable_name/Value, 0 rows
 *
 * so the whole Overview and Health panels failed on Doris for a clause the bare
 * statement does not need (#573). The bare form is accepted everywhere measured that
 * day: MySQL 26.7.0 (528 rows), MariaDB 12.3.2 (571), TiDB 8.5.1 (13), SingleStore
 * (75), StarRocks 3.3.22 (0) and Doris 4.1.3 (0).
 *
 * The match is case-insensitive because `LIKE` was: replacing the server-side filter
 * with a client-side one must not narrow what it accepted.
 */
function statusValue(rows: RowDataPacket[], name: string): unknown {
  const wanted = name.toLowerCase();
  return rows.find((row) => String(row.Variable_name).toLowerCase() === wanted)?.Value;
}

// ============================================================================
// SQL Statements
// ============================================================================
// Multi-line SQL is hoisted to module scope so per-line coverage attribution
// stays stable (repo pattern, see the SCHEMA_*_SQL consts in mssql.ts).

/**
 * `COALESCE(INDEX_LENGTH, 0)` in every size sum below, not just `INDEX_LENGTH`: measured
 * 2026-09-16 on StarRocks 4.1.4 and 3.3.22 alike, a real `BASE TABLE` with rows and a real
 * `DATA_LENGTH` answers `INDEX_LENGTH` NULL always, never 0 - so the addition poisoned the
 * whole sum to NULL and every size read "0 B" for a table actually holding data. A VIEW's
 * `DATA_LENGTH` stays NULL on every engine measured, so `NULL + COALESCE(NULL, 0)` is still
 * NULL there and the "unmeasured" reading `measuredNumber`/`measuredNullableAggregate` give
 * a view is unchanged.
 */
const DATABASE_SIZE_MB_SQL = `
        SELECT
          ROUND(SUM(DATA_LENGTH + COALESCE(INDEX_LENGTH, 0)) / 1024 / 1024, 2) as size_mb
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?;
      `;

// Shared by getHealth() and getPerformanceMetrics().
const BUFFER_CACHE_HIT_RATIO_SQL = `
        SELECT
          (1 - (
            (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_reads') /
            NULLIF((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_read_requests'), 0)
          )) * 100 as hit_ratio;
      `;

const HEALTH_ACTIVE_SESSIONS_SQL = `
        SELECT
          ID as pid,
          USER as user,
          DB as \`database\`,
          COMMAND as state,
          LEFT(COALESCE(INFO, ''), 100) as query,
          CONCAT(TIME, 's') as duration
        FROM information_schema.PROCESSLIST
        WHERE DB = ?
        ORDER BY TIME DESC
        LIMIT 10;
      `;

const MAINTENANCE_TABLES_SQL = `
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      AND TABLE_TYPE = 'BASE TABLE'
      LIMIT 50;
    `;

const OVERVIEW_DATABASE_SIZE_SQL = `
        SELECT SUM(DATA_LENGTH + COALESCE(INDEX_LENGTH, 0)) as size_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?;
      `;

// INDEX_NAME is unique per table only, so a database-wide COUNT(DISTINCT INDEX_NAME)
// collapses every table's PRIMARY (and any other index name two tables share) into
// one. Counting distinct (TABLE_NAME, INDEX_NAME) pairs instead counts each table's
// indexes separately, which is what "N indexes" in the overview means.
const OVERVIEW_INDEX_COUNT_SQL = `
        SELECT COUNT(DISTINCT TABLE_NAME, INDEX_NAME) as index_count
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?;
      `;

const OVERVIEW_TABLE_COUNT_SQL = `
        SELECT COUNT(*) as cnt FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE';
      `;

const BUFFER_POOL_PAGES_SQL = `
        SELECT
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_pages_data') as data_pages,
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_pages_total') as total_pages;
      `;

const QUERIES_PER_SECOND_SQL = `
        SELECT
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Queries') as queries,
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime') as uptime;
      `;

/**
 * The ONE read of `performance_schema.events_statements_summary_by_digest`, shared by
 * `getSlowQueries()` (the Queries panel) and `getHealth()`'s slow-query line, with only
 * the LIMIT interpolated at each call site.
 *
 * It is shared because the two used to be separate statements and the health one was
 * wrong (#512): it asked for `LEFT(sql_text, 100)`, and this table has no `sql_text`
 * column. `SQL_TEXT` belongs to `events_statements_current`/`_history`; the digest table
 * carries the normalised `DIGEST_TEXT` (MySQL 9.4 manual, "Statement Summary Tables",
 * and the server's own `information_schema.columns` on every build below). So that
 * statement answered
 *
 *   errno=1054 code=ER_BAD_FIELD_ERROR sqlState=42S22
 *   Unknown column 'sql_text' in 'field list'
 *
 * and never once returned a row. Measured 2026-08-27 on MySQL 26.7.0, Percona Server
 * 8.4.11-11, MySQL 26.7.0 started `--performance-schema=OFF` and MariaDB 12.3.2 - all
 * four, whatever `@@performance_schema` said - while this statement answered 5 real rows
 * on the two with the schema on, over the same connection.
 *
 * Two statements for one fact is what drifted, and the copy the health panel used was
 * the one no test ever put in front of a server: the mysql2 mock invented a `query`
 * column for any statement over this table, so the broken read looked like a working one
 * for as long as it was only mocked.
 */
const SLOW_QUERIES_BODY_SQL = `
        SELECT
          DIGEST as query_id,
          LEFT(DIGEST_TEXT, 500) as query,
          COUNT_STAR as calls,
          SUM_TIMER_WAIT / 1000000000 as total_time_ms,
          AVG_TIMER_WAIT / 1000000000 as avg_time_ms,
          MIN_TIMER_WAIT / 1000000000 as min_time_ms,
          MAX_TIMER_WAIT / 1000000000 as max_time_ms,
          SUM_ROWS_EXAMINED as rows_examined
        FROM performance_schema.events_statements_summary_by_digest
        WHERE SCHEMA_NAME = ?
        ORDER BY SUM_TIMER_WAIT DESC`;

/**
 * The five heaviest digests - the LIMIT the health statement this replaced already used,
 * kept so the reading's size does not change with the repair.
 *
 * A CAP, NOT A COUNT, and nothing downstream can tell the difference, which is why it is
 * written here. `SLOW_QUERIES_BODY_SQL` has no slowness predicate at all: its only WHERE
 * term is the connected schema and "slow" is the ORDERING (`SUM_TIMER_WAIT DESC`), so the
 * top five digests for a schema come back whether they took 15 ms or 15 hours. So on any
 * server with five or more digests for this schema, the LENGTH of this list is 5 -
 * permanently, and about statements no threshold has called slow. The agent's curated
 * health reading used to forward that length to the model as `slowQueryCount`; it no
 * longer projects any length at all, because a figure whose value is a cap has no
 * referent (`src/lib/agent/tools.ts`, and #513). The cap is still
 * written here: nothing downstream can tell a cap from a count, so the only place the
 * distinction can be recorded is where the limit is applied.
 *
 * Measured 2026-08-27 on MySQL 26.7.0: the digest table held 59 rows for one connected
 * schema, and the five this statement returns for it were ALL Studio's own introspection
 * statements, with the slow-query read itself first at `avg 79.11ms, calls 3` and the rest
 * between 1.15 ms and 7.78 ms. Nothing in that list is slow and none of it is the user's
 * workload; what the reading honestly reports is "the five heaviest digests recorded for
 * this schema". Raising the limit would move the saturation point without turning the
 * number into a count - only a slowness threshold, or a differently named projection,
 * would - and the projection is in a file this one does not own.
 */
const HEALTH_SLOW_QUERY_LIMIT = 5;

/**
 * One digest row in the Queries panel's shape. Module-level rather than inline in
 * `getSlowQueries()` so `getHealth()` projects the SAME row the panel does: the health
 * line's job is to agree with the panel beside it, and it can only be structurally
 * unable to disagree while there is one statement and one mapper.
 */
function toSlowQueryStats(r: RowDataPacket): SlowQueryStats {
  return {
    queryId: r.query_id || undefined,
    query: r.query || "",
    calls: parseInt(r.calls || "0"),
    totalTime: parseFloat(r.total_time_ms || "0"),
    avgTime: parseFloat(r.avg_time_ms || "0"),
    minTime: parseFloat(r.min_time_ms || "0"),
    maxTime: parseFloat(r.max_time_ms || "0"),
    rows: parseInt(r.rows_examined || "0"),
  };
}

/**
 * The health summary's narrower `SlowQuery` shape, from the panel's row.
 *
 * NOTHING RENDERS THESE TWO FIELDS, and the format is chosen on that basis rather than on
 * an appearance nobody can check. No component reads `HealthInfo.slowQueries` (the
 * monitoring Queries and Overview tabs read `MonitoringData.slowQueries`, a different
 * reading with its own `SlowQueryStats` shape), and the one caller of
 * `POST /api/db/health` - the 60s connection pulse in `src/hooks/use-connection-pulse.ts` -
 * reads `res.ok` and discards the body. The agent's curated health reading
 * (`src/lib/agent/tools.ts`) was the last live consumer and read only the list's LENGTH -
 * never `query`, never `avgTime` - and it no longer reads the list at all (#513). So this
 * shape now has no consumer in the app beyond the serialised route body.
 *
 * So `toFixed(2)` plus `"ms"` is here for one reason: it is the string the statement this
 * replaced produced with `CONCAT(ROUND(avg_timer_wait / 1000000000, 2), 'ms')`, and
 * keeping the type's contents identical in form means no consumer added later inherits a
 * silent change of units from this repair. What DID change is the query text: the old
 * statement asked for `LEFT(sql_text, 100)` (and answered ER_BAD_FIELD_ERROR every time,
 * so no consumer ever saw 100 characters of anything), the shared one asks for
 * `LEFT(DIGEST_TEXT, 500)` - the panel's own width, five times wider, and the reason the
 * two readings can no longer disagree about a statement's text.
 */
function toHealthSlowQuery(stats: SlowQueryStats): SlowQuery {
  return { query: stats.query, calls: stats.calls, avgTime: `${stats.avgTime.toFixed(2)}ms` };
}

/**
 * Vendor names that a MySQL-protocol server puts into its own `VERSION()` string.
 *
 * `mysql2` serves MySQL and its wire-compatible relatives alike, and `VERSION()`
 * is the only thing that says which one answered. MySQL returns a bare number
 * ("8.0.35"), so the overview has to supply the vendor; these four supply it
 * themselves, and prefixing "MySQL" onto their answer asserted the wrong vendor
 * outright - a MariaDB 12.3 server read as "MySQL 12.3.2-MariaDB-ubu2404".
 *
 * The list is exactly the self-identifying strings `WIRE_COMPATIBLE_ENGINES`
 * records from a live probe: MariaDB `12.3.2-MariaDB-ubu2404`, TiDB
 * `8.0.11-TiDB-v8.5.1`, Vitess `8.0.43-Vitess`, OceanBase
 * `5.7.25-OceanBase_CE-v4.4.2.1`. StarRocks and SingleStore are deliberately
 * absent: both answer `VERSION()` with a plain MySQL number and nothing to key
 * on, which the compatibility table already records as their behaviour.
 */
const SELF_IDENTIFYING_VERSION = /mariadb|tidb|vitess|oceanbase/i;

/**
 * Doris is absent from `SELF_IDENTIFYING_VERSION` for the same reason as
 * StarRocks and SingleStore - `VERSION()` answers a fixed, fictitious MySQL
 * number (`5.7.99`) with nothing to key on - but unlike those two, Doris does
 * put its own build string in `@@version_comment`: `"doris version
 * doris-4.1.3-rc02-7126cf65d96"`, measured against
 * `apache/doris:all-in-one-4.1.3`. Real MySQL's own `@@version_comment`
 * ("MySQL Community Server - GPL") and MariaDB's ("mariadb.org binary
 * distribution") do not match this shape, so keying on it does not misfire on
 * the engine this provider is named for.
 */
const DORIS_VERSION_COMMENT = /doris version (?:doris-)?(\S+)/i;

/**
 * Percona Server for MySQL answers `VERSION()` with a bare MySQL-style number
 * (`8.4.11-11`) and keeps its name in `@@version_comment`:
 * `"Percona Server (GPL), Release 11"`, measured against
 * `percona/percona-server:latest` 8.4.11-11. Anchored at the start, because
 * MySQL's own comment ("MySQL Community Server - GPL") and MariaDB's
 * ("mariadb.org binary distribution") must not match (#1444).
 */
const PERCONA_VERSION_COMMENT = /^Percona Server\b/i;

/**
 * How the overview names the server: the string as the server gave it when
 * that already names a vendor, Doris's own build string extracted from
 * `@@version_comment` when the fictitious `VERSION()` number is the only
 * other option, `Percona Server <version>` when `@@version_comment` names
 * Percona, `MySQL <version>` otherwise.
 */
function labelServerVersion(version: string, versionComment?: string): string {
  if (SELF_IDENTIFYING_VERSION.test(version)) return version;
  const doris = versionComment?.match(DORIS_VERSION_COMMENT);
  if (doris) return `Apache Doris ${doris[1]}`;
  if (versionComment !== undefined && PERCONA_VERSION_COMMENT.test(versionComment)) {
    return `Percona Server ${version}`;
  }
  return `MySQL ${version}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// The LIMIT clause is interpolated at the call site in getActiveSessions().
const ACTIVE_SESSIONS_BODY_SQL = `
        SELECT
          ID as pid,
          USER as user,
          DB as database_name,
          HOST as client_addr,
          COMMAND as state,
          LEFT(COALESCE(INFO, ''), 500) as query,
          TIME as duration_seconds
        FROM information_schema.PROCESSLIST
        WHERE DB = ? OR DB IS NULL
        ORDER BY TIME DESC`;

const TABLE_STATS_SQL = `
        SELECT
          TABLE_SCHEMA as schema_name,
          TABLE_NAME as table_name,
          TABLE_ROWS as row_count,
          DATA_LENGTH as table_size_bytes,
          INDEX_LENGTH as index_size_bytes,
          DATA_LENGTH + COALESCE(INDEX_LENGTH, 0) as total_size_bytes,
          DATA_FREE as free_space_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY DATA_LENGTH + COALESCE(INDEX_LENGTH, 0) DESC
        LIMIT 100;
      `;

const INDEX_STATS_SQL = `
        SELECT
          TABLE_SCHEMA as schema_name,
          TABLE_NAME as table_name,
          INDEX_NAME as index_name,
          INDEX_TYPE as index_type,
          GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as columns,
          NOT NON_UNIQUE as is_unique,
          INDEX_NAME = 'PRIMARY' as is_primary,
          MAX(CARDINALITY) as cardinality
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?
        GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, INDEX_TYPE, NON_UNIQUE
        ORDER BY TABLE_NAME, INDEX_NAME
        LIMIT 200;
      `;

// Sizes come from the InnoDB persistent-statistics table, not from the INNODB_* views in
// information_schema. Two measurements on 2026-08-23 forced the move: `INNODB_TABLESPACES` has no
// `INDEX_SIZE` column on MySQL 26.7.0 or on the MySQL 8.0 inside Vitess 24.0.2 (both answer
// ER_BAD_FIELD_ERROR), and the old statement's `WHERE t.NAME LIKE 'schema/%'` assumed InnoDB names
// the table after the database you connected to, which Vitess does not — it stores the physical
// shard database, `vt_probe_0/orders`. `stat_value` is the index size in pages, per index rather
// than per tablespace, and the row is keyed on database/table/index columns that
// information_schema.STATISTICS reports the same way, so nothing here parses or guesses a prefix.
const INDEX_SIZES_SQL = `
          SELECT
            database_name,
            table_name,
            index_name,
            stat_value * @@innodb_page_size as size_bytes
          FROM mysql.innodb_index_stats
          WHERE stat_name = 'size' AND database_name = ?;
        `;

const STORAGE_STATS_SQL = `
        SELECT
          TABLE_SCHEMA as name,
          SUM(DATA_LENGTH + COALESCE(INDEX_LENGTH, 0)) as size_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        GROUP BY TABLE_SCHEMA;
      `;

// ============================================================================
// Object surface (#789)
// ----------------------------------------------------------------------------
// Hoisted to module scope for the same coverage reason as the schema SQL above.
//
// `information_schema` answers for every kind here, which is the OPPOSITE of the
// PostgreSQL provider's reasoning and is deliberate: MySQL 8's data dictionary made
// `information_schema` a set of views over the dictionary tables rather than the
// materialised copies it was through 5.7, so there is no cheaper native catalog to prefer
// and the SQL-standard names are the portable ones across the wire-compatible family.
// ============================================================================

/**
 * Schemas the server reserves for itself.
 *
 * A hand-written name list, unlike Oracle's `ORACLE_MAINTAINED` and PostgreSQL's
 * `pg_depend` ownership test, because neither server publishes the fact: nothing in
 * `information_schema.SCHEMATA` says whether a schema is the server's own. All four are
 * RESERVED on MySQL and MariaDB - `CREATE DATABASE mysql` answers ER_DB_CREATE_EXISTS on a
 * fresh server - so hiding them cannot hide a database a person created under that
 * spelling. Measured 2026-09-11 on MySQL 26.7.0 and MariaDB 12.3.2: `SCHEMATA` holds
 * exactly these four plus the user's own on both.
 *
 * They are hidden from the BROWSER and remain fully reachable from the SQL editor, which is
 * the same treatment `pg_catalog` gets on PostgreSQL. This provider itself reads two of
 * them (`performance_schema.global_status`, `mysql.innodb_index_stats`).
 */
const SYSTEM_SCHEMAS = ["information_schema", "mysql", "performance_schema", "sys"] as const;

/**
 * The reserved schemas that are reserved in EVERY spelling, compared case-insensitively.
 *
 * Only these two: measured 2026-10-09 on MySQL 8.4 with `lower_case_table_names=0`,
 * `CREATE DATABASE INFORMATION_SCHEMA` and `CREATE DATABASE Performance_Schema` answer 1044,
 * while `CREATE DATABASE MYSQL` and `CREATE DATABASE SYS` succeed. Folding `mysql` and `sys`
 * too would hide those two user databases. TiDB v8.5.8 answers `SHOW DATABASES` with
 * `INFORMATION_SCHEMA` and `PERFORMANCE_SCHEMA` in upper case, which is what this fold is
 * for (#1428).
 */
const CASE_FOLDED_SYSTEM_SCHEMAS: ReadonlySet<string> = new Set(["information_schema", "performance_schema"]);

/**
 * Databases a wire-compatible engine owns beyond the four above, keyed on what the server
 * says it is, and compared by exact name.
 *
 * Keyed on the server rather than hidden everywhere, because none of these names is
 * reserved on MySQL: measured 2026-10-09 on MySQL 8.4, `CREATE DATABASE` accepts
 * `METRICS_SCHEMA`, `oceanbase`, `cluster` and `memsql`, and the tree must keep listing
 * them there. Each was measured as listed as a person's database on its own engine (#1428).
 *
 * - TiDB v8.5.1 and v8.5.8: `METRICS_SCHEMA`, answered in upper case. `VERSION()` carries
 *   `TiDB`.
 * - OceanBase 4.4.2.1 CE: `oceanbase`. `VERSION()` carries `OceanBase`.
 * - SingleStore 8.7.12 and 9.1.1: `cluster` and `memsql`. `VERSION()` is a plain `5.7.32`,
 *   so `@@version_comment` (`SingleStoreDB source distribution ...`) is what names it.
 */
const ENGINE_OWNED_SCHEMAS: readonly {
  readonly owns: (version: string | undefined, versionComment: string | undefined) => boolean;
  readonly names: readonly string[];
}[] = [
  { owns: (version) => version !== undefined && /tidb/i.test(version), names: ["METRICS_SCHEMA"] },
  { owns: (version) => version !== undefined && /oceanbase/i.test(version), names: ["oceanbase"] },
  {
    owns: (_version, versionComment) => versionComment !== undefined && /^SingleStoreDB\b/i.test(versionComment),
    names: ["cluster", "memsql"],
  },
];

/**
 * The exact names hidden on a server that answered this `VERSION()` and `@@version_comment`.
 * An unmeasured server gets the four reserved names only, so nothing a person could have
 * created is hidden on a guess.
 */
function systemSchemasFor(version: string | undefined, versionComment: string | undefined): ReadonlySet<string> {
  return new Set([
    ...SYSTEM_SCHEMAS,
    ...ENGINE_OWNED_SCHEMAS.filter((engine) => engine.owns(version, versionComment)).flatMap((engine) => engine.names),
  ]);
}

function isSystemSchema(name: string, systemSchemas: ReadonlySet<string>): boolean {
  return systemSchemas.has(name) || CASE_FOLDED_SYSTEM_SCHEMAS.has(name.toLowerCase());
}

/**
 * The containers this connection has, which on MySQL is one level: databases.
 *
 * Bound to NOTHING, and that is the point. Every other introspection read in this file is
 * parameterised with `TABLE_SCHEMA = config.database` (section 3.2 of the provider doc), so
 * the app has only ever shown the database the connection opened against. MySQL resolves a
 * qualified name across databases on one connection - unlike PostgreSQL, where a `pg` pool
 * is pinned to one database and a second would need a second connection - so every database
 * the server holds is genuinely browsable from this session.
 *
 * `SHOW DATABASES` and not `information_schema.SCHEMATA`, because the two disagree on Vitess
 * and only this one names something a statement can address. Measured 2026-10-04 through
 * vtgate on Vitess 24.0.4 (`vitess/vttestserver:v24.0.4-mysql84`, keyspace `e2e`): SCHEMATA
 * answers `_vt` and `vt_e2e_0`, the sidecar and the physical shard database, and never the
 * keyspace, while `SHOW DATABASES` answers `e2e`. vtgate refuses the shard name everywhere
 * else (`VT05003: unknown database 'vt_e2e_0' in vschema`), so a tree built from SCHEMATA
 * could open nothing. Off Vitess, measured the same day, `SHOW DATABASES` answers the same
 * set as SCHEMATA on MySQL 26.7.0, MariaDB 13.0.2, Percona Server 8.4.11-11, TiDB 8.5.8,
 * Apache Doris 4.1.3, StarRocks and Databend 1.2.925; OceanBase was not measured. The
 * provider doc's section 7.1 has the table.
 *
 * The reserved schemas are dropped by `listContainers` rather than by a WHERE clause,
 * because vtgate ignores a WHERE on `SHOW DATABASES` and answers all five rows anyway. The
 * name is read from the FIRST column by position, not by the label `Database`, because the
 * label is not shared: Databend 1.2.925 calls it `databases_in_default`.
 */
const CONTAINERS_SQL = "SHOW DATABASES";

/**
 * The same question asked of the catalog, for a caller `SHOW DATABASES` refuses.
 *
 * A server started with `--skip-show-database` answers `SHOW DATABASES` only to a holder of
 * the global `SHOW DATABASES` privilege; anyone else gets errno 1227
 * (`ER_SPECIFIC_ACCESS_DENIED_ERROR`), while `information_schema.SCHEMATA` still lists the
 * databases that caller holds a grant on. Measured 2026-10-04 on MySQL 26.7.0 and MariaDB
 * 13.0.2, both started with `--skip-show-database`, as a user granted only `e2e.*`: the
 * statement above is refused and this one answers `e2e`. So on that refusal, and only on it,
 * `listContainers` falls back to the read this provider made before Vitess forced the change.
 */
const CONTAINERS_FALLBACK_SQL = "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA";

/** `ER_SPECIFIC_ACCESS_DENIED_ERROR`: what `SHOW DATABASES` answers under `--skip-show-database`. */
const SHOW_DATABASES_DENIED_ERRNO = 1227;

/**
 * Which database the session is in, by the SERVER's own answer rather than
 * `config.database`, for the reason Oracle reads `SYS_CONTEXT` instead of
 * `connection.user`: the configured value is what a person typed into a form. NULL when no
 * database was selected, which matches no container.
 */
const SESSION_DATABASE_SQL = "SELECT DATABASE() AS name";

/**
 * The catalog and EVERY spelling each declared kind is addressed by, written once.
 *
 * Two `information_schema` views answer for six of the eight kinds, and the values in each
 * entry are the literals that view's own type column holds. The counting statement's CASE
 * arms and every listing's BOUND types are both built from this table, so a kind added to
 * `objectKinds` without an entry here fails loudly instead of drawing a folder nothing can
 * fill. Triggers and events have a view each and need no type at all, so they are not here.
 *
 * THE ENGINE IS ENUMERATED HERE, NOT THE FIXTURE, and the difference was a real defect. The
 * first version of this table came from `SELECT DISTINCT TABLE_TYPE` over the seeded
 * fixture, which answers only what the fixture happens to hold; a type neither the CASE nor
 * the listing names falls out of BOTH, so the object is invisible in the tree while the
 * count and the listing still agree and every gate still passes. Measured 2026-09-11 over
 * tables built to produce each case:
 *
 * | `TABLE_TYPE` | MySQL 26.7.0 | MariaDB 12.3.2 | here |
 * |---|---|---|---|
 * | `BASE TABLE` | yes | yes | `table` |
 * | `VIEW` | yes | yes | `view` |
 * | `SYSTEM VIEW` | yes | yes | absent, see below |
 * | `SEQUENCE` | no | yes | `sequence` |
 * | `SYSTEM VERSIONED` | no | yes | `table` |
 * | `TEMPORARY` | no | yes | absent, see below |
 *
 * A PARTITIONED table is `BASE TABLE` on both, measured, so partitioning adds no spelling.
 * `ROUTINE_TYPE` is `PROCEDURE` and `FUNCTION` on MySQL, plus `PACKAGE` and `PACKAGE BODY`
 * on MariaDB, and MariaDB's grammar has no other routine form.
 *
 * `SYSTEM VERSIONED` is a `table` and not a kind of its own: MariaDB's system versioning is
 * a property of a table you still SELECT from, INSERT into and address by name, and giving it
 * a folder would split one concept across two.
 *
 * Two spellings are deliberately ABSENT, and each would be wrong in a different way.
 * `SYSTEM VIEW` is what `information_schema`'s own tables are, and that schema is not a
 * container here. `TEMPORARY` is SESSION-SCOPED, which a pooled provider cannot address at
 * all: measured on MariaDB 12.3.2, a `CREATE TEMPORARY TABLE` in one session is listed by
 * that session and by no other, and this provider hands out a different pooled connection
 * per method call. A Temporary folder would therefore badge whatever the connection that
 * answered `countObjects` happened to hold, list whatever a different connection held, and
 * hand out addresses that resolve on one connection and not the next.
 */
const MYSQL_OBJECT_TYPES: Record<
  string,
  { readonly catalog: "tables" | "routines"; readonly types: readonly string[] }
> = {
  table: { catalog: "tables", types: ["BASE TABLE", "SYSTEM VERSIONED"] },
  view: { catalog: "tables", types: ["VIEW"] },
  sequence: { catalog: "tables", types: ["SEQUENCE"] },
  procedure: { catalog: "routines", types: ["PROCEDURE"] },
  function: { catalog: "routines", types: ["FUNCTION"] },
  package: { catalog: "routines", types: ["PACKAGE"] },
};

/** Every kind one catalog answers for, derived so it cannot drift from the table above. */
function catalogKinds(catalog: "tables" | "routines"): readonly string[] {
  return Object.keys(MYSQL_OBJECT_TYPES).filter((kind) => MYSQL_OBJECT_TYPES[kind].catalog === catalog);
}

/** Every spelling one catalog answers for, derived so it cannot drift from the table above. */
function modelledTypes(catalog: "tables" | "routines"): readonly string[] {
  return Object.values(MYSQL_OBJECT_TYPES)
    .filter((spec) => spec.catalog === catalog)
    .flatMap((spec) => spec.types);
}

/**
 * Every catalog type this provider has a RULE for, and for the excluded ones the reason.
 *
 * This exists because "the vocabulary enumerates the engine" is a claim that decays. A future
 * MariaDB release can add a `TABLE_TYPE`, and the failure mode is silence: a spelling no CASE
 * arm names is dropped from the count AND from the listing, so the two still agree, every gate
 * still passes, and the object is simply absent from the tree. That is how `SYSTEM VERSIONED`
 * hid here in the first place.
 *
 * So the set is exported, and `tests/live/mysql-object-vocabulary.ts` asks a live server for
 * its own `SELECT DISTINCT TABLE_TYPE` and `SELECT DISTINCT ROUTINE_TYPE` and fails NAMING
 * anything outside it. The modelled half is derived from `MYSQL_OBJECT_TYPES`; the excluded
 * half is written here, and it is a map rather than a list so an exclusion cannot be added
 * without saying why.
 */
export const CATALOG_TYPE_RULES: {
  readonly tables: { readonly modelled: readonly string[]; readonly excluded: Readonly<Record<string, string>> };
  readonly routines: { readonly modelled: readonly string[]; readonly excluded: Readonly<Record<string, string>> };
} = {
  tables: {
    modelled: modelledTypes("tables"),
    excluded: {
      "SYSTEM VIEW": "what information_schema's own tables are, and that schema is not a container here",
      TEMPORARY:
        "session-scoped, and a pooled provider hands out a different connection per call, so the folder would badge one connection's tables and list another's",
    },
  },
  routines: {
    modelled: modelledTypes("routines"),
    excluded: {
      "PACKAGE BODY": "the second ROUTINES row of one package node; counting it would double the Packages badge",
    },
  },
};

/**
 * One CASE mapping one catalog's type column onto the kind ids it answers for.
 *
 * `flatMap`, because a kind may have SEVERAL spellings: `table` covers `BASE TABLE` and
 * MariaDB's `SYSTEM VERSIONED`, so a per-kind `map` would silently count only the first.
 */
function kindCase(catalog: "tables" | "routines", column: string): string {
  const arms = Object.entries(MYSQL_OBJECT_TYPES)
    .filter(([, spec]) => spec.catalog === catalog)
    .flatMap(([kind, spec]) => spec.types.map((type) => `WHEN '${type}' THEN '${kind}'`))
    .join(" ");
  return `CASE ${column} ${arms} END`;
}

/**
 * One statement, one GROUP BY, one round trip for the whole folder row.
 *
 * Four `information_schema` views, one UNION ALL arm each, and the SAME statement is sent to
 * both servers. Nothing here branches on the flavour and nothing needs to: MySQL holds no
 * `SEQUENCE` row and no `PACKAGE` row, so those CASE arms simply never fire there. The data
 * decides, which is one fewer place the two branches can disagree.
 *
 * A NULL kind is what the CASE has no name for, and it is dropped rather than counted under
 * a folder that does not exist: `SYSTEM VIEW` on both servers, plus `PACKAGE BODY` and
 * `TEMPORARY` on MariaDB. All three are deliberate and `MYSQL_OBJECT_TYPES` says why each
 * one is. The package body is not a second package - measured, `CREATE PACKAGE BODY` with no
 * specification answers ER_SP_DOES_NOT_EXIST - so counting it would double the Packages
 * badge exactly as it would on Oracle.
 *
 * Anything NOT on that list reaching a NULL kind is a defect and not a design: an object
 * dropped here is dropped from the listing too, so the count and the listing agree while the
 * object is invisible in the tree. That is why `MYSQL_OBJECT_TYPES` enumerates the engine
 * rather than a fixture.
 *
 * The NULL group is dropped AFTER the read, by `applyKindCounts`, and not by an outer
 * `WHERE kind IS NOT NULL`, because vtgate cannot plan that filter. Measured 2026-10-04 on
 * Vitess 24.0.4 (`vitess/vttestserver:v24.0.4-mysql84`): with the outer WHERE this statement
 * is `VT13001: [BUG] could not find the column 'TABLE_TYPE' on the UNION`, which put that
 * sentence on every folder of the tree, and without it vtgate answers the same counts MySQL
 * does. It is the filter pushed through three or more arms: the same WHERE over two arms is
 * answered. One extra GROUP BY row is the whole cost.
 *
 * The schema is bound four times rather than once because a prepared statement takes
 * positional parameters and each arm needs its own.
 */
const COUNTS_SQL = `
        SELECT kind, COUNT(*) AS n FROM (
          SELECT ${kindCase("tables", "TABLE_TYPE")} AS kind
          FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
          UNION ALL
          SELECT ${kindCase("routines", "ROUTINE_TYPE")}
          FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
          UNION ALL
          SELECT 'trigger' FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
          UNION ALL
          SELECT 'event' FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?
        ) s
        GROUP BY kind`;

/**
 * `COUNTS_SQL` one catalog at a time, each with the kinds its catalog answers for. Sent only
 * when the one-statement count is refused, so a server missing one of the four views loses
 * the folders that view counts and keeps the rest.
 *
 * Databend 1.2.881 has `information_schema.tables` and no `ROUTINES`, `TRIGGERS` or `EVENTS`
 * (measured 2026-10-04: each is `UnknownTable`, errno 1105), so the union failed as a whole
 * and its sentence was put on every folder of the tree, Tables and Views included, over a
 * catalog that answers them.
 */
const COUNTS_BY_CATALOG: readonly { readonly kinds: readonly string[]; readonly sql: string }[] = [
  {
    kinds: catalogKinds("tables"),
    sql: `
        SELECT kind, COUNT(*) AS n FROM (
          SELECT ${kindCase("tables", "TABLE_TYPE")} AS kind
          FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
        ) s
        GROUP BY kind`,
  },
  {
    kinds: catalogKinds("routines"),
    sql: `
        SELECT kind, COUNT(*) AS n FROM (
          SELECT ${kindCase("routines", "ROUTINE_TYPE")} AS kind
          FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
        ) s
        GROUP BY kind`,
  },
  {
    kinds: ["trigger"],
    sql: "SELECT 'trigger' AS kind, COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?",
  },
  {
    kinds: ["event"],
    sql: "SELECT 'event' AS kind, COUNT(*) AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?",
  },
];

/**
 * One kind's listing, with an `IN` list sized to however many spellings that kind has.
 *
 * `IN (?, ?)` and not `= ?`, because `table` has two: `BASE TABLE` and MariaDB's
 * `SYSTEM VERSIONED`. The placeholder count comes from `MYSQL_OBJECT_TYPES`, so the listing
 * and the counting statement's CASE arms cannot disagree about how many spellings a kind
 * has; nothing a caller supplied ever reaches the statement text, and the values are BOUND.
 *
 * On the relation side, `TABLE_ROWS` is an ESTIMATE for InnoDB, the same nature as
 * PostgreSQL's `reltuples`, and it is NULL for a VIEW along with both length columns -
 * measured, so `measuredNumber` reads absence there rather than reporting a view as an empty
 * relation. A MariaDB SEQUENCE answers `TABLE_ROWS` 1 and a real `DATA_LENGTH`, because a
 * sequence IS a table underneath.
 *
 * On the routine side, the bare `ROUTINE_NAME` is the whole path segment, and unlike
 * PostgreSQL it needs no argument list to be unique: MySQL does not overload routines.
 * Measured on 26.7.0, a second `CREATE PROCEDURE app.foo(a INT)` over an existing
 * `app.foo()` answers `ER_SP_ALREADY_EXISTS`, so a name identifies a routine within its
 * database and its type.
 */
function listingSql(catalog: "tables" | "routines", spellings: number): string {
  const placeholders = Array.from({ length: spellings }, () => "?").join(", ");
  if (catalog === "tables") {
    return `
        SELECT TABLE_NAME AS name, TABLE_ROWS AS row_count, DATA_LENGTH + COALESCE(INDEX_LENGTH, 0) AS size_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN (${placeholders})`;
  }
  return `
        SELECT ROUTINE_NAME AS name
        FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE IN (${placeholders})`;
}

/**
 * One rendered listing statement per kind, built at module scope.
 *
 * Rendered once rather than per call for the coverage reason the schema SQL above is hoisted
 * for: bun reports the interior lines of a template literal inside a function body as
 * zero-hit in any test process that imports this module without calling it.
 */
const LIST_OBJECT_SQL: Record<string, string> = Object.fromEntries(
  Object.entries(MYSQL_OBJECT_TYPES).map(([kind, spec]) => [kind, listingSql(spec.catalog, spec.types.length)]),
);

/**
 * The database's triggers, each with the table it fires on.
 *
 * `EVENT_OBJECT_TABLE` is the parent segment, which is what the `attachedTo: "table"`
 * declaration states. It is NOT there to make the name unique: measured on MySQL 26.7.0, a
 * trigger name is unique per DATABASE and not per table, so a second
 * `CREATE TRIGGER app.foo` on a different table answers `ER_TRG_ALREADY_EXISTS`. The
 * nesting is the tree shape the engine's own model implies - a trigger cannot exist without
 * its table - and `[database, trigger]` would be a perfectly unique address that simply does
 * not say what the trigger hangs off.
 *
 * `TRIGGER_SCHEMA` rather than `EVENT_OBJECT_SCHEMA`: they are the same on every MySQL
 * server, because a trigger lives in its table's database, and the first one is the
 * container that OWNS the row.
 */
const LIST_TRIGGERS_SQL = `
        SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS parent
        FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = ?`;

/** The database's scheduled events. One view, one column, no type to bind. */
const LIST_EVENTS_SQL = `
        SELECT EVENT_NAME AS name
        FROM information_schema.EVENTS
        WHERE EVENT_SCHEMA = ?`;

/**
 * One object's columns, primary key included: `COLUMN_KEY = 'PRI'` is the same read
 * `getSchema()` uses, so the two surfaces cannot disagree about which column is the key.
 *
 * It carries NO `LIMIT`, and that is the one way it differs from `SCHEMA_COLUMNS_SQL`.
 * That statement stops at 100 columns, which is a cap the flat tree can live with and a
 * detail panel cannot: nothing downstream can tell a cap from a count, so a 140-column
 * table would report 100 columns as a fact.
 *
 * It is a separate statement rather than a reuse for the same reason Oracle's four are:
 * `getSchema()` goes away with #789's last task, and the object surface's reads must not
 * have to be untangled from it then.
 */
const OBJECT_COLUMNS_SQL = `
        SELECT
          COLUMN_NAME AS column_name,
          COLUMN_TYPE AS column_type,
          DATA_TYPE AS data_type,
          IS_NULLABLE AS is_nullable,
          COLUMN_DEFAULT AS column_default,
          COLUMN_KEY AS column_key,
          EXTRA AS extra
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`;

/**
 * One object's foreign keys, with the database each reference lands in.
 *
 * `REFERENCED_TABLE_SCHEMA` is what `SCHEMA_FOREIGN_KEYS_SQL` does not read, and it matters
 * here because the object browser is no longer confined to one database: InnoDB accepts a
 * foreign key into another database, and a bare name for one of those addresses a table in
 * the wrong place.
 */
const OBJECT_FOREIGN_KEYS_SQL = `
        SELECT
          COLUMN_NAME AS column_name,
          REFERENCED_TABLE_SCHEMA AS referenced_schema,
          REFERENCED_TABLE_NAME AS referenced_table,
          REFERENCED_COLUMN_NAME AS referenced_column
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`;

/**
 * One object's indexes, ONE ROW PER COLUMN, grouped in code.
 *
 * `SCHEMA_INDEXES_SQL` uses `GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)` and this one
 * deliberately does not: `group_concat_max_len` is 1024 by default (measured on both
 * servers) and the function TRUNCATES silently at it, so a wide composite index would report
 * a column list that is short by an unknowable amount. Reading the rows and grouping them
 * here has no cap at all.
 */
const OBJECT_INDEXES_SQL = `
        SELECT INDEX_NAME AS index_name, COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`;

// ----------------------------------------------------------------------------
// Every object of one kind, described together (#789)
// ----------------------------------------------------------------------------

/**
 * The objects one bulk read describes, ordered, and bounded when the caller bounded it.
 *
 * This is the MEMBERSHIP of the answer and it comes from `information_schema.TABLES`, which
 * is the same view `listObjects` reads and is deliberately NOT the column read. Measured on
 * MySQL 26.7.0: a view whose base table has been dropped keeps its `TABLES` row and has no
 * `COLUMNS` row at all, so a target derived from the column read would silently drop an
 * object the folder lists - the same class of absence standing ruling 5a is about. It is
 * also what lets an object with no columns come back with three empty lists rather than
 * missing.
 *
 * `ORDER BY TABLE_NAME` is what makes a BOUNDED read deterministic, and it is the one sort
 * here that runs under the server's own collation. Measured on MySQL 26.7.0,
 * `information_schema.TABLES.TABLE_NAME` collates `utf8mb3_bin`, so that order is by code
 * point on this server; a fork that collates it case-insensitively would cut a different
 * set, which is why the doc records the order as the SERVER's rather than as ours. It
 * decides WHICH objects a bound keeps and nothing else: the answer is re-sorted by path
 * below, and a caller joins on path rather than on position.
 *
 * The bound is SPELLED INTO the statement rather than bound as a parameter, and it is the one
 * thing here that is not the obvious shape. This paragraph used to say the opposite, that
 * `LIMIT ?` is bound and not interpolated because MySQL 26.7.0 accepts a placeholder in a
 * derived table's LIMIT. That measurement still holds and was the wrong one to generalise
 * from: two of this driver's own relatives refuse a parameter in the LIMIT position under the
 * binary prepared protocol, measured 2026-09-22 through mysql2. Apache Doris 4.1.3-rc02
 * answers `mismatched input 'LIMIT' expecting {<EOF>, ';'}` and StarRocks 3.3.22-753696f
 * answers `using parameter(?) as limit or offset not supported`, while both run the identical
 * statement with the number written in, and the text protocol takes either form everywhere.
 * Stock MySQL binds it either way, so writing the bound in costs nothing there.
 * `describeObjects` validates the caller's limit as a positive whole number before this is
 * reached, so what gets spelled in is only ever digits.
 */
function bulkTargetSql(spellings: number, bound?: number): string {
  const placeholders = Array.from({ length: spellings }, () => "?").join(", ");
  return `
          SELECT TABLE_NAME AS name
          FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN (${placeholders})
          ORDER BY TABLE_NAME${bound === undefined ? "" : `\n          LIMIT ${bound}`}`;
}

/** The four statements one bulk read issues, all four sharing one target set. */
interface BulkDetailStatements {
  readonly target: string;
  readonly columns: string;
  readonly foreignKeys: string;
  readonly indexes: string;
}

/**
 * The three detail reads, each re-pointed from ONE object to the whole target set.
 *
 * They are the `OBJECT_*_SQL` bodies above with `TABLE_NAME = ?` replaced by a join to
 * `bulkTargetSql()`, so every measured decision those statements carry still applies here:
 * `COLUMN_KEY = 'PRI'` is the same primary-key rule `getSchema()` uses, the index read is
 * one row per column rather than a `GROUP_CONCAT` that truncates at 1024 bytes, and the
 * foreign-key read carries `REFERENCED_TABLE_SCHEMA` so a reference that leaves the
 * database can be qualified. Neither the columns nor the indexes are capped: getSchema()'s
 * `LIMIT 100` is an unreported bound and is the defect `ObjectDetailBatch.truncated` exists
 * to prevent. What is bounded here is the number of OBJECTS, by the caller, and it is
 * reported.
 *
 * FOUR round trips for a whole folder rather than THREE PER OBJECT, which is the entire
 * reason this method exists. One statement is not reachable on this engine: mysql2 sends
 * one statement per call, and `JSON_ARRAYAGG` has no ordering guarantee at all, so the
 * column order a person reads would become the order the optimizer happened to produce.
 *
 * The three reads repeat the target subquery rather than joining a temporary of it, and
 * that is safe for one measured reason: a table name is unique within a database, so
 * `ORDER BY TABLE_NAME` is a TOTAL order and all four statements cut the same set. Rows
 * for an object the target's extra `limit + 1` row named are dropped by the caller below
 * rather than by a fourth bound.
 */
function bulkDetailSql(spellings: number, bound?: number): BulkDetailStatements {
  const target = bulkTargetSql(spellings, bound);
  return {
    target,
    columns: `
        SELECT
          d.name AS object_name,
          c.COLUMN_NAME AS column_name,
          c.COLUMN_TYPE AS column_type,
          c.DATA_TYPE AS data_type,
          c.IS_NULLABLE AS is_nullable,
          c.COLUMN_DEFAULT AS column_default,
          c.COLUMN_KEY AS column_key,
          c.EXTRA AS extra
        FROM (${target}) d
        JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = ? AND c.TABLE_NAME = d.name
        ORDER BY d.name, c.ORDINAL_POSITION`,
    foreignKeys: `
        SELECT
          d.name AS object_name,
          k.COLUMN_NAME AS column_name,
          k.REFERENCED_TABLE_SCHEMA AS referenced_schema,
          k.REFERENCED_TABLE_NAME AS referenced_table,
          k.REFERENCED_COLUMN_NAME AS referenced_column
        FROM (${target}) d
        JOIN information_schema.KEY_COLUMN_USAGE k ON k.TABLE_SCHEMA = ? AND k.TABLE_NAME = d.name
        WHERE k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY d.name, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    indexes: `
        SELECT
          d.name AS object_name,
          s.INDEX_NAME AS index_name,
          s.COLUMN_NAME AS column_name,
          s.NON_UNIQUE AS non_unique
        FROM (${target}) d
        JOIN information_schema.STATISTICS s ON s.TABLE_SCHEMA = ? AND s.TABLE_NAME = d.name
        ORDER BY d.name, s.INDEX_NAME, s.SEQ_IN_INDEX`,
  };
}

/**
 * One entry per kind that HAS columns, which on this engine is the kinds
 * `information_schema.TABLES` resolves.
 *
 * Rendered at module scope for the coverage reason the listing statements are: bun reports
 * the interior lines of a template literal inside a function body as zero-hit in a process
 * that imports this module without calling it.
 */
const BULK_DETAIL_SQL: Record<string, BulkDetailStatements> = Object.fromEntries(
  Object.entries(MYSQL_OBJECT_TYPES)
    .filter(([, spec]) => spec.catalog === "tables")
    .map(([kind, spec]) => [kind, bulkDetailSql(spec.types.length)]),
);

// ----------------------------------------------------------------------------
// The declaration, which is a function of the SERVER and not of the type id
// ----------------------------------------------------------------------------

/**
 * The source declaration every kind on this engine carries (#789 Phase 2).
 *
 * ONE value spread into eight kinds rather than eight pairs of literals, so a kind cannot gain
 * `hasSource` and miss its language: an absent or unregistered Monaco id degrades to plain text
 * with no throw and nothing observable, which is a Source tab that silently stops highlighting.
 *
 * `mysql` is a language id the installed monaco-editor 0.57.0 bundle really registers, unlike
 * `plsql`, `tsql` and `cql`, which the design's first-pass table named and the bundle does not
 * have. The same id serves MariaDB: the two servers share one dialect for everything here
 * except the ORACLE-mode package, whose text Monaco highlights as MySQL with the quoted
 * identifiers rendered as strings, and there is no closer id in the bundle to prefer.
 */
const MYSQL_SOURCE_DECLARATION = { hasSource: true, sourceLanguage: "mysql" } as const;

/**
 * The six kinds every MySQL-protocol server has.
 *
 * No `index` kind, deliberately. MySQL's own dictionary models an index as an attribute of
 * the table it is on - `information_schema.STATISTICS` is keyed by `TABLE_SCHEMA` and
 * `TABLE_NAME`, and an index cannot exist without them - so it belongs in
 * `describeObject`'s output, where it is, rather than in a container-level folder.
 */
const MYSQL_OBJECT_KINDS: readonly ObjectKindSpec[] = [
  {
    id: "table",
    role: "relation",
    label: "Table",
    labelPlural: "Tables",
    acceptsRowWrites: true,
    // DERIVED, not transcribed (#789). `hasColumns()` (:1860) is the one rule `describeObject`
    // and `describeObjects` already gate on, and a function declaration hoists, so calling it
    // here is legal: `MYSQL_OBJECT_TYPES` (:694) is initialized ahead of this array. A second
    // hand-written copy of the catalog fact is how the client gate and the reads would drift.
    hasColumns: hasColumns("table"),
    ...MYSQL_SOURCE_DECLARATION,
  },
  // No `acceptsRowWrites`. MySQL takes an UPDATE against a simple updatable view and
  // refuses it against a view with an aggregate, a UNION or a DISTINCT, which is a
  // per-OBJECT fact this per-kind declaration cannot state; claiming it would offer an
  // import target that fails on most views in most databases.
  {
    id: "view",
    role: "relation",
    label: "View",
    labelPlural: "Views",
    hasColumns: hasColumns("view"),
    ...MYSQL_SOURCE_DECLARATION,
  },
  {
    id: "procedure",
    role: "routine",
    label: "Stored Procedure",
    labelPlural: "Stored Procedures",
    ...MYSQL_SOURCE_DECLARATION,
  },
  { id: "function", role: "routine", label: "Function", labelPlural: "Functions", ...MYSQL_SOURCE_DECLARATION },
  {
    id: "trigger",
    role: "attached",
    label: "Trigger",
    labelPlural: "Triggers",
    attachedTo: "table",
    ...MYSQL_SOURCE_DECLARATION,
  },
  { id: "event", role: "config", label: "Event", labelPlural: "Events", ...MYSQL_SOURCE_DECLARATION },
];

/**
 * The two kinds MariaDB has and MySQL does not have at all.
 *
 * A package's members are DECLARED and not browsable in Phase 1: `childKinds` is a true
 * statement about the engine, and the provider surface is container-scoped end to end, so
 * a Procedures folder under a package would render, never badge, and expand to nothing.
 */
const MARIADB_EXTRA_OBJECT_KINDS: readonly ObjectKindSpec[] = [
  {
    id: "package",
    role: "group",
    label: "Package",
    labelPlural: "Packages",
    childKinds: ["procedure", "function"],
    ...MYSQL_SOURCE_DECLARATION,
  },
  {
    id: "sequence",
    role: "config",
    label: "Sequence",
    labelPlural: "Sequences",
    // `config` and it still has columns, which is the entry that refutes deriving the client
    // gate from the role: a sequence is a table underneath and `information_schema.COLUMNS`
    // answers eight rows for it (measured on MariaDB 12.3.2). Same derivation as `table`.
    hasColumns: hasColumns("sequence"),
    ...MYSQL_SOURCE_DECLARATION,
  },
];

/**
 * MariaDB's own name inside its `VERSION()` string.
 *
 * Narrower than `SELF_IDENTIFYING_VERSION` above on purpose: that one asks "did the server
 * name a vendor at all", and this one asks "is this server MariaDB", which is a different
 * question with a different answer for TiDB, Vitess and OceanBase. All three self-identify
 * and none of them has a package or a sequence.
 */
const MARIADB_VERSION = /mariadb/i;

/**
 * Which server in this family this is.
 *
 * A type id cannot answer it: `DatabaseType` has no `mariadb` entry, and choosing MySQL in
 * the connection dialog is the documented way to reach a MariaDB server
 * (docs/providers/mysql.md 1.1). Branching on the type id here would be both forbidden
 * inside `src/lib/db` and unable to tell the two servers apart in the first place.
 */
type MySQLFlavour = "mysql" | "mariadb";

/**
 * The flavour a server with this `VERSION()` string is, and THE ONLY PLACE
 * `MARIADB_VERSION` is read.
 *
 * An unmeasured version answers `"mysql"`, which is what an unconnected provider gets:
 * `POST /api/db/provider-meta` reads capabilities off a provider it never connects (#457).
 * MySQL is the safe default of the two for `objectKinds`, because declaring a kind the
 * server does not have draws a folder that can never fill, while missing one costs two
 * folders a MariaDB user regains the moment the connection is live.
 */
function flavourFor(version: string | undefined): MySQLFlavour {
  return version !== undefined && MARIADB_VERSION.test(version) ? "mariadb" : "mysql";
}

/**
 * The kinds a server of this flavour has.
 *
 * THIS IS THE ONE PROVIDER WHOSE `objectKinds` IS NOT A CONSTANT, and the resolution is from
 * the server rather than from the type id, for the reason `MySQLFlavour` records.
 */
function objectKindsFor(flavour: MySQLFlavour): readonly ObjectKindSpec[] {
  return flavour === "mariadb" ? [...MYSQL_OBJECT_KINDS, ...MARIADB_EXTRA_OBJECT_KINDS] : MYSQL_OBJECT_KINDS;
}

/**
 * What this server calls itself, or `undefined` when it would not say. Run once per
 * `connect()`, on the connection the pool check already holds.
 *
 * Nothing here rejects, for the reason `probeExplainFormat` does not: a version string the
 * server would not give is a fact about which folders the browser can draw, not about the
 * connection, and `connect()` must not fail for it. The cost of the absent case is
 * `flavourFor`'s MySQL default, which every server in this family does have.
 */
const probeServerVersion = async (queryable: MySQLQueryable): Promise<string | undefined> => {
  try {
    const [rows] = await runStatement(queryable, "SELECT VERSION() AS version");
    const version = rows[0]?.version;
    return version === null || version === undefined ? undefined : String(version);
  } catch {
    // Refused, so the flavour is unmeasured. The capability this produces IS the report.
    return undefined;
  }
};

/**
 * What this server says about its own build in `@@version_comment`, or `undefined` when it
 * would not say. The same never-rejects contract as `probeServerVersion`, for the same reason:
 * the answer only decides which databases the tree hides, and an unmeasured comment hides
 * nothing beyond the reserved four.
 */
const probeVersionComment = async (queryable: MySQLQueryable): Promise<string | undefined> => {
  try {
    const [rows] = await runStatement(queryable, "SELECT @@version_comment AS version_comment");
    const comment = rows[0]?.version_comment;
    return comment === null || comment === undefined ? undefined : String(comment);
  } catch {
    // Refused, so the engine is unmeasured and only the reserved names are hidden.
    return undefined;
  }
};

/** U+1F600, which only a 4-byte UTF-8 sequence (or a 6-byte CESU-8 pair) can carry. */
const UTF8MB3_LABEL_PROBE = "SELECT '\u{1F600}' AS probe";

/**
 * Whether this server sends 4-byte UTF-8 in a column it labels utf8mb3.
 *
 * mysql2 asks for a utf8mb4 session, and a MySQL-family server then converts every text
 * result to utf8mb4 and labels it so. Databend, StarRocks and Apache Doris label EVERY
 * text column 33 (utf8mb3_general_ci) whatever the session asked for, while the bytes are
 * plain UTF-8. Measured 2026-10-04 on Databend 1.2.881, StarRocks 4.1.6 and Doris 4.1.3:
 * this literal came back labelled 33 and, through mysql2's `cesu8` decoder, as four
 * U+FFFD; `hex()` of a stored value held `f09f9880`. Neither `charset:
 * 'UTF8MB4_UNICODE_CI'` (mysql2's default), `UTF8MB4_GENERAL_CI`, `UTF8MB4_0900_AI_CI` nor
 * `SET NAMES utf8mb4` changed the label.
 *
 * Measured, not derived from the type id: the same probe on MySQL 26.7.0, MariaDB 13.0.2
 * and TiDB v7.5.1 answers a utf8mb4 label and the character itself, so those connections
 * decode exactly as mysql2 decides. A refusal reads as "no", the decoding mysql2 already
 * does.
 */
const probeUtf8UnderUtf8mb3 = async (queryable: MySQLQueryable): Promise<boolean> => {
  try {
    const [rows, fields] = await runStatement(queryable, UTF8MB3_LABEL_PROBE);
    return fields[0]?.encoding === "cesu8" && String(rows[0]?.probe).includes("\uFFFD");
  } catch {
    return false;
  }
};

// ----------------------------------------------------------------------------
// Object surface shapes and derivations
// ----------------------------------------------------------------------------

/**
 * One row of `CONTAINERS_SQL` or `CONTAINERS_FALLBACK_SQL`. One column whose LABEL differs by
 * engine (`Database`, Databend's `databases_in_default`, the fallback's `name`), so it is read
 * by position.
 */
type ContainerRow = RowDataPacket;

/** One row of `SESSION_DATABASE_SQL`. NULL when the session selected no database. */
interface SessionDatabaseRow extends RowDataPacket {
  name: string | null;
}

/**
 * One row of `COUNTS_SQL`: a kind id and how many of it the database holds. The kind is NULL
 * for the group of catalog spellings the CASE arms do not name, which `applyKindCounts`
 * skips because no declared kind is called that.
 */
interface KindCountRow extends RowDataPacket {
  kind: string | null;
  n: number;
}

/**
 * One listed object, from whichever of the four listing statements answered.
 *
 * `parent` is selected by the trigger listing alone and `row_count` / `size_bytes` by the
 * relation listing alone, which is what lets one mapper serve all four.
 */
interface ObjectRow extends RowDataPacket {
  name: string;
  parent?: string | null;
  row_count?: string | number | null;
  size_bytes?: string | number | null;
}

/**
 * The container levels this provider declares, sliced to the depth `containerDepth()` reports.
 *
 * One reader for the whole file, so the depth and the level list can never be taken by two
 * different rules. `containerDepth()` is what decides, never `containerLevels.length`.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * The segment of `path` belonging to the declared container level `id`.
 *
 * NEVER `path[0]`, and that is the general form of a defect this file shipped three times in
 * two narrower shapes. A container level's POSITION is a property of the declaration, not a
 * constant: MySQL declares `[schema]`, so the schema is the first segment here, and the five
 * two-level engines that copy this file declare `[catalog, schema]`, where `path[0]` is the
 * CATALOG and binding it as the schema narrows every read to a database that does not exist.
 * The three earlier shapes were `container.length !== 1`, `path[1]` for the object name, and
 * `path[0]` for the schema; all three are depth-identical on a one-level engine, which is
 * exactly why each survived a review. Standing ruling 5g forbids the class, not the instances.
 *
 * Both failure modes raise through one guard: a declaration with no level of this `id`, and a
 * path too short to carry it. Neither may fall through to `undefined`, which mysql2 rejects
 * outright as a bind and which would otherwise surface as a driver error naming neither the
 * path nor the method.
 */
function containerSegment(
  capabilities: ProviderCapabilities,
  path: readonly string[],
  id: ContainerLevelSpec["id"],
): string {
  const levels = declaredLevels(capabilities);
  const index = levels.findIndex((level) => level.id === id);
  const segment = index < 0 ? undefined : path.slice(0, levels.length)[index];
  if (segment === undefined) {
    throw new QueryError(
      `A MySQL path needs a "${id}" container level and a segment for it; the declaration is ` +
        `[${levels.map((level) => level.id).join(", ")}] and the path is ${JSON.stringify(path)}`,
      "mysql",
    );
  }
  return segment;
}

/**
 * The one database a container path names on this engine.
 *
 * The expected depth is read through `containerDepth()` and the segment NAMES come from the
 * declared level labels, so the check and its message are the same array and a provider
 * copying this file cannot inherit a hardcoded `1`. That matters even though MySQL declares
 * exactly one level: `container.length !== 1` is behaviour-identical here and silently wrong
 * on the five two-level engines that copy this file, so no suite on a one-level engine can
 * tell the two spellings apart.
 *
 * A path of any other length is a caller that built it from another engine's shape, and it
 * raises rather than reading a segment and carrying on, because `undefined` bound to `?`
 * would answer an empty folder that looks exactly like a database holding nothing - and
 * mysql2 rejects `undefined` outright, which would surface as a driver error naming neither
 * the path nor the method. The segment itself comes from `containerSegment()`, so which
 * position holds the schema is read off the declaration rather than assumed.
 */
function containerSchema(capabilities: ProviderCapabilities, container: readonly string[]): string {
  assertContainerPathShape(capabilities, container, MYSQL_CONTAINER_PATH_ENGINE);
  return containerSegment(capabilities, container, "schema");
}

/**
 * Every declared kind seeded at zero, before any row is read.
 *
 * Seeding is what makes "this server has this kind and this database holds none" render as a
 * 0 badge. Building the record from the GROUP BY rows alone would leave the kind out
 * entirely, and an absent kind already means something else and stronger: the server has no
 * such concept, so the tree draws no folder at all.
 */
function seedZeroCounts(kinds: readonly ObjectKindSpec[]): Record<string, KindCount> {
  return Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 } as KindCount]));
}

/**
 * Overwrites the seeded zeros with what the GROUP BY actually answered.
 *
 * A kind that was never seeded is SKIPPED, and on this provider that is a live case rather
 * than defensive programming: the counting statement is the same text on both servers, so a
 * MariaDB server whose version probe came back empty answers `sequence` and `package` rows
 * that the MySQL declaration has no folder for. The DECLARATION decides which folders exist
 * and a catalog row cannot add one, which is also what keeps
 * `tests/helpers/object-surface-conformance.ts`'s "never answers for an undeclared kind"
 * true from the provider's side.
 *
 * `Object.hasOwn` and not `in`, which is what makes that guarantee absolute rather than
 * nearly so: `in` walks the prototype chain, so a catalog row whose kind read `toString` or
 * `constructor` would pass the test and write a folder the provider never declared.
 */
function applyKindCounts(counts: Record<string, KindCount>, rows: readonly KindCountRow[]): void {
  for (const row of rows) {
    if (row.kind !== null && Object.hasOwn(counts, row.kind)) counts[row.kind] = { count: Number(row.n) };
  }
}

/**
 * The server's own sentence, verbatim, against every kind the failed read covered.
 *
 * Deliberately NOT through `mapDatabaseError`. That mapper gives a THROWN error a type and
 * this product's prefix, and nothing here throws: the sentence is rendered to a person as
 * the reason a folder has no number, so prefixing it would put our words in front of the
 * server's. A refused read is never 0 - "SELECT command denied to user" and "this database
 * holds no tables" are different facts and `KindCount` is the type that keeps them apart.
 */
function unavailableCounts(ids: readonly string[], error: unknown): Record<string, KindCount> {
  const reason = error instanceof Error ? error.message : String(error);
  return Object.fromEntries(ids.map((id) => [id, { unavailable: reason } as KindCount]));
}

/**
 * Errnos for a statement the server STOPPED rather than refused: `ER_QUERY_INTERRUPTED` (1317,
 * a `KILL QUERY`), MySQL's `max_execution_time` (3024, `ER_QUERY_TIMEOUT`) and MariaDB's
 * `max_statement_time` (1969, `ER_STATEMENT_TIMEOUT`). The statement was fine; asking its
 * parts one at a time would only be stopped again.
 */
const STOPPED_STATEMENT_ERRNOS: ReadonlySet<number> = new Set([1317, 3024, 1969]);

/**
 * Whether an error is the server refusing the statement, which is the only case a smaller
 * statement can answer: a positive server errno, on a connection mysql2 did not mark `fatal`,
 * for a statement that was not stopped. A network error carries a negative `errno` and
 * `fatal: true`, and an error with no errno never reached the server at all.
 */
function isStatementRefusal(error: unknown): boolean {
  const { errno, fatal } = (error ?? {}) as { errno?: unknown; fatal?: unknown };
  return typeof errno === "number" && errno > 0 && fatal !== true && !STOPPED_STATEMENT_ERRNOS.has(errno);
}

/**
 * The counts read one catalog at a time, after the one-statement count was refused. Each
 * catalog that refuses marks only the declared kinds it counts, with its own sentence, and a
 * server that refuses all four ends where the one statement did: every folder unavailable.
 */
async function countByCatalog(
  conn: PoolConnection,
  schema: string,
  counts: Record<string, KindCount>,
): Promise<Record<string, KindCount>> {
  for (const { kinds, sql } of COUNTS_BY_CATALOG) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one pooled connection runs one statement at a time.
      const [rows] = await runStatement<KindCountRow[]>(conn, sql, [schema]);
      applyKindCounts(counts, rows);
    } catch (error) {
      Object.assign(
        counts,
        unavailableCounts(
          kinds.filter((kind) => Object.hasOwn(counts, kind)),
          error,
        ),
      );
    }
  }
  return counts;
}

/**
 * MySQL: an attached kind takes EITHER depth, because `objectPath()` collapses a
 * parentless trigger onto the container-level address (standing ruling 5f: the listing
 * must contain exactly what the count counted, and the count wins), so the error names
 * both shapes.
 */
const PATH_SHAPE_ENGINE: ObjectPathShapeEngine = {
  code: "mysql",
  label: "A MySQL",
  attachedSegment: "optional",
};

// ----------------------------------------------------------------------------
// Object source reading (#789 Phase 2)
// ----------------------------------------------------------------------------

/**
 * One part of one object's source document, and the statement that reads it.
 *
 * `column` is the reply column's exact spelling and it is per statement rather than per row
 * position, because the four routine forms do not agree: MEASURED on MySQL 26.7.0 and MariaDB
 * 12.3.2, the columns are `Create Procedure`, `Create Function`, `Create Package` and
 * `Create Package Body`, and a trigger's is `SQL Original Statement`. A positional read would
 * be right for six kinds and silently wrong for the two the reply shape differs on.
 *
 * `optional` is the MariaDB package body and nothing else: a part whose ABSENCE is a legal
 * state of the object rather than a failure to read it.
 */
interface SourcePartPlan {
  readonly id: string;
  readonly label: string;
  /** The statement text; the escaped address is appended to it. It never takes a bind. */
  readonly statement: string;
  readonly column: string;
  readonly form: ObjectSourceForm;
  readonly origin: ObjectSourceOrigin;
  readonly optional?: true;
}

/**
 * The first part of a document, whose absence is the OBJECT's absence and therefore raises.
 *
 * `optional?: undefined` and not a bare omission: the head of the tuple would otherwise accept
 * an entry carrying `optional: true`, which would make a whole object silently unreadable.
 */
type SourceHeadPlan = SourcePartPlan & { readonly optional?: undefined };

/**
 * Every part AFTER the first, whose absence must be a legal state of the object.
 *
 * `optional: true` is REQUIRED here by the type rather than checked at runtime, and that is the
 * repository's own precedent: `object-route.ts` deleted a 501 arm on the argument that a guard
 * for a state the type can express is a covered line nothing executes. A tail entry added later
 * without it is a red BUILD, which is stronger than a throw no test can reach.
 */
type SourceTailPlan = SourcePartPlan & { readonly optional: true };

/**
 * Which statements read one kind's definition, head first.
 *
 * Every `form` is `complete`: MEASURED, each of these answers a statement that runs as given,
 * never a body or a bare SELECT, which is what separates this engine from PostgreSQL's
 * `pg_get_viewdef`.
 *
 * `origin` is split and the split is a measurement rather than a convention. A procedure, a
 * function, a trigger, an event and a MariaDB package come back as the AUTHOR'S OWN BYTES,
 * including the fixture's two-space indentation and its `COALESCE(NEW.total, 0)` spacing, so
 * they are `stored`. A table, a view and a MariaDB sequence are REBUILT from the dictionary:
 * `CREATE TABLE customers (id INT NOT NULL, ...)` comes back as
 * `CREATE TABLE \`customers\` (\n  \`id\` int NOT NULL,...` with backquoting, a display width
 * and an `ENGINE=` clause nobody typed, and `CREATE SEQUENCE invoice_number_seq START WITH 1`
 * comes back carrying `minvalue`, `maxvalue`, `cache` and `nocycle`. They are `regenerated`,
 * and a reader must never be shown a reconstruction as an original.
 *
 * MEASURED on MariaDB 12.3.2 and it REFUTES the design's predicted column name: the reply to
 * `SHOW CREATE SEQUENCE` carries `Table` and `Create Table`, not `Sequence` and
 * `Create Sequence`. A sequence is a table underneath on that server, which is the same fact
 * that puts it in `information_schema.TABLES` with `TABLE_TYPE = 'SEQUENCE'`.
 *
 * THE SESSION `sql_mode` IS NOT TOUCHED, and that is a measurement too. The design said
 * `SHOW CREATE PACKAGE` may need `sql_mode=ORACLE`; it does not. On 12.3.2 both package
 * statements answered the full text under the image's default mode, byte-identical to the same
 * statements after `SET SESSION sql_mode='ORACLE'`. The ORACLE spelling that appears in the
 * reply's own `sql_mode` COLUMN is the mode the package was CREATED under, which is a property
 * of the stored object and not a requirement on its reader (#789).
 *
 * Nothing here branches on the DATABASE TYPE id, which `CLAUDE.md` forbids inside
 * `src/lib/db`. A kind id is this provider's own declaration and only this provider can
 * interpret it, exactly as `MYSQL_OBJECT_TYPES` does one derivation above.
 */
const MYSQL_SOURCE_PART_PLANS: Record<string, readonly [SourceHeadPlan, ...SourceTailPlan[]]> = {
  table: [
    {
      id: "definition",
      label: "Definition",
      statement: "SHOW CREATE TABLE",
      column: "Create Table",
      form: "complete",
      origin: "regenerated",
    },
  ],
  view: [
    {
      id: "definition",
      label: "Definition",
      statement: "SHOW CREATE VIEW",
      column: "Create View",
      form: "complete",
      origin: "regenerated",
    },
  ],
  procedure: [
    {
      id: "definition",
      label: "Definition",
      statement: "SHOW CREATE PROCEDURE",
      column: "Create Procedure",
      form: "complete",
      origin: "stored",
    },
  ],
  function: [
    {
      id: "definition",
      label: "Definition",
      statement: "SHOW CREATE FUNCTION",
      column: "Create Function",
      form: "complete",
      origin: "stored",
    },
  ],
  trigger: [
    {
      id: "definition",
      label: "Definition",
      statement: "SHOW CREATE TRIGGER",
      column: "SQL Original Statement",
      form: "complete",
      origin: "stored",
    },
  ],
  event: [
    {
      id: "definition",
      label: "Definition",
      statement: "SHOW CREATE EVENT",
      column: "Create Event",
      form: "complete",
      origin: "stored",
    },
  ],
  sequence: [
    {
      id: "definition",
      label: "Definition",
      statement: "SHOW CREATE SEQUENCE",
      column: "Create Table",
      form: "complete",
      origin: "regenerated",
    },
  ],
  // A MariaDB package is ONE tree node over TWO statements, the same shape Oracle's is, and it
  // carries the same two part labels so a reader moving between the two engines reads one
  // vocabulary. The BODY is optional and the SPECIFICATION is not, which is the engine's own
  // asymmetry: MEASURED on 12.3.2, `app.spec_only_pkg` answers its spec and answers
  // `ERROR 1305 PACKAGE BODY spec_only_pkg does not exist` for its body, while a
  // `CREATE PACKAGE BODY` with no specification is refused with the same errno. So a body
  // cannot exist without a spec, a spec can exist without a body, and reading the spec FIRST is
  // what tells a missing body apart from a missing package.
  package: [
    {
      id: "spec",
      label: "Package specification",
      statement: "SHOW CREATE PACKAGE",
      column: "Create Package",
      form: "complete",
      origin: "stored",
    },
    {
      id: "body",
      label: "Package body",
      statement: "SHOW CREATE PACKAGE BODY",
      column: "Create Package Body",
      form: "complete",
      origin: "stored",
      optional: true,
    },
  ],
};

/**
 * The errnos that mean THIS SERVER WILL NOT SHOW YOU THIS, measured rather than listed.
 *
 * Every one of them was produced on both servers by a caller holding `GRANT EXECUTE ON app.*`
 * and nothing else, against objects the fixture holds:
 *
 * - 1142 `ER_TABLEACCESS_DENIED_ERROR`, twice and with two different verbs:
 *   `SHOW command denied to user 'src_probe'@'localhost' for table 'orders'` from
 *   `SHOW CREATE TABLE`, and `SELECT command denied ... for table 'order_summary'` from
 *   `SHOW CREATE VIEW`, which is the `SHOW VIEW` plus `SELECT` requirement in the server's own
 *   words. MariaDB 12.3.2 qualifies the table name and MySQL 26.7.0 does not, which is one more
 *   reason the sentence is carried VERBATIM rather than rebuilt here.
 * - 1227 `ER_SPECIFIC_ACCESS_DENIED_ERROR`,
 *   `Access denied; you need (at least one of) the TRIGGER privilege(s) for this operation`.
 * - 1044 `ER_DBACCESS_DENIED_ERROR`, `Access denied for user 'src_probe'@'%' to database 'app'`,
 *   which is what `SHOW CREATE EVENT` answers without the `EVENT` privilege.
 *
 * A refusal is NOT an absence and the two are not one number here: the folder listed the object,
 * so telling a reader it does not exist would be a false claim about the database.
 */
const SOURCE_REFUSAL_ERRNOS: ReadonlySet<number> = new Set([1044, 1142, 1227]);

/**
 * The errnos that mean NO SUCH OBJECT AT THIS ADDRESS, measured against names nothing holds.
 *
 * - 1146 `ER_NO_SUCH_TABLE`, `Table 'app.no_such_table' doesn't exist`, from the table, view and
 *   sequence statements alike.
 * - 1305 `ER_SP_DOES_NOT_EXIST`, `PROCEDURE no_such_procedure does not exist`, from all four
 *   routine forms, `PACKAGE BODY` included.
 * - 1360 `ER_TRG_DOES_NOT_EXIST`, `Trigger does not exist`, which NAMES NOTHING. That is why the
 *   absence raise below carries OUR sentence and not the server's: a message that does not name
 *   the object cannot tell a reader which read failed.
 * - 1539 `ER_EVENT_DOES_NOT_EXIST`, `Unknown event 'no_such_event'`.
 * - 1347 `ER_WRONG_OBJECT`, `'app.orders' is not VIEW` on MySQL and `is not of type 'VIEW'` on
 *   MariaDB, and 4089 `'app.orders' is not a SEQUENCE` on MariaDB. A name that resolves to an
 *   object of ANOTHER kind is the absence of an object of THIS kind, and the kind is what the
 *   caller asked under: MEASURED, `app.order_archive` is both a table and a procedure on both
 *   servers, so this is a live case rather than a defensive one.
 *
 * ERROR 1305 is ALSO what a caller holding nothing at all is told about an object that does
 * exist, and that caller is NOT a case this arm mishandles: MEASURED, the same caller sees no
 * row for the routine in `information_schema.ROUTINES` either, so it never lists the object and
 * never reaches this read.
 */
const SOURCE_ABSENCE_ERRNOS: ReadonlySet<number> = new Set([1146, 1305, 1347, 1360, 1539, 4089]);

/** The driver's own errno, or nothing when the failure did not come from the server. */
function sourceErrno(error: unknown): number | undefined {
  const errno = (error as { errno?: unknown } | null)?.errno;
  return typeof errno === "number" ? errno : undefined;
}

/**
 * The database a monitoring row names: the server's own spelling when it is the database the
 * read was filtered on, and the filter otherwise.
 *
 * The echo is kept when it matches without regard to case, because on a server with
 * `lower_case_table_names=1` a connection configured as `App` reads rows whose `TABLE_SCHEMA`
 * is `app`, and `app` is the spelling the tree's containers carry, which the Operations tab
 * matches a row against. The echo is REPLACED when it names something else, which is Vitess:
 * there it is the physical shard (`vt_e2e_0` for the keyspace `e2e`, measured 2026-10-04 on
 * 24.0.4), this field is the container `runMaintenance` qualifies with, and vtgate refuses the
 * shard name (`VT05003: unknown database 'vt_e2e_0' in vschema`).
 */
function reportedSchema(echoed: unknown, filter: string | undefined): string {
  if (typeof echoed === "string" && filter !== undefined && echoed.toLowerCase() === filter.toLowerCase()) {
    return echoed;
  }
  return filter ?? "";
}

/**
 * What one source read produced: a text, the server's refusal, or a legal absence.
 *
 * Three arms and never a shape with an optional `text`, for the reason `ObjectSourcePart` is a
 * union: a refusal and an empty answer are different facts, and one shape carrying both makes
 * them the same value at every call site below.
 */
type SourceRead =
  | { readonly outcome: "text"; readonly text: string }
  | { readonly outcome: "refused"; readonly unavailable: string }
  | { readonly outcome: "absent" };

/**
 * One plan and one read, as the part a document carries.
 *
 * The two arms are built as WHOLE LITERALS and neither is spread from the other, which is the
 * point rather than a style. A part carrying BOTH `text` and `unavailable` COMPILES as an
 * `ObjectSourcePart`, because TypeScript's excess-property check on a union admits any property
 * declared on ANY member of it, and `isSourcePartUnavailable` then narrows such a part to the
 * refusal arm and drops a definition the engine really returned. A provider that spread a
 * conditional `{ unavailable }` onto a bounded text would build exactly that part; this one
 * cannot, because the refusal arm returns before the text arm is reached and neither literal
 * mentions the other's keys (#789).
 */
function sourcePart(
  plan: SourcePartPlan,
  read: SourceRead & { outcome: "text" | "refused" },
  language: string,
  limit: number | undefined,
): ObjectSourcePart {
  if (read.outcome === "refused") {
    return { id: plan.id, label: plan.label, unavailable: read.unavailable };
  }
  const bounded = applySourceBound(read.text, limit);
  return {
    id: plan.id,
    label: plan.label,
    text: bounded.text,
    language,
    form: plan.form,
    origin: plan.origin,
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}

/**
 * Which statement answers for one kind, or nothing when this server has no such kind.
 *
 * Four shapes, and the kind decides which: a trigger reads the trigger view for the table it
 * hangs off, an event reads the event view, and the other six are one row each out of
 * `TABLES` or `ROUTINES` with the type BOUND rather than interpolated - so nothing a caller
 * supplied ever reaches the statement text.
 */
function objectListingStatement(schema: string, kind: string): { sql: string; params: unknown[] } | undefined {
  if (kind === "trigger") return { sql: LIST_TRIGGERS_SQL, params: [schema] };
  if (kind === "event") return { sql: LIST_EVENTS_SQL, params: [schema] };
  const spec = MYSQL_OBJECT_TYPES[kind];
  if (spec === undefined) return undefined;
  return { sql: LIST_OBJECT_SQL[kind], params: [schema, ...spec.types] };
}

/**
 * Where one listed object is addressed.
 *
 * Built from the ROW rather than from the kind id, so the four listing statements share one
 * rule: a `parent` column adds a nesting segment and nothing else does. That is what the
 * `attachedTo: "table"` declaration states.
 *
 * A NULL parent collapses to the container-level address, and on MySQL that is a complete
 * address rather than a degraded one: a trigger name is unique per DATABASE (measured,
 * ER_TRG_ALREADY_EXISTS), so `[database, trigger]` addresses it. No measured server puts a
 * NULL there - `information_schema.TRIGGERS` has no row without a base table - which is why
 * this is one expression and not two shapes.
 *
 * It takes the WHOLE CONTAINER and not the schema segment. This used to be
 * `objectPath(container, row)` building `[schema, name]`, which is behaviour-identical on this
 * one-level engine and silently wrong the moment a declaration grows a level: both readings
 * then agreed on an address that had lost its outer segment, and agreeing with each other is
 * not the same as being right. The caller has already had the container refused by
 * `containerSchema()` unless it is exactly the declared depth, so what arrives here is the
 * container the declaration describes, whatever depth that becomes (standing ruling 5g, #789).
 */
function objectPath(container: readonly string[], row: ObjectRow): string[] {
  const parent = row.parent;
  if (parent === undefined || parent === null) return [...container, row.name];
  return [...container, parent, row.name];
}

/** One row of the column read, single or bulk. `object_name` is present only in the bulk one. */
interface DetailColumnRow extends RowDataPacket {
  column_name: string;
  /**
   * The type AS DECLARED, length and precision and value list and `unsigned` included
   * (#1033). Both column reads select it, so it is required rather than optional: a row
   * without it is a read this module did not write.
   */
  column_type: string;
  /** The type FAMILY. A separate catalog column the server reports on its own, not one derived from `COLUMN_TYPE` by stripping parts out of it. */
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  column_key: string;
  /** Optional because the mocks of the OTHER column reads in the suite do not carry it, and
   *  because a row without it says nothing about the column being generated, which is a
   *  true reading rather than a fallback. */
  extra?: string | null;
}

/** One referencing column of one foreign key, with the database the reference lands in. */
interface DetailForeignKeyRow extends RowDataPacket {
  column_name: string;
  referenced_schema: string;
  referenced_table: string;
  referenced_column: string;
}

/** One COLUMN of one index. The index itself is grouped out of these rows. */
interface DetailIndexRow extends RowDataPacket {
  index_name: string;
  column_name: string;
  non_unique: number;
}

/** The three row sets one object's detail is built from, whichever read produced them. */
interface DetailRows {
  readonly columns: readonly DetailColumnRow[];
  readonly foreignKeys: readonly DetailForeignKeyRow[];
  readonly indexes: readonly DetailIndexRow[];
}

/**
 * How a server of one flavour spells a column default in `information_schema.COLUMNS`.
 *
 * Measured 2026-09-20 on MariaDB 12.3.2-MariaDB-ubu2404 and MySQL 26.7.0, one probe table
 * per server, `HEX(COLUMN_DEFAULT)` read beside the text.
 *
 * MySQL reports the VALUE: a column with no default is SQL NULL, and `DEFAULT 'abc'` reads
 * back as the three characters `abc`. MariaDB reports the DEFAULT EXPRESSION AS WRITTEN: a
 * NULLABLE column with no default reads back as the four-character keyword `NULL`, and
 * `DEFAULT 'abc'` reads back as `'abc'`, quotes included. So the same four characters mean
 * opposite things on the two servers, and every string default differs by its quotes (#795).
 *
 * This is a table and not a conditional so that the next divergence adds a FIELD here
 * rather than a branch at a call site.
 */
interface CatalogDefaultReading {
  /** What `COLUMN_DEFAULT` holds for a column that has no default. */
  readonly absence: "sql-null" | "null-keyword";
  /** Whether a string default arrives evaluated, or as the SQL literal as written. */
  readonly literal: "evaluated" | "as-written";
  /**
   * Where a default's SQL text comes from: the catalog row itself, or - on the flavour whose
   * catalog carries none - `SHOW CREATE TABLE`, read only for a caller that asks (#1031).
   */
  readonly defaultSql: "catalog" | "show-create";
}

const CATALOG_DEFAULT_READING: Record<MySQLFlavour, CatalogDefaultReading> = {
  mysql: { absence: "sql-null", literal: "evaluated", defaultSql: "show-create" },
  mariadb: { absence: "null-keyword", literal: "as-written", defaultSql: "catalog" },
};

/**
 * The two `EXTRA` spellings that mean the column is generated, and the reason the match is
 * on the WHOLE value.
 *
 * Measured on both servers: a generated column reads `STORED GENERATED` or `VIRTUAL
 * GENERATED`, identically. But MySQL also writes `DEFAULT_GENERATED` for an ORDINARY
 * expression default, and `DEFAULT_GENERATED on update CURRENT_TIMESTAMP` for an on-update
 * one, where MariaDB writes nothing at all. A rule matching the substring `GENERATED` would
 * therefore erase a MySQL default the user really set.
 */
const GENERATED_COLUMN_EXTRA = new Set(["STORED GENERATED", "VIRTUAL GENERATED"]);

/**
 * One catalog row's default, as BOTH readings a column can have: the value it really
 * defaults to, and the SQL text that produces that value where this server's catalog text is
 * valid SQL. An empty object is a column with no default at all, and neither field is set.
 *
 * The order is part of the contract:
 *
 *  1. SQL NULL is absence on both servers, whatever else the row says.
 *  2. A generated column has no insert default on EITHER server, so this rule carries no
 *     flavour and is true everywhere. It comes before the keyword rule because MariaDB
 *     reports the same four characters for both cases.
 *  3. The keyword, on the flavour that spells absence with it.
 *  4. A literal, on the flavour that reports literals as written. `unquoteLiteral` answers
 *     `undefined` for anything that is not exactly one literal, which is what lets an
 *     expression default such as `concat('x','y')` through untouched.
 */
function catalogDefault(
  raw: string | null,
  extra: string | null | undefined,
  reading: CatalogDefaultReading,
): { defaultValue?: string; defaultExpression?: string } {
  if (raw === null) return {};
  // `undefined` is a row that carries no EXTRA at all, which is the shape every OTHER mock
  // in the suite produces and a truthful reading: nothing said this column was generated.
  if (extra !== null && extra !== undefined && GENERATED_COLUMN_EXTRA.has(extra.trim().toUpperCase())) {
    return {};
  }
  if (reading.absence === "null-keyword" && raw === "NULL") return {};
  // MariaDB's catalog text is always valid SQL for MariaDB: measured on 12.3.2, every form
  // it reports - `'abc'`, `''`, `42`, `b'1'`, `x'616263'`, `'2020-01-01'`,
  // `current_timestamp()`, `concat('x','y')` - can be pasted back after the word DEFAULT. So
  // the expression is the raw text, unchanged, and the value is it decoded.
  if (reading.literal === "as-written") {
    return { defaultValue: unquoteLiteral(raw, "mysql") ?? raw, defaultExpression: raw };
  }
  // MySQL reports the VALUE, and no column of the row says whether that text is also SQL:
  // `abc` is a value and is not valid after DEFAULT, while `b'1'` and `0x616263` ARE SQL,
  // and all three arrive with an EMPTY `EXTRA`. So the CATALOG row declares no SQL text
  // rather than a guessed one. The text comes from the engine instead, `SHOW CREATE TABLE`,
  // for a caller that asks for it (`defaultSql: "show-create"`, #1031), and is filled in by
  // `objectDetailFromRows`. Do not guess it here from the value or the type.
  return { defaultValue: raw };
}

/**
 * Three catalog row sets turned into one `ObjectDetail`, shared by the single and the bulk
 * read.
 *
 * ONE function because the two reads select the same columns from the same three views and
 * a caller joins their results together: two copies of this mapping would be two chances
 * for the bulk read to spell a foreign key differently from the single read of the SAME
 * table, and nothing downstream could tell which one was right.
 *
 * `NON_UNIQUE` is 0 for a unique index, so the flag is its negation and not its value, and
 * the columns of one index arrive in `SEQ_IN_INDEX` order because both statements order by
 * it.
 *
 * `referencedTable` is spelled the way `getSchema()` spells it - bare within the container,
 * qualified outside it - because `ForeignKeySchema` carries one string and both surfaces
 * are live through Phase 1. The phase that removes `getSchema` is where that string becomes
 * a path. Qualifying the cross-database case is not cosmetic: a bare name there addresses a
 * table in the wrong database, and InnoDB does accept a foreign key into another one.
 */
function objectDetailFromRows(
  path: readonly string[],
  schema: string,
  rows: DetailRows,
  reading: CatalogDefaultReading,
  ddlDefaults?: ReadonlyMap<string, string>,
): ObjectDetail {
  const columns: ColumnSchema[] = rows.columns.map((row) => {
    const catalog = catalogDefault(row.column_default, row.extra, reading);
    // Only for a column the catalog says HAS a default: the DDL says `DEFAULT NULL` for a
    // nullable column with none, and that is not a default the column was given (#1031).
    const ddl = catalog.defaultValue === undefined ? undefined : ddlDefaults?.get(row.column_name);
    return {
      name: row.column_name,
      type: row.column_type,
      ...(row.column_type === row.data_type ? {} : { baseType: row.data_type }),
      nullable: row.is_nullable === "YES",
      isPrimary: row.column_key === "PRI",
      ...catalog,
      ...(ddl === undefined ? {} : { defaultExpression: portableDefaultSql(ddl, row.data_type) }),
    };
  });

  const byIndex = new Map<string, IndexSchema>();
  for (const row of rows.indexes) {
    const name = String(row.index_name);
    const index = byIndex.get(name) ?? { name, columns: [], unique: Number(row.non_unique) === 0 };
    index.columns.push(String(row.column_name));
    byIndex.set(name, index);
  }

  const foreignKeys: ForeignKeySchema[] = rows.foreignKeys.map((row) => ({
    columnName: row.column_name,
    referencedTable:
      row.referenced_schema === schema
        ? String(row.referenced_table)
        : `${String(row.referenced_schema)}.${String(row.referenced_table)}`,
    referencedColumn: row.referenced_column,
  }));

  return { path: [...path], columns, indexes: [...byIndex.values()], foreignKeys };
}

/**
 * Whether this kind's objects can have columns, an index or a foreign key on this server.
 *
 * ONE rule for the single read and the bulk one, keyed on the CATALOG each kind is read
 * from rather than on `role === "relation"`. That is what makes a MariaDB SEQUENCE come out
 * right: it is `config`, since nobody selects rows from it, and it still has eight real
 * columns because a sequence is a table underneath (measured on 12.3.2).
 *
 * `Object.hasOwn` and not a bare index: a kind id is an OPEN string, and
 * `MYSQL_OBJECT_TYPES["constructor"]` answers an object off the prototype chain.
 */
function hasColumns(kind: string): boolean {
  return Object.hasOwn(MYSQL_OBJECT_TYPES, kind) && MYSQL_OBJECT_TYPES[kind].catalog === "tables";
}

/** The rows of one bulk read grouped by the object each belongs to. */
function byObjectName<T extends RowDataPacket>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const name = String(row.object_name);
    const held = grouped.get(name);
    if (held === undefined) grouped.set(name, [row]);
    else held.push(row);
  }
  return grouped;
}

// ============================================================================
// MySQL Provider
// ============================================================================

export class MySQLProvider extends SQLBaseProvider {
  private pool: Pool | null = null;

  /**
   * The EXPLAIN grammar this server accepts, measured by `probeExplainFormat()` at
   * connect. It starts as MySQL's own grammar, which is what this provider declared
   * unconditionally before the probe existed and is still the right answer for an
   * unconnected provider: `POST /api/db/provider-meta` reads capabilities off a
   * provider it never connects (#457), so the pre-flight the client does keeps
   * exactly the behaviour it had.
   */
  private measuredExplainFormat: ExplainFormat | undefined = "mysql-json";

  /**
   * Which server this is, derived at connect from `probeServerVersion()`. It starts as
   * `"mysql"`, the answer for a provider that has not asked any server anything yet, for
   * the reason `flavourFor` records. The DERIVED fact is what is stored, the same way
   * `measuredExplainFormat` stores a grammar and not the text of the probe that found it.
   */
  private measuredFlavour: MySQLFlavour = "mysql";
  private systemSchemas: ReadonlySet<string> = systemSchemasFor(undefined, undefined);

  /**
   * Which maintenance verbs this server's grammar has, measured by `probeMaintenance()` at connect
   * (#1387). Undefined is "not measured", and answers the whole MySQL set, for the same reason
   * `measuredExplainFormat` starts at MySQL's grammar.
   */
  private measuredMaintenance: Partial<Record<MaintenanceOperation, MeasuredMaintenancePlacements>> | undefined;

  /**
   * True when this instance was opened under the agent read-only execution profile.
   *
   * Server-injected only (see `ProviderExecutionContext`): the editor path builds
   * providers from caller-supplied `ProviderOptions`, which has no route to this
   * flag in either direction.
   */
  private readonly readOnlyProfile: boolean;

  /**
   * The pool `queryReadOnly` runs on, built only when `readOnlyProfile` is true.
   *
   * Separate from the pool every other path shares, for two measured reasons:
   *
   * 1. `multipleStatements` must be FALSE on it, and a pasted connection string
   *    carrying `?multipleStatements=true` beats an option mysql2 was handed
   *    (measured 2026-10-09 on MySQL 26.7.0 through mysql2: the `;`-joined text
   *    ran). `buildReadOnlyPoolConfig()` strips the parameter rather than trusting
   *    the option to win.
   * 2. Every call pins a transaction and several session modes on the connection it
   *    holds, and resets them before release; keeping that traffic off the pool the
   *    editor's own statements share costs an editor user nothing.
   */
  private roPool: Pool | null = null;

  // Transaction support: dedicated connection held outside pool
  private txConn: PoolConnection | null = null;
  private txActive = false;
  /** Whether the server reported the state of the held transaction when it opened (`beginTransaction()`). */
  private txStateReported = false;
  private txTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly TX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  constructor(config: DatabaseConnection, options: ProviderOptions = {}, execution: ProviderExecutionContext = {}) {
    super(config, options);
    this.readOnlyProfile = execution.readOnly === true;
    this.validate();
  }

  // ============================================================================
  // Provider Metadata
  // ============================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      defaultPort: 3306,
      // Measured at connect, not declared per type id: the MySQL-wire relatives do
      // not all accept `EXPLAIN FORMAT=JSON` (#574). The key is spread in rather than
      // set to `undefined` because `ProviderCapabilities.explainFormat` is present iff
      // `supportsExplain` is true, and the provider tests assert that as a shape.
      supportsExplain: this.measuredExplainFormat !== undefined,
      ...(this.measuredExplainFormat === undefined ? {} : { explainFormat: this.measuredExplainFormat }),
      supportsConnectionString: true,
      supportsInlineRowEdit: true,
      // The Generate Test Data dialog's multi-row `INSERT INTO ... VALUES` (#1468).
      supportsTestDataGeneration: true,
      // `LIMIT n OFFSET m`, applied by the shared limiter in `SQLBaseProvider.prepareQuery`.
      supportsResultPagination: true,
      // BEGIN over one held connection (`beginTransaction()` below).
      supportsTransactions: true,
      // DDL, account and table-administration statements commit the open transaction
      // (the MySQL manual's "Statements That Cause an Implicit Commit"), so SANDBOX
      // refuses them instead of reporting a rollback that undid nothing.
      implicitCommitStatements: MYSQL_IMPLICIT_COMMIT_STATEMENTS,
      implicitCommitExceptions: MYSQL_IMPLICIT_COMMIT_EXCEPTIONS,
      // MySQL's own set, narrowed to what the connected server accepted (#1387): see
      // `probeMaintenance`. Unconnected, it is the whole set.
      ...narrowMaintenance(MYSQL_MAINTENANCE, this.measuredMaintenance),
      // One level, and on MySQL the level IS a database: a schema is not a thing created
      // beside a database, the two words name the same object. `catalog` is not a second
      // level here - MySQL has exactly one and `information_schema.SCHEMATA` is what a
      // catalog would contain.
      containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
      // Only the declared depth is an address: a partial path would leave a level unbound and
      // answer an empty folder. Read through `acceptedContainerShapes()` (#1147).
      containerPathShapes: "exact",
      // Six kinds on MySQL and eight on MariaDB, resolved from what the server called
      // itself and never from the type id (#789). See `objectKindsFor`.
      objectKinds: objectKindsFor(this.measuredFlavour),
    };
  }

  /**
   * The vacuum slot and the slow-query empty state; every other label is the SQL
   * default and right.
   *
   * MySQL rendered the base default *"Vacuum Table"* in the explorer's per-row menu
   * and the base *"Run Vacuum" / "Reclaim Space"* copy on the Operations tab, for an
   * engine whose operations are `analyze`/`optimize`/`check`/`kill` (#496). The words
   * below name what MySQL actually runs, and `vacuumActionOperation` says which
   * operation the surfaces should send for them.
   *
   * `getSlowQueries()` reads `performance_schema.events_statements_summary_by_digest`,
   * and the panel used to name PostgreSQL's extension in its empty state (#463) - a
   * statement store MySQL does not have under any name.
   *
   * The sentence describes the SOURCE and what an empty list means about it, and stops
   * there. It cannot do more: `QueriesTab` renders this one fixed string for every empty
   * list whatever produced it, so any instruction in it is addressed to causes it cannot
   * tell apart. It used to end "enable the Performance Schema to see them", which named
   * the one cause that never reaches the failure path at all (off-ness answers 0 rows,
   * measured; see `getSlowQueries()`) and was unactionable advice for the ones that do -
   * a denied grant, or a tenant with no `performance_schema` database. Those now reject
   * instead of emptying, and the panel shows the server's own reason through
   * `PanelUnavailable`, which is a different string on a different branch.
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      vacuumAction: "Optimize Table",
      vacuumActionOperation: "optimize",
      vacuumGlobalLabel: "Run Optimize",
      vacuumGlobalTitle: "Optimize Tables",
      vacuumGlobalDesc:
        "Runs OPTIMIZE TABLE over every table in the database, rebuilding its storage and reclaiming the space deleted rows left behind.",
      slowQueriesEmptyState:
        "Query stats come from performance_schema.events_statements_summary_by_digest for this database. An empty list means it recorded nothing - the Performance Schema is off, or nothing has run against this database yet.",
    };
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError("Host is required for MySQL", "mysql");
      }
      if (!this.config.database) {
        throw new DatabaseConfigError("Database name is required for MySQL", "mysql");
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    try {
      // No pool `error` listener here, unlike the PostgreSQL and SQL Server providers
      // (#298): mysql2's pool has no pool-level `error` event to listen for. Audited in
      // the installed package — `mysql2/lib/base/pool.js` emits only `acquire`,
      // `connection`, `enqueue` and `release`, the promise wrapper forwards exactly those
      // four (`lib/promise/pool.js`), and `typings/mysql/lib/Pool.d.ts` types no `error`
      // overload. A connection that fails reports through the call that holds it.
      this.pool = mysql.createPool(this.buildPoolConfig());

      const conn = await this.pool.getConnection();
      // The pool check already holds a connection, so the probes cost no extra
      // acquisition. Neither rejects, so the release below is never skipped.
      this.measuredExplainFormat = await probeExplainFormat(conn);
      // Which server this is, which is what decides the object-kind declaration (#789).
      // Measured rather than derived from the type id, because there is no `mariadb` type
      // id to derive from.
      const version = await probeServerVersion(conn);
      this.measuredFlavour = flavourFor(version);
      const versionComment = await probeVersionComment(conn);
      // Which databases this engine owns beyond the reserved four (#1428). Never rejects.
      this.systemSchemas = systemSchemasFor(version, versionComment);
      // Which of ANALYZE, OPTIMIZE and CHECK TABLE this server has (#1387). Never rejects.
      this.measuredMaintenance = await probeMaintenance(conn, this.config.database);
      // Every later acquisition, this probe connection's included, then reads utf8mb3
      // columns as UTF-8 through `runStatement`. Only this pool's connections are marked.
      if (await probeUtf8UnderUtf8mb3(conn)) {
        this.pool.on("acquire", (core: object) => UTF8_UNDER_UTF8MB3.add(core));
      }
      // The same per-pool marking for a server that will not prepare a statement, so its
      // parameterised reads bind their values client-side instead of failing.
      const bindsClientSide = await probeClientSideBinding(conn);
      if (bindsClientSide) {
        this.pool.on("acquire", (core: object) => BINDS_CLIENT_SIDE.add(core));
      }
      const probeCore = (conn as { connection?: object }).connection;
      const readsUtf8UnderUtf8mb3 = probeCore !== undefined && UTF8_UNDER_UTF8MB3.has(probeCore);

      // Under the profile the boundary has to be PROVEN before the provider is handed
      // out: which server this is, and what the session's principal may do. Both
      // checks run on the connection the pool check already holds, and either failing
      // refuses the open - an unproven boundary is not a boundary.
      if (this.readOnlyProfile) {
        MySQLProvider.assertAgentEngineIsAdmissible(version, versionComment);
        const grants = await MySQLProvider.readAgentGrants(conn);
        MySQLProvider.assertAgentPrincipalIsUnprivileged(grants);
        this.roPool = mysql.createPool(this.buildReadOnlyPoolConfig());
        // The same per-pool markings the main pool got, so a read through
        // `queryReadOnly` decodes utf8mb3 and binds exactly the way `query` does.
        if (readsUtf8UnderUtf8mb3) {
          this.roPool.on("acquire", (core: object) => UTF8_UNDER_UTF8MB3.add(core));
        }
        if (bindsClientSide) {
          this.roPool.on("acquire", (core: object) => BINDS_CLIENT_SIDE.add(core));
        }
      }
      conn.release();

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      // The pools are built before anything that can fail after them, and
      // `acquireExecutionProfileProvider` drops a provider whose connect threw WITHOUT
      // calling disconnect(), so a pool left open here leaks its idle sockets and timers
      // with no reference left to close them.
      const failedPool = this.pool;
      const failedRoPool = this.roPool;
      this.pool = null;
      this.roPool = null;
      await failedPool?.end().catch(() => {});
      await failedRoPool?.end().catch(() => {});
      // A typed profile refusal keeps its identity: wrapping it would strip the deny
      // code that callers branch on (`PROFILE_*`), which is the whole reason the code
      // exists.
      if (error instanceof ExecutionProfileError) {
        throw error;
      }
      throw new ConnectionError(
        `Failed to connect to MySQL: ${error instanceof Error ? error.message : error}`,
        "mysql",
        this.config.host,
        this.config.port,
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.setConnected(false);
    }
    // The read-only pool is separate (see `roPool`), so it is ended separately. It can
    // exist without the main one surviving: `connect()` clears both when it fails.
    if (this.roPool) {
      await this.roPool.end().catch(() => {});
      this.roPool = null;
    }
  }

  private buildPoolConfig(): mysql.PoolOptions {
    const baseConfig: mysql.PoolOptions = {
      // Without this, mysql2 hands a BIGINT past 2^53 back as a rounded Number. Measured on
      // MySQL 8.4.11 through the inline-edit hook: a table holding 9007199254740992 and
      // 9007199254740993 sent BOTH rows to the browser as ...992, the guard asked about
      // ...992 and was told one row matched, and the UPDATE then wrote the NEIGHBOUR's row
      // and reported success. With it, the driver returns a string for the values a Number
      // cannot hold and the edit writes the row the user opened.
      //
      // First entry so it covers both paths below - the structured config and the pasted
      // connection string, which share nothing else.
      //
      // Nothing narrower changes type - measured on the same server with this on, `SELECT 5`
      // is still the number 5 and `COUNT(*)` is still a number; only the values a Number
      // cannot hold arrive as strings. `bigNumberStrings` is deliberately NOT set: it would
      // turn both of those into strings too, changing types that were never wrong.
      supportBigNumbers: true,
      // DATE, DATETIME and TIMESTAMP as the text the server sends (#1388). Left to itself
      // mysql2 builds a `Date`, which holds milliseconds and always a time of day, so
      // `DATETIME(6)` lost three digits, a `DATE` became a UTC midnight instant, and every
      // surface showed an ISO form with a `Z` the column does not have. The inline editor
      // pre-filled that ISO text and the server refused it back (`Incorrect date value`).
      // The text is the server's own rendering, in the session `time_zone` for TIMESTAMP,
      // which is also what it accepts in a literal, so an edit or an exported INSERT
      // round-trips it, a zero date included. Same first-entry placement, for both paths.
      dateStrings: true,
      connectionLimit: this.poolConfig.max,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    };

    // Without a zone, mysql2 reads DATE and DATETIME in the Node process's local zone and the
    // row then serialises as ISO UTC, so the value moves with the server's TZ. Measured under
    // TZ=Europe/Istanbul on MySQL 8.4: a pasted connection string answered `DATE '2026-09-01'`
    // as 2026-08-31T21:00:00.000Z, the previous day, while the structured form, the only one
    // that set this, answered 2026-09-01. Since `dateStrings` no row is read through it any
    // more; it still decides how a JavaScript `Date` bound as a PARAMETER is written, which
    // is the same zone question in the other direction.
    const timezone = this.options.timezone ?? "Z";

    if (this.config.connectionString) {
      // A `?timezone=` written into the string is the user's own choice, and mysql2 lets an
      // option beat the `uri` (`ConnectionConfig` skips every uri key the options already
      // set), so the default is passed only when the string names no zone of its own.
      const connectionString = this.config.connectionString;
      const namesTimezone = new URL(connectionString).searchParams.has("timezone");
      return {
        ...baseConfig,
        ...(namesTimezone ? {} : { timezone }),
        uri: connectionString,
      };
    }

    return {
      ...baseConfig,
      host: this.config.host,
      port: this.config.port ?? 3306,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      ssl: this.buildSSLConfig(),
      timezone,
    };
  }

  private buildSSLConfig(): mysql.SslOptions | undefined {
    const connSSL = this.config.ssl;

    if (connSSL) {
      if (connSSL.mode === "disable") return undefined;

      const ssl: mysql.SslOptions = {
        // Every mode except `require` verifies (D26): `verify-system` checks the chain against
        // the trust store the runtime already has - no `ca` is set below, so Node's bundled
        // roots decide - while `verify-ca`/`verify-full` check it against the PEM pasted into
        // the form. `require` is the one mode that encrypts without checking anything.
        rejectUnauthorized: connSSL.mode !== "require",
      };

      if (connSSL.caCert) ssl.ca = connSSL.caCert;
      if (connSSL.clientCert) ssl.cert = connSSL.clientCert;
      if (connSSL.clientKey) ssl.key = connSSL.clientKey;

      return ssl;
    }

    if (this.shouldEnableSSL()) {
      return { rejectUnauthorized: false };
    }

    return undefined;
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  /**
   * Build the query envelope from what mysql2 handed back.
   *
   * `execute`'s first return value is an ARRAY of rows only for a statement that
   * produced a result set. For everything else - DDL, INSERT, UPDATE, DELETE - it
   * is a `ResultSetHeader` object and `fields` is `undefined`. Measured verbatim
   * against mysql 26.7.0 on 2026-08-23, `INSERT INTO r5_hdr (note) VALUES
   * ('a'),('b')` answers
   * `{fieldCount:0,affectedRows:2,insertId:1,info:"Records: 2  Duplicates: 0  Warnings: 0",serverStatus:2,warningStatus:0,changedRows:0}`.
   *
   * Calling `.map` on that object threw `result.rows.map is not a function` AFTER
   * the server had already applied the statement, so every DDL and DML statement
   * run from the editor reported a failure for work that had landed - the answer
   * that makes a user retry and double-apply it.
   *
   * The empty-result answer follows what the other SQL providers here already do:
   * no rows, no fields, and the affected-row count in `rowCount` (mssql reports
   * `rowsAffected[0]`, sqlite `changes`, postgres `pg`'s own `rowCount`).
   * `insertId`, `changedRows` and `warningStatus` are deliberately dropped:
   * `QueryResult` models none of them, and `rowCount` is the field the results
   * footer renders. `affectedRows` is the matched count, which is why a no-op
   * UPDATE still reports 1 - matching mssql, whose `rowsAffected` counts the same
   * way.
   *
   * A result set arrives as array rows (`rowsAsArray`, see `runStatement`) and is keyed here by
   * `uniqueFieldNames`, by position: mysql2's object rows keep the last of two columns that share
   * a name, so a join projecting `id` from both tables showed one table's id under both headers.
   * A `CALL` answers one result set per SELECT its procedure ran and its own OK packet last, with
   * `fields` one list per set and `undefined` for each header; a connection string that opted into
   * `multipleStatements` answers a `;`-separated text the same way. Then `rows`, `fields` and
   * `columnTypes` are the first set's, `rowCount` its row count (or the first header's
   * `affectedRows` when no set came back), and `resultSets` lists every set when there are several.
   * Before, that list was read as one set's rows.
   */
  private buildQueryResult(
    rows: unknown,
    fields: FieldPacket[] | undefined,
    executionTime: number,
    sql: string,
  ): QueryResult {
    if (!Array.isArray(rows)) {
      const header = rows as { affectedRows?: number };
      return {
        rows: [],
        fields: [],
        rowCount: header.affectedRows ?? 0,
        executionTime,
      };
    }

    return {
      // The driver's rows are handed on UNCHANGED, binary values included.
      // A `sanitizeRow` used to walk every row and turn a `Buffer` into the string
      // `0x<hex>` (and an empty one into `""`), because the JSON a Buffer serializes
      // to - `{"type":"Buffer","data":[…]}` - was unreadable. `src/lib/export/binary.ts`
      // now READS that exact shape (#469), which is how Postgres's `bytea` reaches the
      // grid, the row sheet, the CSV and the SQL export, so the string was the only
      // thing standing between a MySQL BLOB and the same treatment: the grid showed
      // `0x0102ab` where Postgres showed `\x0102ab`, and the export wrote the eight
      // characters `'0x0102ab'` into a BLOB column rather than the three bytes.
      // Measured against MySQL 26.7.0 on 2026-08-24; see docs/providers/mysql.md §3.3.
      ...mysqlResults(rows, fields, sql),
      executionTime,
    };
  }

  // Track running query thread IDs for cancellation
  private runningQueryThreadIds = new Map<string, number>();

  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        const conn = await this.pool!.getConnection();
        try {
          // Track thread ID for cancellation support
          if (queryId) {
            this.runningQueryThreadIds.set(queryId, conn.threadId);
          }
          const [rows, fields] = await runStatement(conn, sql, params, true);
          return { rows, fields };
        } catch (error) {
          throw mapDatabaseError(error, "mysql", sql);
        } finally {
          if (queryId) this.runningQueryThreadIds.delete(queryId);
          conn.release();
        }
      });

      return this.buildQueryResult(result.rows, result.fields, executionTime, sql);
    });
  }

  public async cancelQuery(queryId: string): Promise<boolean> {
    const threadId = this.runningQueryThreadIds.get(queryId);
    if (!threadId) return false;

    try {
      await runStatement(this.pool!, `KILL QUERY ${threadId}`);
      return true;
    } catch (error) {
      console.error("[MySQL] Failed to cancel query:", error);
      return false;
    }
  }

  // ============================================================================
  // Agent Read-Only Execution Profile (#1612)
  // ============================================================================

  /**
   * Runs EXACTLY ONE read statement, on a connection this call holds for its whole
   * duration, inside a read-only transaction that is always rolled back.
   *
   * The database is the boundary in five places, none of which is a text match on the
   * statement:
   *
   * 1. **The principal may not write** (`assertAgentPrincipalIsUnprivileged`, verified
   *    at open). Measured 2026-10-09 on MySQL 26.7.0 and MariaDB 13.0.2 as a
   *    SELECT-only account: INSERT, CREATE, DROP, TRUNCATE and GRANT were all refused
   *    (1142), and so were SET GLOBAL and `SELECT ... INTO OUTFILE` (1227). `root` is
   *    the positive control: it did all of them, and it is therefore refused at open.
   *    MariaDB does not privilege-check `SELECT ... FOR UPDATE` the way MySQL does -
   *    measured, it ran as a plain SELECT-granted user - which is why the transaction
   *    below is a layer of its own rather than decoration.
   * 2. **The transaction itself refuses the writes the principal could lie about.**
   *    `START TRANSACTION READ ONLY` refuses DML, `SELECT ... FOR UPDATE` and CREATE
   *    TEMPORARY TABLE with 1792 on both engines. It is NOT the boundary on its own -
   *    DDL, GRANT and SET GLOBAL each cause an implicit commit that ends the read-only
   *    transaction first, measured as `root` creating a table under one - which is
   *    exactly why the principal is the first layer and this the second.
   * 3. **One statement per call.** The read-only pool is built with
   *    `multipleStatements: false`, so a `;`-joined text is refused by the server with
   *    1064 before anything runs (measured), including when the saved connection
   *    string itself says `multipleStatements=true` - that parameter is STRIPPED, for
   *    the reason `buildReadOnlyPoolConfig` records: through mysql2, a `uri`'s
   *    `multipleStatements=true` beats an option the pool was handed, measured.
   * 4. **The server stops the result at the row budget.** `sql_select_limit` is set to
   *    ONE MORE than the budget allows, so a statement that would stream past it is
   *    stopped by the server and the extra row is the signal to refuse. This is not a
   *    nicety: measured on this fixture, a 20-million-row recursive read under
   *    `sql_select_limit = 501` handed the client 501 rows and 0.2 MB of heap, while
   *    the unbounded 3-million-row form took 118.8 MB - the 20-million form is the
   *    out-of-memory crash the SQL Server profile met, and no result-side cap can
   *    prevent it.
   * 5. **The deadline is enforced server-side AND by a timer this provider owns.**
   *    `max_execution_time` (MySQL) or `max_statement_time` (MariaDB) is set on the
   *    session, and each is defeatable by the statement itself, measured, both ways:
   *    MySQL's `MAX_EXECUTION_TIME(60000)` optimizer hint - the comment form - overrode a 2000 ms session
   *    limit and ran 6 s, and MariaDB's single-statement `SET STATEMENT
   *    max_statement_time = 20 FOR SELECT ...` overrode a 2 s limit and ran 8 s. So
   *    the timer this call owns is the deadline that cannot be disarmed: it fires
   *    `KILL QUERY` for the connection's own thread id from another session of the
   *    main pool, which ended a running cross join with 1317 in 700 ms and left the
   *    connection alive and reusable, measured. `SLEEP()` is the one shape that
   *    answers a kill as a normal result (the value `1`) rather than an error, so the
   *    timer also sets a flag and a query that resolved while its kill was in flight
   *    is refused rather than served.
   *
   * WHAT IT DOES NOT BOUND, stated rather than implied: what an admitted SELECT may
   * READ. A least-privilege principal reaches only the databases its SELECT grants
   * name, but metadata readable by `PUBLIC` (`information_schema` of its own grants,
   * `performance_schema` where granted) is inside the boundary, exactly as it is on
   * the other engines.
   *
   * A third session mode rides with the two: `group_concat_max_len`, raised to 4 MB
   * for the column lists the catalog compositions aggregate (its default ceilings,
   * measured, are 1024 on MySQL and 1048576 on MariaDB, and a ceiling hit there is a
   * silent truncation of the array), and reset with the others.
   *
   * EVERY SESSION MODE THIS SETS LEAKS, and that is measured, not feared: the pool a
   * connection returns to does not reset `sql_select_limit`, the deadline variable or
   * `group_concat_max_len` -
   * the next borrower read the values a previous call had set, measured through
   * mysql2's own `release()`. So each is reset to `DEFAULT` on the same connection in
   * a `finally`, and a reset that FAILS destroys the connection rather than returning
   * one whose next statement would run with a stranger's row limit and deadline.
   */
  public async queryReadOnly(
    sql: string,
    budget: ReadOnlyStatementBudget,
    mode: ReadOnlyStatementMode = "execute",
  ): Promise<QueryResult> {
    this.ensureConnected();
    assertReadOnlyBudget(budget, "mysql");
    if (!this.readOnlyProfile || this.roPool === null) {
      // A provider opened outside the profile has had no principal verification, so
      // its session may be able to write. Refuse rather than serve agent semantics
      // without the layer that makes them true.
      throw new QueryError(
        "Read-only execution requires a provider opened under the agent read-only profile",
        "mysql",
        sql,
      );
    }

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        const conn = await this.roPool!.getConnection();
        try {
          await conn.query("START TRANSACTION READ ONLY");
          // One more than the budget: the server stops the result there, and the extra
          // row is what distinguishes "the statement returned exactly the budget" from
          // "the server cut it off".
          await conn.query(`SET SESSION sql_select_limit = ${budget.maxResultRows + 1}`);
          await conn.query(`SET SESSION ${this.agentDeadlineVariable()} = ${this.agentDeadlineValue(budget)}`);
          // The catalog compositions aggregate a table's column list through
          // GROUP_CONCAT, whose ceiling is 1024 by default on MySQL (1048576 on
          // MariaDB) and whose ceiling hit is a SILENT truncation: the JSON array
          // would end mid-object and the model would read a column list that is not
          // the table's. 4 MB is a column list of a size no measured database
          // approaches, and it is put back on the reset below.
          await conn.query("SET SESSION group_concat_max_len = 4194304");
          // The estimating plan is a statement prefix on this engine, unlike SQL
          // Server's session mode, and it needs no privilege a reader lacks (measured
          // as the least-privilege account on both engines). Prefixing before the
          // deadline keeps the plan under the same budget the execution would be.
          const statement = mode === "estimate-plan" ? `EXPLAIN FORMAT=JSON ${sql}` : sql;
          const [rows, fields] = await this.runWithAgentDeadline(conn, statement, budget);
          return { rows: rows as unknown[], fields };
        } catch (error) {
          throw error instanceof QueryError ? error : mapDatabaseError(error, "mysql", sql);
        } finally {
          const sessionIsClean = await this.resetProfiledSession(conn);
          // Ordering: the statement is settled by the time this runs - the deadline
          // KILLs and AWAITS the rejection rather than abandoning the promise - so the
          // rollback is never issued over a request still in flight. A rollback on a
          // transaction the server already aborted throws, so that throw is swallowed;
          // what is never swallowed is a session whose modes are still set.
          await conn.query("ROLLBACK").catch(() => {});
          if (!sessionIsClean) {
            conn.destroy();
          } else {
            conn.release();
          }
        }
      });

      const rows = Array.isArray(result.rows) ? result.rows : [];
      if (rows.length > budget.maxResultRows) {
        throw new QueryError(
          `Read-only execution exceeded the row budget: ${rows.length} rows > ${budget.maxResultRows} allowed`,
          "mysql",
          sql,
        );
      }
      const resultBytes = measureResultBytes(rows);
      if (resultBytes > budget.maxResultBytes) {
        throw new QueryError(
          `Read-only execution exceeded the byte budget: ${resultBytes} bytes > ${budget.maxResultBytes} allowed`,
          "mysql",
          sql,
        );
      }

      return {
        ...mysqlResults(rows, result.fields as FieldPacket[], sql),
        executionTime,
      };
    });
  }

  /**
   * The session variable that carries the server-side deadline, by flavour.
   *
   * MySQL spells it `max_execution_time` and MariaDB `max_statement_time`, and neither
   * accepts the other's spelling, so the flavour probed at connect decides. The UNITS
   * differ too, which is the trap: MySQL counts milliseconds and MariaDB seconds,
   * measured 2026-10-09 on 13.0.2 - `max_statement_time = 3000` under a 3-second
   * `SLEEP` let it run to completion, because the value was three thousand SECONDS.
   */
  private agentDeadlineVariable(): "max_execution_time" | "max_statement_time" {
    return this.measuredFlavour === "mariadb" ? "max_statement_time" : "max_execution_time";
  }

  /**
   * The value that variable is set to, in its own unit.
   *
   * MariaDB 10.8+ accepts decimals in `max_statement_time` (measured: 0.5 stopped a
   * 2-second SLEEP at half a second), but the whole family below it takes integers,
   * so the portable spelling is seconds rounded UP, never below one: a sub-second
   * budget's exact deadline is the KILL timer this provider owns, and the session
   * variable is the second, coarser layer - one second is the closest that layer can
   * sit under a 500 ms budget without refusing budgets it was never asked to hold.
   */
  private agentDeadlineValue(budget: ReadOnlyStatementBudget): number {
    return this.measuredFlavour === "mariadb"
      ? Math.max(1, Math.ceil(budget.statementTimeoutMs / 1000))
      : budget.statementTimeoutMs;
  }

  /**
   * Sends one statement and ends it at the deadline, by KILLING it rather than by
   * abandoning the promise.
   *
   * `KILL QUERY` must come from ANOTHER session: a connection cannot kill its own
   * running query. The main pool provides that session, the same way `cancelQuery`
   * already does. The kill's own failure is swallowed - the session deadline
   * (`max_execution_time`/`max_statement_time`) is a second, independent layer, and a
   * pool too busy to carry the kill right now is a reason to keep waiting, not to
   * throw a plumbing error at the caller.
   *
   * A query that resolves while its kill is in flight is refused rather than served:
   * `SLEEP()` answers a kill as a normal result (the value `1`), measured, and a
   * partial result with no error is the one shape this boundary must not hand to a
   * model as an answer.
   */
  private async runWithAgentDeadline(
    conn: PoolConnection,
    sql: string,
    budget: ReadOnlyStatementBudget,
  ): Promise<[RowDataPacket[], FieldPacket[]]> {
    let killIssued = false;
    const deadline = setTimeout(() => {
      killIssued = true;
      void runStatement(this.pool!, `KILL QUERY ${conn.threadId}`).catch(() => {});
    }, budget.statementTimeoutMs);
    try {
      // No parameters: the text protocol, which is also the one protocol every
      // MySQL-wire relative fully implements (see `runStatement`), and the utf8mb3
      // marking is honoured for exactly the connections that were measured to need it.
      // Array rows, the same shape `query()` reads: one row its values in column
      // order, so a result is one result however the fixture spelled it.
      const answer = await runStatement<RowDataPacket[]>(conn, sql, undefined, true);
      if (killIssued) {
        throw new QueryError(
          `Read-only execution exceeded the statement deadline of ${budget.statementTimeoutMs}ms and was killed server-side`,
          "mysql",
          sql,
        );
      }
      return answer;
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * Puts every session mode this profile sets back to its default, and says whether
   * it succeeded. The caller destroys the connection when it did not: a connection
   * returned to the pool with `sql_select_limit` still set runs the next borrower's
   * statement under a stranger's row limit, and with the deadline variable set under
   * a stranger's deadline, which are wrong answers rather than errors.
   */
  private async resetProfiledSession(conn: PoolConnection): Promise<boolean> {
    try {
      await conn.query(
        `SET SESSION sql_select_limit = DEFAULT, ${this.agentDeadlineVariable()} = DEFAULT, group_concat_max_len = DEFAULT`,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The pool `queryReadOnly` runs on: the shared shape with `multipleStatements`
   * forced off and the connection string's own `multipleStatements` parameter
   * stripped, because through mysql2 a `uri` key beats a same-named option the pool
   * was handed (measured 2026-10-09: `mysql://…?multipleStatements=true` with
   * `multipleStatements: false` in the options RAN the `;`-joined text).
   *
   * A pool of two: the agent sends one tool at a time, and the second slot absorbs a
   * host that drives the profile directly. `waitForConnections` queues a third caller
   * rather than failing it.
   */
  private buildReadOnlyPoolConfig(): mysql.PoolOptions {
    const config = this.buildPoolConfig();
    if (typeof config.uri === "string") {
      const url = new URL(config.uri);
      url.searchParams.delete("multipleStatements");
      return { ...config, uri: url.toString(), multipleStatements: false, connectionLimit: 2 };
    }
    return { ...config, multipleStatements: false, connectionLimit: 2 };
  }

  /**
   * What `SHOW GRANTS` answered, as the lines the server writes.
   *
   * `SHOW GRANTS` with no `FOR` clause is the session-EFFECTIVE answer, which is the
   * one the boundary needs: a role granted but not activated does not write, and a
   * role activated mid-session is a `SET ROLE` the single-statement rule already
   * refuses to smuggle in.
   */
  private static async readAgentGrants(conn: PoolConnection): Promise<string[]> {
    const [rows] = await conn.query("SHOW GRANTS");
    return (rows as Record<string, unknown>[]).map((row) => String(Object.values(row)[0] ?? ""));
  }

  /**
   * Refuses a principal whose privileges reach past what a read-only boundary can
   * contain.
   *
   * The admitted shape is deliberately narrow: `USAGE` (no privilege at all) and
   * `SELECT`, on any database the operator chose, with nothing else. Everything else
   * a grant line can carry is refused - `INSERT` and friends by inspection, the
   * dynamic privileges by shape (a comma list that is not USAGE/SELECT fails the
   * pattern), `PROXY` by its own line, and `WITH GRANT OPTION` because a session that
   * can GRANT can widen what the next statement may do. MariaDB appends `IDENTIFIED
   * BY PASSWORD '*…'` to a grant line, measured, so that suffix is removed before the
   * line is read; the digest inside it never leaves this comparison.
   *
   * FAIL-CLOSED, twice: a server that answers NOTHING (an older relative, a proxy that
   * swallowed the command) leaves the boundary unproven and is refused, and so is any
   * line this parser cannot read, because a line that is not understood is a
   * privilege that is not ruled out.
   */
  private static assertAgentPrincipalIsUnprivileged(grants: readonly string[]): void {
    if (grants.length === 0) {
      throw new ExecutionProfileError(
        "The agent read-only execution profile could not read this session's grants, so the boundary is unproven and the connection is refused.",
        "PROFILE_PRIVILEGES_TOO_BROAD",
      );
    }
    const admitted = /^(?:USAGE|SELECT)(?:\s*,\s*(?:USAGE|SELECT))*$/;
    for (const line of grants) {
      // MariaDB's password-digest suffix, removed before the line is read.
      const text = line.replace(/\s+IDENTIFIED BY PASSWORD\s+'[^']*'$/, "");
      // "GRANT <privileges> ON <scope> TO <grantee>[ WITH GRANT OPTION]"
      const parsed = /^GRANT\s+([^]+?)\s+ON\s+(?!PROXY\b)\S+\s+TO\s/.exec(text);
      const privileges = parsed?.[1];
      if (
        parsed === null ||
        privileges === undefined ||
        !admitted.test(privileges.trim()) ||
        /\bWITH GRANT OPTION\b/i.test(text)
      ) {
        throw new ExecutionProfileError(
          `The agent read-only execution profile requires a least-privilege principal holding only SELECT (and USAGE); this session holds "${(privileges ?? text).slice(0, 120)}", which the boundary cannot contain. Create a SELECT-only account for the agent, or point the connection at one.`,
          "PROFILE_PRIVILEGES_TOO_BROAD",
        );
      }
    }
  }

  /**
   * Refuses, under the profile, every server that shares MySQL's wire but is not
   * MySQL or MariaDB.
   *
   * A mechanism proven on MySQL is not proven on any of them - Vitess, for instance,
   * refuses `KILL QUERY` - so admission is by NAME, taken from the server's own
   * self-identification: TiDB, Vitess and OceanBase put their names in `VERSION()`,
   * and Doris and Percona in `@@version_comment` (`SELF_IDENTIFYING_VERSION`,
   * `DORIS_VERSION_COMMENT`, `PERCONA_VERSION_COMMENT`, all measured). StarRocks and
   * SingleStore answer `VERSION()` with a plain MySQL number and nothing to key on,
   * which is the compatibility table's own record; they cannot be refused by name and
   * the profile does not pretend otherwise. An absent version string is refused
   * fail-closed: an unidentified server is an unproven boundary.
   */
  private static assertAgentEngineIsAdmissible(version: string | undefined, versionComment: string | undefined): void {
    if (version === undefined) {
      throw new ExecutionProfileError(
        "The agent read-only execution profile requires a server that names its version, and this one did not, so the boundary is unproven and the connection is refused.",
        "PROFILE_UNSUPPORTED_TARGET",
      );
    }
    const selfIdentified = SELF_IDENTIFYING_VERSION.test(version);
    const mariadb = MARIADB_VERSION.test(version);
    if (
      (selfIdentified && !mariadb) ||
      DORIS_VERSION_COMMENT.test(versionComment ?? "") ||
      PERCONA_VERSION_COMMENT.test(versionComment ?? "")
    ) {
      throw new ExecutionProfileError(
        `The agent read-only execution profile is proven on MySQL and MariaDB only; "${labelServerVersion(version, versionComment)}" shares the wire but its own enforcement is not measured, so the connection is refused.`,
        "PROFILE_UNSUPPORTED_TARGET",
      );
    }
  }

  // ============================================================================
  // Transaction Support
  // ============================================================================

  private clearTxTimeout(): void {
    if (this.txTimeout) {
      clearTimeout(this.txTimeout);
      this.txTimeout = null;
    }
  }

  /**
   * Force-expire an active transaction (auto-rollback).
   * Called by the timeout timer, but also available for testing.
   */
  public async expireTransaction(): Promise<void> {
    if (this.txActive && this.txConn) {
      console.warn("[MySQL] Transaction timed out, auto-rolling back");
      try {
        await this.txConn.rollback();
      } catch {
        /* ignore */
      } finally {
        this.txConn.release();
        this.txConn = null;
        this.txActive = false;
        this.clearTxTimeout();
      }
    }
  }

  public async beginTransaction(options: BeginTransactionOptions = {}): Promise<BeginTransactionResult> {
    this.ensureConnected();
    if (this.txActive) throw new QueryError("Transaction already active", "mysql");
    const conn = await this.pool!.getConnection();
    this.txConn = conn;
    // Sent directly rather than through the driver's own `beginTransaction()`, because that
    // method resolves to nothing and the OK packet is the evidence: a server of the MySQL wire
    // family that accepts the statement without opening a transaction answers it with
    // `SERVER_STATUS_IN_TRANS` cleared, and everything run "inside" it would autocommit while
    // SANDBOX reported a rollback.
    let status: number | undefined;
    try {
      status = statusFlagsOf(await openTransaction(conn));
    } catch (error) {
      conn.release();
      this.txConn = null;
      throw error;
    }
    // Neither bit set (or no header) is a server that reports no transaction state at all,
    // which is a different answer from bit 1 alone, "autocommit, and no transaction open".
    const stateReported = status !== undefined && (status & (SERVER_STATUS_IN_TRANS | SERVER_STATUS_AUTOCOMMIT)) !== 0;
    if (stateReported && (status! & SERVER_STATUS_IN_TRANS) === 0) {
      conn.release();
      this.txConn = null;
      throw new QueryError(NO_TRANSACTION_OPENED, "mysql");
    }
    if (!stateReported && options.requireReportedState) {
      // The BEGIN may well have opened one (it does on Databend, StarRocks and Doris), so it is
      // rolled back before the connection goes back to the pool.
      await this.endHeldTransaction(conn);
      throw new QueryError(TRANSACTION_STATE_UNREPORTED, "mysql");
    }
    this.txActive = true;
    this.txStateReported = stateReported;

    // Auto-rollback after timeout to prevent leaked locks
    this.txTimeout = setTimeout(() => {
      void this.expireTransaction();
    }, MySQLProvider.TX_TIMEOUT_MS);
    return { stateReported };
  }

  public async commitTransaction(): Promise<void> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "mysql");
    this.clearTxTimeout();
    const conn = this.txConn;
    try {
      await conn.commit();
    } finally {
      this.releaseHeldConnection(conn);
    }
  }

  public async rollbackTransaction(): Promise<void> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "mysql");
    this.clearTxTimeout();
    const conn = this.txConn;
    try {
      await conn.rollback();
    } finally {
      this.releaseHeldConnection(conn);
    }
  }

  public isInTransaction(): boolean {
    return this.txActive;
  }

  /**
   * Hand `conn` back and forget the session, but only while it is still THE session's
   * connection. A COMMIT or ROLLBACK queued behind an in-flight `queryInTransaction()` can
   * find that statement's `endHeldTransaction()` already released it, and releasing it
   * twice (or `null`) is a crash rather than a no-op.
   */
  private releaseHeldConnection(conn: PoolConnection): void {
    if (this.txConn !== conn) return;
    conn.release();
    this.txConn = null;
    this.txActive = false;
  }

  /**
   * Let go of a session the SERVER already ended. A ROLLBACK is still sent first, best effort:
   * the status flag is the evidence the transaction is gone, and it was measured on a few
   * MySQL-wire servers, not on all of them (`docs/providers/mysql.md` section 6.0). If one
   * ever clears the flag with a transaction still open, the connection must not go back to
   * the pool holding it; where the transaction really is gone, MySQL answers the ROLLBACK
   * with an OK and nothing else.
   */
  private async endHeldTransaction(conn: PoolConnection): Promise<void> {
    this.clearTxTimeout();
    try {
      await conn.query("ROLLBACK");
    } catch {
      /* a no-op that failed is still a no-op; the release below is what matters */
    }
    this.releaseHeldConnection(conn);
  }

  public async queryInTransaction(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "mysql");

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const [rows, fields] = await runStatement(this.txConn!, sql, params, true);
          // The server's own word on whether the transaction survived the statement. A
          // statement that commits implicitly (DDL, `SET autocommit = 1`, a typed
          // `COMMIT`) ends it, and from then on the held connection autocommits: a
          // ROLLBACK would answer success and undo nothing. So the session is ended here
          // and the route reports `inTransaction: false` instead of a rollback. Only on a
          // server that reported the state at BEGIN: StarRocks and Doris answer an INSERT
          // inside a transaction with status 0, which says nothing, not "closed".
          if (this.txStateReported && serverReportsOpenTransaction(rows) === false) {
            await this.endHeldTransaction(this.txConn!);
          }
          return { rows, fields };
        } catch (error) {
          throw mapDatabaseError(error, "mysql", sql);
        }
      });

      return this.buildQueryResult(result.rows, result.fields, executionTime, sql);
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  // ============================================================================
  // Object surface (#789)
  // ============================================================================

  /**
   * The databases this connection can see. One level, so `parent` can only ever name a
   * database, and nothing nests under one here - that answers `[]` rather than raising,
   * because "this level has no children" is a true statement about MySQL and not a caller
   * mistake.
   *
   * This is what ends the single-database confinement section 3.2 of the provider doc
   * records: `getSchema()` binds `TABLE_SCHEMA = config.database` in all four of its reads,
   * and this one is bound to nothing at all.
   */
  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.ensureConnected();
    if (parent !== undefined && parent.length > 0) return [];

    const conn = await this.pool!.getConnection();
    try {
      let rows: ContainerRow[];
      try {
        [rows] = await runStatement<ContainerRow[]>(conn, CONTAINERS_SQL);
      } catch (error) {
        if (sourceErrno(error) !== SHOW_DATABASES_DENIED_ERRNO) throw error;
        [rows] = await runStatement<ContainerRow[]>(conn, CONTAINERS_FALLBACK_SQL);
      }
      const [[session]] = await runStatement<SessionDatabaseRow[]>(conn, SESSION_DATABASE_SQL);
      return (
        rows
          .map((row) => String(Object.values(row)[0]))
          .filter((name) => !isSystemSchema(name, this.systemSchemas))
          .map((name) => ({ path: [name], name, level: 0, isSessionDefault: name === session?.name }))
          // By path, the rule `listObjects` orders by: vtgate answers SHOW DATABASES unsorted.
          .sort((left, right) => comparePaths(left.path, right.path))
      );
    } finally {
      conn.release();
    }
  }

  /**
   * How many objects of each declared kind one database holds, in one statement.
   *
   * Three outcomes, and the type keeps all three apart. A kind the GROUP BY answered for
   * carries its count. A kind it did not carries `{ count: 0 }`, because it was seeded
   * before the read. A kind whose read was refused carries the server's own sentence, so the
   * object browser can say why a folder has no number instead of showing a zero nobody
   * measured.
   *
   * The four `information_schema` views are one statement, so the server answers it whole or
   * not at all; a caller who can see only part of a database gets a real count of the part
   * they can see, because `information_schema` FILTERS by privilege rather than refusing.
   *
   * There is one partial outcome. When the server refuses the statement itself (an errno, on a
   * connection that survived it, and not a statement that was stopped), the views are asked
   * one at a time by `countByCatalog`, and a view the server lacks marks only the kinds it
   * counts: Databend has `TABLES` and none of the other three. Anything else - a connection
   * that failed, a statement killed or timed out - is reported against every kind with the
   * error the union got, because four more statements would only take as long and fail the
   * same way.
   */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const schema = containerSchema(capabilities, container);
    const declared = declaredKinds(capabilities);
    const counts = seedZeroCounts(declared);

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement<KindCountRow[]>(conn, COUNTS_SQL, [schema, schema, schema, schema]);
      applyKindCounts(counts, rows);
      return counts;
    } catch (error) {
      if (isStatementRefusal(error)) return await countByCatalog(conn, schema, counts);
      return unavailableCounts(
        declared.map((kind) => kind.id),
        error,
      );
    } finally {
      conn.release();
    }
  }

  /**
   * One object-surface read, mapped against THE STATEMENT THE SERVER RECEIVED.
   *
   * Shared by `listObjects` and `describeObject` so a failure in the third of three detail
   * reads does not quote the first one's text at whoever has to read the message.
   */
  private async runObjectQuery<T extends RowDataPacket[]>(
    conn: PoolConnection,
    sql: string,
    params: unknown[],
  ): Promise<T> {
    try {
      const [rows] = await runStatement<T>(conn, sql, params);
      return rows;
    } catch (error) {
      throw mapDatabaseError(error, "mysql", sql);
    }
  }

  /**
   * The objects of one kind in one database, names only.
   *
   * Ordering is done here rather than with an `ORDER BY`, and that is deliberate. Four
   * statements answer these listings, so four `ORDER BY` clauses would be four chances to
   * disagree; and a SQL sort runs under the column's own collation, which is case
   * insensitive on the `information_schema` views and case sensitive on a server started
   * with a binary collation, so the same database would come back in two orders on two
   * servers. A code-point sort here is one rule and the same rule everywhere.
   *
   * By PATH and not by name, because it is the address that has to be stable: sorting by the
   * address groups a table's triggers together under that table.
   */
  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const schema = containerSchema(capabilities, container);
    // Two questions, asked in order, and only the DECLARATION answers the first. Deciding
    // "is this kind declared" from whether a listing statement exists would make the two
    // methods disagree, and would report "declares no object kind" about a kind
    // `objectKinds` does declare - which on THIS provider is a live case, because
    // `MYSQL_OBJECT_TYPES` carries MariaDB's two entries whatever server is connected.
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`MySQL declares no object kind "${kind}"`, "mysql");
    }
    const statement = objectListingStatement(schema, kind);
    if (statement === undefined) {
      throw new QueryError(`MySQL declares the kind "${kind}" but has no statement that lists it`, "mysql");
    }

    const conn = await this.pool!.getConnection();
    try {
      const rows = await this.runObjectQuery<ObjectRow[]>(conn, statement.sql, statement.params);
      return rows
        .map((row) => ({
          path: objectPath(container, row),
          name: row.name,
          kind,
          // Absent for every kind but a relation, and absent for a VIEW too: measured,
          // `information_schema.TABLES` answers NULL in all three columns for a view, and a
          // view reported as 0 rows and 0 bytes would be a measurement nobody took.
          rowCount: measuredNumber(row.row_count),
          sizeBytes: measuredNumber(row.size_bytes),
        }))
        .sort((left, right) => comparePaths(left.path, right.path));
    } finally {
      conn.release();
    }
  }

  /**
   * Columns, indexes and foreign keys for one object of one KIND.
   *
   * The kind decides everything and nothing here reads the name to work out what it is
   * holding. Only the kinds `information_schema.TABLES` resolves - the `tables` entries of
   * `MYSQL_OBJECT_TYPES` - have any of the three, so a routine, a trigger, an event and a
   * MariaDB package answer three empty arrays without a round trip. That is a true fact
   * about those kinds rather than a failed read, and
   * `tests/helpers/object-surface-conformance.ts` states the same rule from the caller's
   * side.
   *
   * A MariaDB SEQUENCE is in the `tables` group and therefore DOES describe: measured on
   * 12.3.2, `information_schema.COLUMNS` answers eight real columns for one
   * (`next_not_cached_value`, `minimum_value`, ...), because a sequence is a table
   * underneath. Keying this on the catalog rather than on `role === "relation"` is what
   * makes that come out right, and a sequence is `config` rather than `relation` because
   * nobody selects rows from it.
   *
   * Without the kind the same answer would come out by accident, and only sometimes. The
   * three reads key the LAST path segment against `TABLE_NAME`, so a procedure returned
   * nothing only because no table was called that - and on MySQL a table and a procedure
   * CAN share a name in one database. Measured on 26.7.0: `app.order_archive` is both, so a
   * name-driven describe would have handed the procedure the table's columns as if they were
   * its own. The kind removes the coincidence.
   */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) {
      throw new QueryError(`MySQL declares no object kind "${kind}"`, "mysql");
    }

    // Derived, not counted, and derived in ONE place: `assertObjectPathShape()` is the same
    // writer `readObjectSource` reads, so the detail pane and the Source tab cannot disagree
    // about what a trigger's address is.
    assertObjectPathShape(capabilities, spec, kind, path, PATH_SHAPE_ENGINE);

    if (!hasColumns(kind)) {
      return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
    }

    // Three narrow reads, each bound to ONE database and ONE object, which is what the four
    // `SCHEMA_*_SQL` statements are not: those are the N+1 `getSchema()` issues per table.
    //
    // Neither bind is positional. The schema comes from the segment the DECLARATION assigns to
    // the `schema` level, and the object's own name is the LAST segment. On MySQL those are
    // `path[0]` and `path[1]`; on the five two-level engines that copy this file `path[0]` is
    // the catalog and `path[1]` is a container segment, so both literals would narrow these
    // three reads to an object that does not exist.
    const schema = containerSegment(capabilities, path, "schema");
    const binds = [schema, path[path.length - 1]];
    const conn = await this.pool!.getConnection();
    try {
      const columns = await this.runObjectQuery<DetailColumnRow[]>(conn, OBJECT_COLUMNS_SQL, binds);
      const foreignKeys = await this.runObjectQuery<DetailForeignKeyRow[]>(conn, OBJECT_FOREIGN_KEYS_SQL, binds);
      const indexes = await this.runObjectQuery<DetailIndexRow[]>(conn, OBJECT_INDEXES_SQL, binds);
      return objectDetailFromRows(
        path,
        schema,
        { columns, foreignKeys, indexes },
        CATALOG_DEFAULT_READING[this.measuredFlavour],
      );
    } finally {
      conn.release();
    }
  }

  /**
   * Columns, indexes and foreign keys for EVERY object of one kind in one database (#789).
   *
   * FOUR round trips for the whole folder, which is the entire reason this method exists:
   * the inventory route built the same answer as one `describeObject` per object - three
   * statements each, up to 5000 objects - and removed it as an N+1. The four are the target
   * read plus the three `bulkDetailSql()` reads, and the count does not grow with the
   * folder.
   *
   * Only the kinds `information_schema.TABLES` resolves can have any of the three, so a
   * routine, a trigger, an event and a MariaDB package answer an empty batch with NO round
   * trip at all, exactly as `describeObject` answers three empty arrays for one of them.
   * That is a true fact about those kinds and not a refused read, so it is `{ details: [] }`
   * rather than a throw or a truncation. `hasColumns()` is the one rule both methods ask.
   *
   * An empty container costs ONE round trip rather than four: there is nothing for the
   * three detail reads to be about, and an empty answer to each of them is not worth asking
   * for.
   *
   * The bound is the CALLER's and is never invented here. `limit + 1` is bound to the target
   * statement, so a saturated read is distinguishable from an exact one without a second
   * count, the extra object is dropped, and `truncated` carries the caller's own limit. An
   * unbounded call runs a statement with no LIMIT clause at all and can never report
   * truncation - if this file ever caps a read of its own, it says so in the same field.
   *
   * The paths are built by `objectPath()`, the same rule `listObjects` builds its paths
   * with, and sorted by the same `comparePaths`, because every caller joins the two answers
   * on path. The three detail reads may carry rows for the extra `limit + 1` object; they
   * are dropped here rather than by a fourth bound, since the target list is what says which
   * objects the answer is about.
   *
   * `defaultSql` adds ONE `SHOW CREATE TABLE` per described table that has a default, on the
   * flavour whose catalog spells no default as SQL (#1031, `readDefaultSql`). It is the one
   * read here that grows with the folder, which is why only a caller that asks pays it, and
   * the caller's `limit` bounds it, since only described objects are read. Tables only: a
   * view's columns report the defaults of the columns they select, and the statement answers
   * no column list for a view, so reading one costs a round trip and always falls back.
   */
  public async describeObjects(
    container: readonly string[],
    kind: string,
    limit?: number,
    options?: DescribeObjectsOptions,
  ): Promise<ObjectDetailBatch> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    // Two questions, asked in order, and only the DECLARATION answers the first, for the
    // reason `listObjects` gives: `MYSQL_OBJECT_TYPES` carries MariaDB's two entries whatever
    // server is connected, so a kind resolved from the statement table would answer for a
    // `sequence` on a server that has none.
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`MySQL declares no object kind "${kind}"`, "mysql");
    }
    const schema = containerSchema(capabilities, container);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      // Not clamped and not ignored. A 0 would answer nothing while reporting a truncation
      // the caller never asked for, and a fraction reaches mysql2 as a bind the server
      // cannot use; both are caller mistakes and neither has a right answer to guess at.
      throw new QueryError(
        `A MySQL bulk column read limit must be a positive whole number, received ${limit}`,
        "mysql",
      );
    }
    if (!hasColumns(kind)) return { details: [] };

    const bounded = limit !== undefined;
    const types = MYSQL_OBJECT_TYPES[kind].types;
    // One row more than the bound, so the read itself says whether it stopped short. The
    // bound is rendered rather than bound, for the reason `bulkTargetSql` carries.
    const statements = bounded ? bulkDetailSql(types.length, limit + 1) : BULK_DETAIL_SQL[kind];
    const targetParams = [schema, ...types];
    // The three detail reads carry the target's own binds and then the schema again, for
    // the join. A prepared statement takes positional parameters, so the repeat is a second
    // bind of one value rather than a second question.
    const detailParams = [...targetParams, schema];

    const conn = await this.pool!.getConnection();
    try {
      const targetRows = await this.runObjectQuery<ObjectRow[]>(conn, statements.target, targetParams);
      const truncated = bounded && targetRows.length > limit;
      const described = truncated ? targetRows.slice(0, limit) : targetRows;
      if (described.length === 0) return { details: [] };

      const columns = byObjectName(
        await this.runObjectQuery<DetailColumnRow[]>(conn, statements.columns, detailParams),
      );
      const foreignKeys = byObjectName(
        await this.runObjectQuery<DetailForeignKeyRow[]>(conn, statements.foreignKeys, detailParams),
      );
      const indexes = byObjectName(await this.runObjectQuery<DetailIndexRow[]>(conn, statements.indexes, detailParams));

      const reading = CATALOG_DEFAULT_READING[this.measuredFlavour];
      const ddlDefaults =
        options?.defaultSql === true && reading.defaultSql === "show-create" && kind === "table"
          ? await this.readDefaultSql(conn, schema, described, columns, reading)
          : undefined;

      const details = described
        .map((row) =>
          objectDetailFromRows(
            objectPath(container, row),
            schema,
            {
              columns: columns.get(row.name) ?? [],
              foreignKeys: foreignKeys.get(row.name) ?? [],
              indexes: indexes.get(row.name) ?? [],
            },
            reading,
            ddlDefaults?.get(row.name),
          ),
        )
        .sort((left, right) => comparePaths(left.path, right.path));
      return truncated ? { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } } : { details };
    } finally {
      conn.release();
    }
  }

  /**
   * Each described table's default SQL, read from `SHOW CREATE TABLE` (#1031), keyed by table
   * then column. A table is absent from the answer whenever its text cannot be trusted, and
   * an absent table keeps today's catalog reading - no `defaultExpression` - rather than
   * failing a read that was going to succeed:
   *
   * - A table with no catalog default is never read: its DDL has nothing to add.
   * - A refusal or an absence is `readSourcePart`'s own classification, so this read and the
   *   Source tab agree about what a refusal is. Measured: a column-level `GRANT SELECT (cols)`
   *   reads the catalog and is refused `SHOW CREATE TABLE` with 1142, and a table dropped
   *   between the catalog read and this one answers 1146. Anything else still raises.
   * - Text `showCreateColumnDefaults` cannot read to the end, or that lacks a DEFAULT for a
   *   column the catalog says has one, leaves the WHOLE table on the catalog: half a table
   *   on each reading would put both readings into one diff.
   *
   * ONE ROUND TRIP PER TABLE, sequential on the connection the three catalog reads used. That
   * is the N+1 shape this method's caller exists to avoid, taken on deliberately and only when
   * asked: see `DescribeObjectsOptions`.
   */
  private async readDefaultSql(
    conn: PoolConnection,
    schema: string,
    described: readonly ObjectRow[],
    columns: ReadonlyMap<string, readonly DetailColumnRow[]>,
    reading: CatalogDefaultReading,
  ): Promise<Map<string, ReadonlyMap<string, string>>> {
    const plan = MYSQL_SOURCE_PART_PLANS.table[0];
    const answer = new Map<string, ReadonlyMap<string, string>>();
    for (const row of described) {
      const withDefault = (columns.get(row.name) ?? []).filter(
        (column) => catalogDefault(column.column_default, column.extra, reading).defaultValue !== undefined,
      );
      if (withDefault.length === 0) continue;
      const address = `${this.escapeIdentifier(schema)}.${this.escapeIdentifier(row.name)}`;
      const read = await this.readSourcePart(conn, plan, address);
      if (read.outcome !== "text") continue;
      const defaults = showCreateColumnDefaults(read.text);
      if (defaults === undefined || withDefault.some((column) => !defaults.has(column.column_name))) continue;
      answer.set(row.name, defaults);
    }
    return answer;
  }

  /**
   * One `SHOW CREATE` read, classified into a text, a refusal or a legal absence.
   *
   * THE STATEMENT TAKES AN IDENTIFIER WHERE A BIND WOULD GO. `SHOW CREATE ...` has no
   * parameterised form at all, so this is one of the three engines in the fleet where a
   * caller-supplied name reaches statement TEXT, and the escaper is therefore load-bearing
   * rather than cosmetic. `SQLBaseProvider.escapeIdentifier` doubles the backtick, which is
   * SUFFICIENT here and MEASURED to be: `CREATE TABLE app.\`bs_one\\\`` on MariaDB 12.3.2
   * produced a table whose `information_schema.TABLES.TABLE_NAME` is `bs_one\\` at
   * `LENGTH() = 7`, so a backslash inside a backtick-quoted identifier is a LITERAL character
   * and the closing backtick still closed the identifier. That is the direct contrast with
   * ClickHouse, where a backslash IS an escape in both quoting forms and the shared escaper is
   * unsafe (#789 probe 11).
   *
   * The NULL arm is the one this engine's row in the design was originally written without. A
   * caller holding `EXECUTE` and not the privilege to see a body gets a ROW whose body column
   * is NULL rather than an error, MEASURED on MySQL 26.7.0 and MariaDB 12.3.2 for all four
   * routine forms. MySQL utters NO sentence for it, so this is the one refusal on this engine
   * whose words are OURS, and the docblock says so where a reader of the provider doc will
   * meet it too. An empty or whitespace-only text is folded into the same arm, because an empty
   * definition is not a definition.
   *
   * A read that answered NO ROW AT ALL is an absence and not a refusal. No live server produced
   * one: every `SHOW CREATE` this task measured either answered a row or raised. It is handled
   * rather than assumed away because a wire-compatible fork is free to answer an empty result,
   * and folding it into the NULL arm would put a refusal sentence over an object nobody found.
   */
  private async readSourcePart(conn: PoolConnection, plan: SourcePartPlan, address: string): Promise<SourceRead> {
    const sql = `${plan.statement} ${address}`;
    let rows: RowDataPacket[];
    try {
      [rows] = await runStatement(conn, sql);
    } catch (error) {
      const errno = sourceErrno(error);
      if (errno !== undefined && SOURCE_REFUSAL_ERRNOS.has(errno)) {
        // The server's own sentence, unprefixed and never through `mapDatabaseError`, which
        // would put this product's words in front of the server's.
        return { outcome: "refused", unavailable: error instanceof Error ? error.message : String(error) };
      }
      if (errno !== undefined && SOURCE_ABSENCE_ERRNOS.has(errno)) return { outcome: "absent" };
      // Everything else RAISES, and the narrowness is the point: a transport failure is nobody
      // answering at all, and rendering "Connection lost" in the Source pane as this object's
      // own refusal would present a symptom as a fact about the object.
      throw mapDatabaseError(error, "mysql", sql);
    }
    const row = rows[0];
    if (row === undefined) return { outcome: "absent" };
    const definition = row[plan.column];
    if (definition === null || definition === undefined || String(definition).trim() === "") {
      return {
        outcome: "refused",
        unavailable:
          `MySQL answered a row for this object whose "${plan.column}" column is NULL, which is how it reports a ` +
          "definition the connected user may not read: EXECUTE on the routine is enough to see that it exists and " +
          "not enough to see its body. The server supplies no sentence of its own for this.",
      };
    }
    return { outcome: "text", text: String(definition) };
  }

  /**
   * One object's definition text, as `SHOW CREATE` answers it (#789 Phase 2).
   *
   * EVERY DECLARED KIND CAN ANSWER, on both servers, which makes this the one provider in the
   * fleet with no kind that declares nothing: MySQL's six and MariaDB's eight each have a
   * `SHOW CREATE` form. The declaration is still what decides, read off `objectKinds` and never
   * off a list of kind ids kept beside it, because `objectKinds` here is a function of the
   * SERVER and a kind MySQL does not have must not be readable on a MySQL connection.
   *
   * MariaDB's `package` and `sequence` DO declare `hasSource`, and they are not reachable from
   * the standalone tree today. That is a known and filed defect rather than an oversight in
   * this method: `POST /api/db/provider-meta` reads capabilities off a provider it never
   * connects, so the client's copy of the declaration is the MySQL six and those two folders
   * are never drawn. The declaration here is true about the ENGINE, and withholding it would be
   * a second wrong declaration rather than a safer one. See docs/providers/mysql.md.
   *
   * A PACKAGE IS TWO STATEMENTS AND ONE NODE, spec first. The order is the engine's asymmetry
   * and not a preference: a body cannot exist without a specification and a specification can
   * exist without a body, so reading the spec first is what tells a MISSING BODY apart from a
   * MISSING PACKAGE. A spec that is absent raises; a body that is absent drops its part.
   *
   * The database is the container segment the DECLARATION names `schema` and the object name is
   * `path[path.length - 1]`, never a literal index (standing ruling 5g), pinned in this
   * provider's suite by a two-level declaration driven all the way to the statement text. A
   * trigger's PARENT segment is deliberately unused: `SHOW CREATE TRIGGER` addresses
   * `<database>.<trigger>` and a trigger name is unique per database on this engine (measured,
   * ER_TRG_ALREADY_EXISTS), so the parent is part of the ADDRESS the tree draws and not part of
   * the statement that reads it.
   */
  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = requireSourceKind(capabilities, kind, { displayName: "MySQL", type: "mysql" });
    assertObjectPathShape(capabilities, spec, kind, path, PATH_SHAPE_ENGINE);
    if (!Object.hasOwn(MYSQL_SOURCE_PART_PLANS, kind)) {
      throw new QueryError(
        `MySQL declares readable source for the kind "${kind}" but has no statement that reads it`,
        "mysql",
      );
    }
    const plans = MYSQL_SOURCE_PART_PLANS[kind];

    const schema = containerSegment(capabilities, path, "schema");
    const name = path[path.length - 1];
    const address = `${this.escapeIdentifier(schema)}.${this.escapeIdentifier(name)}`;

    const conn = await this.pool!.getConnection();
    try {
      const [head, ...rest] = plans;
      const first = await this.readSourcePart(conn, head, address);
      if (first.outcome === "absent") {
        // Absence RAISES and is never a refusal part, and the sentence is OURS rather than the
        // server's: ER_TRG_DOES_NOT_EXIST is the bare words "Trigger does not exist", which
        // names neither the object nor the database, and a message that names nothing cannot
        // tell a reader which read failed.
        throw new QueryError(
          `MySQL holds no ${spec.label.toLowerCase()} called "${name}" in database "${schema}"`,
          "mysql",
          `${head.statement} ${address}`,
        );
      }
      const parts: [ObjectSourcePart, ...ObjectSourcePart[]] = [sourcePart(head, first, spec.sourceLanguage, limit)];
      for (const plan of rest) {
        const read = await this.readSourcePart(conn, plan, address);
        // A tail part that is not there is DROPPED, not refused: a package with no body is a
        // complete package, and a refusal sentence over it would report a privilege problem
        // where the engine reported a legal shape. Every tail is `SourceTailPlan`, which
        // REQUIRES `optional: true`, so there is no non-optional tail for this arm to get
        // wrong: a tail added later without it is a red build rather than a runtime throw no
        // test could reach.
        if (read.outcome === "absent") continue;
        parts.push(sourcePart(plan, read, spec.sourceLanguage, limit));
      }
      return { path: [...path], kind, parts };
    } finally {
      conn.release();
    }
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      // One bare read, picked client-side: see `statusValue()` for the Doris measurement
      // that forced it. `Threads_connected` is absent on TiDB 8.5.1 (13 status rows,
      // none of them that one), on StarRocks 3.3.22 and on Doris 4.1.3 (0 rows each),
      // all measured 2026-09-06, and an unmeasured count is OMITTED rather than sent as
      // a fabricated 0 (#477, and the docblock on `HealthInfo.activeConnections`): this
      // is the field the agent's curated health reading forwards to the model.
      const [statusRows] = await runStatement(conn, "SHOW STATUS");
      const activeConnections = measuredNumber(statusValue(statusRows, "Threads_connected"));

      const [sizeRows] = await runStatement(conn, DATABASE_SIZE_MB_SQL, [this.config.database]);
      const databaseSize = `${sizeRows[0]?.size_mb || 0} MB`;

      // A tenant can be missing the performance_schema DATABASE rather than merely
      // having the schema off, and then this query does not answer NULLs, it throws:
      // measured 2026-08-20 on OceanBase Community Edition 4.4.2.1 through this
      // provider, and reproduced on mysql:latest as
      // `ERROR 1049 (42000): Unknown database 'performance_schema_absent'`. Uncaught,
      // it took the whole health read down, so the panel showed nothing at all where
      // one unavailable metric was the honest answer.
      let cacheHitRatio = CACHE_HIT_RATIO_UNAVAILABLE;
      try {
        const [hitRows] = await runStatement(conn, BUFFER_CACHE_HIT_RATIO_SQL);
        cacheHitRatio = formatCacheHitRatio(measuredNumber(hitRows[0]?.hit_ratio));
      } catch {
        // Nothing to read, so nothing is reported.
      }

      // The digest rows, or none - never a sentence dressed as a row (#512).
      //
      // This used to report `[{ query: "Performance schema not available", calls: 0,
      // avgTime: "N/A" }]` whenever its statement threw, and the statement threw on every
      // server: it named a column the digest table does not have (see
      // SLOW_QUERIES_BODY_SQL). So the line stated an engine capability as absent on
      // MySQL 26.7.0 and Percona Server 8.4.11-11 where `@@performance_schema` was 1 and
      // `getSlowQueries()` answered 5 rows on the same connection - measured 2026-08-27,
      // both arms.
      //
      // That row was a fabricated measurement rather than a missing number, which is the
      // class the absence rule (#477) exists to prevent: `calls: 0` is a figure nobody
      // took, and it was COUNTED - the agent's curated health reading then forwarded
      // `health.slowQueries.length` as `slowQueryCount` (src/lib/agent/tools.ts), so the
      // invented row told the model "1 slow query" about every MySQL-family server. That
      // projection carries no length any more (#513), so a row invented here would now be
      // silent rather than counted - a reason to keep it out, not a reason it could return.
      //
      // Why an empty list rather than a marker that says "unavailable": the capability
      // being OFF does not raise here at all. Measured on the same pass, MySQL 26.7.0
      // started `--performance-schema=OFF` and MariaDB 12.3.2 (which ships it off) both
      // keep the digest table selectable and answer 0 rows. A marker keyed on the throw
      // would therefore be emitted for something other than off-ness - the same fabrication
      // as the row it replaces, one level up.
      // What remains in the catch is a genuine refusal: no `performance_schema` DATABASE
      // at all (ER_1049 on the OceanBase tenant above), or a grant denied on it.
      //
      // ON THIS PATH THE REASON IS DROPPED, and saying so is the point of this
      // paragraph. `HealthInfo.slowQueries` is a `SlowQuery[]`; it has no error field
      // and no sibling that carries one, so a refusal cannot be represented here at all,
      // and a row saying "Performance schema not available" is what representing it
      // anyway looked like. Empty is the least-wrong shape, not a shape that carries the
      // reason. Nothing renders this list either: no component reads
      // `HealthInfo.slowQueries` (the monitoring Queries and Overview tabs read
      // `MonitoringData.slowQueries`, a different reading), and the one caller of
      // `POST /api/db/health` - the 60s connection pulse in
      // `src/hooks/use-connection-pulse.ts` - looks at `res.ok` and discards the body.
      //
      // The operator is not left without the reason, because the SAME refusal reaches
      // them on the path that does have a channel: `getSlowQueries()` below lets it
      // reject, `getMonitoringData()` (src/lib/db/base-provider.ts) records it as
      // `errors.slowQueries`, and `QueriesTab` renders that through `PanelUnavailable`
      // with the server's own sentence. `ProviderLabels.slowQueriesEmptyState` is NOT
      // that channel - it is the same sentence for every empty list regardless of cause,
      // which is why it must not name one cause as the fix.
      let slowQueries: SlowQuery[] = [];
      try {
        const [slowRows] = await runStatement(conn, `${SLOW_QUERIES_BODY_SQL} LIMIT ${HEALTH_SLOW_QUERY_LIMIT};`, [
          this.config.database,
        ]);
        slowQueries = slowRows.map((r) => toHealthSlowQuery(toSlowQueryStats(r)));
      } catch {
        // Nothing was read, so nothing is reported.
      }

      const [sessionRows] = await runStatement(conn, HEALTH_ACTIVE_SESSIONS_SQL, [this.config.database]);

      const activeSessions: ActiveSession[] = sessionRows.map((r) => ({
        pid: r.pid,
        user: r.user || "unknown",
        database: r.database || "",
        state: r.state || "unknown",
        query: r.query || "",
        duration: r.duration || "N/A",
      }));

      return {
        ...(activeConnections === undefined ? {} : { activeConnections }),
        databaseSize,
        cacheHitRatio,
        slowQueries,
        activeSessions,
      };
    } finally {
      conn.release();
    }
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  /**
   * A maintenance target as a `database.table` identifier, qualified only when the caller's
   * container is a database OTHER than the connected one. A MySQL statement already resolves
   * a bare table inside the connected database, so qualifying with the same name would add a
   * prefix the engine reads as redundant, and a container that is not a database at all is
   * not something this engine can act on.
   */
  private qualifyMaintenanceTarget(target: string, container?: string): string {
    if (container && container !== this.config.database) {
      return `${this.escapeIdentifier(container)}.${this.escapeIdentifier(target)}`;
    }
    return this.escapeIdentifier(target);
  }

  public async runMaintenance(type: MaintenanceType, target?: string, container?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      const conn = await this.pool!.getConnection();
      try {
        let sql = "";

        switch (type) {
          // The three table verbs share one shape: `<VERB> TABLE <list>`, where the
          // list is the one table the caller named or every table in the database, and
          // the answer is a RESULT SET carrying the verdict on MySQL and an OK packet on
          // TiDB, OceanBase and Databend (`readMaintenanceReport` reads both).
          case "analyze":
          case "optimize":
          case "check": {
            const tables = target
              ? this.qualifyMaintenanceTarget(target, container)
              : await this.getAllTablesForMaintenance(conn);
            // An empty database joined to an empty list, and `OPTIMIZE TABLE ` alone is
            // a syntax error - measured through the provider against a database with no
            // tables on 2026-08-25: "You have an error in your SQL syntax ... near ''".
            // Nothing to do is not a failure, so it is reported as what it is rather
            // than as the engine's complaint about a statement we should not have sent.
            if (!tables) {
              return {
                success: true,
                message: `${type.toUpperCase()}: no tables in ${this.config.database ?? "this database"} to run it on.`,
              };
            }
            // `runStatement` types its answer as rows; on an OK-packet server it is a header.
            const answer: MaintenanceReportRow[] | ResultSetHeader = (
              await runStatement<MaintenanceReportRow[]>(conn, `${type.toUpperCase()} TABLE ${tables}`)
            )[0];
            return readMaintenanceReport(type, answer);
          }
          case "kill":
            if (!target) {
              throw new QueryError("Target connection ID is required for kill operation", "mysql");
            }
            const connId = parseInt(target, 10);
            if (isNaN(connId)) {
              throw new QueryError("Invalid connection ID for kill operation", "mysql");
            }
            sql = `KILL ${connId}`;
            break;
        }

        // Unsupported types fall through the switch with sql left empty. A
        // `default:` label is deliberately avoided here: bun's coverage emits
        // a 0-hit line record for `default:` that no runtime execution ever
        // credits, which permanently poisons the merged lcov report.
        if (!sql) {
          throw new QueryError(`Unsupported maintenance type for MySQL: ${type}`, "mysql");
        }

        await runStatement(conn, sql);
        return { success: true, message: `${type.toUpperCase()} completed successfully` };
      } finally {
        conn.release();
      }
    });

    return {
      success: result.success,
      executionTime,
      message: result.message,
    };
  }

  private async getAllTablesForMaintenance(conn: PoolConnection): Promise<string> {
    const [rows] = await runStatement(conn, MAINTENANCE_TABLES_SQL, [this.config.database]);

    return rows.map((r) => this.escapeIdentifier(r.TABLE_NAME)).join(", ");
  }

  // ============================================================================
  // Monitoring Operations
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      // Get version
      const [versionRows] = await runStatement(
        conn,
        "SELECT VERSION() as version, @@version_comment as version_comment",
      );
      const version = versionRows[0]?.version || "Unknown";
      const versionComment = versionRows[0]?.version_comment as string | undefined;

      // Uptime and the connection count come out of ONE bare `SHOW STATUS`: the LIKE
      // clause is what Doris 4.1.3 refuses (see `statusValue()`), and reading the list
      // once serves both variables in one round trip instead of two.
      const [statusRows] = await runStatement(conn, "SHOW STATUS");
      const uptimeSeconds = measuredNumber(statusValue(statusRows, "Uptime"));
      const activeConnections = measuredNumber(statusValue(statusRows, "Threads_connected"));

      // `SHOW VARIABLES LIKE` STAYS. Doris rejects the LIKE clause on `SHOW STATUS`
      // only: measured 2026-09-06, `SHOW VARIABLES LIKE 'max_connections'` is accepted
      // on Doris 4.1.3 and on StarRocks 3.3.22 alike (both answering 0 rows), so the
      // narrowest fix changes only the statement a grammar refuses.
      //
      // The `|| "151"` default is gone with it: 151 is MySQL's compiled-in ceiling and
      // was reported for every server that published none, including TiDB, which
      // publishes a real `0`. `maxConnections` is the one figure where 0 and absence
      // are the SAME fact, "no limit published", which is why it stays a required
      // number here rather than being omitted (see `src/lib/db/types.ts`).
      const [maxConnRows] = await runStatement(conn, "SHOW VARIABLES LIKE 'max_connections'");
      const maxConnections = measuredNumber(maxConnRows[0]?.Value) ?? 0;

      // Get database size
      const [sizeRows] = await runStatement(conn, OVERVIEW_DATABASE_SIZE_SQL, [this.config.database]);
      const databaseSizeBytes = measuredNullableAggregate(sizeRows[0], "size_bytes");
      const databaseSize = databaseSizeBytes === undefined ? "N/A" : formatBytes(databaseSizeBytes);

      // Get table and index count
      const [countRows] = await runStatement(conn, OVERVIEW_INDEX_COUNT_SQL, [this.config.database]);

      const [tableCountRows] = await runStatement(conn, OVERVIEW_TABLE_COUNT_SQL, [this.config.database]);

      return {
        version: labelServerVersion(version, versionComment),
        // "N/A" is what a provider that cannot measure uptime sends (sqlite, duckdb,
        // libsql, mongodb), and no `startTime` is derived from an uptime nobody
        // published: `Date.now()` would have been reported as the server's start.
        uptime: uptimeSeconds === undefined ? "N/A" : this.formatUptimeString(uptimeSeconds),
        ...(uptimeSeconds === undefined ? {} : { startTime: new Date(Date.now() - uptimeSeconds * 1000) }),
        ...(activeConnections === undefined ? {} : { activeConnections }),
        maxConnections,
        databaseSize,
        ...(databaseSizeBytes === undefined ? {} : { databaseSizeBytes }),
        tableCount: parseInt(tableCountRows[0]?.cnt || "0"),
        indexCount: parseInt(countRows[0]?.index_count || "0"),
      };
    } finally {
      conn.release();
    }
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      // Every reading below is optional on purpose. A server with performance_schema
      // OFF - MariaDB's default - answers each of these with NULL rather than
      // failing, and a metric nobody measured must stay absent instead of arriving
      // as a number the panels would rate (#424, and the rule #448/#452 settled).

      // Calculate cache hit ratio from InnoDB buffer pool
      const [hitRows] = await runStatement(conn, BUFFER_CACHE_HIT_RATIO_SQL);
      const hitRatio = measuredNumber(hitRows[0]?.hit_ratio);

      // Get buffer pool usage
      const [poolRows] = await runStatement(conn, BUFFER_POOL_PAGES_SQL);
      const dataPages = measuredNumber(poolRows[0]?.data_pages);
      const totalPages = measuredNumber(poolRows[0]?.total_pages);

      // Get queries per second
      const [qpsRows] = await runStatement(conn, QUERIES_PER_SECOND_SQL);
      const queries = measuredNumber(qpsRows[0]?.queries);
      const uptime = measuredNumber(qpsRows[0]?.uptime);

      // Get deadlocks. SHOW STATUS answers this with or without performance_schema,
      // so a 0 here is a measurement and is reported as one. Bare, for the reason
      // `statusValue()` records: Doris 4.1.3 refuses the LIKE clause on this statement.
      // `Innodb_deadlocks` is MariaDB's variable (12.3.2 publishes it among 571 rows);
      // MySQL 26.7.0 publishes none of it among its 528, measured 2026-09-06, so the
      // row is simply not in the list there and the reading stays absent.
      const [statusRows] = await runStatement(conn, "SHOW STATUS");
      const deadlocks = measuredNumber(statusValue(statusRows, "Innodb_deadlocks"));

      return {
        ...(hitRatio === undefined ? {} : { cacheHitRatio: Math.min(100, Math.max(0, hitRatio)) }),
        ...(queries === undefined || !uptime ? {} : { queriesPerSecond: round2(queries / uptime) }),
        ...(dataPages === undefined || !totalPages ? {} : { bufferPoolUsage: round2((dataPages / totalPages) * 100) }),
        ...(deadlocks === undefined ? {} : { deadlocks }),
      };
    } catch {
      // performance_schema is absent entirely rather than merely off: nothing was
      // measured, so nothing is reported.
      return {};
    } finally {
      conn.release();
    }
  }

  /**
   * The digests, or the server's refusal - this read does NOT swallow.
   *
   * It used to `return []` on any throw, with a comment saying the reason travelled
   * through `ProviderLabels.slowQueriesEmptyState` instead. It did not: that label is
   * one fixed sentence rendered for every empty list whatever produced it, and the
   * sentence this provider declares names the Performance Schema - the one cause that
   * never reaches here.
   *
   * What never reaches here is off-ness. Measured 2026-08-27, a server with
   * `@@performance_schema` = 0 keeps the digest table selectable and answers 0 rows
   * (MySQL 26.7.0 started `--performance-schema=OFF`, MariaDB 12.3.2 which ships it off),
   * so an unreadable source is the ONLY thing that throws: no `performance_schema`
   * DATABASE at all (ER_1049 on an OceanBase tenant) or the grant denied on it -
   *
   *   errno=1142 code=ER_TABLEACCESS_DENIED_ERROR sqlState=42000
   *   SELECT command denied to user 'nops'@'...' for table
   *   'events_statements_summary_by_digest'
   *
   * measured on MySQL 26.7.0 with a user holding only `SELECT ON d32.*` plus `PROCESS`.
   * Letting that reject is what puts the reason in front of the operator: it becomes
   * `errors.slowQueries` in `getMonitoringData()` (src/lib/db/base-provider.ts), which
   * reads every panel with `Promise.allSettled` and records a rejected one by name, and
   * `QueriesTab` renders it through `PanelUnavailable` carrying the server's own
   * sentence. One rejected panel costs nothing else: that method throws only when all
   * four core reads reject. This is also what the PostgreSQL provider already does - it
   * falls back to `pg_stat_activity` and lets a failure of THAT propagate.
   */
  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement(conn, `${SLOW_QUERIES_BODY_SQL} LIMIT ${Number(limit)};`, [
        this.config.database,
      ]);

      return rows.map(toSlowQueryStats);
    } finally {
      conn.release();
    }
  }

  public async getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 50;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement(conn, `${ACTIVE_SESSIONS_BODY_SQL} LIMIT ${Number(limit)};`, [
        this.config.database,
      ]);

      return rows.map((r) => {
        const durationSeconds = parseInt(r.duration_seconds || "0");
        return {
          pid: r.pid,
          user: r.user || "unknown",
          database: r.database_name || "",
          clientAddr: r.client_addr?.split(":")[0] || undefined,
          state: r.state || "unknown",
          query: r.query || "",
          duration: this.formatDurationString(durationSeconds * 1000),
          durationMs: durationSeconds * 1000,
        };
      });
    } finally {
      conn.release();
    }
  }

  public async getTableStats(options?: { schema?: string }): Promise<TableStats[]> {
    this.ensureConnected();
    const schema = options?.schema ?? this.config.database;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement(conn, TABLE_STATS_SQL, [schema]);

      return rows.map((r) => {
        const tableSizeBytes = parseInt(r.table_size_bytes || "0");
        const indexSizeBytes = parseInt(r.index_size_bytes || "0");
        const totalSizeBytes = parseInt(r.total_size_bytes || "0");
        const freeSpaceBytes = parseInt(r.free_space_bytes || "0");

        // Estimate bloat ratio from free space
        const bloatRatio = totalSizeBytes > 0 ? (freeSpaceBytes / totalSizeBytes) * 100 : 0;

        return {
          schemaName: reportedSchema(r.schema_name, schema),
          tableName: r.table_name || "",
          rowCount: parseInt(r.row_count || "0"),
          tableSize: formatBytes(tableSizeBytes),
          tableSizeBytes,
          indexSize: formatBytes(indexSizeBytes),
          // The byte figure was computed and then dropped, so the storage panel had no per-table
          // index total to add up: `INDEX_LENGTH` is what MySQL itself calls index bytes.
          indexSizeBytes,
          totalSize: formatBytes(totalSizeBytes),
          totalSizeBytes,
          bloatRatio: Math.round(bloatRatio * 10) / 10,
        };
      });
    } finally {
      conn.release();
    }
  }

  public async getIndexStats(options?: { schema?: string }): Promise<IndexStats[]> {
    this.ensureConnected();
    const schema = options?.schema ?? this.config.database;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement(conn, INDEX_STATS_SQL, [schema]);

      // Vitess answers information_schema.STATISTICS with the physical shard database
      // (`vt_probe_0`) even though the filter above named the keyspace, so the size lookup asks
      // for the schema the server just reported rather than the one we connected to.
      const physicalSchema = (rows[0]?.schema_name as string | undefined) ?? schema;

      const indexSizes: Record<string, number> = {};
      try {
        const [sizeRows] = await runStatement(conn, INDEX_SIZES_SQL, [physicalSchema]);

        for (const row of sizeRows) {
          indexSizes[`${row.database_name}/${row.table_name}/${row.index_name}`] = parseInt(row.size_bytes || "0");
        }
      } catch {
        // Reading mysql.innodb_index_stats needs SELECT on the mysql schema, which a user granted
        // only its own database does not have (measured ER_TABLEACCESS_DENIED_ERROR). Every index
        // then reports no size at all rather than a fabricated 0 bytes.
      }

      return rows.map((r) => {
        // An absent row is not a zero-byte index: MyISAM tables and InnoDB tables whose
        // persistent statistics were never written have no row here at all.
        const indexSizeBytes = indexSizes[`${r.schema_name}/${r.table_name}/${r.index_name}`];

        return {
          // As in `getTableStats`; the shard name is only a size key here.
          schemaName: reportedSchema(r.schema_name, schema),
          tableName: r.table_name || "",
          indexName: r.index_name || "",
          indexType: r.index_type || "BTREE",
          columns: r.columns?.split(",") || [],
          isUnique: Boolean(r.is_unique),
          isPrimary: Boolean(r.is_primary),
          indexSize: indexSizeBytes === undefined ? "N/A" : formatBytes(indexSizeBytes),
          indexSizeBytes,
          scans: parseInt(r.cardinality || "0"),
        };
      });
    } finally {
      conn.release();
    }
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      const stats: StorageStats[] = [];

      // Get database size
      const [dbRows] = await runStatement(conn, STORAGE_STATS_SQL, [this.config.database]);

      if (dbRows.length > 0) {
        const sizeBytes = parseInt(dbRows[0].size_bytes || "0");
        stats.push({
          name: "Data",
          location: this.config.database || "default",
          size: formatBytes(sizeBytes),
          sizeBytes,
        });
      }

      // Get binary log size if available
      try {
        const [binlogRows] = await runStatement(conn, "SHOW BINARY LOGS");
        const binlogSize = binlogRows.reduce((sum, r) => sum + parseInt(r.File_size || "0"), 0);
        if (binlogSize > 0) {
          stats.push({
            name: "Binary Logs",
            size: formatBytes(binlogSize),
            sizeBytes: binlogSize,
          });
        }
      } catch {
        // Binary logging not enabled
      }

      // Get InnoDB data file size
      try {
        const [innodbRows] = await runStatement(conn, "SHOW VARIABLES LIKE 'innodb_data_file_path'");
        if (innodbRows.length > 0) {
          stats.push({
            name: "InnoDB",
            location: innodbRows[0].Value || "ibdata1",
            size: "N/A",
            sizeBytes: 0,
          });
        }
      } catch {
        // Could not get InnoDB info
      }

      return stats;
    } finally {
      conn.release();
    }
  }

  private formatUptimeString(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  private formatDurationString(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }
}

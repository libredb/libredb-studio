/**
 * The `influxdb3` object surface (InfluxDB spec 4, R16, E6, E13): one kind, the table, with no container level, the
 * Qdrant shape. A connection reads one database, the session database `connect()` resolved (R1), and its tables are
 * top-level objects, so an object path is one segment, the table; a path of any other length is refused before any
 * request.
 *
 * The database listing (`GET /api/v3/configure/database?format=json`) feeds `resolveSessionDatabase` and never
 * offers `_internal`, which holds the token table on 3.x. The table listing reads `table_schema = 'iox'`, so no
 * `system.*` table is ever listed, and asks for one name more than `INFLUX_LIST_CAP` so a cut listing shows it was
 * cut. A table's columns come from `system.influxdb_schema`, ordered `time`, tags, fields, each in server order.
 *
 * Every catalog text is fixed here or built with the single-quoted literal (`''` doubling; DataFusion has no
 * backslash escape) and passes `evaluateInfluxSql` before it is sent (E6). Each read goes through the `send` it is
 * handed, under the surface's signal; an answer that is not a 200 of JSON is raised as an `InfluxAnswerError` and a
 * row the catalog should not hold as an `InfluxAnswerShapeError`, both worded by errors.ts, so nothing here words an
 * HTTP failure, retries or waits. No pattern reads the server's text (R40).
 */
import { QueryError } from "@/lib/db/errors";
import type { DatabaseObject, KindCount, ObjectDetail, ObjectKindSpec } from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";
import type { InfluxAnswer, InfluxSend } from "./client";
import { INFLUX_CELL_BUDGET, INFLUX_LIST_CAP, INFLUX_ROW_CUT } from "./connection-options";
import { InfluxAnswerError, InfluxAnswerShapeError } from "./errors";
import { SQL_ROUTES } from "./routes";
import { evaluateInfluxSql } from "./sql-policy";
import { shapeJsonlBody } from "./sql-results";

/** The one kind. */
const TABLE_KIND = "table";

export const INFLUXDB3_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: TABLE_KIND,
    role: "relation",
    label: "Table",
    labelPlural: "Tables",
    hasColumns: true,
    hasSource: false,
    acceptsRowWrites: false,
  },
]);

/** Spec section 4: a describe or preview asked with a path that is not one segment, the table. */
export function influxdb3PathRefusal(sessionDatabase: string): string {
  return `This InfluxDB 3 connection reads one database, ${sessionDatabase}, whose tables have no database prefix; set Database on the connection to read another.`;
}

/** The database that holds the token table on 3.x (I11), never offered as a session database. */
const INTERNAL_DATABASE = "_internal";

/** The key a `configure/database` entry names its database by. */
const DATABASE_NAME_KEY = "iox::database";

const LISTING_TEXT = `SELECT table_name FROM information_schema.tables WHERE table_schema = 'iox' ORDER BY table_name LIMIT ${INFLUX_LIST_CAP + 1}`;

/** What a count over the cap was counted from; the number is `INFLUX_LIST_CAP`, pinned by the count test. */
const LISTING_SAMPLE = "the first 2,000 tables information_schema.tables returned";

const SHAPE_LIMITS = { rowCut: INFLUX_ROW_CUT, cellBudget: INFLUX_CELL_BUDGET } as const;

/** The media types the SQL routes answer with: `json` for the listing, `jsonl` for a query. */
const SQL_MEDIA_TYPES: ReadonlySet<string> = new Set(["application/json", "application/jsonl"]);

/** What one read of the session database runs with; the provider builds one per surface call. */
export interface Influxdb3SurfaceContext {
  /** One query under its own permit and the surface deadline. */
  readonly send: InfluxSend<"query">;
  readonly signal: AbortSignal;
  /** The session database `connect()` resolved, sent as `db` on every read. */
  readonly sessionDatabase: string;
}

/** The session database's tables, at most `INFLUX_LIST_CAP`, and whether the listing held more. */
export interface Influxdb3TableListing {
  readonly tables: readonly DatabaseObject[];
  readonly truncated: boolean;
}

/** The answer's text when it is a 200 of JSON; otherwise the answer is raised for errors.ts to word. */
function acceptedText(answer: InfluxAnswer, route: string): string {
  const media = (answer.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (answer.status !== 200 || !SQL_MEDIA_TYPES.has(media)) throw new InfluxAnswerError(answer, route);
  return answer.text;
}

/**
 * The rows of a catalog query; a catalog text the policy refuses is never sent. The shaped `cut` is not read because
 * no catalog text here can reach the row cut: the listing asks for `INFLUX_LIST_CAP + 1` rows, and a describe answers
 * one two-cell row per column, so it would need more than 10,000 columns in one table, twenty times the per-table
 * column limit of 500 the server enforced when measured (R06).
 */
async function queryRows(context: Influxdb3SurfaceContext, q: string): Promise<readonly Record<string, unknown>[]> {
  const verdict = evaluateInfluxSql(q);
  if (!verdict.allowed) throw new QueryError(verdict.message, "influxdb3");
  const answer = await context.send({ route: "query", values: { db: context.sessionDatabase, q } }, context.signal);
  return shapeJsonlBody(acceptedText(answer, SQL_ROUTES.query.path), SHAPE_LIMITS).rows;
}

/** A catalog cell that must be text. */
function textCell(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new InfluxAnswerShapeError("not-json");
  return value;
}

/** A DataFusion single-quoted literal: a quote is doubled, and nothing else is escaped. */
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The databases the token lists, in server order, `_internal` removed; `resolveSessionDatabase` reads them. */
export async function readInfluxdb3Databases(
  send: InfluxSend<"databases">,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const text = acceptedText(await send({ route: "databases", values: {} }, signal), SQL_ROUTES.databases.path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InfluxAnswerShapeError("not-json");
  }
  if (!Array.isArray(parsed)) throw new InfluxAnswerShapeError("not-json");
  const names = parsed.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) throw new InfluxAnswerShapeError("not-json");
    return textCell(entry as Readonly<Record<string, unknown>>, DATABASE_NAME_KEY);
  });
  return names.filter((name) => name !== INTERNAL_DATABASE);
}

/** The session database's tables (`table_schema = 'iox'`, so never `system.*`), in name order. */
export async function listInfluxdb3Tables(context: Influxdb3SurfaceContext): Promise<Influxdb3TableListing> {
  const names = (await queryRows(context, LISTING_TEXT)).map((row) => textCell(row, "table_name"));
  const tables = names.slice(0, INFLUX_LIST_CAP).map((name) => ({ path: [name], name, kind: TABLE_KIND }));
  return { tables, truncated: names.length > INFLUX_LIST_CAP };
}

/** The table count from the listing; past the cap a floor that says what it counted. */
export async function countInfluxdb3Tables(context: Influxdb3SurfaceContext): Promise<KindCount> {
  const { tables, truncated } = await listInfluxdb3Tables(context);
  return truncated ? { count: tables.length, sampledFrom: LISTING_SAMPLE } : { count: tables.length };
}

/** One column as the catalog types it: `time` is never null, and no column is a key. */
function columnOf(name: string, type: string): ColumnSchema {
  return { name, type, nullable: type !== "time", isPrimary: false };
}

/** A table's columns from `system.influxdb_schema`: `time`, then tags, then fields, each in server order. */
export async function describeInfluxdb3Table(
  context: Influxdb3SurfaceContext,
  path: readonly string[],
): Promise<ObjectDetail> {
  if (path.length !== 1) throw new QueryError(influxdb3PathRefusal(context.sessionDatabase), "influxdb3");
  const q = `SELECT key, data_type FROM system.influxdb_schema WHERE measurement = ${sqlLiteral(path[0])}`;
  const columns = (await queryRows(context, q)).map((row) =>
    columnOf(textCell(row, "key"), textCell(row, "data_type")),
  );
  const rank = (column: ColumnSchema) => (column.type === "time" ? 0 : column.type === "tag" ? 1 : 2);
  // `toSorted` is stable, so each group keeps the server's order.
  return { path: [...path], columns: columns.toSorted((a, b) => rank(a) - rank(b)), indexes: [], foreignKeys: [] };
}

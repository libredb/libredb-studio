/**
 * The `influxdb` object surface (InfluxDB spec 4; E6, E13): databases are the one container level, a measurement
 * is the one kind, and its columns are `time`, its tag keys and its field keys. Retention policies are not a level:
 * a tree read uses the database's default policy through `"db".."m"`.
 *
 * Every catalog text is built with `quoteInfluxqlIdentifier` and passes `evaluateInfluxql` before it is sent, as a
 * user's text does (no trusted internal path, C6), and its database goes through `resolveRunDatabase`, so `_internal`
 * on a generation that hides it is refused here before any request, whichever read names it. The texts name their
 * database with `ON`, which is also sent as `db`.
 *
 * Every read of one surface call goes through the `send` it is handed, with the call's one deadline
 * (`min(10 s, query timeout)`, R43); the provider gives each read its limiter permit and words a failure through
 * `toInfluxError`, so nothing here retries or writes a server sentence. An answer other than a 200 is handed on as
 * an `InfluxAnswerError`, and a 200 is read by `readInfluxqlCatalogRows`, so C5 and a statement's error apply here
 * too, and a series without exactly the statement's columns is refused before any row is read (R43).
 */
import { QueryError } from "@/lib/db/errors";
import type {
  Container,
  ContainerLevels,
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectKindSpec,
} from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";
import type { InfluxSend } from "./client";
import { INFLUX_LIST_CAP } from "./connection-options";
import { InfluxAnswerError, InfluxAnswerShapeError } from "./errors";
import { evaluateInfluxql } from "./influxql-policy";
import { quoteInfluxqlIdentifier } from "./influxql-quote";
import { readInfluxqlCatalogRows } from "./influxql-results";
import { INFLUXQL_ROUTES } from "./routes";
import { resolveRunDatabase } from "./run-database";
import { GENERATION_TRAITS, type InfluxGeneration } from "./versions";

/** influxdb3 declares no container level (R16); this is the `influxdb` one. */
export const INFLUX_CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Database", labelPlural: "Databases" },
] as const);

const MEASUREMENT_KIND = "measurement";

export const INFLUXQL_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: MEASUREMENT_KIND,
    role: "relation",
    label: "Measurement",
    labelPlural: "Measurements",
    hasColumns: true,
    hasSource: false,
    acceptsRowWrites: false,
  },
]);

/** What a floor count was read from, phrased to follow "counted from". */
const MEASUREMENT_SAMPLE = "the first 2,000 measurements SHOW MEASUREMENTS returned";

/** What one surface call runs with; the provider builds one per call. */
export interface InfluxqlCatalogContext {
  /** One unchunked `/query` under its own permit: every catalog text is a SHOW (R53). */
  readonly send: InfluxSend<"query-unchunked">;
  /** The surface call's one deadline (R43): every read of the call is handed the same signal. */
  readonly signal: () => AbortSignal;
  /** The generation `/ping` reported, which decides whether `_internal` is browsed. */
  readonly generation: InfluxGeneration;
}

/**
 * One catalog read: the policy and the run database first, then the request, then the rows of the answer's expected
 * `columns`, read with no grid (R43), so a hostile answer costs time linear in its size and is refused when its
 * series carry any other column.
 */
async function catalogRead(
  context: InfluxqlCatalogContext,
  text: string,
  columns: readonly string[],
): Promise<readonly (readonly unknown[])[]> {
  const verdict = evaluateInfluxql(text);
  if (!verdict.allowed) throw new QueryError(verdict.message, "influxdb");
  // `SHOW DATABASES` needs no database, and every other catalog text names its own with `ON`.
  const run = resolveRunDatabase({
    namedDatabases: verdict.namedDatabases,
    needsDatabase: false,
    connection: undefined,
    visible: undefined,
    internalDatabase: GENERATION_TRAITS[context.generation].internalDatabase,
  });
  if ("refused" in run) throw new QueryError(run.refused, "influxdb");
  const values: Readonly<Record<string, string>> =
    run.database === undefined ? { q: text } : { q: text, db: run.database };
  const answer = await context.send({ route: "query-unchunked", values }, context.signal());
  if (answer.status !== 200) throw new InfluxAnswerError(answer, INFLUXQL_ROUTES.query.path);
  return readInfluxqlCatalogRows(answer.text, columns);
}

/** The text cells at `index` of every row; a cell that is not text is not an answer of `SHOW`. */
function textColumn(rows: readonly (readonly unknown[])[], index: number): readonly string[] {
  return rows.map((row) => {
    const value = row[index];
    if (typeof value !== "string") throw new InfluxAnswerShapeError("not-json");
    return value;
  });
}

/** The database listing and whether the cap cut it, so a count built on it can say it is a floor. */
export interface InfluxqlDatabaseListing {
  readonly containers: Container[];
  readonly cut: boolean;
}

/**
 * The databases the credential lists (`SHOW DATABASES`, no `db`), in server order, as containers, at most
 * `INFLUX_LIST_CAP` (R43); `_internal` is left out where the generation hides it, before the cap. `SHOW DATABASES`
 * takes no `LIMIT`, so the whole answer is read and the names past the cap are dropped. The connection's database
 * marks `isSessionDefault` and filters nothing.
 */
export async function readInfluxqlDatabaseListing(
  context: InfluxqlCatalogContext,
  connectionDatabase: string | undefined,
): Promise<InfluxqlDatabaseListing> {
  const rows = await catalogRead(context, "SHOW DATABASES", ["name"]);
  const hidden = GENERATION_TRAITS[context.generation].internalDatabase === "hide";
  const names = textColumn(rows, 0).filter((name) => !(hidden && name === "_internal"));
  return {
    containers: names
      .slice(0, INFLUX_LIST_CAP)
      .map((name) => ({ path: [name], name, level: 0, isSessionDefault: name === connectionDatabase })),
    cut: names.length > INFLUX_LIST_CAP,
  };
}

/** `readInfluxqlDatabaseListing`'s containers. */
export async function readInfluxqlDatabases(
  context: InfluxqlCatalogContext,
  connectionDatabase: string | undefined,
): Promise<Container[]> {
  return (await readInfluxqlDatabaseListing(context, connectionDatabase)).containers;
}

/** `SHOW MEASUREMENTS ON <db> LIMIT 2001`: one name past the cap shows that the listing stopped short. */
async function measurementNames(context: InfluxqlCatalogContext, database: string): Promise<readonly string[]> {
  const text = `SHOW MEASUREMENTS ON ${quoteInfluxqlIdentifier(database)} LIMIT ${INFLUX_LIST_CAP + 1}`;
  return textColumn(await catalogRead(context, text, ["name"]), 0);
}

/** The measurements of `database`, in server order, at most `INFLUX_LIST_CAP`. */
export async function listInfluxqlMeasurements(
  context: InfluxqlCatalogContext,
  database: string,
): Promise<DatabaseObject[]> {
  const names = await measurementNames(context, database);
  return names.slice(0, INFLUX_LIST_CAP).map((name) => ({ path: [database, name], name, kind: MEASUREMENT_KIND }));
}

/** The measurement count from the listing; past the cap a floor. */
export async function countInfluxqlMeasurements(
  context: InfluxqlCatalogContext,
  database: string,
): Promise<Record<string, KindCount>> {
  const names = await measurementNames(context, database);
  const count: KindCount =
    names.length > INFLUX_LIST_CAP
      ? { count: INFLUX_LIST_CAP, sampledFrom: MEASUREMENT_SAMPLE }
      : { count: names.length };
  return { [MEASUREMENT_KIND]: count };
}

const column = (name: string, type: string, nullable = true): ColumnSchema => ({
  name,
  type,
  nullable,
  isPrimary: false,
});

/**
 * `time`, then the tag keys (`SHOW TAG KEYS ON <db> FROM <m>`), then the field keys with their types
 * (`SHOW FIELD KEYS ON <db> FROM <m>`), each in server order. `time` is the only column that is never null, and no
 * column is a key; a measurement has no index and no foreign key.
 */
export async function describeInfluxqlMeasurement(
  context: InfluxqlCatalogContext,
  database: string,
  measurement: string,
): Promise<ObjectDetail> {
  const on = `ON ${quoteInfluxqlIdentifier(database)} FROM ${quoteInfluxqlIdentifier(measurement)}`;
  const tags = await catalogRead(context, `SHOW TAG KEYS ${on}`, ["tagKey"]);
  const fields = await catalogRead(context, `SHOW FIELD KEYS ${on}`, ["fieldKey", "fieldType"]);
  const fieldTypes = textColumn(fields, 1);
  return {
    path: [database, measurement],
    columns: [
      column("time", "time", false),
      ...textColumn(tags, 0).map((name) => column(name, "tag")),
      ...textColumn(fields, 0).map((name, index) => column(name, fieldTypes[index])),
    ],
    indexes: [],
    foreignKeys: [],
  };
}

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
 * Every read goes through the `send` the surface is handed, with the signal of the surface's deadline
 * (`min(10 s, query timeout)`); the provider gives each read its limiter permit and words a failure through
 * `toInfluxError`, so nothing here retries or writes a server sentence. An answer other than a 200 is handed on as
 * an `InfluxAnswerError`, and a 200 is read by `shapeInfluxqlBody`, so C5 and a statement's error apply here too.
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
import { type InfluxShapeLimits, type ShapedResult, shapeInfluxqlBody } from "./influxql-results";
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

/**
 * A catalog answer is never cut: the measurement listing carries its own `LIMIT`, and the database listing and the
 * key reads are bounded by the response byte cap, so a column list is whole or the read fails.
 */
const CATALOG_LIMITS: InfluxShapeLimits = { rowCut: Number.MAX_SAFE_INTEGER, cellBudget: Number.MAX_SAFE_INTEGER };

/** What one surface call runs with; the provider builds one per call. */
export interface InfluxqlCatalogContext {
  /** One `/query` under its own permit. */
  readonly send: InfluxSend<"query">;
  /** The surface deadline's signal, asked once per read. */
  readonly signal: () => AbortSignal;
  /** The generation `/ping` reported, which decides whether `_internal` is browsed. */
  readonly generation: InfluxGeneration;
}

/** One catalog read: the policy and the run database first, then the request, then the answer as a grid. */
async function catalogRead(context: InfluxqlCatalogContext, text: string): Promise<ShapedResult> {
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
  const answer = await context.send({ route: "query", values }, context.signal());
  if (answer.status !== 200) throw new InfluxAnswerError(answer, INFLUXQL_ROUTES.query.path);
  return shapeInfluxqlBody(answer.text, CATALOG_LIMITS);
}

/** The text cells of one column; a cell that is not text is not an answer of `SHOW`. */
function textColumn(result: ShapedResult, column: string): readonly string[] {
  return result.rows.map((row) => {
    const value = row[column];
    if (typeof value !== "string") throw new InfluxAnswerShapeError("not-json");
    return value;
  });
}

/**
 * The databases the credential lists (`SHOW DATABASES`, no `db`), in server order, as containers; `_internal` is
 * left out where the generation hides it. The connection's database marks `isSessionDefault` and filters nothing.
 */
export async function readInfluxqlDatabases(
  context: InfluxqlCatalogContext,
  connectionDatabase: string | undefined,
): Promise<Container[]> {
  const listing = await catalogRead(context, "SHOW DATABASES");
  const hidden = GENERATION_TRAITS[context.generation].internalDatabase === "hide";
  return textColumn(listing, "name")
    .filter((name) => !(hidden && name === "_internal"))
    .map((name) => ({ path: [name], name, level: 0, isSessionDefault: name === connectionDatabase }));
}

/** `SHOW MEASUREMENTS ON <db> LIMIT 2001`: one name past the cap shows that the listing stopped short. */
async function measurementNames(context: InfluxqlCatalogContext, database: string): Promise<readonly string[]> {
  const text = `SHOW MEASUREMENTS ON ${quoteInfluxqlIdentifier(database)} LIMIT ${INFLUX_LIST_CAP + 1}`;
  return textColumn(await catalogRead(context, text), "name");
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
  const tags = await catalogRead(context, `SHOW TAG KEYS ${on}`);
  const fields = await catalogRead(context, `SHOW FIELD KEYS ${on}`);
  const fieldTypes = textColumn(fields, "fieldType");
  return {
    path: [database, measurement],
    columns: [
      column("time", "time", false),
      ...textColumn(tags, "tagKey").map((name) => column(name, "tag")),
      ...textColumn(fields, "fieldKey").map((name, index) => column(name, fieldTypes[index])),
    ],
    indexes: [],
    foreignKeys: [],
  };
}

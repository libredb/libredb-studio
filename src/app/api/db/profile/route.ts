import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
  PermissionDeniedError,
  PoolExhaustedError,
  QueryCancelledError,
  TimeoutError,
} from "@/lib/db/errors";
import { offersColumnProfiling } from "@/lib/db/types";
import { createErrorResponse } from "@/lib/api/errors";
import { type ProviderTextScrub, providerTextScrub, withheldProviderError } from "@/lib/db/operations/provider-text";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { editorProvider } from "@/lib/api/editor-provider";
import { openWithinCall, queryTimeoutError } from "@/lib/api/editor-query";
import { openProfileReads, type ProfileReads } from "@/lib/api/profile-reads";
import { jsonCommandAddress, outermostFieldPaths } from "@/lib/db/providers/document/mongodb/generators";
import { objectSegment, quoteIdentifier, quoteObjectPath } from "@/lib/query-generators";
import type { ColumnProfile } from "@/lib/export/data-profile";
import { renderValue } from "@/lib/export/csv";
import { type RecordedUnit, runRecorded } from "@/lib/query-events/recorded-run";

/*
 * THE DATA PROFILE ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clause C-86).
 *
 * Every read this route sends is one host core execute through the profile's reads (`openProfileReads`,
 * src/lib/api/profile-reads.ts): each statement the route composes on a composed statement session, exactly as
 * written, and the SQL sample on the console session asking a page of five, each under a deadline of its own and the
 * request's signal. The route calls no provider statement member. The connection opens within its engine's connect
 * budget and while the request stays (`openWithinCall`), and a statement timeout the host cannot wait on is refused
 * before the open. A read past its deadline or a request that leaves answers a `TimeoutError` or a
 * `QueryCancelledError`, so it ends the profile as `ENDS_PROFILE` ends it.
 */

/** The most columns one profile reads: each one costs the engine a scan of the table. */
const PROFILED_COLUMN_LIMIT = 20;

/**
 * `row[name]`, or the field whose name differs from it only in case.
 *
 * An unquoted alias is folded by the engine, and not always to lower case: Oracle answers
 * `TOTAL` for `total`, which made every Oracle profile report 0 rows. The exact name is
 * tried first, so a result holding both `id` and `ID` still reads the one asked for.
 */
function field(row: Record<string, unknown> | undefined, name: string): unknown {
  if (row === undefined) return undefined;
  if (Object.hasOwn(row, name)) return row[name];
  const folded = Object.keys(row).find((key) => key.toLowerCase() === name.toLowerCase());
  return folded === undefined ? undefined : row[folded];
}

/**
 * A MongoDB field's value in a sampled document, `address.geo.lat` read by walking the nested
 * document: a projected document stays nested, so a dotted column is never a key of the row,
 * and reading it as one profiled every nested field as 100 % null. A path that crosses a
 * scalar, an array or a missing field is absent, as the field is in that document.
 */
function valueAtPath(row: Record<string, unknown>, path: string): unknown {
  let value: unknown = row;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/** A MIN or MAX as the text the profiler shows, through the export's own spelling of a value. */
function valueText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : renderValue(value);
}

/**
 * Why a statement failed, as the user may read it: an engine's own message, which is what the
 * editor shows for the same statement, and nothing from an error this server raised itself.
 * The engine's message is answered through the connection's scrub: one that holds a credential of
 * the connection answers Studio's sentence naming the error's class instead.
 */
function reasonOf(scrub: ProviderTextScrub, error: unknown): string {
  if (!(error instanceof DatabaseError)) return "Could not profile this column";
  return withheldProviderError(scrub, error)?.message ?? error.message;
}

/**
 * The failures that say nothing about the column: the connection, the session or the request
 * itself is gone or out of time, or the credential lacks a privilege the read needs. Asking the
 * next measure would only meet them again, and on a table big enough to reach a statement
 * timeout every retry is another full scan, so they end the whole profile and reach
 * `createErrorResponse`, which answers each with its own status.
 */
const ENDS_PROFILE = [
  ConnectionError,
  AuthenticationError,
  PermissionDeniedError,
  PoolExhaustedError,
  TimeoutError,
  QueryCancelledError,
  DatabaseConfigError,
];

/**
 * `error` as one measure's refusal, the engine's reason for it, or thrown on when it ends the
 * profile. Anything else is read as a refusal, the shape in which a type that does not take an
 * aggregate fails, whichever class its provider raised it as.
 */
function refusalOf(scrub: ProviderTextScrub, error: unknown): string {
  if (ENDS_PROFILE.some((kind) => error instanceof kind)) throw error;
  return reasonOf(scrub, error);
}

/**
 * One column's statistics, in as few statements as the engine allows.
 *
 * Every statement is plain SQL every SQL engine here reads: no cast and no arithmetic,
 * because a cast is dialect syntax (`::text` is PostgreSQL's, and the one statement this
 * route used to send failed on every other engine), and MIN and MAX are read on the
 * column's own type so a number is ordered as a number (ids 1..200 answered `max 99`
 * through the text cast). The null count is worked out here rather than in SQL for the
 * same reason, since CQL has no arithmetic on aggregates.
 *
 * Not every type takes every aggregate: SQL Server refuses COUNT(DISTINCT) on `text`,
 * PostgreSQL has no MIN(boolean), CQL has no COUNT(DISTINCT) at all. So when the one
 * statement fails, each measure is asked on its own and a refused one is reported with
 * the engine's reason, instead of the whole column reading as 0 % null and 0 distinct.
 */
async function profileSqlColumn(
  reads: ProfileReads,
  scrub: ProviderTextScrub,
  table: string,
  name: string,
  column: string,
  totalRows: number,
): Promise<ColumnProfile> {
  const counts = `COUNT(*) AS total_count, COUNT(${column}) AS non_null_count`;
  const distinct = `COUNT(DISTINCT ${column}) AS distinct_count`;
  const range = `MIN(${column}) AS min_value, MAX(${column}) AS max_value`;
  const read = async (projection: string) => (await reads.composed(`SELECT ${projection} FROM ${table}`)).rows[0] ?? {};

  let row: Record<string, unknown>;
  const warnings: string[] = [];
  try {
    row = await read(`${counts}, ${distinct}, ${range}`);
  } catch (error) {
    refusalOf(scrub, error);
    try {
      row = { ...(await read(counts)) };
    } catch (countError) {
      const countRefusal = refusalOf(scrub, countError);
      // A large-object type takes no aggregate at all (SQL Server `text`: "Operand data type
      // text is invalid for count operator"; Oracle CLOB: ORA-22849), but IS NULL still
      // reads it, so its nulls are counted in a filter against the table's own total. The
      // other two measures are aggregates too, so they are reported refused for that same
      // reason rather than sent to be refused again.
      let nulls: Record<string, unknown> | undefined;
      try {
        nulls = (await reads.composed(`SELECT COUNT(*) AS null_count FROM ${table} WHERE ${column} IS NULL`)).rows[0];
      } catch (nullError) {
        return { name, totalRows, error: refusalOf(scrub, nullError) };
      }
      const nullCount = field(nulls, "null_count");
      if (nullCount === undefined) return { name, totalRows, error: countRefusal };
      return {
        ...columnFigures(name, { total_count: totalRows, non_null_count: totalRows - Number(nullCount) }),
        warnings: [`Distinct count and min/max: ${countRefusal}`],
      };
    }
    for (const [label, projection] of [
      ["Distinct count", distinct],
      ["Min/max", range],
    ]) {
      try {
        Object.assign(row, await read(projection));
      } catch (measureError) {
        warnings.push(`${label}: ${refusalOf(scrub, measureError)}`);
      }
    }
  }

  return { ...columnFigures(name, row), warnings: warnings.length > 0 ? warnings : undefined };
}

/** The figures a profile reports from one result row, whatever case its aliases came back in. */
function columnFigures(name: string, row: Record<string, unknown>): ColumnProfile {
  const total = Number(field(row, "total_count") ?? 0);
  const nullCount = total - Number(field(row, "non_null_count") ?? 0);
  const distinctCount = field(row, "distinct_count");
  return {
    name,
    totalRows: total,
    nullCount,
    nullPercent: total > 0 ? Math.round((nullCount / total) * 100) : 0,
    distinctCount: distinctCount === undefined ? undefined : Number(distinctCount),
    minValue: valueText(field(row, "min_value")),
    maxValue: valueText(field(row, "max_value")),
  };
}

export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/profile", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  // Core's scrub of the resolved connection, held out here for the `catch` below: before the connection resolves no
  // provider ran.
  let scrub: ProviderTextScrub | undefined;
  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(req);
    if (body === null) {
      return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    }
    const { tablePath, columns } = body;

    const connection = await resolveConnection(body, guard.session);
    const connectionScrub = providerTextScrub(connection, "any");
    scrub = connectionScrub;

    // The object's ADDRESS, one element per segment, and it is checked element by element
    // rather than by `Array.isArray` alone: an array is not a path if it holds anything but
    // strings, and the old body carried a dotted STRING that this route split on `.`, which
    // is the defect `path` exists to retire (#789). Refused explicitly here so a caller that
    // lost the address gets a 400 instead of a statement built around `undefined`.
    if (!Array.isArray(tablePath) || tablePath.length === 0 || tablePath.some((s) => typeof s !== "string")) {
      return NextResponse.json(
        { error: "tablePath is required: the object address, one segment per element" },
        { status: 400 },
      );
    }
    // Each column name is quoted into the statement as an identifier, which a non-string
    // cannot be: refused here rather than turned into `"undefined"` or a crash mid-profile.
    if (columns !== undefined && (!Array.isArray(columns) || columns.some((c) => typeof c !== "string"))) {
      return NextResponse.json({ error: "columns must be a list of column names" }, { status: 400 });
    }
    // Every read waits on the connection's statement timeout, so one the host cannot wait on is refused before the
    // open, in the query route's sentence: inside a measure's refusal it would read as every column's.
    const timeoutError = queryTimeoutError(connection.queryTimeout);
    if (timeoutError !== null) return NextResponse.json({ error: timeoutError }, { status: 400 });
    const path = tablePath as string[];
    // The LABEL, for the response alone: the profiler names its export after it.
    const tableName = objectSegment(path);

    // The open is waited for within its engine's connect budget and while the request stays: a wait that ends answers
    // 504 or 499, not-sent, and the open goes on for the next request.
    const provider = await openWithinCall(req.signal, connection.type, (wait) =>
      editorProvider(guard.session, connection, requestCatalog(body), wait),
    );
    // One `profile` event per run: a profile reads aggregates of user data, so it is a SELECT whatever engine runs it.
    const profileUnit = (statement: string): RecordedUnit => ({
      source: "profile",
      session: guard.session,
      connection,
      statement,
      statementType: "SELECT",
    });

    {
      const capabilities = provider.getCapabilities();

      // A language this route writes no statement in is refused BEFORE anything is sent
      // (#1085). The branch below took every language that is not SQL for MongoDB and sent
      // it an `aggregate` document, which only MongoDB reads. The gate is the one both row
      // menus ask, so no menu offers what this refuses. The message names the provider's own
      // declared language and never the request's table or columns.
      if (!offersColumnProfiling(capabilities)) {
        // An engine that declines the profiler speaks a language this route writes, so the language sentence
        // below would name the wrong reason.
        if (capabilities.supportsColumnProfiling === false) {
          throw new DatabaseConfigError(
            "This connection does not offer column profiling, so nothing was sent.",
            provider.type,
          );
        }
        const dialect = capabilities.queryDialect === undefined ? "" : ` in the ${capabilities.queryDialect} dialect`;
        throw new DatabaseConfigError(
          "Column profiling runs as SQL or as a MongoDB aggregate document, and this connection speaks " +
            `"${capabilities.queryLanguage}"${dialect}, so nothing was sent.`,
          provider.type,
        );
      }

      const isSQL = capabilities.queryLanguage === "sql";

      // Refused for both branches: SQL has no statement to write without a column, and
      // MongoDB refuses the empty `$project` an empty list would build.
      const colList = (columns || []) as string[];
      if (colList.length === 0) {
        return NextResponse.json({ error: "No columns to profile" }, { status: 400 });
      }

      // The host core is read once here, before any read and outside every measure's refusal, so a profile run before
      // its install fails by name and sends nothing.
      const reads = openProfileReads(provider, req.signal, "api/db/profile");

      if (!isSQL) {
        // MongoDB profiling. The database rides as its own key: the connected database is
        // not the collection's database in general, and without the key both reads went to
        // the connected database's same-named collection (#843).
        const address = jsonCommandAddress(path, capabilities);
        const profileQuery = JSON.stringify({
          ...address,
          operation: "aggregate",
          pipeline: [
            { $sample: { size: 1000 } },
            // The outermost paths only: the column list names a subdocument beside its own
            // dotted children, and a `$project` naming both is refused as a path collision.
            { $project: Object.fromEntries(outermostFieldPaths(colList).map((c) => [c, 1])) },
          ],
        });
        // The run is recorded with the address as the route writes it into both reads
        // (docs/GOVERNANCE.md#query-events).
        return await runRecorded(profileUnit(JSON.stringify(address)), async () => {
          const sampleResult = await reads.composed(profileQuery);
          const totalCountResult = await reads.composed(
            JSON.stringify({
              ...address,
              // `count`, the operation MongoDBProvider dispatches (it calls the
              // driver's countDocuments internally). `countDocuments` is not in its
              // SUPPORTED_OPERATIONS, so every MongoDB profile answered 400
              // "Unsupported operation: countDocuments" - the route's own test mock
              // had accepted the name and hid it.
              operation: "count",
              filter: {},
            }),
          );

          const totalRows = totalCountResult.rows[0]?.count || sampleResult.rows.length;
          const columnProfiles = colList.map((col) => {
            // Absent and `null` are both empty (#1456): MongoDB has no declared nullability, so
            // counting only the absent ones made an explicit null a value, and a distinct one.
            // The samples keep the nulls, shown as `NULL` like the SQL branch shows them.
            const present = sampleResult.rows.map((r) => valueAtPath(r, col)).filter((v) => v !== undefined);
            const values = present.filter((v) => v !== null);
            const nullCount = sampleResult.rows.length - values.length;
            const distinctValues = new Set(values.map((v) => JSON.stringify(v)));

            return {
              name: col,
              type: values.length > 0 ? typeof values[0] : "unknown",
              totalRows,
              nullCount,
              nullPercent: sampleResult.rows.length > 0 ? Math.round((nullCount / sampleResult.rows.length) * 100) : 0,
              distinctCount: distinctValues.size,
              // Spelled as the SQL branch spells them: a subdocument or an array as its JSON
              // (`String` answered `[object Object]`), and a null as `NULL`.
              sampleValues: present.slice(0, 5).map((v) => (v === null ? "NULL" : renderValue(v))),
            };
          });

          return NextResponse.json({ tableName, totalRows, columns: columnProfiles });
        });
      }

      // SQL profiling
      // Quote the ADDRESS once for the target dialect, per segment and never by splitting a
      // string: two containers may hold one label, and a name may itself contain a dot.
      const safeTable = quoteObjectPath(path, provider.type, capabilities);

      // The run is recorded with the quoted path as its statement, never the reads Studio built around it
      // (docs/GOVERNANCE.md#query-events).
      return await runRecorded(profileUnit(safeTable), async () => {
        const countResult = await reads.composed(`SELECT COUNT(*) AS total FROM ${safeTable}`);
        const totalRows = Number(field(countResult.rows[0], "total") ?? 0);

        const profiled = colList.slice(0, PROFILED_COLUMN_LIMIT);
        const columnProfiles: ColumnProfile[] = [];
        // One column at a time, on purpose: each statement scans the table, and twenty of them
        // at once would be twenty concurrent scans of the user's database.
        for (const col of profiled) {
          columnProfiles.push(
            await profileSqlColumn(
              reads,
              connectionScrub,
              safeTable,
              col,
              quoteIdentifier(col, provider.type, capabilities, { always: true }),
              totalRows,
            ),
          );
        }

        // Sample values for the first five columns. The bound is the provider's own spelling, through
        // the console session's page of five: `LIMIT 5` written here was a syntax error on Oracle,
        // SQL Server and Db2. The provider is asked one row past the page, and five are kept.
        const topCols = profiled.slice(0, 5);
        const safeCols = topCols
          .map((c) => quoteIdentifier(c, provider.type, capabilities, { always: true }))
          .join(", ");
        try {
          const sampleRows = await reads.sample(`SELECT ${safeCols} FROM ${safeTable}`, 5);
          for (const profile of columnProfiles) {
            if (topCols.includes(profile.name)) {
              profile.sampleValues = sampleRows
                .map((r) => field(r, profile.name))
                .map((v) => (v === null || v === undefined ? "NULL" : renderValue(v)))
                .slice(0, 5);
            }
          }
        } catch {
          /* skip sample values on error */
        }

        const omittedColumns = colList.slice(PROFILED_COLUMN_LIMIT);
        return NextResponse.json({
          tableName,
          totalRows,
          columns: columnProfiles,
          ...(omittedColumns.length > 0 ? { omittedColumns } : {}),
        });
      });
    }
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/profile", scrub });
  }
}

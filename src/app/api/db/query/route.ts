import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { createDatabaseProvider, getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { editorProvider } from "@/lib/api/editor-provider";
import { readBoundParams } from "@/lib/api/bound-params";
import { checkEditorQuery, runEditorQuery } from "@/lib/api/editor-query";
import { ObjectRouteError, objectRouteErrorBody, optionalDatabase } from "@/lib/api/object-route";
import { containerDepth } from "@/lib/db/object-kinds";
import { getExplainStrategy, type ExplainMode } from "@/lib/explain";
import { countCodeStatements } from "@/lib/sql/statement-splitter";
import { hasLoneCarriageReturnInLineComment, hasUnterminatedSpan } from "@/lib/sql/spans";
import { readsSqlText, resolveSqlGrammar } from "@/lib/sql/grammar";
import type { ExplainFormat, QueryPrepareOptions } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { admitQueryExecution } from "@/lib/query-events/admission";
import { queryEventStart } from "@/lib/query-events/build";
import {
  queryEventRequest,
  recordExecutedUnit,
  recordRefusedRequest,
  requestedConnectionId,
} from "@/lib/query-events/route-events";

/**
 * The error an unreadable `explain` field gets. It names the whole allowed shape
 * rather than what was sent, the way `BOUND_PARAMS_MESSAGE` does.
 */
const EXPLAIN_REQUEST_MESSAGE = 'explain must be { "mode": "estimate" } or { "mode": "analyze" }';

type ExplainRequestResult =
  | { valid: true; explain: { mode: ExplainMode } | undefined }
  | { valid: false; message: string };

/**
 * Read a request's `explain` field: the ASK for a plan, not a statement (#574).
 *
 * The EXPLAIN statement is built on this side because the accepted form is not
 * always knowable before connecting. Measured 2026-09-06 over the MySQL wire
 * protocol (mysql2 3.24.2, text protocol): `EXPLAIN FORMAT=JSON SELECT 1` is
 * refused by TiDB v8.5.1 (errno 1105, "explain format 'json' is not supported
 * now"), Apache Doris 4.1.3 (errno 1105, "mismatched input '='"), StarRocks
 * 3.3.22 and SingleStore (both errno 1064), while a plain `EXPLAIN SELECT 1` is
 * accepted on every one of them. `POST /api/db/provider-meta` never connects
 * (#457), so the client cannot be told which form to build; it asks for a mode
 * and the connected provider's capabilities decide the rest.
 */
function readExplainRequest(value: unknown): ExplainRequestResult {
  if (value === undefined) return { valid: true, explain: undefined };
  if (typeof value !== "object" || value === null) return { valid: false, message: EXPLAIN_REQUEST_MESSAGE };

  const mode = (value as { mode?: unknown }).mode;
  if (mode !== "estimate" && mode !== "analyze") return { valid: false, message: EXPLAIN_REQUEST_MESSAGE };

  return { valid: true, explain: { mode } };
}

export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/query", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  // THE QUERY EVENT OF THIS REQUEST (docs/GOVERNANCE.md#query-events). What it names is held out here, so the `catch`
  // below can record a request that failed at any step: refused before its connection resolved, refused by the
  // admission gate, or run. `stage` says which, and the statement is the text the user submitted, never the EXPLAIN or
  // the bound built from it.
  const started = queryEventStart();
  const events = queryEventRequest("editor", guard.session, req);
  let requestedId: string | undefined;
  let connection: DatabaseConnection | undefined;
  let submitted: string | null = null;
  let explainMode: ExplainMode | undefined;
  let stage: "request" | "admission" | "execution" = "request";

  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(req);
    if (body === null) {
      return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    }
    // `options` is handed on as the page options it names, as it was when the body was read untyped.
    const { sql, options = {}, queryId } = body as { options?: QueryPrepareOptions } & Record<string, unknown>;
    requestedId = requestedConnectionId(body);
    submitted = typeof sql === "string" ? sql : null;

    connection = await resolveConnection(body, guard.session);

    // A `sql` that is present but not a string, a falsy one (0, false) included, is refused in words: a truthy one
    // reached the provider and answered 500 with its own TypeError. A missing (null) or empty one keeps its answer.
    if (sql != null && typeof sql !== "string") {
      return NextResponse.json({ error: "sql must be a string" }, { status: 400 });
    }
    if (!sql) {
      return NextResponse.json({ error: "Connection and query are required" }, { status: 400 });
    }
    // The id a provider tracks the run under and the cancel route names it by: a provider
    // sends it on to the engine (ClickHouse) or keys a Map with it, so only a string (#1364).
    if (queryId !== undefined && typeof queryId !== "string") {
      return NextResponse.json({ error: "queryId must be a string" }, { status: 400 });
    }

    // The page bounds and the console text bound, before any provider resolves (`src/lib/api/editor-query.ts`).
    const refusal = checkEditorQuery({ statement: sql, type: connection.type, options });
    if (refusal !== null) {
      return NextResponse.json({ error: refusal.error }, { status: refusal.status });
    }

    // A generated statement sends its values here rather than writing them into the
    // SQL (#290). They go straight to the driver's bind path, so what may be bound
    // is decided before the provider is even reached.
    const bound = readBoundParams(body.params);
    if (!bound.valid) {
      return NextResponse.json({ error: bound.message }, { status: 400 });
    }

    const explain = readExplainRequest(body.explain);
    if (!explain.valid) {
      return NextResponse.json({ error: explain.message }, { status: 400 });
    }
    explainMode = explain.explain?.mode;

    // AN EXPLAIN PREFIXES ONE STATEMENT (#1311). Handed `SELECT 1 AS a; INSERT ...` it
    // explained the SELECT and the simple-query protocol then RAN the INSERT as a
    // statement of its own: measured on Materialize 26.44.1, AlloyDB Omni 17.9 and
    // Cloudberry 2.1.0, one RUN of that text applied the INSERT twice, once in the run
    // and once in its background plan request. A plan of several statements is not a
    // plan of anything, so the text is refused before a provider is opened. It is read
    // under the connection's own grammar, the one the editor splits a run with, so a
    // `;` inside a quote or a comment is not a second statement, and neither is a note
    // after the final `;` (a fragment of comments only is not counted). A text with a
    // run the grammar cannot close is refused too: the splitter finds no boundary in
    // it, yet `SELECT E'\''; INSERT ...` is two statements to PostgreSQL. So is a text whose
    // line comment holds a lone carriage return, which ends the comment on PostgreSQL and
    // not on CockroachDB, so the code after it is a second statement to one. Only SQL text
    // is counted: an engine whose text is not SQL enforces one statement in its own
    // parser (Firestore's provider refuses a second statement), and the SQL counter
    // would read a `;` in its comment as a boundary.
    const explainGrammar = resolveSqlGrammar(connection.type);
    if (
      explain.explain &&
      typeof sql === "string" &&
      readsSqlText(connection.type) &&
      (countCodeStatements(sql, explainGrammar) > 1 ||
        hasUnterminatedSpan(sql, explainGrammar) ||
        hasLoneCarriageReturnInLineComment(sql, explainGrammar))
    ) {
      return NextResponse.json({ error: "Only a single statement can be explained" }, { status: 400 });
    }

    // The database one RUN should reach. A key lives in exactly one numbered database and
    // `GET <key>` cannot name it, so a tab opened under a chosen database carries the number here
    // (`QueryTab.databaseOverride`) and the statement runs where the key is.
    //
    // READ RATHER THAN THROWN: this route answers body fields in its own style, and
    // `createErrorResponse` does not know `ObjectRouteError` — a throw from here would reach it as a
    // generic 500. The sentence itself is `optionalDatabase`'s and is shared with
    // `POST /api/db/keys/scan`, so the two routes cannot drift about what an invalid `database` is.
    let database: number | undefined;
    try {
      database = optionalDatabase(body, "database");
    } catch (error) {
      if (!(error instanceof ObjectRouteError)) throw error;
      // The SAME body shape and status `handleObjectRequest` renders for it, so a caller cannot tell
      // which of the two routes refused the field.
      return NextResponse.json(objectRouteErrorBody(error), { status: error.status });
    }

    if (database !== undefined) {
      /*
       * APPLIED AFTER THE SEED IS RESOLVED, and gated on the walk being declared.
       *
       * `resolveConnection` discards a caller's connection fields when the id claims the `seed:`
       * namespace (GHSA-3wh2-8x78), which is exactly why the number cannot ride on the connection
       * object: for a managed connection it would be dropped on the way in and the read would run in
       * the SESSION's database while the key tab claims it read another — the defect this field
       * closes. A field of its own, applied to what the OPERATOR's config produced, touches nothing
       * that decides which connection is opened or as whom, so the role filter is unchanged.
       *
       * The gate is `keyScan` for a reason and not a taste: this field carries the database a KEY was
       * walked in, because Redis has no database-qualified key syntax. On an engine whose statements
       * can name their own database the same field would be a per-run override of an
       * operator-pinned `database` with no walk to justify it, so it is refused here in words rather
       * than quietly honoured or quietly ignored.
       *
       * READ FROM THE DECLARATION, BEFORE ANY SOCKET. Capabilities are type-driven, so the
       * unconnected provider `POST /api/db/provider-meta` reads them from (#457) answers the same
       * question. Checked after `getOrCreateProvider`, an unreachable Postgres answered 503 for a
       * request that was never valid, and a reachable one was connected only to be refused.
       */
      const declared = await createDatabaseProvider(connection);
      const capabilities = declared.getCapabilities();
      if (capabilities.keyScan === undefined) {
        return NextResponse.json(
          {
            error:
              `${connection.type} declares no key-space walk: "database" names the database a ` +
              `key was walked in, and only an engine that needs such a name accepts it`,
          },
          { status: 400 },
        );
      }
      /*
       * AND ONLY WHERE THERE IS A DATABASE TO NAME (spec 3.4). A walk declared with no container level
       * is one key space per connection (etcd), so a number here names nothing the engine has. It is
       * refused from the same unconnected declaration, before `getOrCreateProvider`, so no provider, SSH
       * forward or channel is opened or cached for it; `containerDepth` is the rule the Keys panel
       * applies before it sends one at all.
       */
      if (containerDepth(capabilities) === 0) {
        return NextResponse.json(
          {
            error:
              `${connection.type} walks one key space and declares no database level: "database" names the ` +
              `numbered database a key was walked in, and this engine has none to name`,
          },
          { status: 400 },
        );
      }
      connection = { ...connection, database: String(database) };
    }

    // Before the provider: a request the gate refuses opens nothing and runs nothing.
    stage = "admission";
    admitQueryExecution();
    stage = "execution";

    // The DuckDB editor file-access posture rides on the server-derived execution context: an
    // admin keeps the full editor reach, every other role opens with external access off, and so
    // does every role on a seed a non-admin role can use, whose one handle they share (non-admin DuckDB file access).
    const provider = await editorProvider(guard.session, connection, requestCatalog(body));

    // The statement that actually runs. For an explain request it is the one the
    // CONNECTED provider's strategy builds, never the caller's own SQL: falling
    // back to that would execute e.g. an UPDATE the user only asked to see (#201).
    //
    // Bound `params` may come with it and are bound to the BUILT statement: every
    // strategy only prefixes the statement, so the placeholders are the same ones
    // in the same order, which is what the background plan request of PR #304
    // relies on. Refusing them would take the plan away from every generated
    // statement that sends its values separately (#290).
    let statement = sql;
    let explainFormat: ExplainFormat | undefined;
    if (explain.explain) {
      const capabilities = provider.getCapabilities();
      // `getExplainStrategy` indexes a Record, so a format outside this build's union
      // (an external implementer of the published interface can declare anything)
      // comes back undefined rather than null; a strict null check let that reach
      // `strategy.buildSql` and surface as a TypeError 500 instead of this 400.
      const strategy = capabilities.supportsExplain ? getExplainStrategy(capabilities.explainFormat) : null;
      if (!strategy) {
        return NextResponse.json({ error: "This server does not support EXPLAIN" }, { status: 400 });
      }
      const built = strategy.buildSql(sql, explain.explain.mode);
      if (built === null) {
        return NextResponse.json({ error: "Only SELECT statements can be explained" }, { status: 400 });
      }
      statement = built;
      // Named in the response so the client stores the plan under the format that
      // really produced it, rather than under the static one provider-meta gave it.
      explainFormat = strategy.format;
    }

    // The run itself, the steps the VS Code extension's backend child runs too (`src/lib/api/editor-query.ts`).
    const { body: answered } = await runEditorQuery(provider, {
      statement,
      options,
      params: bound.params,
      queryId,
      signal: req.signal,
      route: "api/db/query",
    });
    recordExecutedUnit(events, {
      connection,
      statement: submitted,
      started,
      explain: explainMode,
      ended: { rowCount: answered.rowCount },
    });
    return NextResponse.json({ ...answered, ...(explainFormat !== undefined && { explainFormat }) });
  } catch (error) {
    if (stage === "execution") {
      recordExecutedUnit(events, {
        connection: connection as DatabaseConnection,
        statement: submitted,
        started,
        explain: explainMode,
        ended: { error },
      });
    } else if (stage === "admission" || (connection === undefined && error instanceof SeedConnectionError)) {
      recordRefusedRequest(events, { requestedId, connection, statement: submitted, started, error });
    }
    return createErrorResponse(error, { route: "api/db/query" });
  }
}

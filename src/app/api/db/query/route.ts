import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { readProviderDeclarations } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { connectionTextScrub, type ProviderTextScrub } from "@/lib/db/operations/provider-text";
import { resolveServedConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { editorTarget } from "@/lib/api/editor-provider";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { readBoundParams } from "@/lib/api/bound-params";
import { checkEditorQuery, openWithinBudget, runEditorQuery } from "@/lib/api/editor-query";
import { isPackageFailure, packageFailureAnswer } from "@/lib/api/package-errors";
import { PackageEngineUnsupportedError } from "@/lib/db/errors";
import {
  type EngineConnection,
  type EngineOffers,
  type EngineRecord,
  legacyConnection,
  legacyProviderType,
} from "@/lib/db/server-catalog";
import { packageConnectBudget } from "@/lib/provider-host/open-context";
import { openedProvider } from "@/lib/provider-host/open-engine";
import { ObjectRouteError, objectRouteErrorBody, optionalDatabase } from "@/lib/api/object-route";
import { containerDepth } from "@/lib/db/object-kinds";
import { getExplainStrategy, type ExplainMode } from "@/lib/explain";
import { countCodeStatements } from "@/lib/sql/statement-splitter";
import { hasLoneCarriageReturnInLineComment, hasUnterminatedSpan } from "@/lib/sql/spans";
import { readsSqlText, resolveSqlGrammar } from "@/lib/sql/grammar";
import type { ExplainFormat, QueryPrepareOptions } from "@/lib/db/types";
import { admitQueryExecution } from "@/lib/query-events/admission";
import { gateRun } from "@/lib/api/run-confirmation";
import { runConfirmationIssuerForSession } from "@/lib/api/run-confirmation-token";
import { queryEventStart } from "@/lib/query-events/build";
import {
  queryEventRequest,
  recordExecutedUnit,
  recordRefusedRequest,
  requestedConnectionId,
} from "@/lib/query-events/route-events";

/** The label this route's failures and late failures are logged under. */
const ROUTE = "api/db/query";

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

/**
 * The first request field a query sets that the engine's record does not offer, by the name the answer gives it, or
 * null when it sets none: a plan (`explain`), whose statement is built by the connected provider's strategy, keyed by
 * a legacy plan format; a key-space `database`, read from a legacy provider's declarations; a server-level `catalog`,
 * a legacy catalog session; and an unbounded page (`options.unlimited`), since the provider contract always pumps a
 * bounded one (clause C-16). Each malformed field keeps its 400, read before this: the caller reads `explain` and
 * `database`, and a `catalog` is read here first where the record does not offer catalogs, so a malformed one answers
 * its 400 before any field is refused, and where the record offers them it is read where the gate reads it.
 *
 * @throws {DatabaseConfigError} For a malformed `catalog`, on an engine whose record does not offer catalogs.
 */
function unofferedField(
  offers: EngineOffers,
  request: { body: Record<string, unknown>; explain: boolean; database: number | undefined; unlimited: boolean },
): string | null {
  const catalog = offers.catalog ? undefined : requestCatalog(request.body);
  if (request.explain && !offers.explain) return "explain";
  if (request.database !== undefined && !offers.database) return "database";
  if (catalog !== undefined) return "catalog";
  return request.unlimited && !offers.unboundedPage ? "options.unlimited" : null;
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
  let connection: EngineConnection | undefined;
  // Core's scrub of the resolved connection, for the run and the `catch` below: before the connection resolves no
  // provider ran.
  let scrub: ProviderTextScrub | undefined;
  let submitted: string | null = null;
  let explainMode: ExplainMode | undefined;
  let stage: "request" | "admission" | "execution" = "request";
  // Whether the failure the `catch` below answers was logged already, as a provider package's (`answeredFailure`).
  const failure = { logged: false };

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

    // An engine of an admitted provider package is served too: its connection resolves with every guard of every route,
    // with the server catalog's record of its engine, whose offers decide each step below that differs between engines,
    // and every engine opens through one open and runs through one run (`editorTarget`, `runEditorQuery`).
    const { connection: named, engine } = await resolveServedConnection(body, guard.session);
    // The connection as the engine-neutral readers of its fields take it (the scrub, the gate, the events), which read
    // no row keyed by its type, so a package's connection is read as any other; a step only a legacy provider serves
    // reads it through `legacyConnection` after the record's offer for that step. The scrub is core's scrub of any
    // record's connection, as Test Connection's is: a `database` the route applies below is no secret, so it is the
    // scrub of the connection that runs.
    connection = named;
    scrub = connectionTextScrub(named, legacyProviderType(engine), "any");

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

    // The page bounds, the connection's statement timeout and the console text bound the engine's statement language
    // row states, where it states one, before any open (`src/lib/api/editor-query.ts`).
    const refusal = checkEditorQuery({
      statement: sql,
      engine,
      options,
      queryTimeout: connection.queryTimeout,
    });
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
    // would read a `;` in its comment as a boundary. Read only where the engine's record offers a plan: any other
    // engine's explain is refused by name below.
    if (explain.explain && engine.offers.explain) {
      const { type } = legacyConnection(engine, connection);
      const explainGrammar = resolveSqlGrammar(type);
      if (
        typeof sql === "string" &&
        readsSqlText(type) &&
        (countCodeStatements(sql, explainGrammar) > 1 ||
          hasUnterminatedSpan(sql, explainGrammar) ||
          hasLoneCarriageReturnInLineComment(sql, explainGrammar))
      ) {
        return NextResponse.json({ error: "Only a single statement can be explained" }, { status: 400 });
      }
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

    // A field the engine's record does not offer is refused by name, after every malformed field's 400 and before
    // the gate, so nothing is classified, opened or run for it.
    const unoffered = unofferedField(engine.offers, {
      body,
      explain: explain.explain !== undefined,
      database,
      unlimited: options.unlimited === true,
    });
    if (unoffered !== null) {
      throw new PackageEngineUnsupportedError(
        `This LibreDB Studio does not serve ${unoffered} in a query on an engine of a provider package yet.`,
        engine.id,
      );
    }

    if (database !== undefined) {
      /*
       * APPLIED AFTER THE SEED IS RESOLVED, and gated on the walk being declared.
       *
       * `resolveServedConnection` discards a caller's connection fields when the id claims the `seed:`
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
       * READ FROM THE DECLARATION, BEFORE ANY SOCKET. Capabilities are type-driven, so
       * `readProviderDeclarations`, the read `POST /api/db/provider-meta` takes (#457), answers the same
       * question without connecting and without opening the connection's tunnel (FND-2 slice 5). Checked after the open (`editorTarget`), an unreachable Postgres answered 503 for a
       * request that was never valid, and a reachable one was connected only to be refused.
       *
       * Built under the session's editor posture, as provider-meta builds it, so a connection the
       * posture denies file access is refused here before Studio reads the path it names.
       */
      const legacy = legacyConnection(engine, connection);
      const { capabilities } = await readProviderDeclarations(legacy, editorExecutionContext(guard.session, legacy));
      if (capabilities.keyScan === undefined) {
        return NextResponse.json(
          {
            error:
              `${legacy.type} declares no key-space walk: "database" names the database a ` +
              `key was walked in, and only an engine that needs such a name accepts it`,
          },
          { status: 400 },
        );
      }
      /*
       * AND ONLY WHERE THERE IS A DATABASE TO NAME (spec 3.4). A walk declared with no container level
       * is one key space per connection (etcd), so a number here names nothing the engine has. It is
       * refused from the same unconnected declaration, before the open (`editorTarget`), so no provider, SSH
       * forward or channel is opened or cached for it; `containerDepth` is the rule the Keys panel
       * applies before it sends one at all.
       */
      if (containerDepth(capabilities) === 0) {
        return NextResponse.json(
          {
            error:
              `${legacy.type} walks one key space and declares no database level: "database" names the ` +
              `numbered database a key was walked in, and this engine has none to name`,
          },
          { status: 400 },
        );
      }
      connection = { ...legacy, database: String(database) };
    }

    // The server's confirmation gate, one for every engine, reading the statement with the reader the engine's record
    // offers: after every field check and after the database override, so a token binds the connection that runs, and
    // before the admission gate and any open, so a request it answers opens nothing, runs nothing and records no
    // query event.
    const gate = await gateRun({
      route: "query",
      issuer: runConfirmationIssuerForSession(guard.session),
      connection,
      engine,
      catalog: requestCatalog(body),
      sql,
      params: bound.params,
      confirmation: body.confirmation,
      explain: explain.explain !== undefined,
    });
    if (gate.kind === "answer") return NextResponse.json(gate.body, { status: gate.status });

    // Before the open: a request the gate refuses opens nothing and runs nothing.
    stage = "admission";
    admitQueryExecution();
    stage = "execution";

    // THE OPEN, ONE FOR EVERY ENGINE: the editor's session of the connection's record in the factory's editor cache
    // (`editorTarget`), a legacy provider in the request's catalog or a provider package's session. The DuckDB editor
    // file-access posture rides on the server-derived execution context: an admin keeps the full editor reach, every
    // other role opens with external access off, and so does every role on a seed a non-admin role can use, whose one
    // handle they share (non-admin DuckDB file access). The open is waited for within the connect budget the engine's
    // record states (`packageConnectBudget`) and while the request stays (`openWithinBudget`): a wait that ends answers
    // 504 or 499, not-sent, and the open goes on for the next request. A failure is answered in the words the record
    // offers (`answeredFailure`). `opening` holds the connection narrowed for the callback, which TypeScript does not
    // narrow `connection` in.
    const opening = connection;
    const target = await openWithinBudget(req.signal, packageConnectBudget(engine), (wait) =>
      editorTarget(guard.session, opening, engine, requestCatalog(body), wait),
    ).catch(answeredFailure(engine, "open", scrub, failure));

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
      // Only an engine whose record offers a plan reaches here (`unofferedField`), and its open answered a provider.
      const capabilities = openedProvider(target).getCapabilities();
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

    // The run itself, one for every engine, the steps the VS Code extension's backend child runs too
    // (`src/lib/api/editor-query.ts`), on what the open answered.
    const { body: answered } = await runEditorQuery(target, {
      statement,
      options,
      params: bound.params,
      queryId,
      signal: req.signal,
      route: ROUTE,
      scrub,
    }).catch(answeredFailure(engine, "execute", scrub, failure));
    recordExecutedUnit(events, {
      connection,
      statement: submitted,
      started,
      explain: explainMode,
      ended: { rowCount: answered.rowCount },
    });
    return NextResponse.json({
      ...answered,
      ...(explainFormat !== undefined && { explainFormat }),
      ...(gate.unconfirmed && { confirmation: "unconfirmed" }),
    });
  } catch (error) {
    if (stage === "execution") {
      recordExecutedUnit(events, {
        connection: connection as EngineConnection,
        statement: submitted,
        started,
        explain: explainMode,
        ended: { error },
      });
    } else if (stage === "admission" || (connection === undefined && error instanceof SeedConnectionError)) {
      recordRefusedRequest(events, { requestedId, connection, statement: submitted, started, error });
    }
    // Once the connection resolved, a provider may have run: its error answers with the connection's scrub, and a
    // package's failure `answeredFailure` logged gets no second line.
    return createErrorResponse(error, { route: ROUTE, scrub, logged: failure.logged });
  }
}

/**
 * How a failure of the editor's `call` on `engine` reaches the client: the one answer of a provider package's failure,
 * as Test Connection reads it (`packageFailureAnswer` in src/lib/api/package-errors.ts; docs/providers/CONTRACT.md,
 * clause C-112). A legacy engine's failure is answered as raised, through the connection's scrub; a package's open
 * failure as a not-sent connection error; a refusal of what a package answered as the package's defect; and a
 * package's own words only where its register row grants them, through core's `scrub`. A package's failure is logged
 * there once (`isPackageFailure`), which `failure.logged` records for the route's answer, so it writes no second line.
 */
function answeredFailure(
  engine: EngineRecord,
  call: "open" | "execute",
  scrub: ProviderTextScrub,
  failure: { logged: boolean },
): (error: unknown) => never {
  return (error) => {
    failure.logged = isPackageFailure(engine, error);
    throw packageFailureAnswer(engine, call, error, scrub, ROUTE);
  };
}

import { NextRequest, NextResponse } from "next/server";
import { createDatabaseProvider, getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { readBoundParams } from "@/lib/api/bound-params";
import { consoleTextByteLimit, consoleTextOverLimit } from "@/lib/db/destructive-commands";
import { ObjectRouteError, objectRouteErrorBody, optionalDatabase } from "@/lib/api/object-route";
import { containerDepth } from "@/lib/db/object-kinds";
import { getExplainStrategy, type ExplainMode } from "@/lib/explain";
import { isMultiStatement } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { endsOpenQueryTransactions, newQueryCallScope } from "@/lib/db/types";
import type { ExplainFormat, OpenQueryTransactionOutcome } from "@/lib/db/types";

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

  try {
    const body = await req.json();
    const { sql, options = {}, queryId } = body;

    let connection = await resolveConnection(body, guard.session);

    if (!sql) {
      return NextResponse.json({ error: "Connection and query are required" }, { status: 400 });
    }

    // A connection type that declares a console text bound is held to it here, before the bound parameters, the
    // provider and the statement cache are reached, so an oversize text opens no socket. The answer names the size
    // and the bound and never repeats the text. The bound is read from the type in the body, after the JSON has been
    // parsed: a streamed bound on the request itself would change every engine and is a separate decision.
    const textLimit = consoleTextByteLimit(connection.type);
    if (textLimit !== undefined) {
      if (typeof sql !== "string") {
        return NextResponse.json({ error: "sql must be a string" }, { status: 400 });
      }
      const over = consoleTextOverLimit(sql, textLimit);
      if (over !== undefined) {
        return NextResponse.json({ error: over }, { status: 413 });
      }
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

    // AN EXPLAIN PREFIXES ONE STATEMENT (#1311). Handed `SELECT 1 AS a; INSERT ...` it
    // explained the SELECT and the simple-query protocol then RAN the INSERT as a
    // statement of its own: measured on Materialize 26.44.1, AlloyDB Omni 17.9 and
    // Cloudberry 2.1.0, one RUN of that text applied the INSERT twice, once in the run
    // and once in its background plan request. A plan of several statements is not a
    // plan of anything, so the text is refused before a provider is opened. It is read
    // under the connection's own grammar, the one the editor splits a run with, so a
    // `;` inside a quote or a comment is not a second statement.
    if (explain.explain && typeof sql === "string" && isMultiStatement(sql, resolveSqlGrammar(connection.type))) {
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

    const provider = await getOrCreateProvider(connection);

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

    const prepared = provider.prepareQuery(statement, options);

    // A SINGLE STATEMENT CAN LEAVE A TRANSACTION OPEN, SO THIS ROUTE ENDS IT (D74).
    //
    // MEASURED 2026-09-15 against PostgreSQL 18.4 through this handler with the real
    // provider and the real process-wide cache: a lone `BEGIN` answered 200 and released
    // its pooled client in status `T`, and the next request on the same cached provider —
    // which is any other signed-in user of that stored connection — ran its `CREATE TABLE`
    // inside that stranger's transaction, answered 200, and an independent reader saw no
    // such table. Driven the other way the loss is loud: a `BEGIN` followed by a statement
    // naming a missing relation leaves the client in `E` and the next request answers 500.
    //
    // This `finally` was tried once before and REVERTED, because the ender it calls named
    // one shared pointer: it rolled back whichever client anybody had recorded last, which
    // cost a concurrent `/api/db/multi-query` script its committed `CREATE TABLE` and an
    // interactive `POST /api/db/transaction` session its own. D87 fixed that in the
    // provider, where the borrowed client is in scope, and the `scope` minted here is what
    // names this request's own session: nothing this handler did not run on can be ended.
    //
    // It is a `finally` and not a line after the call because the statement that poisons a
    // client is usually the one that threw, and the response must not be able to leave by
    // a path that skips this.
    const scope = newQueryCallScope();
    let openTransaction: OpenQueryTransactionOutcome = "none";

    // Pass queryId to provider for cancellation tracking
    const supportsCancel = "cancelQuery" in provider;
    let result: Awaited<ReturnType<typeof provider.query>>;
    try {
      result = await provider.query(prepared.query, bound.params, supportsCancel ? queryId : undefined, scope);
    } finally {
      if (endsOpenQueryTransactions(provider)) {
        openTransaction = await provider.endOpenQueryTransaction(scope);
      }
    }

    // PAGE TWO IS ONLY OFFERED FOR A BOUND THIS LAYER APPLIED (#816).
    //
    // `wasLimited` is the limiter saying it rewrote the statement, and it is the only
    // thing that makes advancing the bound meaningful: a statement returned untouched —
    // one carrying the user's own `LIMIT 50`, or a ClickHouse query whose trailing
    // `FORMAT`/`SETTINGS` clause the limiter declines to cut into — runs the same way at
    // every offset. Without this conjunct such a statement, answering with exactly
    // `prepared.limit` rows, offered a Load More whose click re-ran it unchanged and
    // appended the rows already on screen, which the user cannot tell from new ones.
    //
    // One rule, per statement, with no branching on database type: if the bound is ours,
    // pagination is offered; if it is the user's, or the statement could not be
    // rewritten, it is not.
    const hasMore = prepared.wasLimited && result.rows.length === prepared.limit;

    return NextResponse.json({
      ...result,
      ...(explainFormat !== undefined && { explainFormat }),
      // Present only when there was a transaction to end, the way `/api/db/multi-query`
      // reports it, so an always-present "none" would announce something that did not happen.
      // `use-query-execution.ts` raises the notice off this field on BOTH paths; it used to raise
      // it only inside its `multiStatement` branch, which a lone statement never sets, so this
      // field was answered and never rendered for its whole first commit.
      ...(openTransaction === "rolled-back" && { openTransaction }),
      pagination: {
        limit: prepared.limit,
        offset: prepared.offset,
        hasMore,
        totalReturned: result.rows.length,
        // A bound the PROVIDER applied is reported too (#1085, section 5.4). A provider that cuts
        // its own result, as the Prometheus provider cuts a vector at its series cap, says so on
        // the result's own `pagination`, and the badge this field drives says "Studio bounded this
        // result", which is as true of that bound as of the limiter's. Only a `true` crosses, so a
        // provider cannot clear a filled bound this layer applied. A short page does not show
        // the limiter badge; `hasMore` above stays on
        // `prepared.wasLimited` alone, because an offset can only advance a bound this layer wrote.
        wasLimited: hasMore || result.pagination?.wasLimited === true,
      },
    });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/query" });
  }
}

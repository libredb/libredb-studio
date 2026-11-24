import { NextResponse } from "next/server";
import {
  AGENT_HANDOVER_BUDGET,
  AGENT_HANDOVER_PROFILE,
  AGENT_HANDOVER_READ_ALLOWANCE,
} from "@/lib/agent/execution-policy";
import type { AgentRunEvent } from "@/lib/agent/types";
import { accessAgentRun } from "@/lib/api/agent-run-access";
import { openWithinCall } from "@/lib/api/editor-query";
import { runReadOnlyExecute } from "@/lib/api/read-only-execute";
import { createErrorResponse } from "@/lib/api/errors";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { catalogSessionConnection } from "@/lib/db/catalog-scope";
import { acquireExecutionProfileProvider } from "@/lib/db/factory";
import { providerTextScrub, withScrubbedWarnings } from "@/lib/db/operations/provider-text";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import { logger } from "@/lib/logger";
import { rowsWithNonFiniteWords } from "@/lib/non-finite";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Replays the statement a run handed to the editor, under the engine's own read-only
 * boundary (#373 review).
 *
 * The defect this route replaces: the hand-over ran the answer's statement through
 * `POST /api/db/query`, the ordinary editor path, in a plain read-write session. The
 * agent's own read is not merely *called* read-only — the ENGINE enforces it, with
 * `BEGIN READ ONLY` on PostgreSQL and `PRAGMA query_only` on SQLite — and the editor
 * path has neither. Its only protection was `isDangerousQuery`, which reads the
 * statement's TEXT, and text is not where the difference lives: a `SELECT` may invoke
 * a VOLATILE function that performs an `INSERT`, which the agent's transaction
 * refuses (SQLSTATE 25006) and a read-write session performs. So the identical
 * statement was harmless where the run proved it and harmful where it was replayed,
 * under a checkbox that says "writes and DDL are refused either way".
 *
 * Four properties make this a narrower surface than the route it replaces, and each
 * one is a deliberate refusal rather than an omission:
 *
 *  - **The request carries no SQL.** The statement is read from the run's own
 *    `answer-composed` event. A route that will replay any statement it is handed —
 *    read-only or not — is a general "run this without a timeout" endpoint, which is
 *    a smaller hole than the old one but still a new one. Nothing a user types can
 *    reach this profile, because nothing a user types is read.
 *  - **The gate's outcome is honoured, not re-decided.** Only `handover:
 *    "auto-executed"` is replayed. `applied` means the three-condition gate declined
 *    (§2.4.0), and the statement belongs in the editor unrun; `none` means the run
 *    was never opened with the setting at all. Both are refused here as well as on
 *    the surface, so a client that forgot cannot cause what the run decided against.
 *  - **The connection is the run's own**, resolved server-side from the persisted
 *    `connectionId` under the persisted actor — the same authority a drive
 *    authorizes against. A caller cannot name a different database for a statement
 *    another database approved.
 *  - **A run answers once** (`ANSWER_ALREADY_RECORDED` in `tools.ts`), so "the
 *    answer" is unambiguous and needs no id in the path.
 *
 * The open waits within the engine's connect budget and the request's signal (`openWithinCall`): a client that leaves
 * while the provider opens is answered 499 and one whose open outlasts the budget 504, both not-sent, and nothing is
 * read. The replay goes through the host core's read-only execute (`runReadOnlyExecute`) on a read-only statement
 * session, whose open refuses a provider without a read-only statement path, so its rows and bytes are held to the
 * hand-over budget again before the response is written, whatever the provider does, and a row larger than one page of
 * the host's is refused. It runs under the request's signal: a client that leaves while the statement runs is answered
 * 499, outcome unknown, the session offers no cancel so the statement runs on, and its later failure is logged by kind
 * and code.
 *
 * What it does NOT do is record a ledger event. The run may already have finished,
 * and a finished ledger does not accept appends; the replay is the editor's action on
 * the user's behalf, and the ledger's claim is that everything the RUN did is in it.
 * It is logged instead.
 */

const ROUTE = "POST /api/agent/runs/[runId]/handover";

type HandoverParams = { params: Promise<{ runId: string }> };

export async function POST(req: Request, context?: HandoverParams) {
  // The path is read defensively so that the SESSION is what answers a request
  // carrying no credential. Next.js always supplies the context; a caller that does
  // not gets an empty run id, which `accessAgentRun` answers exactly as it answers a
  // run that does not exist — never a destructuring error before the guard has run.
  // That is the "no credential, no work" property `tests/security/route-auth.test.ts`
  // enumerates every provider-reaching route for, and this is the first dynamic POST
  // route to be in it.
  const runId = (await context?.params)?.runId ?? "";
  const access = await accessAgentRun({ route: ROUTE, request: req, runId });
  if ("response" in access) return access.response;

  const { record } = access.report;
  const answer = record.events.find(
    (event): event is Extract<AgentRunEvent, { kind: "answer-composed" }> => event.kind === "answer-composed",
  );
  if (answer === undefined) {
    return NextResponse.json({ error: "This run composed no answer" }, { status: 404 });
  }
  if (answer.handover !== "auto-executed") {
    // 409 rather than 403: the request is well formed and the caller is entitled to
    // this run — the run's own recorded decision is what is in the way, and the
    // warning it recorded is the honest thing to repeat.
    return NextResponse.json(
      {
        error: `This run did not hand this statement over to be run${
          answer.handoverWarning === undefined ? "" : `: ${answer.handoverWarning}`
        }`,
      },
      { status: 409 },
    );
  }

  let connection: DatabaseConnection;
  try {
    const resolved = await resolveConnection(
      { connectionId: record.connectionId },
      { role: record.actor.role, username: record.actor.sessionId },
    );
    // In the database the run read, on a server-level connection (#1530): the run drafted the
    // statement against that database's objects, so it runs there and nowhere else.
    connection = record.catalog === undefined ? resolved : catalogSessionConnection(resolved, record.catalog);
  } catch (error) {
    return createErrorResponse(error, { route: ROUTE });
  }

  // From here a provider is built and asked, so its text, in a failure's response and log line and in a result's
  // warnings, passes core's scrub of this connection's credential first; a failure whose text is withheld keeps its
  // own status, code, kind and outcome (`createErrorResponse`).
  const scrub = providerTextScrub(connection, "profiled");
  try {
    // The run's own actor decides the file-access posture, as it decided the connection above: SQLite
    // opens only for a trusted requester, on this profile as in the editor. The request waits for the open within its
    // engine's connect budget and its own signal, so a client that leaves is answered at once while the open goes on.
    const provider = await openWithinCall(req.signal, connection.type, (wait) =>
      acquireExecutionProfileProvider(
        connection,
        AGENT_HANDOVER_PROFILE,
        {},
        editorExecutionContext({ role: record.actor.role }, connection),
        wait,
      ),
    );
    // A read allowance of this request's own: the run has ended, and the replay is the editor's read, not the run's.
    // Through the host core's read-only execute, whose session's open refuses a provider without a read-only statement
    // path, so `query()` is never the fallback; it holds the answer to the hand-over budget before any of it is written
    // into the response, stops waiting at the budget's timeout, the ceiling stated beside it, and answers at once a
    // client that leaves.
    const result = await runReadOnlyExecute(provider, {
      type: connection.type,
      statement: answer.sql,
      budget: {
        ...AGENT_HANDOVER_BUDGET,
        readAllowance: new RunReadAllowance(AGENT_HANDOVER_READ_ALLOWANCE, { scope: "call" }),
      },
      caller: req.signal,
      route: ROUTE,
    });
    logger.info("Agent hand-over replayed in the editor", {
      route: ROUTE,
      runId,
      connectionId: record.connectionId,
      rowCount: result.rowCount,
    });

    // The statement travels back beside its rows so the surface renders the text that
    // actually ran rather than its own copy of it. No `pagination`: there is no offset
    // to page with here — the row bound refuses rather than truncates, exactly as the
    // agent's own path does (§2.5), so a result that arrived is a whole result.
    // NaN and the infinities as words, as on `/api/db/query` (`src/lib/non-finite.ts`).
    return NextResponse.json({
      runId,
      ...(record.catalog === undefined ? {} : { catalog: record.catalog }),
      sql: answer.sql,
      result: { ...withScrubbedWarnings(scrub, result), rows: rowsWithNonFiniteWords(result.rows) },
    });
  } catch (error) {
    return createErrorResponse(error, { route: ROUTE, scrub });
  }
}

import { NextResponse } from "next/server";
import { AGENT_HANDOVER_BUDGET, AGENT_HANDOVER_PROFILE } from "@/lib/agent/execution-policy";
import type { AgentRunEvent } from "@/lib/agent/types";
import { accessAgentRun } from "@/lib/api/agent-run-access";
import { createErrorResponse } from "@/lib/api/errors";
import { acquireExecutionProfileProvider } from "@/lib/db/factory";
import { logger } from "@/lib/logger";
import { resolveConnection } from "@/lib/seed/resolve-connection";

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

  try {
    const connection = await resolveConnection(
      { connectionId: record.connectionId },
      { role: record.actor.role, username: record.actor.sessionId },
    );
    const provider = await acquireExecutionProfileProvider(connection, AGENT_HANDOVER_PROFILE);
    if (typeof provider.queryReadOnly !== "function") {
      // Never a fallback to `query()`. `acquireExecutionProfileProvider` already
      // refuses a provider without the database-native path under this profile, so
      // reaching here is a server fault — and the one thing it must not do is put the
      // statement on the writable path this route exists to leave.
      throw new Error("agent hand-over: the acquired provider exposes no read-only execution path");
    }

    const result = await provider.queryReadOnly(answer.sql, AGENT_HANDOVER_BUDGET);
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
    return NextResponse.json({ runId, sql: answer.sql, result });
  } catch (error) {
    return createErrorResponse(error, { route: ROUTE });
  }
}

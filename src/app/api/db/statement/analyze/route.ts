import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, isJsonObject, readJsonObject } from "@/lib/api/json-object-body";
import { createDatabaseProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { analyzeStatement, type StatementAnalysis } from "@/lib/editor/statement-analysis";
import { type RunTargetRange, RunTargetRangeError } from "@/lib/sql/run-target";

export const dynamic = "force-dynamic";

/**
 * The longest text this route analyses, in UTF-16 code units, the unit of its offsets (#2204, decision 1).
 *
 * The analysis is CPU on the event loop, and every reader in it is linear in the text. Measured on 2026-11-04 with the
 * whole text selected, through this route under Node 24 and on `analyzeStatement` under Bun 1.4.4: a 1,000,000-unit
 * PostgreSQL script took about 165 ms, and the slowest text found, 166,666 words `BEGIN ` on Snowflake, about 1.2 s
 * under Node and 1.6 s under Bun, almost all of it in the confirmation gate; Spark's slowest took about 0.85 s. The
 * proxy truncates a body at 10 MB rather than refusing it, so without a bound of its own one request could hold every
 * other request of the process for ten times as long. It is the LibreDB Mobile editor's own cap, so that client never
 * meets it; the web editor and the VS Code extension analyse their text locally and never send it here.
 *
 * The bound does not stop one signed-in user from filling the event loop: at one slot per request, the `query`
 * bucket's default 120 a minute buy more CPU time than the minute holds. That is a known limit in docs/SECURITY.md,
 * and a charge that grows with the text, or a faster gate, is `docs/BACKLOG.md` U202.
 */
const MAX_TEXT_LENGTH = 1_000_000;

type AnalysisFields =
  | { readonly ok: true; readonly text: string; readonly selection: RunTargetRange; readonly cursor: number }
  | { readonly ok: false; readonly status: 400 | 413; readonly error: string };

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

/**
 * The request's text, selection and caret, or the refusal of the first one that is not what the contract names, in
 * the words VS Code's `query/target` refuses the same field with. `null` is no value for any of them. The text is
 * handed on exactly as it was sent, never trimmed or normalised, because the offsets index into it.
 *
 * Whether the offsets fall within the text is not asked here: that is the run target's own rule, and its
 * `RunTargetRangeError` is answered below, so the rule has one implementation.
 */
function readAnalysisFields(body: Record<string, unknown>): AnalysisFields {
  const { text, selection, cursor } = body;
  if (typeof text !== "string") return { ok: false, status: 400, error: "text must be a string" };
  if (!isJsonObject(selection)) return { ok: false, status: 400, error: "selection must be an object" };
  const { start, end } = selection;
  if (!isInteger(start)) return { ok: false, status: 400, error: "selection.start must be an integer" };
  if (!isInteger(end)) return { ok: false, status: 400, error: "selection.end must be an integer" };
  if (!isInteger(cursor)) return { ok: false, status: 400, error: "cursor must be an integer" };
  if (text.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      status: 413,
      error: `The text is ${text.length} UTF-16 code units long, over the ${MAX_TEXT_LENGTH}-unit limit for statement analysis. Shorten it to run it.`,
    };
  }
  return { ok: true, text, selection: { start, end }, cursor };
}

/**
 * What Run would do with the editor's text, decided as the web editor decides it (#2204): the statement to send,
 * where it sits, whether the connection type refuses it, whether to ask before it runs and what to type, and which
 * route it takes. The answer is `analyzeStatement`'s, whole, so the web editor and a client outside the browser read
 * one implementation of every decision; this route only reads the request and resolves the connection.
 *
 * IT RUNS NOTHING. The provider is built to read its capabilities, as `POST /api/db/provider-meta` builds it, and its
 * `connect()` is never called, so no socket, file or pool opens; resolving the connection may still read Vault for a
 * `${vault:...}` seed and ask the Kubernetes API under the access review, as on every connection route. It records no
 * query event and asks no admission gate, because nothing runs. It logs no part of the text, of the statement or of
 * the refusal, which may quote a word of the text.
 *
 * IT IS ADVISORY, like the web editor's confirmation dialog: it is no authorization check, and `POST /api/db/query`
 * does not require it.
 *
 * THE ORDER IS THE SECURITY CENSUSES': the session, the body, the connection, then the fields. A connection the caller
 * may not open answers its own refusal whatever the body holds, which tests/security/custom-connections.test.ts,
 * governance-grants.test.ts and kubernetes-access-review.test.ts send every connection route, and which
 * `POST /api/db/query` answers the same way.
 *
 * Metered on the `query` bucket, one slot per request: the analysis is CPU on the event loop, and the provider is
 * built as on `POST /api/db/provider-meta`, which that bucket meters too.
 */
export async function POST(req: NextRequest) {
  // Ahead of body parsing: an unauthenticated caller gets no body parsed on its behalf, and the rate limiter sees the
  // request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/statement/analyze", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await readJsonObject(req);
    if (body === null) {
      return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    }

    const connection = await resolveConnection(body, guard.session);
    // An inline record may name no type, or a type that is no string; it names no provider to read, so it is refused in
    // `POST /api/db/provider-meta`'s words rather than reaching the factory, which fails on it with a TypeError. A name
    // that is present and no string, null included, is refused in the same words: the factory logs the name with a
    // string method, and the analysis reads it as the text a typed confirmation expects (docs/BACKLOG.md D454).
    if (!connection.type || typeof connection.type !== "string") {
      return NextResponse.json({ error: "Valid connection configuration is required" }, { status: 400 });
    }
    if (connection.name !== undefined && typeof connection.name !== "string") {
      return NextResponse.json({ error: "Valid connection configuration is required" }, { status: 400 });
    }

    // Before any provider is built: a request this route cannot read costs no provider.
    const fields = readAnalysisFields(body);
    if (!fields.ok) {
      return NextResponse.json({ error: fields.error }, { status: fields.status });
    }

    // The execution context, as every route that builds a provider passes it, although this one opens no handle.
    const provider = await createDatabaseProvider(connection, {}, editorExecutionContext(guard.session, connection));

    let analysis: StatementAnalysis;
    try {
      analysis = analyzeStatement({
        text: fields.text,
        selection: fields.selection,
        cursor: fields.cursor,
        databaseType: connection.type,
        capabilities: provider.getCapabilities(),
        connectionName: connection.name,
      });
    } catch (error) {
      // Offsets the run target cannot honour are the caller's, answered in the rule's own sentence, which names
      // numbers only and never the text, as VS Code's query/target answers them. Anything else is the server's, a
      // RangeError the runtime raises included: a stack overflow in an engine's reader is no offset of the caller's.
      if (!(error instanceof RunTargetRangeError)) throw error;
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(analysis);
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/statement/analyze" });
  }
}

import { NextResponse } from "next/server";
import { isThreadContextEnabled, resolveAgentAvailability } from "@/lib/agent/config";
import { operatorTuningStatus } from "@/lib/agent/model-tuning";
import { getSession } from "@/lib/auth";

/**
 * GET /api/agent/config — whether this server runs agents (#329 T10a; derived
 * availability #331 T5).
 *
 * The rail is a client component and everything that decides the answer is
 * server-side only, so visibility is discovered at runtime the way the storage mode
 * already is (`src/hooks/use-storage-sync.ts` reads `/api/storage/config`). Reading
 * it at build time instead would answer for the build: the standalone pages are
 * statically prerendered, and the operator sets these variables on the container.
 *
 * This route owns **the whole answer**, and it is the only place that can. T5 kept
 * `isAgentRuntimeEnabled()` synchronous for its five in-request callers, so that
 * function answers the flag and the model configuration; the second condition — that
 * the durable ledger has a writable path — is I/O, and this handler is already async
 * and already forbidden from failing on a misconfiguration.
 *
 * Three deliberate properties:
 *
 *  - **A session is required.** T9 pinned that the availability check sits after the
 *    session check in every agent route, so an unauthenticated caller cannot learn
 *    whether an agent surface exists here. The rail only ever renders for a
 *    logged-in user, so nothing is lost.
 *  - **`enabled` is a literal boolean.** `use-agent-capability.ts` compares
 *    `body.enabled === true`, so the field cannot become a code or a string without
 *    the rail silently disappearing everywhere.
 *  - **It never fails.** `resolveAgentAvailability` catches its own refusals and
 *    turns them into a reason, because a 500 here is indistinguishable from a server
 *    that simply runs no agents — hiding the misconfiguration behind the symptom an
 *    operator would be trying to diagnose.
 *
 * The `reason`/`detail` pair is for the operator, not for the rail: the rail renders
 * nothing when the answer is no, so it reads only `enabled`. The pair is what turns
 * `curl /api/agent/config` into a diagnosis instead of a shrug — which is the
 * requirement the ratified T5 proposal states, that the surface says which condition
 * is missing rather than offering a Start that must fail.
 *
 * **`reason` is for every session; `detail` is for an admin one.** The reason codes
 * name an operator action and no path, which is what makes them the field to filter
 * on and safe to hand anybody. The details are the underlying messages, and
 * `LEDGER_UNAVAILABLE`'s carries an absolute server filesystem path plus the OS
 * error string — server topology an ordinary user has no use for, since the rail
 * renders nothing either way. It is withheld as a whole rather than per reason: a
 * rule that has to be re-audited every time a reason is added is a rule that
 * eventually leaks the next detail somebody writes. Non-admin sessions get one
 * stable sentence naming who can see the rest.
 *
 * **`ledgerVerified` says which kind of yes this is.** `true` means the ledger's own
 * writable-path check ran and passed. `false` means the durable backend was accepted
 * without being contacted — the documented Postgres carve-out (B31), where the only
 * possible check is a connection attempt per page load. Without it, `{"enabled":
 * true}` would read as verified for a deployment whose `WORKFLOW_POSTGRES_URL` points
 * nowhere.
 *
 * The session is verified here with `getSession` rather than through `guardRoute`,
 * and **that rationale had to be rewritten in T5, because the handler it described no
 * longer exists.** It used to read one environment variable and reach nothing, so
 * "unmetered" cost nothing. It now performs I/O — a `mkdir`, a write and an unlink in
 * the ledger directory — which a logged-in caller could otherwise drive in a loop.
 *
 * The route still stays out of the `ai` bucket, and the reason is unchanged: metering a
 * visibility probe there would spend a run's budget on rendering a panel, and a
 * throttled probe makes the rail vanish for a user who reloads — the hook asks once per
 * mount and never retries, so a single 429 costs that browser its whole page session.
 * What bounds the cost instead is that the ledger answer is memoised for
 * `LEDGER_PROBE_TTL_MS` (`src/lib/agent/config.ts`): however often this route is
 * called, the filesystem is touched at most once per interval per directory per
 * process. The cheap half — the flag and the model configuration — is still re-read on
 * every call, so an operator's change to those is visible immediately.
 */

export const dynamic = "force-dynamic";

/** What a session that cannot act on the diagnosis is told instead of it. */
const WITHHELD_DETAIL = "the agent is unavailable on this server; an administrator can see why";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const isAdmin = session.role === "admin";
  const availability = await resolveAgentAvailability();
  /*
    Reported on BOTH answers, because it is the one part of the agent's configuration that fails
    open: every other misconfiguration takes the rail away, so an operator finds out by looking,
    while a tuning document that cannot be read leaves a working agent running settings nobody
    chose. The enabled answer is exactly where that needs saying.

    Admin-only, under the rule this route already states for `detail`: the status names an absolute
    server path and a parser message. Withheld as a whole rather than field by field, for the same
    reason given there. Cheap on repeat: the document is memoised for the process, so this adds at
    most one file read per process rather than one per call.
  */
  const modelTuning = isAdmin ? { modelTuning: operatorTuningStatus() } : {};
  if (availability.available) {
    // ADMIN only, beside `modelTuning`, because an operator is the only reader it has.
    // The setting exists so somebody who switches it off can confirm the switch took —
    // the same reason `modelTuning` reports itself — and `curl` is how they check.
    //
    // Deliberately NOT sent to every session, and the earlier reasoning for that was
    // simply false: the rail's "switched off on this server" sentence comes from the
    // RUN's own `thread.declined`, not from this probe (`use-agent-capability.ts` reads
    // `enabled` and nothing else). Telling every session on page load would also be the
    // wrong moment — the user needs it when a follow-up is not read as one, which is
    // where the run already says it.
    const operatorState = isAdmin ? { threadContext: isThreadContextEnabled() } : {};
    return NextResponse.json({
      enabled: true,
      ledgerVerified: availability.ledgerVerified,
      ...operatorState,
      ...modelTuning,
    });
  }

  const detail = isAdmin ? availability.detail : WITHHELD_DETAIL;
  return NextResponse.json({ enabled: false, reason: availability.reason, detail, ...modelTuning });
}

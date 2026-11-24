/**
 * The host's tree call (docs/providers/CONTRACT.md, clauses C-64, C-62, C-27, C-17 and C-28), part of the provider host
 * core.
 *
 * `treeCall` makes one `objects.tree` call on a session and answers a record of how it ended. It is checked before it
 * is made: `checkCallStart` refuses a call whose deadline passed or whose signal aborted, then `checkObjectsFacet` a
 * session that does not offer `objects.tree`. Each refusal is answered as a record, `called` false, and the provider is
 * never called. Then the context and the request are frozen in place, `freezeContext` and `freezeData`, so the caller
 * builds both fresh for each call.
 *
 * The call is waited for with `awaitWithin` until the context's signal. An answer is the session's own, by reference
 * (clause C-62): the caller reads the member its action answers. A wait the signal ends answers a stop, the signal's
 * reason by reference, and `settled`, which resolves once the call the host stopped waiting for has settled either way;
 * a failure after the stop reaches `ports.late` once and a later answer is dropped, so no promise the host stopped
 * waiting for is left without a handler. A provider's error passes by reference.
 *
 * The call reads the core's call machinery from the console calls (src/lib/provider-host/core/console.ts):
 * `refusedBefore`, `stoppedBy`, `lateFailure`, `settledOf` and `startCall`, one definition for every call the core
 * makes. Like them it constructs no class and keeps no module state.
 */
import {
  awaitWithin,
  type CallContext,
  checkCallStart,
  checkObjectsFacet,
  freezeContext,
  freezeData,
  type TreeAnswer,
  type TreeRequest,
} from "@libredb/provider-sdk/calls";
import type { Calls } from "@libredb/provider-sdk/manifest";
import {
  type HostCallPorts,
  lateFailure,
  type RefusedRecord,
  refusedBefore,
  type StoppedRecord,
  settledOf,
  startCall,
  stoppedBy,
} from "./console";

/** One session as the host core calls its object facets: its calls, and its tree function with the handle already bound. */
export interface ObjectsSession {
  readonly calls: Calls;
  tree?(request: TreeRequest, ctx: CallContext): Promise<TreeAnswer>;
}

/** A tree call that answered: the session's own answer, by reference. */
export interface AnsweredTree {
  readonly kind: "answered";
  readonly answer: TreeAnswer;
}

/** How a tree call ended: answered, refused before the call, or stopped. */
export type TreeRecord = RefusedRecord | StoppedRecord | AnsweredTree;

/** The tree function of `session`, a host defect when the session offers it and holds no function for it. */
function sessionTree(session: ObjectsSession, request: TreeRequest, ctx: CallContext): Promise<TreeAnswer> {
  if (session.tree === undefined) {
    throw new Error("The session offers objects.tree and has no tree function, a defect of the host's session.");
  }
  return session.tree(request, ctx);
}

/**
 * One `objects.tree` call on `session`: checked, the facet included, frozen, waited for until `ctx.signal`, answered as
 * a record with the session's answer by reference. A failure after the wait ended reaches `ports.late` once, and a
 * later answer is dropped.
 *
 * @throws The provider's error by reference, or a host defect when the session offers the facet and holds no function.
 */
export async function treeCall(
  session: ObjectsSession,
  request: TreeRequest,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<TreeRecord> {
  const start = checkCallStart(ctx);
  if (start.length > 0) return refusedBefore(start, ctx);
  const facet = checkObjectsFacet(session.calls, "tree");
  if (facet.length > 0) return refusedBefore(facet, ctx);
  freezeContext(ctx);
  freezeData(request);
  const call = startCall(() => sessionTree(session, request, ctx));
  try {
    const answer = await awaitWithin(call, ctx.signal, lateFailure(ctx, ports.late));
    return { kind: "answered", answer };
  } catch (error) {
    if (!stoppedBy(ctx, error)) throw error;
    return { kind: "stopped", reason: error, settled: settledOf(call) };
  }
}

/** The object calls one host core holds. */
export interface ObjectsCalls {
  readonly treeCall: typeof treeCall;
}

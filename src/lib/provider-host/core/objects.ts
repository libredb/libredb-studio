/**
 * The host's tree call (docs/providers/CONTRACT.md, clauses C-64, C-62, C-27, C-17, C-28 and M-89), part of the
 * provider host core.
 *
 * `treeCall` makes one `objects.tree` call on a session and answers a record of how it ended. It is checked before it
 * is made: `checkCallStart` refuses a call whose deadline passed or whose signal aborted, then `checkObjectsFacet` a
 * session that does not offer `objects.tree`, then `checkTreeRequest` a request naming a level or a kind the session's
 * object model does not state (clause M-89). Each refusal is answered as a record, `called` false, and the provider is
 * never called. A session that offers the tree states its model, a package session its declaration's and a bridged one
 * its legacy provider's; one that states none is the host's defect, named. Then the context and the request are frozen in place, `freezeContext` and `freezeData`, so the caller
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
  checkTreeRequest,
  freezeContext,
  freezeData,
  type TreeAnswer,
  type TreeRequest,
} from "@libredb/provider-sdk/calls";
import type { Calls, ObjectModel } from "@libredb/provider-sdk/manifest";
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

/**
 * One session as the host core calls its object facets: its calls, the object model its engine is read through, and its
 * tree function with the handle already bound.
 */
export interface ObjectsSession {
  readonly calls: Calls;
  /** The engine's object model the session's tree is read through; present exactly when the session offers `objects.tree`. */
  readonly objectModel?: ObjectModel;
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

/** The object model of `session`, which offers `objects.tree`; a host defect when it states none. */
function sessionObjectModel(session: ObjectsSession): ObjectModel {
  if (session.objectModel === undefined) {
    throw new Error("The session offers objects.tree and states no object model, a defect of the host's session.");
  }
  return session.objectModel;
}

/**
 * One `objects.tree` call on `session`: checked, the facet and the session's object model included, frozen, waited for until `ctx.signal`, answered as
 * a record with the session's answer by reference. A failure after the wait ended reaches `ports.late` once, and a
 * later answer is dropped.
 *
 * @throws The provider's error by reference, or a host defect when the session offers the facet and states no object
 * model or holds no function.
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
  const unstated = checkTreeRequest(sessionObjectModel(session), request);
  if (unstated.length > 0) return refusedBefore(unstated, ctx);
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

/**
 * The host's tree and source calls (docs/providers/CONTRACT.md, clauses C-64, C-62, C-27, C-17, C-28, C-115 and M-89),
 * part of the provider host core.
 *
 * `treeCall` makes one `objects.tree` call on a session and answers a record of how it ended. It is checked before it
 * is made: `checkCallStart` refuses a call whose deadline passed or whose signal aborted, then `checkObjectsFacet` a
 * session that does not offer `objects.tree`, then `checkTreeRequest` a request naming a level or a kind the session's
 * object model does not state (clause M-89). Each refusal is answered as a record, `called` false, and the provider is
 * never called. A session that offers the tree states its model, a package session its declaration's and a bridged one
 * its legacy provider's; one that states none is the host's defect, named. Then the context and the request are frozen in place, `freezeContext` and `freezeData`, so the caller
 * builds both fresh for each call.
 *
 * The call is waited for with `awaitWithin` until the context's signal. An answer is read once with `checkTreeAnswer`
 * against the form its request's action answers (clause C-62), whatever session answered it, a package's or the
 * bridge's: one that is not that form is refused as a record, `called` true, each refusal naming the rule
 * `tree-answer-unreadable` and its pointer, never a value. Past the check the answer is the session's own, by
 * reference, typed as its action's form (`TreeAnswerOf`) as the check answers it: the caller reads the member its
 * action answers and checks nothing of its own. The core reads the answer by reference past the check under operator
 * trust, the trust an installed package runs under, so a package that changes its answer after the check is not
 * guarded against. A wait the signal ends answers a stop, the signal's
 * reason by reference, and `settled`, which resolves once the call the host stopped waiting for has settled either way;
 * a failure after the stop reaches `ports.late` once and a later answer is dropped, so no promise the host stopped
 * waiting for is left without a handler. A provider's error passes by reference.
 *
 * `sourceCall` makes one `objects.source` call (clauses C-115, C-17, C-111 and M-89) the same way: `checkCallStart`,
 * then `checkObjectsFacet` a session that does not offer `objects.source`, then `checkSourceRequest` a request naming a
 * kind the session's object model does not state or states without source, an empty path, or a path deeper than the
 * model admits for its kind, each refused as a record before the call. Its answer is read once with
 * `checkSourceAnswer`, the SDK's closed source document of the request's path and kind, and one that is not that
 * document is refused as a record, `called` true, each refusal naming `source-answer-unreadable` and its pointer.
 * Unlike the tree's answer, a well-formed source answer is not answered by reference: it is the NEW document
 * `boundSourceAnswer` builds from it, each readable part past `SOURCE_CHARACTER_LIMIT` cut and marked and each part
 * rebuilt without the members it holds with no value, so every reader after the core reads each part in the form the
 * check read it, by its members' values. A stop, a late failure and a provider's error are answered as the tree's.
 *
 * Both calls read the core's call machinery from the console calls (src/lib/provider-host/core/console.ts):
 * `refusedBefore`, `stoppedBy`, `lateFailure`, `settledOf` and `startCall`, one definition for every call the core
 * makes. Like them they construct no class and keep no module state.
 */
import {
  awaitWithin,
  boundSourceAnswer,
  type CallContext,
  checkCallStart,
  checkObjectsFacet,
  checkSourceAnswer,
  checkSourceRequest,
  checkTreeAnswer,
  checkTreeRequest,
  freezeContext,
  freezeData,
  type ObjectSourceDocument,
  type SourceRequest,
  type TreeAnswer,
  type TreeAnswerOf,
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
 * tree and source functions with the handle already bound.
 */
export interface ObjectsSession {
  readonly calls: Calls;
  /**
   * The engine's object model the session's tree and source are read through; present where the session offers
   * `objects.tree` or `objects.source`.
   */
  readonly objectModel?: ObjectModel;
  tree?(request: TreeRequest, ctx: CallContext): Promise<TreeAnswer>;
  /** The engine's source read (clause C-115); present exactly when the session offers `objects.source`. */
  source?(request: SourceRequest, ctx: CallContext): Promise<ObjectSourceDocument>;
}

/** A tree call that answered: the session's own answer, by reference, in the form its request's action answers. */
export interface AnsweredTree<Answer extends TreeAnswer = TreeAnswer> {
  readonly kind: "answered";
  readonly answer: Answer;
}

/**
 * How a tree call ended: answered, refused before the call or for what it answered, or stopped. `Answer` is the form
 * its request's action answers.
 */
export type TreeRecord<Answer extends TreeAnswer = TreeAnswer> = RefusedRecord | StoppedRecord | AnsweredTree<Answer>;

/** The tree function of `session`, a host defect when the session offers it and holds no function for it. */
function sessionTree(session: ObjectsSession, request: TreeRequest, ctx: CallContext): Promise<TreeAnswer> {
  if (session.tree === undefined) {
    throw new Error("The session offers objects.tree and has no tree function, a defect of the host's session.");
  }
  return session.tree(request, ctx);
}

/** The source function of `session`, a host defect when the session offers it and holds no function for it. */
function sessionSource(
  session: ObjectsSession,
  request: SourceRequest,
  ctx: CallContext,
): Promise<ObjectSourceDocument> {
  if (session.source === undefined) {
    throw new Error("The session offers objects.source and has no source function, a defect of the host's session.");
  }
  return session.source(request, ctx);
}

/**
 * The object model of `session`, which offers `facet`; a host defect, naming the facet it was read for, when it states
 * none.
 */
function sessionObjectModel(session: ObjectsSession, facet: "objects.tree" | "objects.source"): ObjectModel {
  if (session.objectModel === undefined) {
    throw new Error(`The session offers ${facet} and states no object model, a defect of the host's session.`);
  }
  return session.objectModel;
}

/**
 * One `objects.tree` call on `session`: checked, the facet and the session's object model included, frozen, waited for
 * until `ctx.signal`, its answer read with `checkTreeAnswer`, answered as a record with the session's answer by
 * reference, or refused, `called` true, when it is not the form `request`'s action answers. A failure after the wait
 * ended reaches `ports.late` once, and a later answer is dropped.
 *
 * @throws The provider's error by reference, or a host defect when the session offers the facet and states no object
 * model or holds no function.
 */
export async function treeCall<R extends TreeRequest>(
  session: ObjectsSession,
  request: R,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<TreeRecord<TreeAnswerOf<R["action"]>>> {
  const start = checkCallStart(ctx);
  if (start.length > 0) return refusedBefore(start, ctx);
  const facet = checkObjectsFacet(session.calls, "tree");
  if (facet.length > 0) return refusedBefore(facet, ctx);
  const unstated = checkTreeRequest(sessionObjectModel(session, "objects.tree"), request);
  if (unstated.length > 0) return refusedBefore(unstated, ctx);
  freezeContext(ctx);
  freezeData(request);
  const call = startCall(() => sessionTree(session, request, ctx));
  try {
    const answer = await awaitWithin(call, ctx.signal, lateFailure(ctx, ports.late));
    const check = checkTreeAnswer(request, answer);
    if (check.kind === "refused") return { kind: "refused", called: true, refusals: check.refusals };
    return { kind: "answered", answer: check.answer };
  } catch (error) {
    if (!stoppedBy(ctx, error)) throw error;
    return { kind: "stopped", reason: error, settled: settledOf(call) };
  }
}

/** A source call that answered: the provider's document as `boundSourceAnswer` cut it, a new document. */
export interface AnsweredSource {
  readonly kind: "answered";
  readonly answer: ObjectSourceDocument;
}

/** How a source call ended: answered, refused before the call or for what it answered, or stopped. */
export type SourceRecord = RefusedRecord | StoppedRecord | AnsweredSource;

/**
 * One `objects.source` call on `session`: checked, the facet and the session's object model included, frozen, waited
 * for until `ctx.signal`, its answer read with `checkSourceAnswer` and answered as a record holding the new document
 * `boundSourceAnswer` cuts from it, or refused, `called` true, when it is not the source document of `request`. A
 * failure after the wait ended reaches `ports.late` once, and a later answer is dropped.
 *
 * @throws The provider's error by reference, or a host defect when the session offers the facet and states no object
 * model or holds no function.
 */
export async function sourceCall(
  session: ObjectsSession,
  request: SourceRequest,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<SourceRecord> {
  const start = checkCallStart(ctx);
  if (start.length > 0) return refusedBefore(start, ctx);
  const facet = checkObjectsFacet(session.calls, "source");
  if (facet.length > 0) return refusedBefore(facet, ctx);
  const unstated = checkSourceRequest(sessionObjectModel(session, "objects.source"), request);
  if (unstated.length > 0) return refusedBefore(unstated, ctx);
  freezeContext(ctx);
  freezeData(request);
  const call = startCall(() => sessionSource(session, request, ctx));
  try {
    const answer = await awaitWithin(call, ctx.signal, lateFailure(ctx, ports.late));
    const check = checkSourceAnswer(request, answer);
    if (check.kind === "refused") return { kind: "refused", called: true, refusals: check.refusals };
    return { kind: "answered", answer: boundSourceAnswer(check.answer) };
  } catch (error) {
    if (!stoppedBy(ctx, error)) throw error;
    return { kind: "stopped", reason: error, settled: settledOf(call) };
  }
}

/** The object calls one host core holds. */
export interface ObjectsCalls {
  readonly treeCall: typeof treeCall;
  readonly sourceCall: typeof sourceCall;
}

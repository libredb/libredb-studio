import {
  checkObjectsFacet,
  deadlineSignal,
  type TreeAnswerOf,
  type TreeContainersAnswer,
  type TreeRequest,
} from "@libredb/provider-sdk/calls";
import type { ObjectModel } from "@libredb/provider-sdk/manifest";
import { callContext, contextOn, EXECUTE_SLACK_MS, executeDeadlineFor } from "@/lib/api/editor-query";
import { type BudgetGrant, budgetGrantEnd } from "@/lib/api/provider-monitoring";
import type { TreeTarget } from "@/lib/api/session-target";
import type { ContainerSource } from "@/lib/db/container-walk";
import { errorCode, errorKind } from "@/lib/db/error-record";
import { waitedSeconds } from "@/lib/db/errors";
import type { Container, DatabaseObject, KindCount, ObjectDetail, ObjectDetailBatch } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import {
  type BudgetView,
  budgetRefusalError,
  budgetStopError,
  type CallerView,
  refusalError,
  stopError,
} from "@/lib/provider-host/access";
import type { RefusedRecord, StoppedRecord } from "@/lib/provider-host/core/console";
import type { HostCore } from "@/lib/provider-host/core/host-core";
import type { TreeRecord } from "@/lib/provider-host/core/objects";
import { hostCore } from "@/lib/provider-host/instance";

/*
 * THE OBJECT TREE ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clauses C-64, C-65 and C-80).
 *
 * `objectTree` is the caller facade of the object tree's reads: the six tree routes under `POST /api/db/objects/` and
 * the VS Code backend's tree calls read every container listing, count, object listing and description through it.
 * Each read is one host core tree call on the session of the target its caller hands it (`TreeTarget` in
 * src/lib/api/session-target.ts): a provider package's session, or the legacy bridge's session of a legacy provider,
 * which the target's builder built once, so no facade builds a bridged session itself and none reads who serves the
 * engine. Each read carries the target's environment, is counted on the target's cache entry while it runs, and reads
 * the core the process's composition root installed before anything else, so a read made before the install fails by
 * name and sends the provider no tree call. It builds a fresh request for each read, with copies of the caller's
 * arrays, so the core freezes nothing a caller holds. The facade's `objectModel` is that session's, the model the host
 * core holds every read to (clause M-89), and the one its callers read the engine's levels and kinds through. A session
 * that does not offer `objects.tree` is refused when a facade is built, before any read, as `FacetNotOfferedError`
 * naming the call, outcome not-sent (clause C-111).
 *
 * Deadlines. Each read waits until its own deadline, taken at that read's start, the target's statement timeout plus
 * `EXECUTE_SLACK_MS` (`executeDeadlineFor`), and until the caller's signal. An inventory's and a search's walks take
 * one deadline per read and not one per request: a whole walk is a sum of round trips that grows with the server's
 * distance (measured on PostgreSQL, 1,418 sequential reads took 68 s at a 50 ms round trip, about what one default
 * deadline allows), so a deadline per request would cut walks that answer, while a deadline per read bounds each round
 * trip and the caller's signal ends the walk at its next read.
 *
 * Answers. A read answers the provider's own answer by reference, the member its action answers. The host core reads
 * every answer against its action's form before the facade sees it (`checkTreeAnswer`, clause C-62), so the facade
 * checks nothing of its own: an answer outside that form, a `needsConfiguration` beside a container or below the top
 * level included, is refused by the core and answered by the accessor as a `HostDefectError` naming the rule
 * `tree-answer-unreadable` and its pointer, which a route answers by whose defect the rule is (`REFUSAL_AUTHOR` in
 * src/lib/api/package-errors.ts): the package's for a provider package, Studio's own for a legacy provider. A read the
 * caller left is answered at once as `QueryCancelledError`, outcome unknown, or not-sent when refused before the call;
 * a read past its deadline as `StudioTimeoutRefusal` naming the read, the statement timeout and the slack. A
 * provider's error passes as the same object, and a read's failure after its wait ended is logged by route, action,
 * kind and code, never its text. A read naming a level or a kind the session's object model does not state is refused
 * before any call as `StudioObjectModelRefusal`, outcome not-sent.
 * Every other refusal before the call is Studio's defect (the accessor's rules). The facade takes no catalog, so no
 * catalog choice is honoured on this path, and each caller's own checks and scrubs run where they ran. A containers
 * answer that says the inventory needs configuration (`needsConfiguration`, clause C-61) is answered by
 * `listContainers` as its containers alone.
 *
 * THE GROUNDING WALK (clause C-80). `grantedObjectTree` is the facade of the agent's grounding inventory walk
 * (`walkObjectInventory` in src/lib/agent/tools.ts). The walk holds ONE deadline, the time its call was granted, and
 * not one per read as the editor's walks do: the run granted the walk that time, so no read of it may outlast it. The
 * walk reads one target's session, whose bridged session its caller built handed the run's billed-read allowance by
 * reference (`providerTreeTarget`'s second input), and the facade builds one deadline signal, so the walk keeps one
 * timer however many reads it makes; each read takes a fresh context on both. Its caller signal is the drive's, which
 * never aborts (`driveCaller`), so a read the deadline stopped, or one refused at its start because the deadline
 * passed between reads, answers the grant's own time refusal (`budgetGrantEnd`), the stopped read's settlement handed
 * to the grant's hold first, so the run counts the read in flight until it settles; the walk sends no further read.
 * Its containers read answers the whole answer, so the walk reads the configuration question on its first read.
 *
 * MCP'S SCHEMA READS (clause C-82). `objectTreeWithinCall` is the facade of MCP's tree reads: inspect_schema's container
 * listings, relation listings and descriptions, and the database choice's listing. An MCP call holds ONE deadline, its
 * start plus `timeout_ms`, which already bounds every step of the call, so the facade takes that deadline and the
 * request's signal, reads its target's session, and builds one signal that aborts at the deadline or when the request
 * leaves, when it is called; each read takes a fresh context on both. A read the request left answers
 * `QueryCancelledError`; a read the deadline stopped, or one refused at its start because the deadline passed, answers
 * the call's own time refusal (`timeRefusal`), so only the caller's own reads can answer its timeout. Nothing is held:
 * a stopped read's provider promise keeps the host's rejection handler, and a later failure is logged under the call's
 * route by action, kind and code. It answers `ObjectTree`, its containers read the containers alone, as the editor's
 * facade does.
 */

/**
 * The object tree of one session as its callers read it: the object model its session states, and each tree read as
 * a host core tree call held to that model. The reads hold no `this`, so a caller may take one off the object.
 */
export interface ObjectTree extends ContainerSource {
  readonly objectModel: ObjectModel;
  listContainers(parent?: readonly string[]): Promise<readonly Container[]>;
  countObjects(container: readonly string[]): Promise<Readonly<Record<string, KindCount>>>;
  listObjects(container: readonly string[], kind: string): Promise<readonly DatabaseObject[]>;
  describeObject(path: readonly string[], kind: string): Promise<ObjectDetail>;
  describeObjects(
    container: readonly string[],
    kind: string,
    limit: number,
    options?: { readonly defaultSql: true },
  ): Promise<ObjectDetailBatch>;
}

type TreeAction = TreeRequest["action"];

/** How each action's read is named in its deadline sentence. */
const READ_NOUN: Readonly<Record<TreeAction, string>> = {
  containers: "The container listing",
  count: "The object count",
  list: "The object listing",
  describe: "The object description",
  describeMany: "The description of the objects",
};

/**
 * The late port of a tree read: a failure after the caller stopped waiting, logged under `route` and `action` by its
 * kind and code, never its text, which can carry a server's words.
 */
function treeLate(route: string, action: TreeAction): (failure: unknown) => void {
  return (failure) => {
    logger.warn("A tree read Studio stopped waiting for failed afterwards", {
      route,
      action,
      kind: errorKind(failure),
      code: errorCode(failure),
    });
  };
}

/**
 * One host core tree call for `request`, answering the form its action answers, which the core checked
 * (`TreeAnswerOf`).
 */
type TreeRead = <R extends TreeRequest>(request: R) => Promise<TreeAnswerOf<R["action"]>>;

/**
 * The tree reads both facades answer through `read`, one host core tree call: each a fresh request with copies of the
 * caller's arrays, and each answering its action's member, which the core checked.
 */
function treeReads(read: TreeRead) {
  return {
    containers: (parent?: readonly string[]): Promise<TreeContainersAnswer> =>
      read(parent === undefined ? { action: "containers" } : { action: "containers", parent: [...parent] }),
    countObjects: async (container: readonly string[]): Promise<Readonly<Record<string, KindCount>>> =>
      (await read({ action: "count", container: [...container] })).counts,
    listObjects: async (container: readonly string[], kind: string): Promise<readonly DatabaseObject[]> =>
      (await read({ action: "list", container: [...container], kind })).objects,
    describeObject: async (path: readonly string[], kind: string): Promise<ObjectDetail> =>
      (await read({ action: "describe", path: [...path], kind })).detail,
    describeObjects: (
      container: readonly string[],
      kind: string,
      limit: number,
      options?: { readonly defaultSql: true },
    ): Promise<ObjectDetailBatch> =>
      read({
        action: "describeMany",
        container: [...container],
        kind,
        limit,
        ...(options?.defaultSql === true ? { defaultSql: true as const } : {}),
      }),
  };
}

/**
 * The deadline sentence of the view `objectTree` answers its build's refusal under: that refusal is of a facet the
 * session does not offer, refused before any read, which no deadline ends, so the accessor reads no deadline sentence
 * for it.
 */
const BUILT_UNREAD = "The object tree was refused before any read, so no read waited for a deadline.";

/**
 * The object model of `target`'s session, read when a facade is built: refused before any read, by `end`'s error for a
 * record refused before the call, when the session does not offer `objects.tree` (`checkObjectsFacet`), so a provider
 * package's session that offers no tree answers `FacetNotOfferedError` naming it, outcome not-sent (clause C-111).
 *
 * @throws {Error} A host defect, when the session offers `objects.tree` and states no object model.
 */
function offeredModel(target: TreeTarget, end: (record: RefusedRecord) => Error): ObjectModel {
  const refusals = checkObjectsFacet(target.session.calls, "tree");
  if (refusals.length > 0) throw end({ kind: "refused", called: false, refusals });
  if (target.session.objectModel === undefined) {
    throw new Error("The session offers objects.tree and states no object model, a defect of the host's session.");
  }
  return target.session.objectModel;
}

/**
 * One host core tree call of `request` on `target`'s session under `ctx`, counted on the target's entry from its start
 * until it ended (`started`, `ended`), a later failure logged under `route`.
 */
async function markedTreeCall<R extends TreeRequest>(
  core: HostCore,
  target: TreeTarget,
  request: R,
  ctx: ReturnType<typeof contextOn>,
  route: string,
): Promise<TreeRecord<TreeAnswerOf<R["action"]>>> {
  target.started();
  let record: TreeRecord<TreeAnswerOf<R["action"]>> | undefined;
  try {
    record = await core.treeCall(target.session, request, ctx, { late: treeLate(route, request.action) });
    return record;
  } finally {
    target.ended(record);
  }
}

/**
 * The object tree of `target`'s session, whose object model is read when this is called (`offeredModel`); each read a
 * host core tree call on it under its own deadline, taken from `clock` at its start and the target's timeout, the
 * target's environment and `caller`, its failures after the caller left logged under `route`.
 *
 * @throws {FacetNotOfferedError} Not-sent, before any read, when the session does not offer `objects.tree`.
 */
export function objectTree(
  target: TreeTarget,
  caller: AbortSignal,
  route: string,
  clock: () => number = Date.now,
): ObjectTree {
  const sentenceOf = (action: TreeAction) =>
    `${READ_NOUN[action]} did not answer within the statement timeout of ${waitedSeconds(target.timeout())} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`;
  const objectModel = offeredModel(target, (record) =>
    refusalError(record, { caller, deadlineSentence: BUILT_UNREAD }),
  );
  async function read<R extends TreeRequest>(request: R): Promise<TreeAnswerOf<R["action"]>> {
    const core = hostCore();
    const view: CallerView = { caller, deadlineSentence: sentenceOf(request.action) };
    const ctx = callContext(executeDeadlineFor(target.timeout(), clock()), caller, target.env);
    const record = await markedTreeCall(core, target, request, ctx, route);
    if (record.kind === "refused") throw refusalError(record, view);
    if (record.kind === "stopped") throw stopError(record.reason, view);
    return record.answer;
  }

  return treeOf(objectModel, read);
}

/**
 * The `ObjectTree` whose reads are `read`'s host core tree calls on a session stating `objectModel`: the model handed
 * through, and the containers read answering the containers alone.
 */
function treeOf(objectModel: ObjectModel, read: TreeRead): ObjectTree {
  const { containers, ...reads } = treeReads(read);
  return {
    objectModel,
    listContainers: async (parent) => (await containers(parent)).containers,
    ...reads,
  };
}

/** How a tree read on one session ends when the core did not answer it: the error `end` builds for the record. */
type TreeEnd = (record: RefusedRecord | StoppedRecord) => Error;

/**
 * One host core tree call per read on `target`, each a fresh context of `deadline`, `signal` and the target's
 * environment, counted on the target's entry, a later failure logged under `route`; a record the core did not answer
 * throws `end`'s error for it.
 */
function sessionReads(
  core: HostCore,
  target: TreeTarget,
  { deadline, signal, route }: { readonly deadline: number; readonly signal: AbortSignal; readonly route: string },
  end: TreeEnd,
): TreeRead {
  return async (request) => {
    const record = await markedTreeCall(core, target, request, contextOn(deadline, signal, target.env), route);
    if (record.kind !== "answered") throw end(record);
    return record.answer;
  };
}

/** What an MCP call hands its tree: its one deadline, the request's signal, its own time refusal and its route. */
interface TreeCallWithin {
  /** The call's one deadline, its start plus `timeout_ms`. */
  readonly deadline: number;
  /** The request's signal: a read it ended is the caller leaving. */
  readonly caller: AbortSignal;
  /** The call's own refusal of a read its deadline ended, built fresh for each read. */
  readonly timeRefusal: () => Error;
  /** The route a read's failure after the call stopped waiting is logged under. */
  readonly route: string;
}

/**
 * The object tree of `target`'s session within one MCP call (clause C-82): one signal that aborts at `call.deadline`
 * or when `call.caller` does, built when this is called. Each read is one host core tree call with a fresh request and
 * a fresh context of the call's deadline, that one signal and the target's environment. A read the caller left throws
 * `QueryCancelledError`; one the deadline ended, or refused at its start because the deadline passed, throws
 * `call.timeRefusal()`; a later failure is logged under `call.route` by action, kind and code.
 *
 * @throws {HostCoreBootOrderError} Synchronously, before the host core is installed, before any read.
 * @throws {FacetNotOfferedError} Not-sent, before any read, when the session does not offer `objects.tree`.
 */
export function objectTreeWithinCall(target: TreeTarget, call: TreeCallWithin): ObjectTree {
  const core = hostCore();
  const view: BudgetView = { caller: call.caller, timeRefusal: call.timeRefusal };
  const objectModel = offeredModel(target, (record) => budgetRefusalError(record, view));
  const signal = deadlineSignal(call.deadline, call.caller);
  const read = sessionReads(core, target, { deadline: call.deadline, signal, route: call.route }, (record) =>
    record.kind === "refused" ? budgetRefusalError(record, view) : budgetStopError(record.reason, view),
  );
  return treeOf(objectModel, read);
}

/**
 * The object tree the agent's grounding walk reads, every read a host core tree call under the walk's one grant. Its
 * containers read answers the whole containers answer, `needsConfiguration` included. The reads hold no `this`.
 */
export interface GrantedObjectTree {
  containers(parent?: readonly string[]): Promise<TreeContainersAnswer>;
  countObjects(container: readonly string[]): Promise<Readonly<Record<string, KindCount>>>;
  listObjects(container: readonly string[], kind: string): Promise<readonly DatabaseObject[]>;
  describeObjects(container: readonly string[], kind: string, limit: number): Promise<ObjectDetailBatch>;
}

/**
 * The object tree of `target`'s session for the agent's grounding walk, under `grant` (clause C-80): one session for
 * the whole walk, the target's, whose bridged session the caller built with the run's read allowance where the walk
 * has one (`providerTreeTarget` in src/lib/api/session-target.ts), and one deadline signal, built when this is called.
 * Each read is one host core tree call with a fresh request and a fresh context of the grant's deadline, that one
 * signal and the target's environment. A read that did not answer throws `budgetGrantEnd`'s error, the grant's own
 * time refusal at the deadline, after a stopped read's settlement is handed to the grant's hold; a later failure is
 * logged under the grant's route and the action by kind and code.
 *
 * @throws {HostCoreBootOrderError} Synchronously, before the host core is installed, before any read.
 * @throws The grant's refusal of a session that does not offer `objects.tree`, before any read.
 */
export function grantedObjectTree(target: TreeTarget, grant: BudgetGrant): GrantedObjectTree {
  const core = hostCore();
  offeredModel(target, (record) => budgetGrantEnd(record, grant));
  const signal = deadlineSignal(grant.deadline);
  const read = sessionReads(core, target, { deadline: grant.deadline, signal, route: grant.route }, (record) =>
    budgetGrantEnd(record, grant),
  );

  const { containers, countObjects, listObjects, describeObjects } = treeReads(read);
  return {
    containers,
    countObjects,
    listObjects,
    describeObjects: (container, kind, limit) => describeObjects(container, kind, limit),
  };
}

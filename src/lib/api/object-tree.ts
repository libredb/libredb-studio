import {
  deadlineSignal,
  type TreeAnswer,
  type TreeContainersAnswer,
  type TreeRequest,
} from "@libredb/provider-sdk/calls";
import type { ObjectModel } from "@libredb/provider-sdk/manifest";
import { callContext, contextOn, EXECUTE_SLACK_MS, executeDeadline, statementTimeout } from "@/lib/api/editor-query";
import { type BudgetGrant, budgetGrantEnd } from "@/lib/api/provider-monitoring";
import type { ContainerSource } from "@/lib/db/container-walk";
import { errorCode, errorKind } from "@/lib/db/error-record";
import { waitedSeconds } from "@/lib/db/errors";
import type { RunReadAllowance } from "@/lib/db/read-allowance";
import type {
  Container,
  DatabaseObject,
  DatabaseProvider,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
} from "@/lib/db/types";
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
import { hostCore } from "@/lib/provider-host/instance";
import { type BridgedConsole, bridgedConsole } from "@/lib/provider-host/legacy-bridge";

/*
 * THE OBJECT TREE ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clauses C-64, C-65 and C-80).
 *
 * `objectTree` is the caller facade of the object tree's reads: the six tree routes under `POST /api/db/objects/` and
 * the VS Code backend's tree calls read every container listing, count, object listing and description through it.
 * Each read is one host core tree call on the legacy bridge's session of the provider its caller resolved, one session
 * built when the facade is, as `cancelEditorRun` builds it. Building it reads the provider's capabilities once, to state
 * the session's object model, before the host core is read; each read then reads the core the process's composition
 * root installed before anything else, so a read made before the install fails by name and sends the provider no tree
 * call. It builds a fresh request for each read, with copies of the caller's arrays, so the core freezes nothing a
 * caller holds. The facade's `objectModel` is that session's, the model the host core holds every read to (clause
 * M-89), and the one its callers read the engine's levels and kinds through.
 *
 * Deadlines. Each read waits until its own deadline, `executeDeadline` taken at that read's start, the statement
 * timeout plus `EXECUTE_SLACK_MS`, and until the caller's signal. An inventory's and a search's walks take one deadline
 * per read and not one per request: a whole walk is a sum of round trips that grows with the server's distance
 * (measured on PostgreSQL, 1,418 sequential reads took 68 s at a 50 ms round trip, about what one default deadline
 * allows), so a deadline per request would cut walks that answer, while a deadline per read bounds each round trip and
 * the caller's signal ends the walk at its next read.
 *
 * Answers. A read answers the provider's own answer by reference, the member its action answers; an answer without it
 * is a defect of Studio's bridge, named, except a `describeMany` batch, which the bridge passes through by reference,
 * so a batch without `details` is the provider's answer without it, named. A read the caller left is answered at once as `QueryCancelledError`, outcome
 * unknown, or not-sent when refused before the call; a read past its deadline as `StudioTimeoutRefusal` naming the
 * read, the statement timeout and the slack. A provider's error passes as the same object, and a read's failure after
 * its wait ended is logged by route, action, kind and code, never its text. A read naming a level or a kind the
 * session's object model does not state is refused before any call as `StudioObjectModelRefusal`, outcome not-sent.
 * Every other refusal is a defect of Studio's bridge, which offers `objects.tree` on every session (the accessor's
 * rules). The facade takes no catalog, so no catalog choice is honoured on this path, and each caller's own checks and
 * scrubs run where they ran. A containers
 * answer that says the inventory needs configuration (`needsConfiguration`, clause C-61) is answered by
 * `listContainers` as its containers alone; one that says so beside a container, or below the top level, is a defect
 * of the provider, named, in both facades.
 *
 * THE GROUNDING WALK (clause C-80). `grantedObjectTree` is the facade of the agent's grounding inventory walk
 * (`walkObjectInventory` in src/lib/agent/tools.ts). The walk holds ONE deadline, the time its call was granted, and
 * not one per read as the editor's walks do: the run granted the walk that time, so no read of it may outlast it. The
 * facade builds one bridged session for the whole walk, handed the run's billed-read allowance by reference
 * (`bridgedConsole`'s third input), and one deadline signal, so the walk keeps one timer however many reads it makes;
 * each read takes a fresh context on both. Its caller signal is the drive's, which never aborts (`driveCaller`), so a
 * read the deadline stopped, or one refused at its start because the deadline passed between reads, answers the
 * grant's own time refusal (`budgetGrantEnd`), the stopped read's settlement handed to the grant's hold first, so the
 * run counts the read in flight until it settles; the walk sends no further read. Its containers read answers the
 * whole answer, so the walk reads the configuration question on its first read.
 *
 * MCP'S SCHEMA READS (clause C-82). `objectTreeWithinCall` is the facade of MCP's tree reads: inspect_schema's container
 * listings, relation listings and descriptions, and the database choice's listing. An MCP call holds ONE deadline, its
 * start plus `timeout_ms`, which already bounds every step of the call, so the facade takes that deadline and the
 * request's signal, and builds one bridged session, with no read allowance, and one signal that aborts at the deadline
 * or when the request leaves, both when it is called; each read takes a fresh context on both. A read the request left
 * answers `QueryCancelledError`; a read the deadline stopped, or one refused at its start because the deadline passed,
 * answers the call's own time refusal (`timeRefusal`), so only the caller's own reads can answer its timeout. Nothing is
 * held: a stopped read's provider promise keeps the host's rejection handler, and a later failure is logged under the
 * call's route by action, kind and code. It answers `ObjectTree`, its containers read the containers alone, as the
 * editor's facade does.
 */

/**
 * The object tree of one provider as its callers read it: the object model its session states, and each tree read as
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

/** The error an answer the bridge builds without `member`, the member its action answers, is answered with. */
function bridgeDefect(action: TreeAction, member: string): Error {
  return new Error(
    `Studio's provider bridge answered a ${action} tree read without ${member}, which is a defect of Studio.`,
  );
}

/** The error the provider's own answer, which the bridge passes through, is answered with when it lacks `member`. */
function providerAnswerDefect(action: TreeAction, member: string): Error {
  return new Error(`The provider answered a ${action} tree read without ${member}, which is a defect of the provider.`);
}

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

/** The error the provider's containers answer is answered with when it says `needsConfiguration` where it may not. */
function needsConfigurationDefect(where: "beside a container" | "below the top level"): Error {
  return where === "beside a container"
    ? new Error(
        "The provider answered a containers tree read with needsConfiguration beside a container, which is a defect of the provider.",
      )
    : new Error(
        "The provider answered a containers tree read below the top level with needsConfiguration, which is a defect of the provider.",
      );
}

/**
 * `answer`, the answer of a containers read under `parent`, held to where `needsConfiguration` may be said: only on a
 * top-level listing that lists no container (clause C-61).
 */
function checkedContainers(answer: TreeContainersAnswer, parent: readonly string[] | undefined): TreeContainersAnswer {
  if (answer.needsConfiguration === undefined) return answer;
  if (parent !== undefined) throw needsConfigurationDefect("below the top level");
  if (answer.containers.length > 0) throw needsConfigurationDefect("beside a container");
  return answer;
}

/**
 * The tree reads both facades answer through `read`, one host core tree call: each a fresh request with copies of the
 * caller's arrays, and each answer held to its action's member, a containers answer also to where it may say the
 * inventory needs configuration.
 */
function treeReads(read: (request: TreeRequest) => Promise<TreeAnswer>) {
  return {
    containers: async (parent?: readonly string[]): Promise<TreeContainersAnswer> => {
      const answer = await read(
        parent === undefined ? { action: "containers" } : { action: "containers", parent: [...parent] },
      );
      if (!("containers" in answer)) throw bridgeDefect("containers", "containers");
      return checkedContainers(answer, parent);
    },
    countObjects: async (container: readonly string[]): Promise<Readonly<Record<string, KindCount>>> => {
      const answer = await read({ action: "count", container: [...container] });
      if (!("counts" in answer)) throw bridgeDefect("count", "counts");
      return answer.counts;
    },
    listObjects: async (container: readonly string[], kind: string): Promise<readonly DatabaseObject[]> => {
      const answer = await read({ action: "list", container: [...container], kind });
      if (!("objects" in answer)) throw bridgeDefect("list", "objects");
      return answer.objects;
    },
    describeObject: async (path: readonly string[], kind: string): Promise<ObjectDetail> => {
      const answer = await read({ action: "describe", path: [...path], kind });
      if (!("detail" in answer)) throw bridgeDefect("describe", "detail");
      return answer.detail;
    },
    describeObjects: async (
      container: readonly string[],
      kind: string,
      limit: number,
      options?: { readonly defaultSql: true },
    ): Promise<ObjectDetailBatch> => {
      const answer = await read({
        action: "describeMany",
        container: [...container],
        kind,
        limit,
        ...(options?.defaultSql === true ? { defaultSql: true as const } : {}),
      });
      if (!("details" in answer)) throw providerAnswerDefect("describeMany", "details");
      return answer;
    },
  };
}

/**
 * The object tree of `provider` on one bridged session, built when this is called, which reads the provider's
 * capabilities for its object model; each read a host core tree call on it under its own deadline, taken from `clock`
 * at its start, and `caller`, its failures after the caller left logged under `route`.
 */
export function objectTree(
  provider: DatabaseProvider,
  caller: AbortSignal,
  route: string,
  clock: () => number = Date.now,
): ObjectTree {
  const { session } = bridgedConsole(provider, {});
  async function read(request: TreeRequest): Promise<TreeAnswer> {
    const core = hostCore();
    const view: CallerView = {
      caller,
      deadlineSentence: `${READ_NOUN[request.action]} did not answer within the statement timeout of ${waitedSeconds(statementTimeout(provider))} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`,
    };
    const record = await core.treeCall(session, request, callContext(executeDeadline(provider, clock()), caller), {
      late: treeLate(route, request.action),
    });
    if (record.kind === "refused") throw refusalError(record, view);
    if (record.kind === "stopped") throw stopError(record.reason, view);
    return record.answer;
  }

  return treeOf(session.objectModel, read);
}

/**
 * The `ObjectTree` whose reads are `read`'s host core tree calls on a session stating `objectModel`: the model handed
 * through, and the containers read answering the containers alone.
 */
function treeOf(objectModel: ObjectModel, read: (request: TreeRequest) => Promise<TreeAnswer>): ObjectTree {
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
 * One host core tree call per read on `session`, each a fresh context of `deadline`, `signal` and the empty
 * environment, a later failure logged under `route`; a record the core did not answer throws `end`'s error for it.
 */
function sessionReads(
  core: HostCore,
  session: BridgedConsole["session"],
  { deadline, signal, route }: { readonly deadline: number; readonly signal: AbortSignal; readonly route: string },
  end: TreeEnd,
): (request: TreeRequest) => Promise<TreeAnswer> {
  return async (request) => {
    const record = await core.treeCall(session, request, contextOn(deadline, signal), {
      late: treeLate(route, request.action),
    });
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
 * The object tree of `provider` within one MCP call (clause C-82): one bridged session with no read allowance, and one
 * signal that aborts at `call.deadline` or when `call.caller` does, both built when this is called. Each read is one
 * host core tree call with a fresh request and a fresh context of the call's deadline, that one signal and the empty
 * environment. A read the caller left throws `QueryCancelledError`; one the deadline ended, or refused at its start
 * because the deadline passed, throws `call.timeRefusal()`; a later failure is logged under `call.route` by action,
 * kind and code.
 *
 * @throws {HostCoreBootOrderError} Synchronously, before the host core is installed, before any read.
 */
export function objectTreeWithinCall(provider: DatabaseProvider, call: TreeCallWithin): ObjectTree {
  const core = hostCore();
  const { session } = bridgedConsole(provider, {});
  const signal = deadlineSignal(call.deadline, call.caller);
  const view: BudgetView = { caller: call.caller, timeRefusal: call.timeRefusal };
  const read = sessionReads(core, session, { deadline: call.deadline, signal, route: call.route }, (record) =>
    record.kind === "refused" ? budgetRefusalError(record, view) : budgetStopError(record.reason, view),
  );
  return treeOf(session.objectModel, read);
}

/**
 * What the grounding walk's tree is granted: the call's grant, and the run's billed-read allowance where it has one.
 */
export interface WalkGrant extends BudgetGrant {
  readonly readAllowance?: RunReadAllowance;
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
 * The object tree of `provider` for the agent's grounding walk, under `grant` (clause C-80): one bridged session for
 * the whole walk, built with the grant's read allowance, and one deadline signal, both built when this is called. Each
 * read is one host core tree call with a fresh request and a fresh context of the grant's deadline, that one signal and
 * the empty environment. A read that did not answer throws `budgetGrantEnd`'s error, the grant's own time refusal at
 * the deadline, after a stopped read's settlement is handed to the grant's hold; a later failure is logged under the
 * grant's route and the action by kind and code.
 *
 * @throws {HostCoreBootOrderError} Synchronously, before the host core is installed, before any read.
 */
export function grantedObjectTree(provider: DatabaseProvider, grant: WalkGrant): GrantedObjectTree {
  const core = hostCore();
  const { readAllowance } = grant;
  const { session } = bridgedConsole(provider, {}, readAllowance === undefined ? {} : { readAllowance });
  const signal = deadlineSignal(grant.deadline);
  const read = sessionReads(core, session, { deadline: grant.deadline, signal, route: grant.route }, (record) =>
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

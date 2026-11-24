import type { TreeAnswer, TreeRequest } from "@libredb/provider-sdk/calls";
import { callContext, EXECUTE_SLACK_MS, executeDeadline, statementTimeout } from "@/lib/api/editor-query";
import type { ContainerSource } from "@/lib/db/container-walk";
import { errorCode, errorKind } from "@/lib/db/error-record";
import { waitedSeconds } from "@/lib/db/errors";
import type {
  Container,
  DatabaseObject,
  DatabaseProvider,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ProviderCapabilities,
} from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { type CallerView, refusalError, stopError } from "@/lib/provider-host/access";
import { hostCore } from "@/lib/provider-host/instance";
import { bridgedConsole } from "@/lib/provider-host/legacy-bridge";

/*
 * THE OBJECT TREE ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clauses C-64 and C-65).
 *
 * `objectTree` is the caller facade of the object tree's reads: the six tree routes under `POST /api/db/objects/` and
 * the VS Code backend's tree calls read every container listing, count, object listing and description through it.
 * Each read is one host core tree call on the legacy bridge's session of the provider its caller resolved, built as
 * `cancelEditorRun` builds it, on the core the process's composition root installed, read before anything else, so a
 * read made before the install fails by name and reaches no provider. It builds a fresh request for each read, with
 * copies of the caller's arrays, so the core freezes nothing a caller holds.
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
 * its wait ended is logged by route, action, kind and code, never its text. Every other refusal is a defect of Studio's
 * bridge, which offers `objects.tree` on every session (the accessor's rule). The facade takes no catalog, so no
 * catalog choice is honoured on this path, and each caller's own checks and scrubs run where they ran.
 */

/**
 * The object tree of one provider as its callers read it: the provider's capabilities, and each tree read as a host
 * core tree call. The reads hold no `this`, so a caller may take one off the object.
 */
export interface ObjectTree extends ContainerSource {
  getCapabilities(): ProviderCapabilities;
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

/**
 * The object tree of `provider`, each read a host core tree call under its own deadline, taken from `clock` at its
 * start, and `caller`, its failures after the caller left logged under `route`.
 */
export function objectTree(
  provider: DatabaseProvider,
  caller: AbortSignal,
  route: string,
  clock: () => number = Date.now,
): ObjectTree {
  async function read(request: TreeRequest): Promise<TreeAnswer> {
    const core = hostCore();
    const view: CallerView = {
      caller,
      deadlineSentence: `${READ_NOUN[request.action]} did not answer within the statement timeout of ${waitedSeconds(statementTimeout(provider))} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`,
    };
    const record = await core.treeCall(
      bridgedConsole(provider, {}).session,
      request,
      callContext(executeDeadline(provider, clock()), caller),
      { late: treeLate(route, request.action) },
    );
    if (record.kind === "refused") throw refusalError(record, view);
    if (record.kind === "stopped") throw stopError(record.reason, view);
    return record.answer;
  }

  return {
    getCapabilities: () => provider.getCapabilities(),
    listContainers: async (parent) => {
      const answer = await read(
        parent === undefined ? { action: "containers" } : { action: "containers", parent: [...parent] },
      );
      if (!("containers" in answer)) throw bridgeDefect("containers", "containers");
      return answer.containers;
    },
    countObjects: async (container) => {
      const answer = await read({ action: "count", container: [...container] });
      if (!("counts" in answer)) throw bridgeDefect("count", "counts");
      return answer.counts;
    },
    listObjects: async (container, kind) => {
      const answer = await read({ action: "list", container: [...container], kind });
      if (!("objects" in answer)) throw bridgeDefect("list", "objects");
      return answer.objects;
    },
    describeObject: async (path, kind) => {
      const answer = await read({ action: "describe", path: [...path], kind });
      if (!("detail" in answer)) throw bridgeDefect("describe", "detail");
      return answer.detail;
    },
    describeObjects: async (container, kind, limit, options) => {
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
